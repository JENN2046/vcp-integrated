'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { createApplicationSenderGuard, resolveWindowWebContents } = require('../ipc/applicationSender');

const channel = 'native-sync:desktop-status';
const openStatus = 'native-sync:show-profile-status';

async function readConnection(appDataRoot) {
    const dir = path.join(appDataRoot, '.native-sync');
    const file = path.join(dir, 'connection.json');
    try {
        if (!(await fs.lstat(dir)).isDirectory()) throw Error('Invalid profile directory');
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536) throw Error('Invalid profile file');
        const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        try {
            const opened = await handle.stat();
            if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink !== 1) {
                throw Error('Profile file changed');
            }
            const bytes = Buffer.alloc(65537);
            let length = 0;
            while (length < bytes.length) {
                const read = await handle.read(bytes, length, bytes.length - length, length);
                if (!read.bytesRead) break;
                length += read.bytesRead;
            }
            if (length > 65536) throw Error('Invalid profile size');
            const config = JSON.parse(bytes.toString('utf8', 0, length));
            if (typeof config?.enabled !== 'boolean') throw Error('Invalid connection');
            const space = config.sharedSpaceId;
            if (space !== undefined && (typeof space !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(space))) {
                throw Error('Invalid shared space');
            }
            return { configured: true, enabled: config.enabled, sharedSpaceId: config.sharedSpaceId ?? null };
        } finally {
            await handle.close();
        }
    } catch (error) {
        if (error.code === 'ENOENT') return { configured: false, enabled: null, sharedSpaceId: null };
        throw error;
    }
}

async function readProfileStatus(host) {
    const connection = await readConnection(host.appDataRoot);
    const settings = await host.readSettings();
    let serverOrigin = null;
    if (settings?.vcpServerUrl) {
        const url = new URL(settings.vcpServerUrl);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw Error('Invalid server');
        serverOrigin = url.origin;
    }
    return { ...connection, serverOrigin };
}

function registerDesktopStatus(host, ipcMain, { integrated = false, getWindow = () => host.mainWindow } = {}) {
    const allowed = createApplicationSenderGuard({ projectRoot: host.projectRoot,
        getWebContents: () => resolveWindowWebContents(getWindow) });
    const mode = integrated ? 'integrated' : (host.agentSettingsSaveOwner ? 'agent-name' : 'profile-only');
    ipcMain.handle(channel, async event => {
        if (!allowed(event)) return { success: false, error: 'MAIN_WINDOW_REQUIRED' };
        if (integrated) return { success: true, mode };
        try {
            return { success: true, mode, profile: await readProfileStatus(host) };
        } catch {
            return { success: false, mode, error: 'PROFILE_STATUS_UNAVAILABLE' };
        }
    });
    let off;
    try {
        if (!integrated) {
            off = host.hooks.on('tray:menu-items', () => [{
                label: 'NativeSync 本机连接信息',
                click() {
                    const win = getWindow();
                    if (!win || win.isDestroyed()) return;
                    win.show();
                    win.webContents.send(openStatus);
                },
            }]);
            host.hooks.emit('tray:refresh', true);
        }
    } catch (error) {
        off?.();
        ipcMain.removeHandler(channel);
        throw error;
    }
    let disposed = false;
    return () => {
        if (disposed) return;
        disposed = true;
        ipcMain.removeHandler(channel);
        off?.();
        if (off) host.hooks.emit('tray:refresh', true);
    };
}

module.exports = { registerDesktopStatus, readProfileStatus };

'use strict';

// Windows test fixture. Observe the real window and let QMP send the UI inputs.
const { app, BrowserWindow, ipcMain } = require('electron');
const { createHash, X509Certificate } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { restrictNodeNetwork } = require('../integration/restrict-network.cjs');
const profile = process.env.VCPCHAT_APP_DATA_DIR;
const desktop = process.env.NS_HOST;
const output = process.env.NS_WIN_EVENTS;
const origin = 'https://127.0.0.1:18443';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const log = (event, data) => fs.appendFileSync(output, JSON.stringify({
    event, time: new Date().toISOString(), pid: process.pid, data
}) + '\n');
let loadingSources = false;
let prior;
let sampleInProgress = false;

restrictNodeNetwork();
app.on('session-created', session => {
    session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, ({ url }, done) => {
        const target = new URL(url);
        const network = /^(?:https?|wss?|ftp):$/.test(target.protocol);
        done({ cancel: network && (target.hostname !== '127.0.0.1' || target.port !== '18443') });
    });
});
app.on('certificate-error', (event, _contents, url, _error, certificate, callback) => {
    const leaf = new X509Certificate(certificate.data);
    const accepted = new URL(url).origin === origin &&
        leaf.fingerprint256 === process.env.NS_CERT_FINGERPRINT;
    if (accepted) event.preventDefault();
    callback(accepted);
});
const register = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handle) => register(channel, async (event, ...args) => {
    if (channel !== 'group-member-handoff') return handle(event, ...args);
    const { action, workId, expectedExecutor, expectedExecutorVersion, expectedNextOrdinal, expectedPreviousReplySeq } = args[0];
    log('group-ui-ipc', { action, workId, expectedExecutor, expectedExecutorVersion, expectedNextOrdinal, expectedPreviousReplySeq });
    const result = await handle(event, ...args);
    log('group-ui-result', { action, success: result?.success, error: result?.error });
    return result;
});

const mainFiles = [
    'Groupmodules/groupchat.js',
    'modules/services/nativeSync/sharedGroup.js',
    'modules/services/nativeSync/sharedGroupHandoff.js'
];
const rendererFile = 'modules/renderer/controlledWorkView.mjs';
const cdsFile = 'modules/services/chatDataService/bin/win32-x64/vcp_chat_data_service.exe';

async function loadedSources(win) {
    const main = mainFiles.map(file => {
        const absolute = path.join(desktop, file);
        const loaded = Boolean(require.cache[absolute]);
        return { file, loaded, sha256: sha256(fs.readFileSync(absolute)) };
    });
    const renderer = await new Promise((resolve, reject) => {
        const debuggerApi = win.webContents.debugger;
        debuggerApi.attach('1.3');
        const report = (_event, name, details) => {
            if (name !== 'Debugger.scriptParsed' || !details.url.endsWith('/' + rendererFile)) return;
            debuggerApi.off('message', report);
            debuggerApi.sendCommand('Debugger.getScriptSource', { scriptId: details.scriptId })
                .then(({ scriptSource }) => resolve({ file: rendererFile, sha256: sha256(scriptSource) }), reject)
                .finally(() => debuggerApi.detach());
        };
        debuggerApi.on('message', report);
        debuggerApi.sendCommand('Debugger.enable').catch(reject);
        setTimeout(() => {
            debuggerApi.off('message', report);
            if (debuggerApi.isAttached()) debuggerApi.detach();
            reject(Error('Renderer source observation timed out'));
        }, 4000).unref();
    });
    log('windows-loaded', { main, renderer, electron: process.versions.electron, arch: process.arch,
        platform: process.platform, account: process.env.USERNAME, sandbox: !app.commandLine.hasSwitch('no-sandbox'),
        cdsSha256: sha256(fs.readFileSync(path.join(desktop, cdsFile))),
        electronSha256: sha256(fs.readFileSync(process.execPath)) });
}

async function sample() {
    const win = BrowserWindow.getAllWindows().find(candidate => /\/main\.html(?:\?|$)/.test(candidate.webContents.getURL()));
    if (!win || win.webContents.isLoading() || sampleInProgress) return;
    sampleInProgress = true;
    try {
        const view = await win.webContents.executeJavaScript(`(async () => {
            const current = window.VCPStateChannels?.get('conversation.current')?.get();
            if (!current?.topicId) return null;
            const { itemId, itemType, topicId } = current;
            const panel = document.querySelector('.native-sync-controlled-work');
            const messages = [...document.querySelectorAll('.message-item[data-message-id]')]
                .map(el => ({ id: el.dataset.messageId, text: el.querySelector('.md-content')?.innerText?.trim() || '' }))
                .filter(row => row.text);
            const state = itemId ? await window.electronAPI.getNativeExecutionStatus(itemId,itemType,topicId,false) : null;
            const handoff = state?.groupHandoff;
            return { topicId, itemId, itemType, connection: state?.connection,
                remote: handoff ? { id: handoff.id, state: handoff.state, executor: handoff.executor,
                    executorVersion: handoff.executorVersion, nextOrdinal: handoff.nextOrdinal,
                    confirmedCount: handoff.confirmedCount, fresh: handoff.fresh } : null,
                panel: panel?.open ? panel.querySelector('[role=status]')?.innerText : null,
                messages };
        })()`);
        if (!view) return;
        if (!loadingSources) {
            loadingSources = true;
            loadedSources(win).catch(error => log('source-observation-error', error.message));
        }
        const signature = JSON.stringify(view);
        if (signature !== prior) {
            prior = signature;
            log('window', view);
        }
    } catch (error) {
        log('sample-error', error.message);
    } finally {
        sampleInProgress = false;
    }
}

app.on('ready', () => log('electron-ready', { electron: process.versions.electron, account: process.env.USERNAME, profile }));
app.on('quit', (_event, code) => log('electron-quit', { code }));
ipcMain.on('lifecycle:renderer-ready', () => log('renderer-ready'));
setInterval(sample, 600).unref();
app.setAppPath(desktop);
require(path.join(desktop, 'main.js'));

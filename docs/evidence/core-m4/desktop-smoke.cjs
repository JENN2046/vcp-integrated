'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const profile = process.env.VCPCHAT_APP_DATA_DIR;
const root = process.env.M4_DESKTOP_HOST;
const output = process.env.M4_GUI_RECEIPT;
const filesBefore = new Set(fs.readdirSync(profile));
assert.deepEqual([...filesBefore], ['settings.json']);
require(path.join(root, 'main.js'));
const timer = setTimeout(() => {
    console.error('isolated desktop smoke timed out');
    app.exit(1);
}, 45000);
app.whenReady().then(async () => {
    let win;
    let lock;
    for (let count = 0; count < 150; count++) {
        win = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/main.html'));
        const name = path.join(profile, 'databases', 'chat_data_service.lock');
        if (win && !win.webContents.isLoading() && fs.existsSync(name)) {
            lock = JSON.parse(fs.readFileSync(name, 'utf8'));
            break;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(win && lock?.pid, 'native main window and CDS');
    const renderer = await win.webContents.executeJavaScript('({ready:document.readyState,title:document.title,preload:typeof window.electronAPI})');
    assert.equal(renderer.ready, 'complete');
    assert.equal(renderer.preload, 'object');
    const cds = fs.readlinkSync('/proc/' + lock.pid + '/exe');
    assert.ok(cds.endsWith('/vcp_chat_data_service'));
    const receipt = { platform: process.platform, architecture: process.arch, electron: process.versions.electron,
        renderer, nativeCds: path.basename(cds), isolatedProfile: true };
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2));
    console.log('M4_ELECTRON ' + JSON.stringify(receipt));
    clearTimeout(timer);
    app.quit();
}).catch(error => {
    console.error(error);
    app.exit(1);
});

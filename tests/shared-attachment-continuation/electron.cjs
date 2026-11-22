'use strict';

const { dialog } = require('electron');
const { install } = require('../integration/electron-fixture-hooks.cjs');
const syntheticFile = process.env.NS_ATTACHMENT_FIXTURE_FILE;
const original = dialog.showOpenDialog.bind(dialog);
dialog.showOpenDialog = function (owner, options) {
    if (options?.title !== '选择要发送的文件' || !syntheticFile) return original(owner, options);
    return Promise.resolve({ canceled:false, filePaths:[syntheticFile] });
};

install({
    commands: {
        async 'type-composer'(window, text) {
            const debuggerApi = window.webContents.debugger;
            if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');
            await debuggerApi.sendCommand('Input.insertText', { text });
        },
    },
});
require('../integration/electron.cjs');

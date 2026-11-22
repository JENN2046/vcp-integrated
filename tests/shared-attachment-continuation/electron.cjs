'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { dialog } = require('electron');
const { install } = require('../integration/electron-fixture-hooks.cjs');
const syntheticFile = process.env.NS_ATTACHMENT_FIXTURE_FILE;
const original = dialog.showOpenDialog.bind(dialog);
dialog.showOpenDialog = function (owner, options) {
    if (options?.title !== '选择要发送的文件' || !syntheticFile) return original(owner, options);
    return Promise.resolve({ canceled:false, filePaths:[syntheticFile] });
};

const { marker } = require('./fixture.cjs');
const ipcPackets = [];
install({
    onIpc(channel, args) {
        if (channel !== 'send-to-vcp') return;
        const [, , messages, , messageId] = args;
        if (JSON.stringify(messages).includes(marker)) ipcPackets.push({ messageId, messages });
    },
    commands: {
        async 'observe-request-output'(window) {
            const debuggerApi = window.webContents.debugger;
            if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');
            const modulePath = path.join(process.env.NS_HOST, 'modules/chat/singleChatRequestOrchestrator.js');
            const source = fs.readFileSync(modulePath, 'utf8');
            const lines = source.split('\n');
            const lineNumber = lines.findIndex(line => line.includes('messages: messagesForVCP,'));
            assert.ok(lineNumber > 0 && lines[lineNumber - 1].trim() === 'return {');
            await debuggerApi.sendCommand('Debugger.enable');
            const { locations } = await debuggerApi.sendCommand('Debugger.setBreakpointByUrl', {
                url: pathToFileURL(modulePath).href,
                lineNumber,
                // The condition snapshots the calculated payload and always returns false.
                // The renderer continues without stops or replacements.
                condition: `(globalThis.__attachmentTrace ??= []).push(
                    JSON.parse(JSON.stringify({messageId, messages:messagesForVCP}))) && false`,
            });
            assert.ok(locations.length, 'renderer source breakpoint resolved');
            return { module: 'modules/chat/singleChatRequestOrchestrator.js',
                line:lineNumber + 1, sha256:createHash('sha256').update(source).digest('hex') };
        },
        async 'read-request-output'(window) {
            const renderer = await window.webContents.executeJavaScript(
                `(globalThis.__attachmentTrace ?? []).filter(row => JSON.stringify(row.messages).includes(${JSON.stringify(marker)}))`);
            return { renderer, ipc:ipcPackets };
        },
        async 'type-composer'(window, text) {
            const debuggerApi = window.webContents.debugger;
            if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');
            await debuggerApi.sendCommand('Input.insertText', { text });
        },
    },
});
require('../integration/electron.cjs');

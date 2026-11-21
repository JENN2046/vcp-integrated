'use strict';

const path = require('node:path');

function install(ipcMain, host, log) {
    const { SenderTaskRegistry } = require(path.join(host, 'modules/services/senderTaskRegistry.js'));
    for (const method of ['begin', 'finish', 'cancel']) {
        const original = SenderTaskRegistry.prototype[method];
        SenderTaskRegistry.prototype[method] = function (sender, requestId, ...args) {
            const result = original.call(this, sender, requestId, ...args);
            if (this.label === 'vcp-stream-tasks') log('desktop-stream-task', {
                method, requestId, active: this.snapshot(), reason: method === 'cancel' ? args[0] : undefined,
            });
            return result;
        };
    }

    const fetch = globalThis.fetch;
    globalThis.fetch = async function (url, options) {
        const response = await fetch.call(this, url, options);
        if (response.headers.get('content-type') !== 'text/event-stream' ||
            !String(url).endsWith('/v1/local-chat/completions')) return response;
        const { requestId } = JSON.parse(options.body);
        const body = response.body;
        const getReader = body.getReader.bind(body);
        body.getReader = function (...args) {
            const reader = getReader(...args);
            for (const method of ['cancel', 'releaseLock']) {
                const original = reader[method].bind(reader);
                reader[method] = function (...args) {
                    try { return original(...args); }
                    finally { log('desktop-stream-reader', { method, requestId, locked: body.locked }); }
                };
            }
            return reader;
        };
        return response;
    };

    const handle = ipcMain.handle;
    ipcMain.handle = function (channel, listener) {
        if (channel !== 'interrupt-vcp-request') return handle.call(this, channel, listener);
        return handle.call(this, channel, async (event, params) => {
            const result = await listener(event, params);
            log('desktop-stop-receipt', { requestId: params.messageId, success: result.success, error: result.error });
            return result;
        });
    };
}

module.exports = { install };

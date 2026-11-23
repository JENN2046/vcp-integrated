'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createHash } = require('node:crypto');

require('../context-chain/server-capture.cjs');
const log = process.env.NS_CONTEXT_HANDLER_LOG;
const load = Module._load;
Module._load = function (request, parent, isMain) {
    const loaded = load.call(this, request, parent, isMain);
    if (request !== './modules/chatCompletionHandler.js' || path.basename(parent?.filename || '') !== 'server.js') {
        return loaded;
    }
    const handle = loaded.prototype.handle;
    loaded.prototype.handle = function (req, ...args) {
        fs.appendFileSync(log, JSON.stringify({
            kind:'native-chat-ingress',
            requestId:req.body?.requestId,
            socketPeer:req.socket.remoteAddress,
            requestIp:req.ip,
            forwardedFor:Boolean(req.headers['x-forwarded-for']),
        }) + '\n', {mode:0o600});
        return handle.call(this, req, ...args);
    };
    return loaded;
};

process.on('exit', () => {
    const sources = ['Plugin.js','FileFetcherServer.js','WebSocketServer.js','modules/vcpLoop/toolExecutor.js']
        .filter(file => require.cache[path.resolve(file)]?.loaded)
        .map(file => ({file:'apps/server/' + file, sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')}));
    fs.appendFileSync(log, JSON.stringify({kind:'uri-loaded-sources', sources}) + '\n', {mode:0o600});
});

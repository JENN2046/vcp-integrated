'use strict';

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { createHash } = require('node:crypto');

// Observe the actual ToolBox handler without changing its input or result.
const file = process.env.NS_CONTEXT_HANDLER_LOG;
if (!file || process.env.NS_CONTEXT_INPUT !== 'GROUP_HANDOFF_BASELINE_INPUT') throw Error('Synthetic group fixture only');
const originalLoad = Module._load;
const wrapped = new WeakSet();

Module._load = function (request, parent, isMain) {
    const loaded = originalLoad.call(this, request, parent, isMain);
    if (request === './modules/chatCompletionHandler.js' && path.basename(parent?.filename || '') === 'server.js' &&
        typeof loaded?.prototype?.handle === 'function' && !wrapped.has(loaded)) {
        wrapped.add(loaded);
        const handle = loaded.prototype.handle;
        const execution = originalLoad.call(this, './modules/requestExecutionContext', parent, false);
        loaded.prototype.handle = function (req, res, forceShowVCP) {
            const member = JSON.stringify(req.body?.messages?.[0]?.content || '').match(/GROUP_RELAY_MEMBER_([ABC])/)?.[1];
            if (member) {
                const handoffFile = 'Plugin/NativeSync/sync/sharedGroupHandoff.js';
                const fullPath = path.resolve(handoffFile);
                if (!require.cache[fullPath]?.loaded) throw Error('Group handoff service was not loaded');
                const handoffSource = { file: handoffFile, sha256: createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex') };
                const row = { member, handoffSource, route: req.path, workId: execution.currentWork() ?? null,
                    device: req.headers['x-nativesync-device'], body: req.body };
                fs.appendFileSync(file, JSON.stringify(row) + '\n', { mode: 0o600 });
            }
            return handle.call(this, req, res, forceShowVCP);
        };
    }
    return loaded;
};

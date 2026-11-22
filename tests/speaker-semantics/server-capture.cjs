'use strict';

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const groupFixture = process.env.NS_CONTEXT_INPUT === 'GC_CURRENT';
require(groupFixture ? '../group-context/server-capture.cjs' : '../context-chain/server-capture.cjs');

const file = process.env.NS_CONTEXT_HANDLER_LOG;
const requestContext = new AsyncLocalStorage();
const originalLoad = Module._load;
const observed = new WeakSet();

const append = row => fs.appendFileSync(file, JSON.stringify(row) + '\n', { mode: 0o600 });
function fingerprint(request, parent) {
    const sourceFile = Module._resolveFilename(request, parent);
    return { file: path.relative(process.cwd(), sourceFile), sha256: createHash('sha256').update(fs.readFileSync(sourceFile)).digest('hex') };
}
function record(stage, source, messages) {
    const turn = requestContext.getStore();
    if (turn) append({ kind: 'speaker-stage', ...turn, stage, source, messages });
}

Module._load = function (request, parent, isMain) {
    const loaded = originalLoad.call(this, request, parent, isMain);
    if (!loaded || (typeof loaded !== 'object' && typeof loaded !== 'function') || observed.has(loaded)) return loaded;
    if (request === './modules/chatCompletionHandler.js' && path.basename(parent?.filename || '') === 'server.js') {
        const execution = originalLoad.call(this, './modules/requestExecutionContext', parent, false);
        const handle = loaded.prototype.handle;
        observed.add(loaded);
        loaded.prototype.handle = function (req, ...rest) {
            const member = JSON.stringify(req.body?.messages?.[0]?.content || '').match(/GC_MEMBER_([AB])/)?.[1];
            const namedContext = !groupFixture && (req.body?.messages || []).some(message =>
                JSON.stringify(message.content).includes(process.env.NS_CONTEXT_INPUT));
            if (!member && !namedContext) return handle.call(this, req, ...rest);
            const requestId = req.body.requestId || req.body.messageId;
            return requestContext.run({ member, requestId, workId: execution.currentWork() ?? null },
                () => handle.call(this, req, ...rest));
        };
    }
    if (!parent?.filename?.endsWith('/modules/chatCompletionHandler.js')) return loaded;
    if (request === './toolResultBatch.js') {
        observed.add(loaded);
        append({ kind: 'speaker-projector', source: fingerprint(request, parent) });
        return loaded;
    }
    const loopStage = {
        './handlers/streamHandler': 'stream-loop-input',
        './handlers/nonStreamHandler': 'non-stream-loop-input',
    }[request];
    if (loopStage) {
        const source = fingerprint(request, parent);
        const handle = loaded.prototype.handle;
        observed.add(loaded);
        loaded.prototype.handle = function (...args) {
            record(loopStage, source, this.context.originalBody.messages);
            return handle.apply(this, args);
        };
        return loaded;
    }
    const probe = {
        './messageProcessor.js': ['applyDetectorsToMessages', 'detectors', true],
        './roleDivider.js': ['process', 'role-divider', true],
        './finalContextStore.js': ['setLastFinalContext', 'final-context', false],
    }[request];
    if (!probe) return loaded;
    const [method, stage, observeResult] = probe;
    const source = fingerprint(request, parent);
    const operation = loaded[method];
    observed.add(loaded);
    loaded[method] = function (...args) {
        const result = operation.apply(this, args);
        record(stage, source, observeResult ? result : args[0].messages);
        return result;
    };
    return loaded;
};

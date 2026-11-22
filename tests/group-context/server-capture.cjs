'use strict';

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { createHash } = require('node:crypto');

const file = process.env.NS_CONTEXT_HANDLER_LOG;
if (!file || process.env.NS_CONTEXT_INPUT !== 'GC_CURRENT') throw Error('Synthetic group capture configuration required');
const append = row => fs.appendFileSync(file, JSON.stringify(row) + '\n', { mode: 0o600 });
const original = Module._load;
const wrapped = new WeakSet();

Module._load = function (request, parent, isMain) {
    const loaded = original.call(this, request, parent, isMain);
    if (request === './modules/chatCompletionHandler.js' && path.basename(parent?.filename || '') === 'server.js' &&
        typeof loaded?.prototype?.handle === 'function' && !wrapped.has(loaded)) {
        wrapped.add(loaded);
        const handle = loaded.prototype.handle;
        const execution = original.call(this, './modules/requestExecutionContext', parent, false);
        loaded.prototype.handle = function (req, res, forceShowVCP) {
            const member = JSON.stringify(req.body?.messages?.[0]?.content || '').match(/GC_MEMBER_([AB])/)?.[1];
            if (member) append({ kind: 'handler', member, route: req.path, workId: execution.currentWork() ?? null,
                forceShowVCP: Boolean(forceShowVCP), body: req.body });
            return handle.call(this, req, res, forceShowVCP);
        };
    }
    if (parent?.filename?.endsWith('/mobile/nativeResponse.js')
        && request.endsWith('/streamDelta')) {
        const source = Module._resolveFilename(request, parent);
        const sha256 = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
        return { ...loaded, groupStreamDelta(frame) {
            const text = loaded.groupStreamDelta(frame);
            append({ kind: 'worker-stream', source: path.relative(process.cwd(), source), sha256, frame, text });
            return text;
        } };
    }
    if (!parent?.filename?.endsWith('/mobile/groupRequest.js')) return loaded;
    if (request.endsWith('/modelSelection')) {
        const source = Module._resolveFilename(request, parent);
        const sha256 = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
        return { ...loaded, resolveEffectiveModel(...args) {
            const result = loaded.resolveEffectiveModel(...args);
            append({ kind: 'worker-model', source: path.relative(process.cwd(), source), sha256, result });
            return result;
        } };
    }
    const method = request.endsWith('/groupContextWindow') ? 'applyGroupContextRules' :
        request.endsWith('/tavernRulesEngine') ? 'applyContextInject' : null;
    if (!method || typeof loaded?.[method] !== 'function') return loaded;
    const facade = Module._resolveFilename(request, parent);
    const source = Module.createRequire(facade).resolve(method === 'applyGroupContextRules'
        ? '@vcp/core-rules/group/groupContextWindow' : '@vcp/core-rules/tavern');
    const sha256 = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    const operation = loaded[method];
    return { ...loaded, [method](...args) {
        const result = operation(...args);
        append({ kind: 'worker-rules', method, source: path.relative(process.cwd(), source), sha256 });
        return result;
    } };
};

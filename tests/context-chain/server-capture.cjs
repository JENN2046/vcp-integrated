'use strict';
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { createHash } = require('node:crypto');

const file = process.env.NS_CONTEXT_HANDLER_LOG;
const input = process.env.NS_CONTEXT_INPUT;
if (!file || !input) throw Error('Context fixture capture requires its isolated log and synthetic input marker');

const original = Module._load;
const packetMethods = ['buildVcpChatExtensionsFromMessages', 'stripInternalMessageMetadata'];

function observePacket(loaded, resolved) {
    const sha256 = createHash('sha256').update(fs.readFileSync(resolved)).digest('hex');
    const view = { ...loaded };
    for (const method of packetMethods) {
        view[method] = (...args) => {
            fs.appendFileSync(file, JSON.stringify({
                kind:'request-envelope', method, module:path.relative(process.cwd(),resolved), sha256,
            }) + '\n', {mode:0o600});
            return loaded[method](...args);
        };
    }
    return view;
}
const observed = new WeakSet();
const selectors = new WeakSet();
const tavern = new WeakMap();
function observeTavern(loaded, method, resolved) {
    if (tavern.has(loaded)) return tavern.get(loaded);
    const operation = loaded[method];
    const sha256 = createHash('sha256').update(fs.readFileSync(resolved)).digest('hex');
    const layout = messages => messages.map(row => [row.role, row.__tavernInjected === true]);
    const view = { ...loaded, [method](messages, ...args) {
        const result = operation(messages, ...args);
        fs.appendFileSync(file, JSON.stringify({
            kind:'tavern-context', method, module:path.relative(process.cwd(),resolved), sha256,
            before:layout(messages), after:layout(result),
        }) + '\n', {mode:0o600});
        return result;
    } };
    tavern.set(loaded, view);
    return view;
}
Module._load = function (request, parent, isMain) {
    const loaded = original.call(this, request, parent, isMain);
    if (parent?.filename?.endsWith('/mobile/nativePacket.js') && packetMethods.every(method => typeof loaded?.[method] === 'function')) {
        const facade = Module._resolveFilename(request, parent);
        const fromFacade = Module.createRequire(facade);
        const entry = '@vcp/core-rules/request-envelope';
        let implementation = facade;
        try {
            const resolved = fromFacade.resolve(entry);
            if (require.cache[resolved]?.exports === loaded) implementation = resolved;
        } catch (error) {
            if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
        }
        return observePacket(loaded, implementation);
    }
    if (parent?.filename?.endsWith('/mobile/effectiveContext.js') &&
        request === '../nativeRules/modules/chat/requestMetadata') {
        const facade = Module._resolveFilename(request, parent);
        let source = facade;
        try {
            source = Module.createRequire(facade).resolve('@vcp/native-history-window/request-metadata');
        } catch (error) {
            if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
        }
        if (require.cache[source]?.exports.attachTimestampMetadata !== loaded.attachTimestampMetadata) source = facade;
        const sha256 = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
        return { ...loaded, attachTimestampMetadata(message, history) {
            const result = loaded.attachTimestampMetadata(message, history);
            fs.appendFileSync(file, JSON.stringify({
                kind:'request-metadata', module:path.relative(process.cwd(),source), sha256,
                metadata:result.__vcpchatTimestampMeta,
            }) + '\n', {mode:0o600});
            return result;
        } };
    }
    if (parent?.filename?.endsWith('/mobile/effectiveContext.js') && typeof loaded?.effectiveContextHistory === 'function' && !selectors.has(loaded)) {
        selectors.add(loaded);
        const select = loaded.effectiveContextHistory;
        const resolved = Module._resolveFilename(request, parent);
        const sha256 = createHash('sha256').update(fs.readFileSync(resolved)).digest('hex');
        // Some generated rule facades use getters. Return a fixture-only view
        // to this one caller and preserve the original implementation/function.
        return { ...loaded, effectiveContextHistory(history) {
            const selected = select(history);
            fs.appendFileSync(file, JSON.stringify({ kind:'checkpoint-selection', module:path.relative(process.cwd(),resolved),
                sha256,
                beforeIds:history.map(row=>row.id), afterIds:selected.map(row=>row.id) }) + '\n', {mode:0o600});
            return selected;
        } };
    }
    if (parent?.filename?.endsWith('/mobile/effectiveContext.js')) {
        const method = request === '../nativeRules/modules/tavernRulesEngine' ? 'applyContextInject' : 'applyContextRules';
        if (typeof loaded?.[method] === 'function') {
            return observeTavern(loaded, method, Module._resolveFilename(request, parent));
        }
    }
    if (request !== './modules/chatCompletionHandler.js' || path.basename(parent?.filename || '') !== 'server.js' ||
        typeof loaded?.prototype?.handle !== 'function' || observed.has(loaded)) return loaded;
    observed.add(loaded);
    const handle = loaded.prototype.handle;
    const execution = original.call(this, './modules/requestExecutionContext', parent, false);
    loaded.prototype.handle = function (req, res, forceShowVCP) {
        const rows=req.body?.messages;
        const current=Array.isArray(rows)?rows.findLast(row=>row.role==='user')?.content:null;
        const text=typeof current==='string'?current:Array.isArray(current)?current.map(part=>part?.text||'').join(''):null;
        if (text?.startsWith(input)) {
            const { messages, model, requestId, stream, temperature, max_tokens, tools, tool_choice, vcpchatExtensions } = req.body;
            fs.appendFileSync(file, JSON.stringify({
                kind:'handler-input', route: req.path, workId: execution.currentWork() ?? null, messages,
                model, requestId, stream, temperature, max_tokens, tools, tool_choice,
                requestContext: vcpchatExtensions?.requestContext,
                timestampBindingCount: vcpchatExtensions?.messageTimestampBindings?.length ?? 0,
                forceShowVCP: Boolean(forceShowVCP),
                body: req.body,
            }) + '\n', { mode: 0o600 });
        }
        return handle.call(this, req, res, forceShowVCP);
    };
    return loaded;
};

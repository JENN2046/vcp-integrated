'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('acorn');

const source = fs.readFileSync(path.join(__dirname, '../../modules/chatManager.js'), 'utf8');
const root = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const factory = root.body.flatMap(node => node.declaration?.declarations || [])
    .find(node => node.id.name === 'chatManager');
const send = factory?.init.callee.body.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'handleSendMessage');
const flow = send?.body.body.find(node => node.type === 'TryStatement' && node.finalizer);

function compileNativeSend(stopBefore, scope) {
    assert(flow, 'handleSendMessage must own a finalizer for the send lifecycle');
    const boundary = flow.block.body.find(node => node.type === 'VariableDeclaration' &&
        node.declarations.some(({ id }) => id.name === stopBefore));
    assert(boundary, 'Missing send boundary ' + stopBefore);
    const keys = Object.keys(scope);
    // Keep the original function entry, branches, and finalizer. Stop only
    // before unrelated model work or attachment execution, per test scope.
    const body = source.slice(send.start, boundary.start) +
        'return modelStage();\n} finally ' + source.slice(flow.finalizer.start, flow.finalizer.end) + '\n}';
    return new Function(...keys, 'modelStage', `
        let itemSelectionGeneration = 0;
        let topicSelectionGeneration = 0;
        generations.changeTopic = () => topicSelectionGeneration++;
        ${body}
        return handleSendMessage;
    `)(...Object.values(scope), () => 'continue');
}

async function runNativeSend(result, options = {}) {
    const content = options.content || '把合成排期延后1分钟';
    const listeners = new Set();
    const input = { value: content,
        addEventListener: (_event, callback) => listeners.add(callback),
        removeEventListener: (_event, callback) => listeners.delete(callback),
    };
    const history = [...(options.history || [])];
    const toasts = [];
    let selected = 'T', attachments = [], current = [], executes = 0;
    const generations = {};
    const controls = {
        edit(value) { input.value = value; for (const listener of listeners) listener(); },
        switchTopic() { selected = 'other'; generations.changeTopic(); },
        returnTopic() { selected = 'T'; generations.changeTopic(); },
        attach() { attachments = [{ synthetic: true }]; },
    };
    const scope = {
        elements: { messageInput: input }, mainDrafts: null, window: {},
        currentSelectedItemRef: { get: () => ({ id: 'A', type: 'agent', name: 'fixture' }) },
        currentTopicIdRef: { get: () => selected },
        currentChatHistoryRef: { get: () => current, set: value => { current = value; } },
        globalSettingsRef: { get: () => ({ vcpServerUrl: 'http://unused.invalid', ...options.settings }) },
        attachedFilesRef: { get: () => attachments, set: value => { attachments = value; } },
        uiHelper: { showToastNotification: message => toasts.push(message), autoResizeTextarea() {} },
        // These tests observe persistence and drafts independently of paint.
        messageRenderer: { renderMessage: async () => null },
        electronAPI: {
            async prepareNativeConversation() {
                const pending = typeof result === 'function' ? result() : result;
                await options.preparing?.(controls);
                return pending;
            },
            async setTopicUnread() { await options.unread?.(controls); return { success: true }; },
            async executeNativeConversation(payload) {
                executes++;
                assert(options.execute, 'unexpected native execute');
                return options.execute(payload, controls);
            },
        },
        notifySendStateChanged() {}, setNextUiEmptyStateActive() {},
        executionAuthority: async () => ({ kind: 'local' }),
        isContextCompacting: () => false,
        pendingSendContexts: new Set(), pendingSendControls: new Map(), pendingUserProjections: new Map(),
        generations,
        itemListManager: null, restoredLocalInput: null, mainRendererFunctions: {}, isCanvasWindowOpen: false,
        async persistOutgoingUserMessage(context, message) {
            if (message.role === 'user') await options.beforeSave?.(controls);
            history.push({ ...message, topic: context.topicId });
            if (message.role === 'user') await options.afterSave?.(controls);
            return history;
        },
        shouldCompactContext: options.shouldCompactContext,
        summarizeCompactionInput: () => ({ sourceCount: 2, anchors: 0, openWindows: 0 }),
        compactContext: options.compactContext,
    };
    const run = compileNativeSend(options.stopBefore || 'thinkingMessageId', scope);
    const returned = await run();
    assert.equal(scope.pendingSendContexts.size, 0);
    assert.equal(scope.pendingSendControls.size, 0);
    assert.equal(scope.pendingUserProjections.size, 0);
    return { returned, input: input.value, history: history.map(({ role, content, topic }) => ({ role, content, topic })),
        toasts, executes, attachments, listeners: listeners.size };
}

module.exports = { runNativeSend };

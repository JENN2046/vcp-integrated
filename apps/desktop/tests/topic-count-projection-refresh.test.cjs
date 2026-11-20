'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '../modules/topicListManager.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '../renderer.js'), 'utf8');
const listenerStart = renderer.indexOf('subscribe: chatAPI.onHistoryFileUpdated,');
const listenerBody = renderer.slice(listenerStart).match(/consume: (async \(event, lifecycle\) => \{[\s\S]*?\n        \}),/)[1];
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function mount(read) {
    const dom = new JSDOM('<section id="tabContentTopics"><ul id="topicList"></ul></section>', { runScripts: 'outside-only' });
    const { window } = dom;
    window.requestAnimationFrame = callback => callback();
    window.IntersectionObserver = class {
        constructor(callback) { this.callback = callback; }
        observe(li) { queueMicrotask(() => this.callback([{ target: li, isIntersecting: true }])); }
        unobserve() {} disconnect() {}
    };
    window.eval(source);
    window.chatManager = { onSharedProjectionSettled() {} };
    window.nativeHistoryRefresh = { consume() {} };
    // Exercise the real renderer notification consumer, not a test-only path.
    const consume = window.eval('(' + listenerBody + ')');
    let selectedTopic = 't1';
    window.topicListManager.init({
        elements: { topicListContainer: window.document.getElementById('tabContentTopics') },
        electronAPI: { getAgentConfig: async () => ({ topics: [{ id: 't1', name: 'one' }, { id: 't2', name: 'two' }] }) },
        chatRepository: { getHistory: read },
        refs: { currentSelectedItemRef: { get: () => ({ id: 'synthetic', type: 'agent', name: 'synthetic' }) }, currentTopicIdRef: { get: () => selectedTopic } },
        uiHelper: {}, mainRendererFunctions: { updateCurrentItemConfig() {} }, topicSelectionReadiness: { isReady: () => true, defer() {} },
    });
    await window.topicListManager.loadTopicList();
    await turn();
    return { window, badge: id => window.document.querySelector(`[data-topic-id="${id}"] .message-count`)?.textContent,
        notify: (extra = {}) => consume({ ownerId: 'synthetic', ownerType: 'agent', topicId: 't1', ...extra }, { isActive: () => true }),
        select: id => { selectedTopic = id; }, close() { window.topicListManager.dispose(); dom.window.close(); } };
}
const messages = n => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: String(i) }));

test('applied A/B projections refresh the existing badge; duplicate/edit/delete use the durable total', async () => {
    let history = [];
    const x = await mount(async () => history);
    try {
        assert.equal(x.badge('t1'), '0');
        for (const count of [1, 2, 3, 4]) { history = messages(count); x.notify(); await turn(); assert.equal(x.badge('t1'), String(count)); }
        x.notify(); x.notify(); await turn(); assert.equal(x.badge('t1'), '4');
        history[0].content = 'edited'; x.notify(); await turn(); assert.equal(x.badge('t1'), '4');
        history = history.slice(1); x.notify(); await turn(); assert.equal(x.badge('t1'), '3');
        // This is the native total, including system/thinking entries if stored;
        // unread assistant-only rules do not redefine the displayed total.
        history.push({ role: 'system' }, { role: 'assistant', isThinking: true });
        x.notify(); await turn(); assert.equal(x.badge('t1'), '5');
    } finally { x.close(); }
});
test('background topic, legacy event, selection return and a newly opened list re-read History', async () => {
    let history = messages(2);
    const x = await mount(async () => history);
    try {
        x.select('t2'); history = messages(4); x.notify(); await turn(); assert.equal(x.badge('t1'), '4');
        x.select('t1'); history = messages(3); x.notify({ ownerId: undefined, ownerType: undefined, agentId: 'synthetic' });
        await turn(); assert.equal(x.badge('t1'), '3');
        await x.window.topicListManager.loadTopicList(); await turn(); assert.equal(x.badge('t1'), '3');
    } finally { x.close(); }
    const reopened = await mount(async () => history);
    try { assert.equal(reopened.badge('t1'), '3'); } finally { reopened.close(); }
});
test('new projection invalidates an in-flight stale read and coalesces to one fresh read', async () => {
    const hold = deferred(); let reads = 0, history = messages(4);
    const x = await mount(async (_id, _type, topic) => topic === 't1' && ++reads === 1 ? hold.promise : history);
    try {
        x.notify(); x.notify(); assert.equal(reads, 1);
        hold.resolve(messages(0)); await turn(); await turn();
        assert.equal(x.badge('t1'), '4'); assert.equal(reads, 2);
    } finally { x.close(); }
});
test('other owner/type/topic events do not read or repaint this list', async () => {
    let reads = 0;
    const x = await mount(async () => { reads++; return []; });
    try {
        const before = reads;
        for (const extra of [{ ownerId: 'other' }, { ownerType: 'group' }, { topicId: 'other' }]) x.notify(extra);
        await turn(); assert.equal(reads, before); assert.equal(x.badge('t1'), '0');
    } finally { x.close(); }
});
test('failed reads remain retryable on the next event; disposed rows never repaint or retry', async () => {
    let fail = false, hold = null;
    const x = await mount(async () => { if (hold) return hold.promise; if (fail) throw Error('synthetic read failure'); return messages(4); });
    try {
        fail = true; x.notify(); await turn(); assert.equal(x.badge('t1'), 'ERR');
        fail = false; x.notify(); await turn(); assert.equal(x.badge('t1'), '4');
        const row = x.window.document.querySelector('[data-topic-id="t1"]');
        hold = deferred(); x.notify(); await turn(); x.window.topicListManager.dispose();
        hold.resolve([]); await turn(); assert.equal(row.querySelector('.message-count').textContent, '4');
    } finally { x.close(); }
});
test('temporary scope admission does not leave the rendered count at N/A', async () => {
    let reads=0;
    const x=await mount(async (_id,_type,topic)=>topic==='t1'&&++reads<3?{error:'HISTORY_AUTHORITY_PENDING'}:messages(4));
    try { await new Promise(r=>setTimeout(r,420));assert.equal(x.badge('t1'),'4');assert.equal(reads,3); } finally{x.close();}
});
test('persistent admission refusal has bounded retries and never becomes an empty count', async () => {
    let reads=0;
    const x=await mount(async(_id,_type,topic)=>topic==='t1'?(reads++,{error:'HISTORY_SCOPE_TRANSITION_PENDING'}):[]);
    try{await new Promise(r=>setTimeout(r,1000));assert.equal(reads,4);assert.equal(x.badge('t1'),'N/A');}finally{x.close();}
});

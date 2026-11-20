const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync('modules/topicListManager.js', 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

async function fixture({ count = 10000, history, config, ownerType = 'agent' } = {}) {
    const dom = new JSDOM(`<!doctype html><body>
        <aside class="sidebar active vcp-ui-scope">
            <section id="tabContentTopics" class="sidebar-tab-content active">
                <div class="topics-header-container">
                    <button id="nextUiCreateTopicBtn"></button><button id="nextUiManageTopicsBtn"></button>
                    <button id="nextUiTopicSearchTrigger"></button><button id="nextUiTopicSearchClose"></button>
                    <input id="topicSearchInput">
                </div>
                <div class="sidebar-list-scroll"><ul id="topicList" class="topic-list"></ul></div>
                <div class="next-ui-topic-manage-panel"></div>
                <span id="nextUiTopicSelectionCount"></span>
                <button id="nextUiSelectAllTopicsBtn"><span class="vcp-ui-icon"></span></button>
                <button id="nextUiDeleteTopicsBtn"></button><button id="nextUiExitTopicManageBtn"></button>
            </section>
        </aside></body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    const doc = window.document;
    const panel = doc.getElementById('tabContentTopics');
    const scroller = doc.querySelector('.sidebar-list-scroll');
    Object.defineProperty(scroller, 'clientHeight', { value: 380 });
    const frames = new Map();
    let frameId = 0;
    window.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
    window.cancelAnimationFrame = id => frames.delete(id);
    let observer;
    window.IntersectionObserver = class {
        constructor(callback) { this.callback = callback; this.rows = new Set(); observer = this; }
        observe(row) { this.rows.add(row); }
        unobserve(row) { this.rows.delete(row); }
        disconnect() { this.rows.clear(); }
        fire() { this.callback([...this.rows].map(target => ({ target, isIntersecting: true }))); }
    };
    const sorts = [];
    window.Sortable = class {
        constructor(element, options) { this.options = options; sorts.push(this); }
        destroy() {}
    };
    window.eval(source);
    let configCalls = 0;
    let historyCalls = 0;
    let savedOrder;
    let selected = { id: 'agent-a', type: ownerType, name: 'Alice', config: { __nativeSyncSharedBase: { sharedId: 'shared-owner' } } };
    let directoryCallback;
    let unsubscribes = 0;
    const topics = Array.from({ length: count }, (_, i) => ({ id: `t${i}`, name: `Topic ${i}` }));
    const initConfig = {
        elements: { topicListContainer: panel },
        electronAPI: {
            onSharedDirectoryChanged: callback => { directoryCallback = callback; return () => { unsubscribes++; }; },
            getAgentGroupConfig: async () => {
                configCalls++;
                return config ? config(selected) : { id: selected.id, topics };
            },
            getAgentConfig: async () => {
                configCalls++;
                return config ? config(selected) : { id: selected.id, topics };
            },
            saveTopicOrder: async (id, ids) => { savedOrder = [...ids]; return { success: true }; },
            searchTopicsByContent: async () => ({ success: true, matchedTopicIds: [] })
        },
        chatRepository: { getHistory: (...args) => { historyCalls++; return history ? history(...args) : Promise.resolve([]); } },
        refs: {
            currentSelectedItemRef: { get: () => selected },
            currentTopicIdRef: { get: () => 't0' }
        },
        uiHelper: { showToastNotification() {} },
        mainRendererFunctions: { updateCurrentItemConfig() {}, selectTopic() {} },
        topicSelectionReadiness: { isReady: () => true, defer() {} }
    };
    window.topicListManager.init(initConfig);
    async function flush() {
        await settle();
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach(callback => callback());
        await settle();
    }
    const rows = () => [...doc.querySelectorAll('.topic-item')];
    const scroll = async top => {
        scroller.scrollTop = top;
        scroller.dispatchEvent(new window.Event('scroll'));
        await flush();
    };
    const hide = () => {
        panel.classList.remove('active');
        window.topicListManager.syncSurfaceVisibility();
    };
    const show = () => {
        panel.classList.add('active');
        window.topicListManager.syncSurfaceVisibility();
    };
    const close = () => { window.topicListManager.dispose(); dom.window.close(); };
    await window.topicListManager.loadTopicList();
    await flush();
    return {
        window, doc, panel, scroller, rows, scroll, hide, show, flush, close, sorts,
        counts: () => ({ config: configCalls, history: historyCalls }),
        notify: change => directoryCallback(change),
        notice: (extra = {}) => ({ kind: 'topic', id: 'new', topicId: 'new', ownerId: selected.id,
            ownerType: selected.type, sharedId: 'shared-new', ownerSharedId: 'shared-owner', ...extra }),
        topics, unsubscribes: () => unsubscribes, callback: () => directoryCallback, reinit: () => window.topicListManager.init(initConfig),
        fireCounts: () => observer.fire(),
        order: () => savedOrder,
        select: value => { selected = value; }
    };
}

test('10000 topics keep a bounded mounted window and keyboard reaches offscreen endpoints', async () => {
    const f = await fixture();
    try {
        assert.equal(f.rows().length, 26);
        const first = f.rows()[0];
        await f.scroll(38000);
        assert.equal(f.rows().length, 26);
        assert.equal(first.isConnected, false, 'old rows are recycled, not appended forever');
        assert.equal(f.rows()[0].dataset.topicIndex, '992');
        const key = name => f.doc.activeElement.dispatchEvent(new f.window.KeyboardEvent('keydown', {
            key: name, bubbles: true, cancelable: true
        }));
        f.rows()[5].focus();
        key('End');
        assert.equal(f.doc.activeElement.dataset.topicId, 't9999');
        assert.equal(f.doc.activeElement.getAttribute('aria-setsize'), '10000');
        key('Home');
        assert.equal(f.doc.activeElement.dataset.topicId, 't0');
        assert.ok(f.rows().length <= 26);
        assert.equal(f.doc.querySelectorAll('.topic-item[tabindex="0"]').length, 1);
    } finally { f.close(); }
});

test('hidden surfaces release rows, restore scroll without reloading, and defer dirty reloads', async () => {
    const f = await fixture();
    try {
        await f.scroll(38000);
        f.hide();
        assert.equal(f.rows().length, 0);
        f.show();
        await f.flush();
        assert.equal(f.counts().config, 1, 'unchanged surface restores the data snapshot');
        assert.equal(f.scroller.scrollTop, 38000);
        assert.equal(f.rows()[0].dataset.topicIndex, '992');
        f.hide();
        await f.window.topicListManager.loadTopicList();
        assert.equal(f.counts().config, 1, 'hidden refreshes do not read or construct rows');
        f.show();
        await f.flush();
        assert.equal(f.counts().config, 2, 'dirty data refreshes once on return');
        assert.ok(f.rows().length <= 26);
        f.doc.querySelector('.sidebar').classList.remove('active');
        await f.flush();
        assert.equal(f.rows().length, 0, 'whole-sidebar hiding uses the same lifecycle');
    } finally { f.close(); }
});

test('count reads are bounded and hiding cancels queued work and late DOM publications', async () => {
    const pending = [];
    const f = await fixture({ history: () => new Promise(resolve => pending.push(resolve)) });
    try {
        f.fireCounts();
        await settle();
        assert.equal(pending.length, 4);
        const oldRows = f.rows();
        f.hide();
        for (const resolve of pending) resolve([{ role: 'assistant' }]);
        await settle();
        await settle();
        assert.equal(f.counts().history, 4, 'hidden queued jobs never start');
        assert.equal(f.rows().length, 0);
        assert.ok(oldRows.every(row => row.querySelector('.message-count').textContent === '...'));
    } finally { f.close(); }
});

test('selection belongs to the full filtered model and survives row recycling', async () => {
    const f = await fixture();
    try {
        f.doc.getElementById('nextUiManageTopicsBtn').click();
        f.doc.getElementById('nextUiSelectAllTopicsBtn').click();
        assert.match(f.doc.getElementById('nextUiTopicSelectionCount').textContent, /10000/);
        await f.scroll(38000);
        assert.ok(f.rows().every(row => row.classList.contains('selected')));
        assert.ok(f.rows().every(row => row.querySelector('.next-ui-topic-select-icon').textContent === 'check_box'));
        f.rows()[0].click();
        assert.match(f.doc.getElementById('nextUiTopicSelectionCount').textContent, /9999/);
        f.hide();
        f.show();
        await f.flush();
        assert.equal(f.rows()[0].classList.contains('selected'), false);
    } finally { f.close(); }
});

test('dragging a virtual window saves every topic exactly once in complete model order', async () => {
    const f = await fixture({ count: 1000 });
    try {
        await f.scroll(3800);
        const rows = f.rows();
        const moved = rows[2];
        const firstIndex = Number(rows[0].dataset.topicIndex);
        const sort = f.sorts.at(-1);
        assert.equal(sort.options.draggable, '.topic-item');
        await sort.options.onStart({ item: moved });
        rows[0].before(moved);
        await sort.options.onEnd({ item: moved, to: moved.parentElement });
        await f.flush();
        assert.equal(f.order().length, 1000);
        assert.equal(new Set(f.order()).size, 1000);
        assert.equal(f.order()[firstIndex], moved.dataset.topicId);
        assert.ok(f.order().every(id => id), 'spacers never enter persisted ordering');
        assert.equal(f.rows()[0].dataset.topicId, moved.dataset.topicId);
    } finally { f.close(); }
});

test('hiding before a pending render frame prevents remounting', async () => {
    const f = await fixture();
    try {
        f.scroller.scrollTop = 38000;
        f.scroller.dispatchEvent(new f.window.Event('scroll'));
        f.hide();
        await f.flush();
        assert.equal(f.rows().length, 0);
    } finally { f.close(); }
});

test('revisiting recycled rows reuses bounded count summaries rather than rereading histories', async () => {
    const f = await fixture();
    const drain = async () => { for (let i = 0; i < 40; i++) await settle(); };
    try {
        f.fireCounts();
        await drain();
        assert.equal(f.counts().history, 26);
        await f.scroll(38000);
        f.fireCounts();
        await drain();
        assert.equal(f.counts().history, 52);
        await f.scroll(0);
        f.fireCounts();
        await drain();
        assert.equal(f.counts().history, 52, 'recycled rows consume summaries without another full history read');
        assert.ok(f.rows().every(row => row.querySelector('.message-count').textContent === '0'));
    } finally { f.close(); }
});

test('a hidden old config request cannot publish over a newly selected assistant', async () => {
    let reads = 0;
    let resolveOld;
    const late = new Promise(resolve => { resolveOld = resolve; });
    const f = await fixture({
        config: () => {
            reads++;
            if (reads === 2) return late;
            return { id: reads === 1 ? 'agent-a' : 'agent-b', topics: [{ id: reads === 1 ? 't0' : 'b0', name: 'Current' }] };
        }
    });
    try {
        const oldLoad = f.window.topicListManager.loadTopicList();
        f.hide();
        f.select({ id: 'agent-b', type: 'agent', name: 'Bob' });
        f.show();
        await f.flush();
        resolveOld({ id: 'agent-a', topics: [{ id: 'stale', name: 'Stale' }] });
        await oldLoad;
        await f.flush();
        assert.deepEqual(f.rows().map(row => row.dataset.topicId), ['b0']);
        assert.equal(f.rows()[0].dataset.itemId, 'agent-b');
    } finally { resolveOld({ topics: [] }); f.close(); }
});

test('unread prioritization uses bounded workers and stops dispatching when hidden', async () => {
    const pending = [];
    const f = await fixture({ history: () => new Promise(resolve => pending.push(resolve)) });
    try {
        f.doc.getElementById('topicSearchInput').value = '未读话题';
        const load = f.window.topicListManager.loadTopicList();
        await settle();
        assert.equal(pending.length, 4);
        f.hide();
        pending.forEach(resolve => resolve([{ role: 'assistant' }]));
        await load;
        await f.flush();
        assert.equal(f.counts().history, 4);
        assert.equal(f.rows().length, 0);
    } finally { f.close(); }
});

for (const ownerType of ['agent', 'group']) test(`${ownerType} shared directory invalidations reread native config, coalesce, defer when hidden and survive compact drawer`, async () => {
    const f = await fixture({ count: 2, ownerType });
    try {
        for (const bad of [{ ownerId: 'other' }, { ownerType: 'invalid' }, { topicId: '../x' }, { sharedId: '' }, { ownerSharedId: 'foreign' }]) {
            await f.notify(f.notice(bad));
        }
        assert.equal(f.counts().config, 1);
        f.topics.unshift({ id: 'new', name: 'From native config' });
        const change = f.notice({ name: 'untrusted title', count: 999 });
        await Promise.all([f.notify(change), f.notify(change), f.notify(change)]);
        await f.flush();
        assert.equal(f.counts().config, 2);
        assert.equal(f.rows()[0].dataset.topicId, 'new');
        assert.match(f.rows()[0].textContent, /From native config/);
        assert.doesNotMatch(f.rows()[0].textContent, /untrusted/);
        f.hide();
        f.topics.splice(0, 1);
        await f.notify(f.notice({ deleted: true }));
        assert.equal(f.counts().config, 2);
        f.show(); await f.flush();
        assert.equal(f.counts().config, 3);
        assert.ok(f.rows().every(row => row.dataset.topicId !== 'new'));
        f.hide();
        f.doc.querySelector('.sidebar').classList.add('avatar-only');
        f.panel.classList.add('compact-drawer-open');
        f.window.topicListManager.syncSurfaceVisibility(); await f.flush();
        f.topics.push({ id: 'drawer', name: 'Drawer' });
        await f.notify(f.notice({ id: 'drawer', topicId: 'drawer' })); await f.flush();
        assert.ok(f.rows().some(row => row.dataset.topicId === 'drawer'));
        const before = f.counts().config;
        f.window.topicListManager.dispose();
        await f.notify(change); await f.flush();
        assert.equal(f.counts().config, before);
        assert.equal(f.unsubscribes(), 1);
    } finally { f.close(); }
});

test('background History invalidation evicts exactly its cached topic, even offscreen and hidden', async () => {
    let size = 1;
    const f = await fixture({ history: async () => Array.from({ length: size }, () => ({ role: 'user' })) });
    const drain = async () => { for (let i = 0; i < 40; i++) await settle(); };
    try {
        f.fireCounts(); await drain();
        const reads = f.counts().history;
        await f.scroll(38000);
        size = 7;
        f.window.topicListManager.refreshTopicMessageCount({ ownerType: 'agent', ownerId: 'agent-a', topicId: 't1', count: 999 });
        await f.scroll(0); f.fireCounts(); await drain();
        assert.equal(f.counts().history, reads + 1, 'other cached summaries survive precise invalidation');
        assert.equal(f.rows().find(row => row.dataset.topicId === 't1').querySelector('.message-count').textContent, '7');
        f.hide(); size = 9;
        f.window.topicListManager.refreshTopicMessageCount({ agentId: 'agent-a', topicId: 't1' });
        f.show(); await f.flush(); f.fireCounts(); await drain();
        assert.equal(f.rows().find(row => row.dataset.topicId === 't1').querySelector('.message-count').textContent, '9');
    } finally { f.close(); }
});

test('invalidation during a count read discards the old result and rereads once', async () => {
    const pending = [];
    const f = await fixture({ count: 1, history: () => new Promise(resolve => pending.push(resolve)) });
    try {
        f.fireCounts(); await settle();
        const event = { ownerType: 'agent', ownerId: 'agent-a', topicId: 't0' };
        f.window.topicListManager.refreshTopicMessageCount(event);
        f.window.topicListManager.refreshTopicMessageCount(event);
        pending.shift()([{ role: 'user' }]); await settle(); await settle();
        assert.equal(f.rows()[0].querySelector('.message-count').textContent, '...');
        assert.equal(pending.length, 1);
        pending.shift()([{ role: 'user' }, { role: 'user' }]); await settle(); await settle();
        assert.equal(f.rows()[0].querySelector('.message-count').textContent, '2');
        assert.equal(f.counts().history, 2);
    } finally { pending.forEach(resolve => resolve([])); f.close(); }
});

test('old owner count completions cannot change the new owner or seed its summary cache', async () => {
    const pending = [];
    const f = await fixture({ count: 1, history: id => id === 'agent-a' ? new Promise(resolve => pending.push(resolve)) : Promise.resolve([]) });
    try {
        f.fireCounts(); await settle();
        f.select({ id: 'agent-b', type: 'agent' });
        await f.window.topicListManager.loadTopicList(); await f.flush();
        pending.shift()([{ role: 'assistant' }]); await settle();
        f.fireCounts(); await settle(); await settle();
        assert.equal(f.rows()[0].dataset.itemId, 'agent-b');
        assert.equal(f.rows()[0].querySelector('.message-count').textContent, '0');
    } finally { pending.forEach(resolve => resolve([])); f.close(); }
});

test('pending native count reads recover within the upstream concurrency queue', async () => {
    let calls = 0;
    const f = await fixture({ count: 1, history: async () => ++calls === 1 ? { error: 'HISTORY_SCOPE_TRANSITION_PENDING' } : [{ role: 'user' }] });
    try {
        f.fireCounts();
        await new Promise(resolve => setTimeout(resolve, 150)); await settle();
        assert.equal(f.rows()[0].querySelector('.message-count').textContent, '1');
        assert.equal(calls, 2);
    } finally { f.close(); }
});

test('10000-topic search returns the full model match beyond the original virtual window', async () => {
    const f = await fixture();
    try {
        f.doc.getElementById('topicSearchInput').value = 'topic 9999';
        await f.window.topicListManager.loadTopicList(); await f.flush();
        assert.deepEqual(f.rows().map(row => row.dataset.topicId), ['t9999']);
        assert.equal(f.scroller.scrollTop, 0);
        assert.equal(f.rows()[0].getAttribute('aria-setsize'), '1');
    } finally { f.close(); }
});


test('a queued callback from a disposed subscription cannot refresh a new lifecycle epoch', async () => {
    const f = await fixture({ count: 1 });
    try {
        const callback = f.callback(), change = f.notice();
        f.window.topicListManager.dispose(); f.reinit();
        await f.window.topicListManager.loadTopicList(); await f.flush();
        const reads = f.counts().config;
        await callback(change); await f.flush();
        assert.equal(f.counts().config, reads);
        await f.notify(change); await f.flush();
        assert.equal(f.counts().config, reads + 1);
    } finally { f.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { createModelPickerPopup, modelCheckStore } from '../modules/renderer/model-picker-popup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceCode = fs.readFileSync(path.resolve(__dirname, '../modules/renderer/composerModelSelect.js'), 'utf8');

const tick = () => new Promise(resolve => setTimeout(resolve, 15));

function setupTestEnv() {
    const dom = new JSDOM(`<!doctype html>
<html>
<head></head>
<body>
    <div class="chat-input-card">
        <div class="chat-input-actions">
            <button id="sendMessageBtn" type="button">Send</button>
        </div>
    </div>
    <div id="settingsPanel">
        <input id="editingAgentId" value="agent_1" />
        <input id="agentModel" value="" />
    </div>
</body>
</html>`, {
        url: 'https://vcp.local/',
        runScripts: 'outside-only'
    });

    const { window } = dom;
    const { document } = window;

    // 挂载通用组件 Portal 与 CheckStore 到 JSDOM window
    window.ModelPickerPopup = {
        createModelPickerPopup,
        modelCheckStore
    };

    globalThis.window = window;
    globalThis.document = document;
    globalThis.localStorage = window.localStorage;
    globalThis.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
    };

    // 执行脚本挂载 window.ComposerModelSelect
    dom.window.eval(sourceCode);
    return { dom, window, document };
}

test('ComposerModelSelect: 默认未配置勾选池时，自适应展示全部模型并提示右键自定义', async () => {
    const { window, document } = setupTestEnv();
    window.localStorage.clear();

    const mockModels = ['gpt-4o', 'gemini-2.5-flash', 'claude-3-5-sonnet'];
    const electronAPI = {
        getCachedModels: async () => mockModels,
        getFavoriteModels: async () => ['gpt-4o'],
        saveAgentConfig: async () => ({ success: true })
    };

    let currentAgent = {
        type: 'agent',
        id: 'agent_1',
        name: '助手',
        config: { model: 'gemini-2.5-flash' }
    };
    const selectedItemRef = {
        get: () => currentAgent,
        set: (item) => { currentAgent = item; }
    };

    const instance = window.ComposerModelSelect.init({
        electronAPI,
        selectedItemRef,
        sendMessageBtn: document.getElementById('sendMessageBtn')
    });

    const trigger = document.querySelector('.vcp-model-select-trigger');
    const label = document.querySelector('.vcp-model-select-label');

    // 按钮显示当前选中的模型
    assert.equal(label.textContent, 'gemini-2.5-flash');

    // 左键点击打开候选菜单
    trigger.click();
    await tick();

    const menu = document.querySelector('.vcp-model-picker-popup[data-mode="select"]');
    assert.ok(menu, 'popup menu should be opened');

    // 规范 v2.0：checkedSet 为空时，自适应展示全部可用模型，绝不呈现冷启动白屏
    const options = document.querySelectorAll('.vcp-model-picker-item');
    assert.equal(options.length, 3, 'all models should be visible when pool is unconfigured');

    const hint = document.querySelector('.vcp-model-picker-hint');
    assert.ok(hint, 'hint should guide user to right-click');
    assert.match(hint.textContent, /右键按钮可自定义常用候选/);

    // 点击某项切换模型
    options[0].click();
    await tick();

    assert.equal(currentAgent.config.model, 'gpt-4o');
    assert.equal(label.textContent, 'gpt-4o');
    assert.equal(document.getElementById('agentModel').value, 'gpt-4o');
    assert.equal(document.querySelector('.vcp-model-picker-popup'), null, 'popup closes after selection');

    instance.dispose();
});

test('ComposerModelSelect: 右键弹出勾选菜单，勾选后持久化，左键仅展示勾选的模型', async () => {
    const { window, document } = setupTestEnv();
    window.localStorage.clear();

    const mockModels = ['gpt-4o', 'gemini-2.5-flash', 'claude-3-5-sonnet'];
    const electronAPI = {
        getCachedModels: async () => mockModels,
        getFavoriteModels: async () => ['gpt-4o'],
        saveAgentConfig: async () => ({ success: true })
    };

    let currentAgent = {
        type: 'agent',
        id: 'agent_1',
        name: '助手',
        config: { model: 'unlisted-model' }
    };
    const selectedItemRef = {
        get: () => currentAgent,
        set: (item) => { currentAgent = item; }
    };

    const instance = window.ComposerModelSelect.init({
        electronAPI,
        selectedItemRef,
        sendMessageBtn: document.getElementById('sendMessageBtn')
    });

    const trigger = document.querySelector('.vcp-model-select-trigger');
    const label = document.querySelector('.vcp-model-select-label');
    assert.equal(label.textContent, 'unlisted-model');

    // 右键点击触发器弹出勾选配置面板
    trigger.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await tick();

    const checkMenu = document.querySelector('.vcp-model-picker-popup[data-mode="check"]');
    assert.ok(checkMenu, 'check menu should open');

    const checkItems = checkMenu.querySelectorAll('.vcp-model-picker-check-item');
    assert.equal(checkItems.length, 3);
    checkItems.forEach(item => {
        assert.equal(item.getAttribute('aria-checked'), 'false');
    });

    // 勾选前两个模型 (gpt-4o, gemini-2.5-flash)
    checkItems[0].click();
    assert.equal(checkItems[0].getAttribute('aria-checked'), 'true');
    checkItems[1].click();
    assert.equal(checkItems[1].getAttribute('aria-checked'), 'true');

    // 验证持久化存储
    const saved = JSON.parse(window.localStorage.getItem('vcp-composer-checked-models'));
    assert.deepEqual(new Set(saved), new Set(['gpt-4o', 'gemini-2.5-flash']));

    // 关闭勾选菜单
    document.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
    assert.equal(document.querySelector('.vcp-model-picker-popup'), null);

    // 再次左键点击打开候选列表
    trigger.click();
    await tick();

    const selectMenu = document.querySelector('.vcp-model-picker-popup[data-mode="select"]');
    assert.ok(selectMenu);

    // 只有勾选的两个模型出现在候选中，未勾选的 claude-3-5-sonnet 被过滤
    const optionNames = Array.from(selectMenu.querySelectorAll('.vcp-model-picker-item .name')).map(el => el.textContent);
    assert.deepEqual(new Set(optionNames), new Set(['gpt-4o', 'gemini-2.5-flash']));
    assert.ok(!optionNames.includes('claude-3-5-sonnet'));

    instance.dispose();
});

test('ComposerModelSelect: 全选与清空操作正确更新持久化与候选状态', async () => {
    const { window, document } = setupTestEnv();
    window.localStorage.clear();

    const mockModels = ['model-a', 'model-b', 'model-c'];
    const electronAPI = {
        getCachedModels: async () => mockModels,
        getFavoriteModels: async () => [],
        saveAgentConfig: async () => ({ success: true })
    };

    let currentAgent = {
        type: 'agent',
        id: 'agent_1',
        config: { model: 'model-a' }
    };
    const selectedItemRef = {
        get: () => currentAgent,
        set: (item) => { currentAgent = item; }
    };

    const instance = window.ComposerModelSelect.init({
        electronAPI,
        selectedItemRef,
        sendMessageBtn: document.getElementById('sendMessageBtn')
    });

    const trigger = document.querySelector('.vcp-model-select-trigger');

    // 右键打开勾选菜单并全选
    trigger.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await tick();

    const selectAllBtn = document.querySelectorAll('.vcp-model-picker-action-btn')[0];
    assert.ok(selectAllBtn, 'selectAllBtn should exist');
    selectAllBtn.click();

    let saved = JSON.parse(window.localStorage.getItem('vcp-composer-checked-models'));
    assert.equal(saved.length, 3);

    // 点击清空
    const clearAllBtn = document.querySelectorAll('.vcp-model-picker-action-btn')[1];
    assert.ok(clearAllBtn, 'clearAllBtn should exist');
    clearAllBtn.click();

    saved = JSON.parse(window.localStorage.getItem('vcp-composer-checked-models'));
    assert.equal(saved.length, 0);

    instance.dispose();
});
function setupDelayedSwitch(t) {
    const { dom, window, document } = setupTestEnv();
    let select;
    window.ModelPickerPopup.createModelPickerPopup = options => {
        select = options.onSelect;
        return { close() {}, dispose() {} };
    };
    let current = { type: 'agent', id: 'agent_1', config: { model: 'model-a', temperature: 0.6 } };
    const calls = [];
    const notices = [];
    window.uiHelperFunctions = { showToastNotification: text => notices.push(text) };
    const instance = window.ComposerModelSelect.init({
        electronAPI: {
            saveAgentConfig: (id, config) => new Promise((resolve, reject) => {
                calls.push({ id, config, resolve, reject });
            })
        },
        selectedItemRef: { get: () => current, set: value => { current = value; } },
        sendMessageBtn: document.getElementById('sendMessageBtn')
    });
    t.after(() => { instance.dispose(); dom.window.close(); });
    return {
        select: model => select(model), calls, notices, instance, document,
        get current() { return current; },
        set current(value) { current = value; },
        flush: async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); }
    };
}

test('ComposerModelSelect: 保存未完成时保留最后选择并按Agent串行写入', async t => {
    const h = setupDelayedSwitch(t);
    h.select('model-b');
    h.select('model-c');
    assert.equal(h.calls.length, 1);
    h.calls[0].resolve({ success: true });
    await h.flush();
    assert.equal(h.calls.length, 2, 'second choice must not be dropped');
    assert.equal(h.calls[1].config.model, 'model-c');
    h.calls[1].resolve({ success: true });
    await h.flush();
    assert.equal(h.current.config.model, 'model-c');
    assert.equal(h.current.config.temperature, 0.6);
    assert.equal(h.document.querySelector('.vcp-model-select-label').textContent, 'model-c');
    assert.equal(h.document.getElementById('agentModel').value, 'model-c');
});

test('ComposerModelSelect: 保存期间选择原模型也必须执行', async t => {
    const h = setupDelayedSwitch(t);
    h.select('model-b');
    h.select('model-a');
    h.calls[0].resolve({ success: true });
    await h.flush();
    assert.equal(h.calls.length, 2, 'returning to original model is a new intent');
    assert.equal(h.calls[1].config.model, 'model-a');
    h.calls[1].resolve({ success: true });
    await h.flush();
    assert.equal(h.current.config.model, 'model-a');
});

test('ComposerModelSelect: 不同Agent独立保存且旧完成结果不得污染当前Agent', async t => {
    const h = setupDelayedSwitch(t);
    h.select('model-b');
    h.current = { type: 'agent', id: 'agent_2', config: { model: 'model-x' } };
    h.select('model-y');
    assert.equal(h.calls.length, 2, 'another Agent must not share a busy lock');
    h.calls[1].resolve({ success: true });
    await h.flush();
    h.calls[0].resolve({ success: true });
    await h.flush();
    assert.equal(h.current.id, 'agent_2');
    assert.equal(h.current.config.model, 'model-y');
    assert.equal(h.document.querySelector('.vcp-model-select-label').textContent, 'model-y');
});

test('ComposerModelSelect: 保存失败不提交失败模型且继续处理后续选择', async t => {
    const h = setupDelayedSwitch(t);
    h.select('model-b');
    h.select('model-c');
    h.calls[0].resolve({ error: 'disk unavailable' });
    await h.flush();
    assert.equal(h.current.config.model, 'model-a');
    assert.equal(h.notices.length, 1);
    assert.equal(h.calls.length, 2);
    h.calls[1].resolve({ success: true });
    await h.flush();
    assert.equal(h.current.config.model, 'model-c');
});

test('ComposerModelSelect: dispose之后保存完成不得回写选中项和设置表单', async t => {
    const h = setupDelayedSwitch(t);
    h.select('model-b');
    h.instance.dispose();
    h.calls[0].resolve({ success: true });
    await h.flush();
    assert.equal(h.current.config.model, 'model-a');
    assert.equal(h.document.getElementById('agentModel').value, '');
});
function setupCatalogRefresh(t, initial = []) {
    const { dom, document, window } = setupTestEnv();
    let cache = initial;
    let current = { type: 'agent', id: 'agent_1', config: { model: 'default-model' } };
    const requests = [];
    const instance = window.ComposerModelSelect.init({
        electronAPI: {
            getCachedModels: async () => cache,
            getFavoriteModels: async () => [],
            refreshModels: () => new Promise(resolve => requests.push(result => {
                if (result.success) cache = result.models;
                resolve(result);
            })),
            saveAgentConfig: async () => ({ success: true })
        },
        selectedItemRef: { get: () => current, set: value => { current = value; } }
    });
    t.after(() => { instance.dispose(); dom.window.close(); });
    return {
        trigger: document.querySelector('.vcp-model-select-trigger'),
        menu: () => document.querySelector('.vcp-model-picker-popup'),
        options: () => [...document.querySelectorAll('.vcp-model-picker-item')].map(node => node.dataset.model),
        requests, readModel: () => current.config.model
    };
}

test('ComposerModelSelect reloads a slow empty cache in the same open menu', async t => {
    const env = setupCatalogRefresh(t);
    env.trigger.click();
    const menu = env.menu();
    await new Promise(resolve => setTimeout(resolve, 1700));
    const at1700 = menu.textContent;
    env.requests[0]({ success: true, models: [{id:'slow-model'}] });
    await tick();
    assert.deepEqual(env.options(), ['slow-model'], 'the menu must show the slow response without reopening');
    assert.match(at1700, /加载中/);
    assert.equal(env.menu(), menu);
    menu.querySelector('[data-model="slow-model"]').click();
    await tick();
    assert.equal(env.readModel(), 'slow-model');
});

test('ComposerModelSelect keeps a warm list through failure, retries in place and shows a confirmed empty result', async t => {
    const env = setupCatalogRefresh(t, ['cached-model']);
    env.trigger.click();
    await tick();
    const menu = env.menu();
    assert.deepEqual(env.options(), ['cached-model']);
    assert.match(menu.textContent, /正在刷新/);
    env.requests[0]({ success: false, models: [{id:'cached-model'}] });
    await tick();
    assert.deepEqual(env.options(), ['cached-model']);
    assert.match(menu.textContent, /加载失败，可重试/);
    assert.doesNotMatch(menu.textContent, /没有可用的模型/);
    [...menu.querySelectorAll('button')].find(button => button.textContent === '重试').click();
    await tick();
    assert.equal(env.menu(), menu);
    assert.deepEqual(env.options(), ['cached-model']);
    env.requests[1]({ success: true, models: [] });
    await tick();
    assert.equal(env.menu(), menu);
    assert.deepEqual(env.options(), []);
    assert.match(menu.textContent, /没有可用的模型/);
    assert.equal(menu.querySelector('[role="status"]').parentElement.hidden, true);
});

test('ComposerModelSelect ignores an out-of-order reply after a fast close and reopen', async t => {
    const env = setupCatalogRefresh(t);
    env.trigger.click();
    await tick();
    const oldMenu = env.menu();
    env.trigger.click();
    assert.equal(env.menu(), null);
    env.trigger.click();
    await tick();
    const newMenu = env.menu();
    assert.notEqual(newMenu, oldMenu);
    env.requests[1]({ success: true, models: [{id:'new-result'}] });
    await tick();
    env.requests[0]({ success: true, models: [{id:'old-result'}] });
    await tick();
    assert.equal(env.menu(), newMenu);
    assert.deepEqual(env.options(), ['new-result']);
});

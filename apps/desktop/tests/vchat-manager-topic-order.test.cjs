'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

test('manager topic sorting stays in the view after the host deletes a topic', async t => {
    const source = path.resolve(__dirname, '../VchatManager');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-topic-order-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const configPath = path.join(root, 'AppData/AgentGroups/g/config.json');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.mkdir(path.join(root, 'AppData/Agents'));
    await fs.writeFile(path.join(root, 'AppData/settings.json'),
        JSON.stringify({ combinedItemOrder: [{ type: 'group', id: 'g' }] }));
    const config = { name: 'Group', topics: [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }] };
    await fs.writeFile(configPath, JSON.stringify(config));

    const handlers = new Map();
    const calls = [];
    const boot = { then() {} };
    const electron = {
        app: { whenReady: () => boot, on() {} },
        ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
        ipcRenderer: { invoke(channel, ...args) {
            calls.push(channel);
            return handlers.get(channel)({}, ...args);
        } }
    };
    const load = file => fs.readFile(path.join(source, file), 'utf8');
    const dom = new JSDOM(await load('index.html'), { runScripts: 'outside-only', url: 'https://manager.invalid/' });
    t.after(() => dom.window.close());
    electron.contextBridge = { exposeInMainWorld: (name, value) => { dom.window[name] = value; } };
    const globals = { __dirname: path.join(root, 'VchatManager'), console,
        require: name => name === 'electron' ? electron : require(name) };
    vm.runInNewContext(await load('main.js'), globals);
    vm.runInNewContext(await load('preload.js'), globals);

    const document = dom.window.document;
    const ready = new Promise(resolve => {
        const observer = new dom.window.MutationObserver(() => {
            if (document.querySelector('#groups-list .sidebar-item')) {
                observer.disconnect();
                resolve();
            }
        });
        observer.observe(document.querySelector('#groups-list'), { childList: true });
    });
    dom.window.eval(await load('script.js'));
    document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    await ready;
    document.querySelector('#groups-list .sidebar-item').click();

    const order = () => [...document.querySelectorAll('.topics-list li')].map(li => li.dataset.topicId);
    assert.deepEqual(order(), ['one', 'two']);
    const deleted = JSON.stringify({ ...config, _historyDeleting: true, topics: [config.topics[1]] });
    await fs.writeFile(configPath, deleted);
    document.querySelector('.topic-move-bottom').click();
    assert.deepEqual(order(), ['two', 'one']);
    assert.equal(document.querySelector('.topic-order-save'), null);
    document.querySelector('.topic-order-revert').click();
    assert.deepEqual(order(), ['one', 'two']);
    assert.equal(calls.includes('fs:writeFile'), false);
    assert.equal(await fs.readFile(configPath, 'utf8'), deleted);
});

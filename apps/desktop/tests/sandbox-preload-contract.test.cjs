'use strict';
// Executes actual source and candidate bundles in Node VM with synthetic IPC.
// This does not emulate contextBridge security or prove Electron/OS sandboxing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../preloads/bundled/BUILD-MANIFEST.json'), 'utf8'));
const source = path.resolve(__dirname, '..');
const originalRegistry = require(path.join(source, 'preloads/core/registry.js'));
const globalsByRole = { chat: 'chatAPI', utility: 'utilityAPI', desktop: 'desktopAPI' };
const portable = value => JSON.parse(JSON.stringify(value));
function harness(role, { candidate = true, skip = [], scope = 'synthetic/A', argv, attestedScope = scope, attestedProfile = 'a'.repeat(64) } = {}) {
    const exposed = {}, ipc = new EventEmitter(), calls = [];
    ipc.sendSync = (channel, ...args) => { calls.push(['sendSync', channel, ...args]); if(channel === 'native-sync:composer-scope') return {scope:attestedScope,profile:attestedProfile}; assert.equal(channel, 'app-features:inactive-folders'); return skip; };
    ipc.invoke = async (channel, ...args) => { calls.push(['invoke', channel, ...args]); return channel === 'read-image-from-clipboard-main' ? { success: true, data: 'synthetic', extension: 'png' } : { channel, args }; };
    ipc.send = (channel, ...args) => calls.push(['send', channel, ...args]);
    const electron = { ipcRenderer: ipc, webUtils: { getPathForFile: () => '/synthetic/file' }, contextBridge: { exposeInMainWorld(name, value) { assert.ok(!Object.hasOwn(exposed, name)); exposed[name] = value; } } };
    const context = vm.createContext({
        console: { log() {}, error() {}, warn() {} }, URLSearchParams, location: { search: '' },
        process: { platform: 'linux', argv: argv || ['electron', '--nativesync-composer-scope=' + encodeURIComponent(JSON.stringify({scope,profile:'a'.repeat(64)}))],
            env: candidate ? new Proxy({}, { get() { throw new Error('Unexpected process.env access in candidate'); } }) : { VCPCHAT_COMPOSER_SCOPE_ID: scope } },
    }, { codeGeneration: { strings: false, wasm: false } });
    const cache = new Map();
    function originalRequire(name, parent) {
        if (name === 'electron') return electron;
        if (name === 'path') return path;
        if (name === 'fs') return {
            readdirSync(file, options) { assert.ok([path.join(source, 'preloads/api'), path.join(source, 'modules')].includes(file)); return fs.readdirSync(file, options); },
            existsSync(file) { assert.ok(file.startsWith(path.join(source, 'modules') + path.sep) && file.endsWith('/preloadApi.js')); return fs.existsSync(file); },
        };
        assert.ok(name.startsWith('.') || path.isAbsolute(name), 'Unexpected original dependency: ' + name);
        let file = path.resolve(path.dirname(parent), name);
        if (!path.extname(file)) file += '.js';
        assert.ok(file.startsWith(source + path.sep));
        if (cache.has(file)) return cache.get(file).exports;
        const module = { exports: {} }; cache.set(file, module);
        const factory = new vm.Script('(function(require,module,exports,__dirname,__filename){\n' + fs.readFileSync(file, 'utf8') + '\n})', { filename: file }).runInContext(context);
        factory(request => originalRequire(request, file), module, module.exports, path.dirname(file), file);
        return module.exports;
    }
    if (candidate) {
        context.require = name => { assert.equal(name, 'electron', 'Candidate must require only electron externally'); return electron; };
        new vm.Script(fs.readFileSync(path.join(source, 'preloads/bundled/dist', role + '.cjs'), 'utf8'), { filename: 'candidate-' + role + '.cjs' }).runInContext(context);
    } else originalRequire(path.join(source, 'preloads', role + '.js'), path.join(source, 'entry.js'));
    return { exposed, ipc, calls, api: exposed[globalsByRole[role]] };
}

test('all three bundled roles preserve actual source APIs and compatibility keys', () => {
    for (const role of Object.keys(globalsByRole)) {
        const before = harness(role, { candidate: false }), after = harness(role);
        assert.deepEqual(Object.keys(after.exposed), Object.keys(before.exposed));
        for (const global of Object.keys(before.exposed)) assert.deepEqual(Object.keys(after.exposed[global]), Object.keys(before.exposed[global]));
        const expected = originalRegistry.describeApis().filter(api => api.roles.includes(role)).map(api => api.name);
        assert.deepEqual(Object.keys(after.api), expected);
    }
});
test('disabled optional features are omitted exactly as in the source registry', () => {
    for (const skip of [['deskpet'], ['nativeSyncSettings'], ['deskpet', 'nativeSyncSettings']]) {
        for (const role of Object.keys(globalsByRole)) {
            const before = harness(role, { candidate: false, skip }), after = harness(role, { skip });
            assert.deepEqual(Object.keys(after.api), Object.keys(before.api));
            assert.deepEqual(Object.keys(after.exposed.electronAPI), Object.keys(before.exposed.electronAPI));
        }
    }
});
test('role isolation stubs retain rejected queries and inert subscriptions', async () => {
    const desktop = harness('desktop');
    assert.equal(desktop.api.getChatHistory, undefined);
    await assert.rejects(desktop.exposed.electronAPI.getChatHistory('synthetic', 'topic'), /权限已隔离/);
    const stop = desktop.exposed.electronAPI.onHistoryFileUpdated(() => assert.fail('Isolated subscription executed'));
    assert.equal(typeof stop, 'function'); stop();
    assert.equal(desktop.ipc.listenerCount('history-file-updated'), 0);
});
test('two distinct synthetic composer scopes stay synchronous and isolated', () => {
    const a = harness('chat', { scope: 'synthetic/A' }), b = harness('chat', { scope: 'synthetic/B' });
    assert.equal(a.api.getComposerScope(), 'synthetic/A');
    assert.equal(b.api.getComposerScope(), 'synthetic/B');
    assert.equal(a.exposed.electronAPI.getComposerScope(), 'synthetic/A');
    assert.throws(() => harness('chat', { argv: ['electron'] }), /CANDIDATE_COMPOSER_SCOPE_REQUIRED/);
    assert.throws(() => harness('chat', { argv: ['electron', '--nativesync-composer-scope=A', '--nativesync-composer-scope=B'] }), /CANDIDATE_COMPOSER_SCOPE_REQUIRED/);
});
test('every native subscription preserves payload shape and independent unsubscribe', () => {
    let checked = 0;
    for (const api of originalRegistry.describeApis().filter(api => api.kind === 'subscription')) {
        const role = api.roles[0], before = harness(role, { candidate: false }), after = harness(role);
        const seenBefore = [], seenAfter = [];
        const callbackBefore = (...values) => seenBefore.push(portable(values));
        const callbackAfter = (...values) => seenAfter.push(portable(values));
        const beforeA = before.api[api.name](callbackBefore), beforeB = before.api[api.name](callbackBefore);
        const afterA = after.api[api.name](callbackAfter), afterB = after.api[api.name](callbackAfter);
        const emit = h => h.ipc.emit(api.channel, { syntheticEvent: true }, 'one', { synthetic: 2 }, 'three');
        emit(before); emit(after);
        beforeA(); afterA(); emit(before); emit(after);
        beforeA(); afterA(); beforeB(); afterB(); emit(before); emit(after);
        assert.deepEqual(seenAfter, seenBefore, api.name);
        assert.equal(seenAfter.length, 3, api.name);
        assert.equal(after.ipc.listenerCount(api.channel), 0, api.name);
        checked++;
    }
    assert.ok(checked > 50);
});
test('native argument forwarding, result transforms and file helper remain unchanged', async () => {
    for (const candidate of [false, true]) {
        const h = harness('chat', { candidate });
        assert.deepEqual(portable(await h.api.getChatHistory('synthetic', 'topic', 'discard')), { channel: 'get-chat-history', args: ['synthetic', 'topic'] });
        assert.deepEqual(portable(await h.api.readImageFromClipboard()), { data: 'synthetic', extension: 'png' });
        assert.equal(h.api.getPathForFile({}), '/synthetic/file');
        h.api.minimizeWindow('discard');
        assert.deepEqual(h.calls.at(-1), ['send', 'minimize-window']);
        assert.deepEqual(portable(await h.exposed.electronPath.basename('/synthetic/file')), { channel: 'path:basename', args: ['/synthetic/file'] });
    }
});
test('bundles need only electron and the real main owns the data root scope', () => {
    assert.deepEqual(manifest.externalModules, ['external "electron"']);
    const main = fs.readFileSync(path.join(source, 'main.js'), 'utf8');
    assert.match(main, /preload: path.join\(__dirname, 'preloads\/bundled\/dist\/chat.cjs'\)/);
    assert.match(main, /sandbox: true/);
    assert.match(main, /update\(APP_DATA_ROOT_IN_PROJECT\)/);
    assert.throws(() => harness('chat', {attestedScope:'foreign-source'}), /CANDIDATE_COMPOSER_IDENTITY_MISMATCH/);
    assert.throws(() => harness('chat', {attestedProfile:'b'.repeat(64)}), /CANDIDATE_COMPOSER_IDENTITY_MISMATCH/);
    for(const scope of ['','bad\0scope','x'.repeat(4097)]) assert.throws(() => harness('chat',{scope}), /CANDIDATE_COMPOSER_SCOPE_REQUIRED/);
    for (const value of ['foreign-root', 'vcpchat-data:' + 'g'.repeat(64), '%', '']) {
        assert.throws(() => harness('chat', { argv: ['electron', '--nativesync-composer-scope=' + value] }));
    }
});

test('bundle manifest matches all current source inputs and domain membership', () => {
    const crypto = require('node:crypto');
    const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    for (const input of manifest.inputs) assert.equal(digest(path.join(source, input.file)), input.sha256, input.file);
    assert.equal(digest(path.join(source, 'scripts/build-sandbox-preloads.cjs')), manifest.builderSHA256);
    const domains = new Set(originalRegistry.describeApis().map(api => api.where));
    assert.deepEqual([...domains].sort(), manifest.domains.map(row => row.where).sort());
    for (const bundle of manifest.bundles) assert.equal(digest(path.join(source,bundle.file)), bundle.sha256);
});

test('auxiliary chat loads without main identity and cannot acquire composer scope', async () => {
    const aux = harness('auxiliary-chat', { argv: ['electron'] });
    assert.equal(aux.exposed.chatAPI.getComposerScope, undefined);
    await assert.rejects(aux.exposed.electronAPI.getComposerScope(), /权限已隔离/);
    assert.equal(typeof aux.exposed.chatAPI.getChatHistory, 'function');
    assert.ok(!aux.calls.some(call => call[1] === 'native-sync:composer-scope'));
});
test('preload resolvers select shipped sandbox bundles and reject arbitrary child code', () => {
    const { PRELOAD_ROLES, resolveProjectPreload, resolveChildPreload } = require('../modules/services/preloadPaths');
    for (const role of Object.values(PRELOAD_ROLES)) {
        const file = resolveProjectPreload(source, role);
        assert.ok(fs.existsSync(file));
        assert.ok(file.endsWith(['chart', 'docx'].includes(role) ? '.js' : '.cjs'));
    }
    assert.throws(() => resolveProjectPreload(source, '../arbitrary'), /Unknown preload role/);
    assert.equal(resolveChildPreload(source), resolveProjectPreload(source, 'utility'));
    assert.throws(() => resolveChildPreload(source, path.join(source, 'preloads/chat.js')), /Unsupported child preload/);
    assert.throws(() => resolveChildPreload(source, '/tmp/arbitrary.cjs'), /Unsupported child preload/);
});

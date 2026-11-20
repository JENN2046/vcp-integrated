'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../modules/services/chatDataService/lifecycle.js'), 'utf8');
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
    const hold = deferred(), entered = deferred(); let spawns = 0;
    class ServiceError extends Error { constructor(message, options) { super(message); Object.assign(this, options); } }
    const context = { module: { exports: {} }, process, console, setTimeout, clearTimeout, require(id) {
        if (id === 'fs') return { existsSync: () => true };
        if (id === 'child_process') return { spawn() { spawns++; throw Error('UNEXPECTED_CDS_SPAWN'); } };
        if (id === './authorityControl') return { verifyAuthorityBinary: () => { entered.resolve(); return hold.promise; } };
        if (id === './client') return { ChatDataServiceError: ServiceError };
        return require(id);
    } };
    vm.runInNewContext(source, context);
    const life = new context.module.exports.ChatDataServiceLifecycle({ appDataPath: '/synthetic/data', binaryPath: '/synthetic/cds' });
    return { life, hold, entered, spawns: () => spawns };
}
test('stop during binary verification prevents a late CDS spawn and ready notification', async () => {
    const x = fixture(); let ready = 0; x.life.on('ready', () => ready++);
    const pending = x.life.start().then(value => ({ value }), error => ({ error }));
    await x.entered.promise; await x.life.stop(); x.hold.resolve(); const result = await pending;
    assert.equal(x.spawns(), 0); assert.equal(result.error, undefined); assert.equal(result.value, null);
    assert.equal(ready, 0); assert.equal(x.life.enabled, false); assert.equal(x.life.stopping, true); assert.equal(x.life.process, null);
});
test('uninterrupted verification still waits for the authority callback and emits ready once', async () => {
    const x = fixture(), authority = deferred(), callbackEntered = deferred(); let spawned = 0, ready = 0;
    const client = {}; x.life._spawnAndWaitForReady = async () => { spawned++; x.life.process = { killed: false }; return client; };
    x.life._scheduleStabilityReset = () => {};
    x.life.onAuthorityReady = async () => { callbackEntered.resolve(); await authority.promise; };
    x.life.on('ready', () => ready++); const pending = x.life.start();
    await x.entered.promise; assert.equal(spawned, 0); x.hold.resolve(); await callbackEntered.promise;
    assert.equal(spawned, 1); assert.equal(ready, 0); authority.resolve(); assert.equal(await pending, client); assert.equal(ready, 1);
});

for (const stage of ['handshake', 'authority callback']) test('stop during ' + stage + ' prevents late ready publication', async () => {
    const x = fixture(), hold = deferred(), entered = deferred(); let callbacks = 0, ready = 0;
    const { EventEmitter } = require('node:events'), child = new EventEmitter();
    child.killed = false;
    child.stdin = { end() { x.life.process = null; queueMicrotask(() => child.emit('exit', 0)); } };
    const client = { shutdown: async () => {} };
    x.life._scheduleStabilityReset = () => assert.fail('late stability timer');
    x.life._spawnAndWaitForReady = async () => { x.life.process = child; if (stage === 'handshake') { entered.resolve(); await hold.promise; } return client; };
    x.life.onAuthorityReady = async () => { callbacks++; if (stage === 'authority callback') { entered.resolve(); await hold.promise; } };
    x.life.on('ready', () => ready++);
    const pending = x.life.start(); await x.entered.promise; x.hold.resolve(); await entered.promise;
    await x.life.stop(); hold.resolve(); assert.equal(await pending, null); assert.equal(ready, 0);
    assert.equal(callbacks, stage === 'handshake' ? 0 : 1);
});

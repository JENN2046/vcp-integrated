'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createHistoryFileWatcher } = require('../modules/services/historyFileWatcher');

const quiet = { info() {}, warn() {}, error() {} };
function fixture() {
    let clock = 10000;
    let nextTimer = 0;
    const pending = new Map();
    const watches = [];
    const polls = [];
    let nativeError = null;
    const stats = value => ({ dev: 1, ino: 2, size: value, mtimeMs: value, ctimeMs: value });
    const io = {
        watch(dir, options, callback) {
            if (nativeError) throw Object.assign(new Error('controlled watch limit'), { code: nativeError });
            const watcher = new EventEmitter();
            watcher.close = () => { watcher.closed = true; };
            watches.push({ dir, options, callback, watcher });
            return watcher;
        },
        watchFile(file, options, callback) { polls.push({ file, options, callback, closed: false }); },
        unwatchFile(file, callback) { polls.find(item => item.file === file && item.callback === callback).closed = true; },
    };
    const timers = {
        setTimeout(callback, delay) { const token = { id: ++nextTimer, due: clock + delay, unref() {} }; pending.set(token, callback); return token; },
        clearTimeout(token) { pending.delete(token); },
    };
    const tick = duration => {
        const end = clock + duration;
        for (;;) {
            const token = [...pending.keys()].filter(token => token.due <= end).sort((a, b) => a.due - b.due)[0];
            if (!token) break;
            clock = token.due;
            const callback = pending.get(token);
            pending.delete(token);
            callback();
        }
        clock = end;
    };
    const owner = createHistoryFileWatcher({ io, logger: quiet, timers, now: () => clock, retryDelays: [50, 100], stabilityMs: 10, saveWindowMs: 100 });
    return { owner, io, watches, polls, tick, pending, stats, fail(code) { nativeError = code; } };
}

test('one selected History uses one non-recursive parent watch and ignores sibling events', async () => {
    const f = fixture(); const changed = [];
    await f.owner.watchFile('/synthetic/UserData/a/topics/t/history.json', file => changed.push(file));
    assert.equal(f.watches.length, 1);
    assert.equal(f.watches[0].dir, '/synthetic/UserData/a/topics/t');
    assert.equal(f.watches[0].options.recursive, false);
    f.watches[0].callback('change', 'unrelated.json'); f.tick(100);
    assert.equal(changed.length, 0);
    f.watches[0].callback('rename', 'history.json'); f.tick(10);
    assert.deepEqual(changed, ['/synthetic/UserData/a/topics/t/history.json']);
    await f.owner.stopWatching(); assert.equal(f.watches[0].watcher.closed, true);
});

test('ENOSPC at subscription is explicit and recovers only the selected History through stat notifications', async () => {
    const f = fixture(); const changed = []; f.fail('ENOSPC');
    const result = await f.owner.watchFile('/synthetic/history.json', file => changed.push(file));
    assert.equal(result.degraded, true); assert.equal(result.mode, 'polling');
    assert.equal(result.errorCode, 'ENOSPC'); assert.equal(f.polls.length, 1);
    assert.equal(f.polls[0].file, '/synthetic/history.json');
    assert.equal(f.polls[0].options.persistent, false);
    f.tick(10); assert.equal(changed.length, 1, 'reconcile the gap once');
    f.polls[0].callback(f.stats(4), f.stats(0)); f.tick(10);
    assert.equal(changed.length, 2, 'existing authoritative file notification reaches the renderer');
    f.tick(150); assert.equal(f.owner.getStatus().recoveryExhausted, true);
    assert.equal(f.pending.size, 0, 'native resubscription attempts are finite');
    assert.equal(f.polls.length, 1, 'one stat subscription throughout degradation');
    await f.owner.stopWatching(); assert.equal(f.polls[0].closed, true);
});

test('asynchronous native error closes the failed handle and recovers without duplicate subscriptions', async () => {
    const f = fixture(); const changed = [];
    await f.owner.watchFile('/synthetic/history.json', file => changed.push(file));
    f.fail('ENOSPC'); f.watches[0].watcher.emit('error', Object.assign(new Error('limit'), { code: 'ENOSPC' }));
    assert.equal(f.watches[0].watcher.closed, true); assert.equal(f.owner.getStatus().degraded, true);
    f.fail(null); f.tick(50);
    assert.equal(f.owner.getStatus().mode, 'native'); assert.equal(f.owner.getStatus().recovered, true);
    assert.equal(f.owner.getStatus().nativeSubscriptions, 1); assert.equal(f.polls[0].closed, true);
    f.tick(10); assert.equal(changed.length, 2, 'one gap check, one restored subscription check');
    await f.owner.stopWatching();
});

test('superseded and stopped leases cannot notify or reopen after late callbacks', async () => {
    const f = fixture(); const changed = []; f.fail('ENOSPC');
    await f.owner.watchFile('/synthetic/old/history.json', file => changed.push(file));
    const stale = f.polls[0]; f.fail(null);
    await f.owner.watchFile('/synthetic/new/history.json', file => changed.push(file));
    stale.callback(f.stats(4), f.stats(0)); f.tick(500);
    assert.equal(changed.length, 0); assert.equal(f.watches.length, 1);
    f.watches[0].callback('change', 'history.json');
    await f.owner.stopWatching(); f.tick(1000);
    f.watches[0].watcher.emit('error', new Error('late error'));
    assert.equal(changed.length, 0); assert.equal(f.pending.size, 0); assert.equal(f.owner.getStatus().mode, 'stopped');
});

test('internal save and editing defer external change instead of dropping it', async () => {
    const f = fixture(); const changed = [];
    await f.owner.watchFile('/synthetic/history.json', file => changed.push(file));
    f.owner.signalInternalSave(); f.watches[0].callback('change', 'history.json'); f.tick(99);
    assert.equal(changed.length, 0); f.tick(1); assert.equal(changed.length, 1);
    f.owner.setEditingMode(true); f.watches[0].callback('rename', 'history.json'); f.tick(1000);
    assert.equal(changed.length, 1);
    f.owner.setEditingMode(false); f.tick(10); assert.equal(changed.length, 2);
    await f.owner.stopWatching();
});

test('real Linux selected History recovers a controlled inotify refusal and atomic replacement with no writes by the watcher', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-watch-recovery-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const target = path.join(dir, 'history.json'); fs.writeFileSync(target, '[]');
    const observed = [];
    const owner = createHistoryFileWatcher({
        io: { ...fs, watch() { throw Object.assign(new Error('controlled ENOSPC'), { code: 'ENOSPC' }); } },
        logger: quiet, stabilityMs: 10, pollIntervalMs: 20, retryDelays: [20, 40],
    });
    t.after(() => owner.stopWatching());
    await owner.watchFile(target, file => observed.push(JSON.parse(fs.readFileSync(file, 'utf8'))));
    await new Promise(resolve => setTimeout(resolve, 40));
    fs.writeFileSync(path.join(dir, 'next.json'), '[{"id":"synthetic-a"}]');
    fs.renameSync(path.join(dir, 'next.json'), target);
    const deadline = Date.now() + 2000;
    while ((!observed.some(rows => rows[0]?.id === 'synthetic-a') || !owner.getStatus().recoveryExhausted)
        && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(observed.some(rows => rows[0]?.id === 'synthetic-a'));
    assert.equal(owner.getStatus().mode, 'polling'); assert.equal(owner.getStatus().recoveryExhausted, true);
    assert.equal(fs.readFileSync(target, 'utf8'), '[{"id":"synthetic-a"}]');
    await owner.stopWatching(); const before = observed.length;
    fs.writeFileSync(target, '[{"id":"synthetic-b"}]'); await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(observed.length, before);
});

test('renderer History paths append portable separators in both selection and new-topic paths', () => {
    const source = fs.readFileSync(path.join(__dirname, '../modules/chatManager.js'), 'utf8');
    assert.match(source, /`\$\{agentConfigForHistory\.agentDataPath\}\/topics\/\$\{topicId\}\/history\.json`/);
    assert.match(source, /`\$\{agentConfigForWatcher\.agentDataPath\}\/topics\/\$\{result\.topicId\}\/history\.json`/);
    for (const [root, platform] of [['/synthetic/UserData/a', path.posix], ['C:\\Synthetic\\UserData\\a', path.win32]]) {
        assert.equal(platform.normalize(`${root}/topics/t/history.json`), platform.join(root, 'topics', 't', 'history.json'));
    }
});

test('the existing renderer lease reports the real degraded selected-History subscription', async () => {
    const { createHistoryWatcherLeaseManager } = require('../modules/services/historyWatcherLeaseManager');
    const f = fixture(); f.fail('ENOSPC');
    const manager = createHistoryWatcherLeaseManager({
        startWatching: ({ filePath, callback }) => f.owner.watchFile(filePath, callback),
        stopWatching: () => f.owner.stopWatching(),
    });
    const lease = manager.claim('synthetic-renderer'); await lease.stopped;
    const result = await manager.start('synthetic-renderer', lease.token, { filePath: '/synthetic/history.json', callback() {} });
    assert.equal(result.success, true, 'loaded History stays usable in fallback mode');
    assert.equal(result.degraded, true, 'IPC cannot silently claim native notifications are healthy');
    assert.equal(result.mode, 'polling'); assert.equal(result.errorCode, 'ENOSPC');
    await manager.dispose();
    assert.equal(f.owner.getStatus().mode, 'stopped'); assert.equal(f.polls[0].closed, true); assert.equal(f.pending.size, 0);
});

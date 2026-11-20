'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsExtra = require('fs-extra');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { HistoryMutationQueue } = require('../modules/services/historyMutationQueue');

const descriptor = (topicId = 'topic_a') => ({ itemId: 'agent_a', itemType: 'agent', topicId });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const caught = operation => Promise.resolve().then(operation).then(value => ({ value }), error => ({ error }));
const quiet = { warn() {}, error() {} };
async function fixture(t, options = {}) {
    // Every byte is synthetic and remains inside this task-owned checkout.
    const root = await fs.mkdtemp(path.join(__dirname, '.f06-history-'));
    const userDataDir = path.join(root, 'UserData');
    await fs.mkdir(path.join(root, 'Agents', 'agent_a'), { recursive: true });
    const config = path.join(root, 'Agents', 'agent_a', 'config.json');
    await fs.writeFile(config, JSON.stringify({ name: 'Synthetic Agent', topics: [{ id: 'topic_a' }, { id: 'topic_b' }] }));
    const queue = new HistoryMutationQueue({ userDataDir, logger: quiet, ...options });
    t.after(async () => { await queue.dispose(); await fs.rm(root, { recursive: true, force: true }); });
    return { root, config, userDataDir, queue, file: queue.getHistoryPath('agent_a', 'topic_a') };
}
async function store(file, bytes) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); }
async function absent(file) { await assert.rejects(fs.lstat(file), { code: 'ENOENT' }); }
async function restart(f) { return new HistoryMutationQueue({ userDataDir: f.userDataDir, logger: quiet }); }
function runChild(root, hook, mode = 'initialize', topicId = 'topic_a') {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(__dirname, 'f06-history-crash-worker.cjs'), root, hook, mode, topicId], {
            env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], cwd: root,
        });
        let stdout = '', stderr = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`crash worker timeout at ${hook}`)); }, 10000);
        child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
        child.on('error', reject);
        child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    });
}

test('F06 runtime is real Node 24', () => { assert.equal(Number(process.versions.node.split('.')[0]), 24); });

test('concurrent initialization creates once and keeps exact existing bytes', async t => {
    const f = await fixture(t);
    const results = await Promise.all(Array.from({ length: 24 }, () => f.queue.initializeIfMissing(descriptor())));
    assert.equal(results.filter(r => r.status === 'created').length, 1);
    assert.equal(results.filter(r => r.status === 'existing').length, 23);
    assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), []);
    for (const bytes of [' \n[ ]\t\n', '[\n { "id": "accepted", "content": "preserve exact bytes" }\n]\n']) {
        await fs.writeFile(f.file, bytes);
        const result = await f.queue.initializeIfMissing(descriptor());
        assert.equal(result.status, 'existing'); assert.equal(await fs.readFile(f.file, 'utf8'), bytes);
    }
});

test('initialization and local mutations share one queue in either arrival order', async t => {
    const f = await fixture(t);
    await Promise.all([f.queue.initializeIfMissing(descriptor()), f.queue.mutate(descriptor(), h => [...h, { id: 'one' }])]);
    await fs.unlink(f.file);
    await Promise.all([f.queue.write(descriptor(), [{ id: 'two' }]), f.queue.initializeIfMissing(descriptor())]);
    assert.deepEqual(await f.queue.read(descriptor()), [{ id: 'two' }]);
});

test('external independent writer wins EEXIST without being replaced or removed', async t => {
    const bytes = '[ { "id": "outside-queue", "content": "accepted" } ]\n';
    let f, raced = false;
    f = await fixture(t, { commitFault: async point => {
        if (point === 'before-publish' && !raced) { raced = true; await fs.writeFile(f.file, bytes, { flag: 'wx' }); }
    } });
    const result = await f.queue.initializeIfMissing(descriptor());
    assert.equal(result.status, 'existing'); assert.equal(result.created, false);
    assert.equal(await fs.readFile(f.file, 'utf8'), bytes);
    assert.equal((await fs.stat(f.file)).nlink, 1);
});

test('corrupt/non-array histories fail without replacing original bytes', async t => {
    const f = await fixture(t);
    for (const bytes of ['', '{ broken', '{}', 'null', '"array-like"']) {
        await store(f.file, bytes);
        const outcome = await caught(() => f.queue.initializeIfMissing(descriptor()));
        assert.ok(outcome.error, bytes); assert.equal(outcome.error.status, 'failure');
        assert.equal(await fs.readFile(f.file, 'utf8'), bytes);
        await assert.rejects(f.queue.replace(descriptor(), []));
        assert.equal(await fs.readFile(f.file, 'utf8'), bytes);
    }
});

test('unsafe identifiers, file/ancestor symlinks and hardlink targets are rejected', async t => {
    const f = await fixture(t);
    for (const id of ['..', '../escape', 'bad\\name', 'nul', 'trailing.', '']) {
        await assert.rejects(caught(() => f.queue.initializeIfMissing({ ...descriptor(), topicId: id })).then(r => { if (r.error) throw r.error; }), { code: 'INVALID_HISTORY_ID' });
    }
    const outside = path.join(f.root, 'synthetic-outside.json'); await fs.writeFile(outside, '[{"id":"untouched"}]');
    await fs.mkdir(path.dirname(f.file), { recursive: true }); await fs.symlink(outside, f.file);
    await assert.rejects(f.queue.initializeIfMissing(descriptor()), { code: 'UNSAFE_HISTORY_FILE' });
    await fs.unlink(f.file); await fs.link(outside, f.file);
    await assert.rejects(f.queue.initializeIfMissing(descriptor()), { code: 'UNSAFE_HISTORY_FILE' });
    await fs.unlink(f.file); await fs.rm(path.dirname(f.file), { recursive: true });
    await fs.mkdir(path.join(f.root, 'synthetic-alias')); await fs.symlink(path.join(f.root, 'synthetic-alias'), path.dirname(f.file));
    await assert.rejects(f.queue.initializeIfMissing(descriptor()), { code: 'UNSAFE_HISTORY_ANCESTOR' });
    assert.equal(await fs.readFile(outside, 'utf8'), '[{"id":"untouched"}]');
});

test('permission errors are failures and never treated as absent', async t => {
    const f = await fixture(t); await store(f.file, '[{"id":"permission-protected"}]');
    const directory = path.dirname(f.file); await fs.chmod(directory, 0);
    try {
        const result = await caught(() => f.queue.initializeIfMissing(descriptor()));
        assert.ok(result.error); assert.equal(result.error.code, 'EACCES'); assert.equal(result.error.status, 'failure');
    } finally { await fs.chmod(directory, 0o700); }
    assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), [{ id: 'permission-protected' }]);
});

test('direct public write serializes behind an occupied queue and behind concurrent writes', async t => {
    const entered = deferred(), release = deferred(), f = await fixture(t);
    const blocker = f.queue.run(descriptor(), async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    let completed = false;
    const first = f.queue.write(descriptor(), [{ id: 'first' }]).then(() => { completed = true; });
    const second = f.queue.write(descriptor(), [{ id: 'second' }]);
    await new Promise(r => setImmediate(r)); assert.equal(completed, false); await absent(f.file);
    release.resolve(); await Promise.all([blocker, first, second]);
    assert.deepEqual(await f.queue.read(descriptor()), [{ id: 'second' }]);
});

test('topic deletion fences an already queued stale operation before it runs', async t => {
    const entered = deferred(), release = deferred(), f = await fixture(t);
    await f.queue.initializeIfMissing(descriptor());
    const blocker = f.queue.run(descriptor(), async () => { entered.resolve(); await release.promise; }); await entered.promise;
    const late = caught(() => f.queue.write(descriptor(), [{ id: 'stale' }]));
    const deleting = f.queue.deleteHistory(descriptor(), async () => {
        await fs.writeFile(f.config, JSON.stringify({ name: 'Synthetic Agent', topics: [{ id: 'topic_b' }] }));
        await fs.rm(path.dirname(f.file), { recursive: true }); return { success: true };
    });
    release.resolve(); await blocker; await deleting;
    assert.equal((await late).error?.code, 'HISTORY_DELETION_FENCED');
    await absent(f.file);
});

test('owner deletion fence also rejects a later unseen topic and cross-type physical alias', async t => {
    const f = await fixture(t), held = deferred(), release = deferred();
    const deletion = f.queue.deleteHistory({ itemId: 'agent_a', itemType: 'agent' }, async () => { held.resolve(); await release.promise; });
    await held.promise;
    const outcomes = await Promise.all([
        caught(() => f.queue.initializeIfMissing(descriptor('topic_b'))),
        caught(() => f.queue.write({ ...descriptor('topic_b'), itemType: 'group' }, [{ id: 'type-alias' }])),
    ]);
    assert.deepEqual(outcomes.map(r => r.error?.code), ['HISTORY_DELETION_FENCED', 'HISTORY_DELETION_FENCED']);
    release.resolve(); await deletion;
    await absent(f.queue.getHistoryPath('agent_a', 'topic_b'));
});

test('deleted configuration membership remains denied to a new queue after restart', async t => {
    const f = await fixture(t); await f.queue.initializeIfMissing(descriptor());
    await f.queue.deleteHistory(descriptor(), async () => {
        await fs.writeFile(f.config, JSON.stringify({ topics: [{ id: 'topic_b' }] })); await fs.rm(path.dirname(f.file), { recursive: true });
    });
    const q = await restart(f); t.after(() => q.dispose());
    await assert.rejects(q.initializeIfMissing(descriptor()), { code: 'HISTORY_TOPIC_DELETED' });
    await assert.rejects(q.write(descriptor(), [{ id: 'old-callback' }]), { code: 'HISTORY_TOPIC_DELETED' }); await absent(f.file);
});

test('strict authority refuses corrupt/missing/duplicate/ambiguous/deleting configuration', async t => {
    const f = await fixture(t);
    for (const bytes of ['{bad', '{}', JSON.stringify({ topics: [{ id: 'topic_a' }, { id: 'topic_a' }] }), JSON.stringify({ _historyDeleting: true, topics: [{ id: 'topic_a' }] })]) {
        await fs.writeFile(f.config, bytes); const q = await restart(f);
        try { await assert.rejects(q.initializeIfMissing(descriptor())); } finally { await q.dispose(); }
        await absent(f.file);
    }
    await fs.unlink(f.config); await fs.writeFile(f.config + '.backup', JSON.stringify({ topics: [{ id: 'topic_a' }] }));
    await assert.rejects(f.queue.initializeIfMissing(descriptor()), { code: 'HISTORY_OWNER_UNVERIFIED' });
    await fs.writeFile(f.config, JSON.stringify({ topics: [{ id: 'topic_a' }] }));
    await fs.mkdir(path.join(f.root, 'AgentGroups', 'agent_a'), { recursive: true });
    await fs.writeFile(path.join(f.root, 'AgentGroups', 'agent_a', 'config.json'), JSON.stringify({ topics: [{ id: 'topic_a' }] }));
    await assert.rejects(f.queue.initializeIfMissing(descriptor()), { code: 'HISTORY_OWNER_AMBIGUOUS' }); await absent(f.file);
});

test('expired async scope cannot be used by an old callback', async t => {
    const f = await fixture(t), callbackReady = deferred(), callbackFinished = deferred();
    await f.queue.run(descriptor(), () => {
        setTimeout(async () => { await callbackReady.promise; callbackFinished.resolve(await caught(() => f.queue.write(descriptor(), [{ id: 'expired' }]))); }, 0);
    });
    callbackReady.resolve();
    assert.equal((await callbackFinished.promise).error?.code, 'HISTORY_WRITER_SCOPE_EXPIRED'); await absent(f.file);
});

test('recursive same-file public operations fail without self-wait', async t => {
    const f = await fixture(t);
    await assert.rejects(f.queue.run(descriptor(), () => f.queue.replace(descriptor(), [])), { code: 'HISTORY_REENTRANT_QUEUE' });
    await assert.rejects(f.queue.run(descriptor(), () => f.queue.deleteHistory(descriptor(), async () => {})), { code: 'HISTORY_DELETE_LOCK_ORDER' });
});

test('a failed run callback must still drain its already accepted internal writes', async t => {
    const firstWriting = deferred(), release = deferred(); let writes = 0;
    const f = await fixture(t, { commitFault: async point => {
        if (point === 'temporary-synced' && ++writes === 1) { firstWriting.resolve(); await release.promise; }
    } });
    const aborted = caught(() => f.queue.run(descriptor(), () => {
        // An internal caller can throw after handing an accepted write to the
        // queue. That error cannot release ownership while the write is alive.
        void f.queue.write(descriptor(), [{ id: 'first-accepted' }]).catch(() => {});
        throw new Error('caller-aborted-after-write');
    }));
    await firstWriting.promise;
    let secondDone = false;
    const second = f.queue.write(descriptor(), [{ id: 'second-accepted' }]).then(() => { secondDone = true; });
    let prematurelyReleased;
    try { await new Promise(r => setTimeout(r, 40)); prematurelyReleased = secondDone; }
    finally { release.resolve(); await Promise.all([aborted, second]); }
    assert.equal(prematurelyReleased, false, 'same-file queue released while an accepted write was still in flight');
    assert.match((await aborted).error?.message, /caller-aborted-after-write/);
    assert.deepEqual(await f.queue.read(descriptor()), [{ id: 'second-accepted' }]);
});

test('existing History still executes real initialization policy and rejects pending/unknown/readonly', async t => {
    const f = await fixture(t); await store(f.file, '[{"id":"protected"}]');
    for (const status of ['pending', 'unknown', 'denied']) {
        let called = 0;
        f.queue.configureSync({ isEnabled: () => true, beforeInitialize: async () => { called++; throw Object.assign(new Error(`synthetic-${status}`), { code: `INIT_${status.toUpperCase()}`, status }); } });
        const result = await caught(() => f.queue.initializeIfMissing(descriptor()));
        assert.equal(called, 1); assert.equal(result.error?.status, status); assert.equal(await fs.readFile(f.file, 'utf8'), '[{"id":"protected"}]');
    }
    let beforeMutation = 0, beforeWrite = 0;
    f.queue.configureSync({ isEnabled: () => false, beforeMutation: async () => { beforeMutation++; }, beforeWrite: async () => { beforeWrite++; } });
    assert.equal((await f.queue.initializeIfMissing(descriptor())).status, 'existing');
    assert.equal(beforeMutation, 1); assert.equal(beforeWrite, 1);
});

test('delete error retains current-process fence and reports unknown', async t => {
    const f = await fixture(t); await f.queue.initializeIfMissing(descriptor());
    const result = await caught(() => f.queue.deleteHistory(descriptor(), async () => { throw Object.assign(new Error('injected-delete-failure'), { code: 'EIO' }); }));
    assert.equal(result.error?.status, 'unknown');
    await assert.rejects(f.queue.write(descriptor(), [{ id: 'unsafe-retry' }]), { code: 'HISTORY_DELETION_FENCED' });
    assert.deepEqual(await f.queue.read(descriptor()), []);
});

for (const hook of ['initialize-authorized', 'temporary-opened', 'temporary-synced', 'before-publish', 'after-publish', 'directory-synced']) {
    test(`real process exit at ${hook} retains atomic data and supports safe reinspection`, async t => {
        const f = await fixture(t);
        const child = await runChild(f.root, hook);
        assert.equal(child.code, 72, JSON.stringify(child));
        const published = ['after-publish', 'directory-synced'].includes(hook);
        if (published) assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), []);
        else await absent(f.file);
        const q = await restart(f); t.after(() => q.dispose());
        // A crash between link and unlink has an unknown publication outcome.
        // Preserve both links as evidence; do not demand automatic cleanup or
        // classify it as an unconditionally successful existing initialization.
        if (hook === 'after-publish') {
            const directory = path.dirname(f.file), before = await fs.readFile(f.file);
            const tempNames = (await fs.readdir(directory)).filter(name => name.endsWith('.tmp'));
            assert.equal(tempNames.length, 1);
            const temp = path.join(directory, tempNames[0]), targetStat = await fs.stat(f.file), tempStat = await fs.stat(temp);
            assert.equal(targetStat.ino, tempStat.ino); assert.equal(targetStat.dev, tempStat.dev); assert.equal(targetStat.nlink, 2);
            const result = await caught(() => q.initializeIfMissing(descriptor()));
            assert.equal(result.error?.status, 'unknown');
            await assert.rejects(q.write(descriptor(), [{ id: 'must-not-replace-unknown' }]));
            assert.deepEqual(await fs.readFile(f.file), before); assert.deepEqual(await fs.readFile(temp), before);
            assert.equal((await fs.stat(f.file)).nlink, 2);
        } else {
            const result = await q.initializeIfMissing(descriptor());
            assert.equal(result.status, published ? 'existing' : 'created');
        }
        assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), []);
    });
}

test('real process exit after deletion fence alone changes no disk facts', async t => {
    const f = await fixture(t); await store(f.file, '[{"id":"accepted-before-fence"}]');
    const child = await runChild(f.root, 'deletion-fenced', 'delete'); assert.equal(child.code, 72, JSON.stringify(child));
    assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), [{ id: 'accepted-before-fence' }]);
    const q = await restart(f); t.after(() => q.dispose());
    assert.equal((await q.initializeIfMissing(descriptor())).status, 'existing');
});

test('persisted native topic deletion still denies re-added old config membership after restart', async t => {
    const f = await fixture(t);
    await fs.writeFile(f.config, JSON.stringify({
        topics: [{ id: 'topic_a' }, { id: 'topic_b' }],
        _historyDeletedTopics: ['topic_a'],
    }));
    const q = await restart(f); t.after(() => q.dispose());
    await assert.rejects(q.initializeIfMissing(descriptor()));
    await assert.rejects(q.write(descriptor(), [{ id: 'old-mobile-upload-or-callback' }]));
    await absent(f.file);
    const legitimate = await q.initializeIfMissing(descriptor('topic_b'));
    assert.equal(legitimate.status, 'created');
});

test('owner deletion tombstone refuses old callbacks after restart even if topic is re-added', async t => {
    const f = await fixture(t);
    await fs.writeFile(f.config, JSON.stringify({ _historyDeleting: true, topics: [{ id: 'topic_a' }] }));
    const q = await restart(f); t.after(() => q.dispose());
    await assert.rejects(q.initializeIfMissing(descriptor()), { code: 'HISTORY_OWNER_UNVERIFIED' });
    await assert.rejects(q.write(descriptor(), [{ id: 'old-owner-callback' }]), { code: 'HISTORY_OWNER_UNVERIFIED' });
    await absent(f.file);
});

test('real process exit after manager publishes a new topic allows safe missing-History initialization', async t => {
    const f = await fixture(t), existingBytes = '[ { "id": "preexisting-accepted", "content": "keep original bytes" } ]\n';
    await store(f.file, existingBytes);
    const newTopic = 'crash_created_topic';
    const child = await runChild(f.root, 'config-published', 'create-config', newTopic);
    assert.equal(child.code, 72, JSON.stringify(child));
    const config = JSON.parse(await fs.readFile(f.config, 'utf8'));
    assert.ok(config.topics.some(topic => topic.id === newTopic));
    const newFile = f.queue.getHistoryPath('agent_a', newTopic); await absent(newFile);
    const q = await restart(f); t.after(() => q.dispose());
    const initialized = await q.initializeIfMissing(descriptor(newTopic));
    assert.equal(initialized.status, 'created'); assert.deepEqual(JSON.parse(await fs.readFile(newFile, 'utf8')), []);
    assert.equal(await fs.readFile(f.file, 'utf8'), existingBytes);
    assert.equal((await q.initializeIfMissing(descriptor())).status, 'existing');
    assert.equal(await fs.readFile(f.file, 'utf8'), existingBytes);
});

test('deletion refuses a symlink target before invoking its destructive callback', async t => {
    const f = await fixture(t), external = path.join(f.root, 'owned-synthetic-external');
    const bytes = '[ { "id": "external-accepted", "content": "keep exact bytes" } ]\n';
    await fs.mkdir(external); await fs.writeFile(path.join(external, 'history.json'), bytes);
    await fs.mkdir(path.dirname(path.dirname(f.file)), { recursive: true });
    await fs.symlink(external, path.dirname(f.file));
    let called = false;
    await assert.rejects(f.queue.deleteHistory(descriptor(), async () => {
        called = true; await fs.unlink(path.join(external, 'history.json'));
    }), { code: 'UNSAFE_HISTORY_ANCESTOR' });
    assert.equal(called, false); assert.equal(await fs.readFile(path.join(external, 'history.json'), 'utf8'), bytes);
});

test('bounded queue drain returns pending without deleting or unlocking in-flight work', async t => {
    const f = await fixture(t, { deletionDrainTimeoutMs: 20 }), entered = deferred(), release = deferred();
    const bytes = '[{"id":"accepted-before-pending-delete"}]'; await store(f.file, bytes);
    const blocker = f.queue.run(descriptor(), async () => { entered.resolve(); await release.promise; }); await entered.promise;
    let callbacks = 0;
    const operation = async () => {
        callbacks++; await fs.writeFile(f.config, JSON.stringify({ topics: [{ id: 'topic_b' }], _historyDeletedTopics: ['topic_a'] }));
        await fs.rm(path.dirname(f.file), { recursive: true }); return { success: true };
    };
    const pending = await caught(() => f.queue.deleteHistory(descriptor(), operation));
    assert.equal(pending.error?.code, 'HISTORY_DELETE_DRAIN_PENDING'); assert.equal(pending.error?.status, 'pending');
    assert.equal(callbacks, 0); assert.equal(await fs.readFile(f.file, 'utf8'), bytes);
    const late = caught(() => f.queue.write(descriptor(), [{ id: 'must-stay-fenced' }]));
    release.resolve(); await blocker;
    assert.equal((await late).error?.code, 'HISTORY_DELETION_FENCED'); assert.equal(await fs.readFile(f.file, 'utf8'), bytes);
    assert.equal((await f.queue.deleteHistory(descriptor(), operation)).success, true); assert.equal(callbacks, 1); await absent(f.file);
});

test('bounded deletion preparation preserves pending facts and supports same-entry continuation', async t => {
    const f = await fixture(t, { deletionDrainTimeoutMs: 20 }), prepared = deferred();
    const bytes = '[{"id":"accepted-before-pending-source-prepare"}]'; await store(f.file, bytes);
    let preparations = 0, callbacks = 0, commits = 0, failures = 0;
    const ticket = { commit: async () => { commits++; }, failed: async () => { failures++; } };
    f.queue.configureSync({ isEnabled: () => false, beginDelete: async () => { preparations++; return preparations === 1 ? prepared.promise : ticket; } });
    const operation = async () => { callbacks++; await fs.unlink(f.file); return { success: true }; };
    const pending = await caught(() => f.queue.deleteHistory(descriptor(), operation));
    assert.equal(pending.error?.code, 'HISTORY_DELETE_DRAIN_PENDING'); assert.equal(pending.error?.status, 'pending');
    assert.equal(callbacks, 0); assert.equal(commits, 0); assert.equal(failures, 0);
    assert.equal(await fs.readFile(f.file, 'utf8'), bytes);
    await assert.rejects(f.queue.write(descriptor(), [{ id: 'must-not-pass-pending-prepare' }]), { code: 'HISTORY_DELETION_FENCED' });
    prepared.resolve(ticket); await new Promise(resolve => setImmediate(resolve));
    assert.equal((await f.queue.deleteHistory(descriptor(), operation)).success, true);
    assert.equal(callbacks, 1); assert.equal(commits, 1); assert.equal(failures, 0); await absent(f.file);
});

for (const code of ['EXDEV', 'ENOTSUP']) {
    test(`create-only ${code} failure never falls back to replacing rename`, async t => {
        const f = await fixture(t), link = fsExtra.link, rename = fsExtra.rename;
        let links = 0, renames = 0;
        fsExtra.link = async () => { links++; throw Object.assign(new Error(`synthetic ${code} from actual publication primitive`), { code }); };
        fsExtra.rename = async (...args) => { renames++; return rename(...args); };
        try {
            const outcome = await caught(() => f.queue.initializeIfMissing(descriptor()));
            assert.equal(outcome.error?.code, code); assert.equal(outcome.error?.status, 'failure'); assert.equal(outcome.value, undefined);
            assert.equal(links, 1); assert.equal(renames, 0, 'unsupported no-replace publication must not degrade to rename');
            await absent(f.file);
            assert.deepEqual(await fs.readdir(path.dirname(f.file)), [], 'only the initializer-owned unpublished temporary file is cleaned');
        } finally { fsExtra.link = link; fsExtra.rename = rename; }
    });
}

test('real parent FileHandle.sync EIO reports unknown and retains complete target without a created success', async t => {
    const f = await fixture(t), open = fs.open, directory = path.dirname(f.file);
    let syncAttempts = 0;
    fs.open = async function(file, flags, ...args) {
        const handle = await open.call(this, file, flags, ...args);
        if (file === directory && flags === 'r') {
            handle.sync = async () => { syncAttempts++; throw Object.assign(new Error('synthetic parent directory fsync failure'), { code: 'EIO' }); };
        }
        return handle;
    };
    let outcome;
    try { outcome = await caught(() => f.queue.initializeIfMissing(descriptor())); }
    finally { fs.open = open; }
    assert.equal(syncAttempts, 1); assert.equal(outcome.error?.status, 'unknown'); assert.equal(outcome.error?.code, 'HISTORY_PUBLISH_OUTCOME_UNKNOWN');
    assert.equal(outcome.error?.cause?.code, 'EIO'); assert.equal(outcome.value, undefined, 'directory sync failure cannot return created success');
    const bytes = await fs.readFile(f.file); assert.deepEqual(JSON.parse(bytes), []);
    assert.deepEqual(await fs.readdir(directory), ['history.json']);
    const before = await fs.lstat(f.file, { bigint: true });
    const recovered = await f.queue.initializeIfMissing(descriptor()); assert.equal(recovered.status, 'existing'); assert.equal(recovered.created, false);
    const after = await fs.lstat(f.file, { bigint: true });
    assert.deepEqual(await fs.readFile(f.file), bytes); assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs); assert.equal(after.ctimeNs, before.ctimeNs);
});

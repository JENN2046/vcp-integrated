'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fork, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BOX, CHAT } = require('./fixtures/paths.cjs');

const baseline = process.env.VCP_UPGRADE_BASE || 'c837e2a7f26453b99b67996b6eb79db94a72c62e';
assert.match(baseline, /^[a-f0-9]{40}$/);
const repo = path.resolve(__dirname, '../..');
const worker = path.join(__dirname, 'recovery-worker.cjs');

test('the baseline and candidate preserve interrupted execution and sync progress across upgrade and isolated code rollback', { timeout: 45000 }, async t => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-recovery-'));
    t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
    const data = path.join(scratch, 'synthetic');
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, 'L4-SYNTHETIC-ONLY'), 'NativeSync L4 synthetic process fixture\n');
    const bundle = path.join(scratch, 'baseline.tar');
    assert.equal(spawnSync('git', ['archive', '-o', bundle, baseline, 'apps/server', 'apps/desktop'], { cwd: repo }).status, 0);
    assert.equal(spawnSync('tar', ['-xf', bundle, '-C', scratch]).status, 0);
    fs.unlinkSync(bundle);
    const server = path.join(scratch, 'apps/server');
    const desktop = path.join(scratch, 'apps/desktop');
    fs.symlinkSync(path.join(BOX, 'node_modules'), path.join(server, 'node_modules'));
    fs.symlinkSync(path.join(CHAT, 'node_modules'), path.join(desktop, 'node_modules'));

    async function run(phase, candidate = false) {
        const child = fork(worker, [phase, data], {
            cwd: scratch,
            execArgv: ['--require', path.join(__dirname, 'fixtures/loopback.cjs')],
            env: { ...process.env, HOME: scratch, VCP_COLLABORATION_SERVER: candidate ? BOX : server, VCP_COLLABORATION_DESKTOP: candidate ? CHAT : desktop },
            stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        });
        let result, failure, intermediate;
        const stopped = once(child, 'exit');
        const limit = setTimeout(() => child.kill('SIGKILL'), 12000);
        child.on('message', report => {
            if (report.intermediate) intermediate = report.intermediate;
            if (report.failure) failure = report.failure;
            if (report.result) {
                result = report.result;
                if (phase === 'crash') child.kill('SIGKILL');
            }
        });
        try {
            const [code, signal] = await stopped;
            assert.equal(failure, undefined);
            assert.ok(result, phase + ' returned a durable snapshot');
            assert.deepEqual([code, signal], phase === 'crash' ? [null, 'SIGKILL'] : [0, null]);
            return { ...result, intermediate };
        } finally { clearTimeout(limit); }
    }

    const initial = await run('baseline');
    const crash = await run('crash');
    const upgraded = await run('upgrade', true);
    const rolledBack = await run('rollback');

    assert.equal(initial.modelCalls, 1);
    assert.equal(initial.journal.length, 2);
    assert.ok(Object.keys(initial.ack).length >= 2, 'the committed baseline has durable acknowledgements');
    assert.ok(Object.values(initial.topicCursors ?? {}).some(cursor => cursor >= 2), 'the committed baseline has an advanced topic cursor');
    assert.equal(crash.modelCalls, 1);
    assert.equal(crash.journal.length, 3);
    assert.deepEqual(crash.journal.slice(0, 2), initial.journal);
    assert.deepEqual(crash.history.slice(0, 2), initial.history);
    assert.deepEqual(crash.pending, upgraded.intermediate && {
        requestId: upgraded.intermediate.requestId,
        inputId: upgraded.intermediate.inputId,
        phase: upgraded.intermediate.phase,
        admitStarted: upgraded.intermediate.admitStarted,
    });
    assert.equal(upgraded.intermediate.modelCalls, 0);
    assert.deepEqual(upgraded.journal, crash.journal);
    assert.deepEqual(upgraded.native.map(row => row.id), crash.native.map(row => row.id));
    for (const [key, ack] of Object.entries(initial.ack)) {
        assert.deepEqual(upgraded.ack[key], ack, 'recovery retains each committed acknowledgement');
    }
    assert.ok(upgraded.cursor >= initial.cursor);
    assert.ok(Object.values(upgraded.topicCursors ?? {}).some(cursor => cursor >= 3), 'reconciled History advances its topic cursor');
    assert.deepEqual(upgraded.history.map(row => row.id), upgraded.journal.map(row => row.msg_id));
    assert.deepEqual(rolledBack.journal, upgraded.journal);
    assert.deepEqual(rolledBack.history, upgraded.history);
    assert.deepEqual(rolledBack.ack, upgraded.ack);
    assert.deepEqual(rolledBack.topicCursors, upgraded.topicCursors);
    assert.equal(rolledBack.cursor, upgraded.cursor);
    assert.deepEqual(rolledBack.pending, upgraded.pending);
    assert.deepEqual(rolledBack.jobs, upgraded.jobs);
    assert.deepEqual(rolledBack.native, upgraded.native);
    assert.equal(upgraded.modelCalls + rolledBack.modelCalls, 0);
    if (process.env.VCP_UPGRADE_EVIDENCE) {
        const revision = spawnSync('git', ['rev-parse', 'HEAD'], {cwd:repo, encoding:'utf8'}).stdout.trim();
        const summary = state => ({
            modelCalls:state.modelCalls, pending:state.pending, cursor:state.cursor, topicCursors:state.topicCursors,
            historyIds:state.history.map(m=>m.id), journal:state.journal.map(({seq,msg_id})=>({seq,msg_id})),
            native:state.native, jobs:state.jobs, ackCount:Object.keys(state.ack).length,
        });
        fs.writeFileSync(process.env.VCP_UPGRADE_EVIDENCE, JSON.stringify({
            baseline,revision,initial:summary(initial),crash:summary(crash),upgraded:summary(upgraded),rolledBack:summary(rolledBack),
            identicalOnRollback:['journal','history','ack','topicCursors','cursor','pending','jobs','native'],
        }, null, 2) + '\n');
    }
    t.diagnostic('Baseline normal exit → baseline SIGKILL after native dispatch → candidate recovery → baseline rollback. Original pending input and unknown native work retained, no repeat dispatch.');
});

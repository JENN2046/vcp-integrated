'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { backup, DatabaseSync } = require('node:sqlite');
const { setTimeout: delay } = require('node:timers/promises');
const { startFixture, waitUntil } = require('../aa-delegation/fixture.cjs');
const { createFixture } = require('../group-relay/fixture.cjs');
const { launch, mobileControl, openPwa } = require('../group-relay/pwa.cjs');

const candidate = path.resolve(__dirname, '../..');
const baseline = 'f00aa6d256a2bb7ef7fbc65fb2002728be7fea5c';
const [scenario, historicalPath, output] = process.argv.slice(2);
const observationDelayMs = 4400;
const git = (...args) => execFileSync('git', args, { cwd: candidate, encoding: 'utf8' }).trim();
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const digest = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const toolDb = 'config/tool-call-records.sqlite3';
const changedCode = 'apps/server/Plugin/NativeSync/';

function read(file, fn) {
    const db = new DatabaseSync(file, { readOnly: true });
    try { return fn(db); }
    finally { db.close(); }
}

async function copySqlite(from, to) {
    const db = new DatabaseSync(from, { readOnly: true });
    try { await backup(db, to); }
    finally { db.close(); }
}

function fingerprint(dbPath) {
    const { dev, ino } = fs.statSync(dbPath);
    return {
        dev, ino, main: hash(dbPath),
        wal: fs.existsSync(dbPath + '-wal') ? hash(dbPath + '-wal') : null,
    };
}

function snapshot(file, workId) {
    return read(file, db => {
        const job = db.prepare('SELECT * FROM mobile_executions WHERE id=?').get(workId);
        assert.ok(job);
        const one = sql => db.prepare(sql).get(workId);
        const all = sql => db.prepare(sql).all(workId);
        return {
            job: { state: job.state, errorCode: job.error_code, terminalState: job.terminal_state, reviewResolved: job.review_resolved },
            identity: { workId, topic: job.topic_key, requestId: job.request_id, userMessageId: job.user_message_id },
            submission: JSON.parse(job.request_payload),
            spaceId: db.prepare("SELECT value FROM native_sync_metadata WHERE key='spaceId'").get().value,
            admission: one('SELECT state,native_terminal,reply_seq FROM shared_admissions WHERE id=?'),
            speakers: all('SELECT * FROM shared_native_requests WHERE admission_id=? ORDER BY ordinal'),
            child: all('SELECT * FROM shared_native_child_requests WHERE work_id=? ORDER BY id'),
            tasks: all('SELECT * FROM mobile_native_tasks WHERE execution_id=? ORDER BY native_task_id'),
            invocations: all('SELECT * FROM mobile_native_invocations WHERE execution_id=? ORDER BY invocation_id'),
            ledger: all('SELECT id,step_index,state,attempts,reply_message_id FROM mobile_execution_steps WHERE job_id=? ORDER BY step_index'),
            history: db.prepare('SELECT * FROM messages WHERE topic_id=? ORDER BY last_seq').all(job.topic_key),
            journal: db.prepare('SELECT * FROM journal WHERE topic_id=? ORDER BY seq').all(job.topic_key),
        };
    });
}

function toolRecords(file) {
    return read(file, db => db.prepare('SELECT id,tool_name,status,success FROM tool_call_records ORDER BY id').all());
}

function evidence(state) {
    return {
        ...state.job, admission: state.admission, ids: state.identity,
        speakerRequests: state.speakers.map(({ id, state, ordinal }) => ({ id, state, ordinal })),
        childRequests: state.child.map(({ id, state, task_id }) => ({ id, state, taskId: task_id })),
        tasks: state.tasks.map(({ native_task_id, result_hash, state }) => ({ id: native_task_id, state, resultHash: result_hash })),
        invocations: state.invocations.map(({ invocation_id, record_id, state }) => ({ id: invocation_id, state, recordId: record_id })),
        ledger: state.ledger,
        history: { count: state.history.length, sha256: digest(state.history) },
        journal: { sha256: digest(state.journal), messages: state.journal.map(({ seq, msg_id }) => ({ seq, id: msg_id })) },
    };
}

async function main() {
    assert.ok(['early', 'late'].includes(scenario) && historicalPath && output,
        'Usage: node tests/group-settlement/upgrade.cjs early|late .runs/<historical-fixture> <receipt.json>');
    const source = fs.realpathSync(historicalPath);
    assert.ok(source.startsWith(path.join(candidate, '.runs/vcp-stage-uncut-')));
    assert.equal(fs.readFileSync(path.join(source, 'seed/L4-SYNTHETIC-ONLY'), 'utf8'),
        'NativeSync L4 synthetic process fixture\n');
    const historical = JSON.parse(fs.readFileSync(path.join(source, 'receipt.json')));
    const trackedReceipt = require('../../docs/evidence/stage-review/uncut' + (scenario === 'early' ? '-early' : '') + '.json');
    assert.deepEqual(historical, trackedReceipt);
    assert.equal(historical.revision, baseline);
    const sourceDb = path.join(source, 'data/central.sqlite');
    const sourceBox = path.join(source, 'runtime-box');
    const sourceTools = path.join(sourceBox, toolDb);
    const sourceFingerprint = fingerprint(sourceDb);
    const sourceToolFingerprint = fingerprint(sourceTools);
    const before = snapshot(sourceDb, historical.workId);
    assert.equal(before.identity.requestId, historical.requestId);
    assert.deepEqual(before.submission, { requestId: historical.requestId, text: 'AA_DELEGATION_COMPLETE' });
    const old = scenario === 'late' ? historical.afterChildReturns : historical.after;
    assert.equal(before.job.state, old.job.state);
    assert.equal(before.job.errorCode, old.job.error_code);
    assert.deepEqual(before.ledger.map(({ id, ...row }) => row), old.ledger);
    assert.deepEqual(before.journal.map(({ seq, msg_id, action }) => ({ seq, msg_id, action })), old.journal);
    const native = before.tasks[0];
    assert.equal(before.tasks.length, 1);
    assert.equal(native.plugin_name, 'AgentAssistant');
    assert.equal(native.agent_base_name, 'SYNTHETIC');
    assert.equal(native.native_task_id, old.task.native_task_id);
    assert.match(native.native_task_id, /^aa-delegation-\d+-[a-f0-9]+$/);
    const nativeFiles = [
        'file/document/AgentTask/' + native.native_task_id + '.native.json',
        'file/document/AgentTask/SYNTHETIC_' + native.native_task_id + '.md',
        'VCPAsyncResults/AgentAssistant-' + native.native_task_id + '.json',
    ];
    const archiveHashes = Object.fromEntries(nativeFiles.map(file => [file, hash(path.join(sourceBox, file))]));
    const proof = JSON.parse(fs.readFileSync(path.join(sourceBox, nativeFiles[0])));
    assert.equal(proof.resultRef, nativeFiles[1]);
    assert.equal(proof.resultHash, native.result_hash);
    assert.equal(proof.archiveHash, archiveHashes[nativeFiles[1]]);
    const oldTools = toolRecords(sourceTools);
    assert.equal(oldTools.length, 1);
    assert.equal(oldTools[0].id, native.record_id);
    assert.equal(oldTools[0].tool_name, 'AgentAssistant');

    const out = fs.mkdtempSync(path.join(candidate, '.runs', 'group-settlement-upgrade-'));
    console.log('Historical ' + scenario + ' upgrade fixture ' + out);
    const relay = createFixture();
    relay.finishFutureRounds();
    const runtimeDb = path.join(out, 'data/central.sqlite');
    const box = path.join(out, 'runtime-box');
    const runtimeTools = path.join(box, toolDb);
    const sourceHashes = {};
    const receipt = {
        scenario, baseline, candidateBaseRevision: git('rev-parse', 'HEAD'), node: process.version,
        historicalFixture: path.relative(candidate, source), isolatedFixture: path.relative(candidate, out),
        sourceFingerprint, archiveHashes,
        historical: evidence(before), receiverToolRecords: { before: oldTools },
    };
    let fx, browser;
    try {
        fx = await startFixture({
            out, candidate, serverRevision: baseline, groupRelay: relay, singleChildRound: true,
            selectParent: body => body.messages.some(message =>
                message.role === 'system' && JSON.stringify(message.content).includes('GROUP_RELAY_MEMBER_C')),
            expectedStartupError: scenario === 'late' ? /failed to initialize NativeSync/ : undefined,
            async restoreSyntheticState({ box, data }) {
                assert.equal(path.join(data, 'central.sqlite'), runtimeDb);
                await copySqlite(sourceDb, runtimeDb);
                await copySqlite(sourceTools, runtimeTools);
                for (const file of nativeFiles) {
                    const to = path.join(box, file);
                    fs.mkdirSync(path.dirname(to), { recursive: true });
                    fs.copyFileSync(path.join(sourceBox, file), to, fs.constants.COPYFILE_EXCL);
                    assert.equal(hash(to), archiveHashes[file]);
                }
                assert.deepEqual(snapshot(runtimeDb, historical.workId), before);
                assert.notEqual(fs.statSync(runtimeDb).ino, sourceFingerprint.ino);
                receipt.snapshotFingerprint = fingerprint(runtimeDb);
            },
        });
        const { service, cert } = fx;
        const mobileBuild = path.join(box, 'Plugin/NativeSync/mobile-dist');
        const index = path.join(mobileBuild, 'index.html');
        const bundle = fs.readFileSync(index, 'utf8').match(/<script[^>]+src="([^"]+\.js)"/)?.[1];
        assert.ok(bundle?.startsWith('/mobile/'));
        receipt.mobileBuild = { indexSha256: hash(index), bundle, bundleSha256: hash(path.join(mobileBuild, bundle.slice('/mobile/'.length))) };
        const logs = fs.readFileSync(path.join(out, 'backend.log'), 'utf8');
        if (scenario === 'late') {
            assert.match(logs, /Error initializing module for NativeSync: SHARED_NATIVE_TERMINAL_REQUIRED/);
            assert.match(logs, /at Object\.recover .*groupTurn\.js:/);
        } else {
            assert.equal(snapshot(runtimeDb, historical.workId).job.state, 'review_required');
            assert.equal((await service.checkMobile()).connectionStatus, 200);
        }
        assert.deepEqual(snapshot(runtimeDb, historical.workId), before);
        assert.deepEqual(service.calls, []);
        assert.deepEqual(toolRecords(runtimeTools), oldTools);
        receipt.baselineBoot = { ready: !service.startupError, errorCode: scenario === 'late' ? 'SHARED_NATIVE_TERMINAL_REQUIRED' : null };
        for (const [file, sha256] of Object.entries(historical.sourceHashes)) {
            assert.equal(hash(path.join(box, 'Plugin/NativeSync', file)), sha256);
        }
        receipt.baselineBoot.sourceHashes = historical.sourceHashes;
        const files = git('diff', baseline, '--name-only', '--', changedCode).split('\n').filter(Boolean);
        assert.ok(files.includes(changedCode + 'mobile/groupTurn.js'), 'expected working-tree settlement changes');
        const baselinePid = service.backendPid;
        const stopped = await service.restartWithUpgrade(() => {
            const beforeSwap = fingerprint(runtimeDb);
            assert.equal(beforeSwap.ino, receipt.snapshotFingerprint.ino);
            for (const file of files) {
                assert.ok(file.startsWith(changedCode) && file.endsWith('.js'));
                const target = path.join(box, file.slice('apps/server/'.length));
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.copyFileSync(path.join(candidate, file), target);
                sourceHashes[file] = hash(target);
            }
            const afterSwap = fingerprint(runtimeDb);
            assert.deepEqual(afterSwap, beforeSwap);
            receipt.codeSwap = { before: beforeSwap, after: afterSwap, sourceHashes };
        });
        assert.deepEqual(stopped, { code: 0, signal: null });
        assert.notEqual(service.backendPid, baselinePid);

        assert.equal((await service.checkMobile()).connectionStatus, 200);
        await waitUntil(() => snapshot(runtimeDb, historical.workId).job.state === 'completed', 'historical work settles after upgrade');
        assert.equal(fs.statSync(runtimeDb).ino, receipt.snapshotFingerprint.ino);
        const upgraded = snapshot(runtimeDb, historical.workId);
        assert.equal(upgraded.job.errorCode, null);
        assert.equal(upgraded.job.reviewResolved, before.job.reviewResolved);
        for (const key of ['identity', 'submission', 'history', 'journal', 'speakers', 'child', 'tasks', 'invocations', 'ledger']) {
            assert.deepEqual(upgraded[key], before[key], key + ' must be preserved on settlement');
        }
        assert.deepEqual(upgraded.admission, { __proto__: null, ...before.admission, state: 'completed', native_terminal: 1 });
        const serverRequire = createRequire(path.join(candidate, 'apps/server/package.json'));
        browser = await launch(serverRequire('puppeteer'), cert);
        receipt.browser = await browser.version();
        const owner = await openPwa({
            browser, service, request: mobileControl(service, cert, out, before.spaceId),
            topic: before.identity.topic, execute: true,
        });
        const route = 'conversations/' + owner.topic;
        const execution = await owner.request(route + '/execution-request?' + new URLSearchParams({ requestId: historical.requestId }));
        assert.equal(execution.status, 200);
        assert.deepEqual(execution.data.executions.map(({ id, state }) => ({ id, state })), [{ id: historical.workId, state: 'completed' }]);
        const pwaHistory = await owner.request(route + '?after=0');
        assert.equal(pwaHistory.status, 200);
        assert.deepEqual(pwaHistory.data.messages.map(row => row.id), before.history.map(row => row.msg_id));
        const nativeResult = await owner.request(route + '/executions/' + historical.workId +
            '/native-tasks/' + native.native_task_id + '/result');
        assert.equal(nativeResult.status, 200);
        assert.equal(nativeResult.data.content, fx.childReport);
        assert.equal(nativeResult.data.task.resultHash, native.result_hash);
        await delay(observationDelayMs);
        assert.deepEqual(snapshot(runtimeDb, historical.workId), upgraded);
        assert.deepEqual(owner.writes, []);
        assert.deepEqual(service.calls, []);
        assert.deepEqual(toolRecords(runtimeTools), oldTools);
        receipt.upgrade = { nativeSyncReady: true, ...evidence(upgraded),
            observationDelayMs, pwaWrites: owner.writes.length, receiverModelCalls: service.calls.length,
            receiverToolCalls: toolRecords(runtimeTools).length - oldTools.length,
            nativeArchive: { http: nativeResult.status, resultHash: nativeResult.data.task.resultHash } };

        fx.release(fx.markers.desktop);
        const next = await owner.request(route + '/messages', { requestId: randomUUID(), text: fx.markers.desktop });
        assert.equal(next.status, 202);
        assert.notEqual(next.data.id, historical.workId);
        await waitUntil(() => snapshot(runtimeDb, next.data.id).job.state === 'completed', 'explicit new group round completes');
        const nextState = snapshot(runtimeDb, next.data.id);
        assert.deepEqual(nextState.journal.slice(0, before.journal.length), before.journal);
        assert.deepEqual(nextState.history.slice(0, before.history.length), before.history);
        assert.equal(nextState.journal.length, before.journal.length + 4);
        assert.equal(nextState.history.length, before.history.length + 4);
        const modelCalls = service.calls.map(({ member, role, round }) => member || role + ':' + round);
        assert.deepEqual([...modelCalls].sort(), ['A', 'B', 'child:1', 'parent:1', 'parent:2'],
            'fresh group reaches registered Provider');
        assert.deepEqual(service.calls.filter(row => row.role).map(row => row.marker), Array(3).fill(fx.markers.desktop));
        const afterTools = toolRecords(runtimeTools);
        assert.equal(afterTools.length, oldTools.length + 1);
        assert.deepEqual(afterTools.find(row => row.id === oldTools[0].id), oldTools[0]);
        const newTool = afterTools.find(row => row.id !== oldTools[0].id);
        assert.equal(newTool.tool_name, 'AgentAssistant');
        assert.deepEqual(nextState.invocations.map(row => row.record_id), [newTool.id]);
        assert.deepEqual(nextState.tasks.map(row => row.state), ['completed']);
        assert.deepEqual(fingerprint(sourceDb), sourceFingerprint);
        assert.deepEqual(fingerprint(sourceTools), sourceToolFingerprint);
        for (const [file, sha256] of Object.entries(archiveHashes)) assert.equal(hash(path.join(sourceBox, file)), sha256);
        receipt.historicalSourcesUnchanged = true;
        receipt.receiverToolRecords.afterExplicitRound = afterTools;
        receipt.next = { http: next.status, ...evidence(nextState), receiverModelCalls: modelCalls };
    } finally {
        await browser?.close();
        await fx?.close();
    }
    receipt.loaded = JSON.parse(fs.readFileSync(path.join(out, 'backend-loaded.json')));
    for (const [file, sha256] of Object.entries(sourceHashes)) {
        const loaded = receipt.loaded.find(item => item.file === file);
        assert.equal(loaded?.sha256, sha256, file + ' loaded the staged candidate');
    }
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
    console.log('Verified historical ' + scenario + ' upgrade in ' + output);
}

main().catch(error => { console.error(error); process.exitCode = 1; });

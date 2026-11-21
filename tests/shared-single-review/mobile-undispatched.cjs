'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync, spawnSync} = require('node:child_process');

const integrated = path.resolve(__dirname, '../..');
const fixtureDir = path.join(integrated, 'tests/collaboration/fixtures');
const origin = 'https://synthetic-shared.invalid';
const request = {requestId: 'mobile-recovery-replay', text: 'Synthetic PWA shared turn'};
const localTopic = {key: 'local-only', ownerType: 'agent', ownerId: 'local-agent', topicId: 'local-topic', agentAlias: 'local', model: 'synthetic'};
const localAgent = {isAgent: () => true, getAgentPrompt: () => 'SYNTHETIC_LOCAL_PROMPT'};
const pwaHeaders = {origin, 'x-forwarded-proto': 'https', 'x-nativesync-capabilities': 'shared-space-v1', 'content-type': 'application/json'};
const sources = JSON.stringify(['A', 'B'].map(x => ({sourceId: 'source' + x, deviceId: 'device' + x, executionMode: 'all-supported'})));
const spaces = JSON.stringify([{id: 'sharedAB', sources: ['sourceA', 'sourceB']}]);
const portalConfig = local => ({
    NativeSyncFullSources: sources, NativeSyncSharedSpaces: spaces, NativeMobileOrigin: origin,
    NativeMobileConfigSync: !local, NativeMobileTopics: JSON.stringify(local ? [localTopic] : []),
    NativeMobileStartDelayMs: 10000,
});

function snapshot(store, engine, workId, count) {
    const row = engine.get(workId);
    return {
        workId: row.id, kind: row.kind, state: row.state, attempts: row.attempts,
        dispatch: row.request_dispatched, cancelled: Boolean(row.cancel_requested), error: row.error_code,
        userMessageId: row.user_message_id, userSeq: row.user_seq, replyMessageId: row.reply_message_id,
        admission: store.db.prepare('SELECT state,dispatched,native_terminal,user_seq,reply_seq FROM shared_admissions WHERE id=?').get(workId),
        native: store.db.prepare('SELECT state FROM shared_native_requests WHERE admission_id=?').get(workId)?.state ?? null,
        journal: store.db.prepare('SELECT seq,msg_id FROM journal ORDER BY seq').all(),
        providerCalls: count(),
    };
}

async function crash(cutpoint) {
    const {fixture, ctx} = require(path.join(fixtureDir, 'sharedSingleHarness.cjs'));
    const f = await fixture({diagnostic() {}, after() {}});
    let cookie, receipt, engine = f.portal.engine, topic = f.topic.id;
    if (cutpoint === 'unshared') {
        const server = process.env.VCP_COLLABORATION_SERVER;
        const {MobilePortal} = require(server + '/Plugin/NativeSync/mobile/portal');
        const localPortal = new MobilePortal({store: f.store, config: portalConfig(true), agentManager: localAgent});
        engine = localPortal.engine;
        topic = localTopic.key;
        f.control.beforeRequest = (req, res, next) => {
            req.url = req.url.slice('/mobile'.length);
            return localPortal.router(req, res, next);
        };
        const pair = await fetch(f.url + '/mobile/api/pair', {method: 'POST', headers: pwaHeaders,
            body: JSON.stringify({code: localPortal.createPairing().pairingCode})});
        assert.equal(pair.status, 200);
        cookie = pair.headers.get('set-cookie').split(';')[0];
        const posted = await fetch(f.url + '/mobile/api/conversations/' + topic + '/messages',
            {method: 'POST', headers: {...pwaHeaders, cookie}, body: JSON.stringify(request)});
        receipt = await posted.json();
        assert.equal(posted.status, 202, JSON.stringify(receipt));
    } else {
        f.control.beforeRequest = (req, _res, next) => { cookie ||= req.headers.cookie; next(); };
        const phone = await f.phone();
        receipt = await phone.call('/conversations/' + topic + '/messages', request, 202);
        if (cutpoint === 'cancelled') await phone.call('/executions/' + receipt.id + '/cancel', {}, 202);
    }
    const emitAndKill = () => {
        fs.writeSync(1, JSON.stringify({
            root: f.root, cookie, topic,
            before: snapshot(f.store, engine, receipt.id, f.calls),
        }) + '\n');
        process.kill(process.pid, 'SIGKILL');
    };
    if (cutpoint === 'intent') {
        const fire = engine.fault.bind(engine);
        engine.fault = point => point === 'native-request-dispatch-intent' ? emitAndKill() : fire(point);
    } else if (cutpoint === 'in-flight') {
        f.control.nativeResponder = () => { ctx.assertDispatch(); emitAndKill(); };
    } else if (cutpoint === 'cancelled') {
        emitAndKill();
    } else if (cutpoint === 'unshared') {
        localAgent.getAgentPrompt = emitAndKill;
    } else if (cutpoint === 'before-prepare') {
        const verify = engine.configs.verify.bind(engine.configs);
        engine.configs.verify = (...args) => {
            if (engine.get(receipt.id).state === 'running') emitAndKill();
            return verify(...args);
        };
    } else {
        const register = require(process.env.VCP_COLLABORATION_SERVER + '/Plugin/NativeSync/mobile/sharedSingle');
        const original = register.register;
        register.register = (...args) => {
            const result = original(...args);
            if (cutpoint === 'wrong-principal') {
                engine.db.prepare('UPDATE shared_admissions SET principal=? WHERE id=?').run('mobile:other',receipt.id);
            }
            if (cutpoint === 'wrong-message') {
                engine.db.prepare('UPDATE mobile_executions SET user_message_id=? WHERE id=?').run('mobile_unbound',receipt.id);
            }
            emitAndKill();
            return result;
        };
    }
    engine.db.prepare('UPDATE mobile_executions SET not_before=0 WHERE id=?').run(receipt.id);
    engine.setEndpoint({url: f.url + '/v1/chat/completions', key: 'synthetic-only'});
    setTimeout(() => process.exit(72), 5000);
}

async function restart() {
    const {root, topic, cookie, before, execute} = JSON.parse(fs.readFileSync(0, 'utf8'));
    const server = process.env.VCP_COLLABORATION_SERVER;
    const nativeSync = server + '/Plugin/NativeSync';
    const {CentralStore} = require(nativeSync + '/sync/centralStore');
    const {SourceCatalog} = require(nativeSync + '/sync/sourceCatalog');
    const {SharedSpace} = require(nativeSync + '/sync/sharedSpace');
    const {SharedNative} = require(nativeSync + '/sync/sharedNative');
    const {MobilePortal} = require(nativeSync + '/mobile/portal');
    const {wait, ctx} = require(path.join(fixtureDir, 'sharedSingleHarness.cjs'));
    const express = require(server + '/node_modules/express');
    const local = topic === localTopic.key, config = portalConfig(local);
    const store = new CentralStore(path.join(root, 'central.sqlite'));
    store.sourceCatalog = new SourceCatalog(store, config);
    store.shared = new SharedSpace(store, config);
    const portal = new MobilePortal({store, config, agentManager: local ? localAgent : {isAgent: () => false}});
    const native = new SharedNative(store.shared, portal.engine);
    const release = ctx.setSharedBoundary(native);
    const app = express();
    app.set('trust proxy', 'loopback');
    app.use(express.json());
    app.use('/mobile', portal.router);
    app.use(ctx.middleware);
    let calls = 0;
    for (const route of ['/v1/chat/completions', '/v1/chatvcp/completions']) {
        app.post(route, (_req, res) => {
            ctx.assertDispatch();
            calls++;
            res.json({choices: [{message: {role: 'assistant', content: 'Synthetic reply'}, finish_reason: 'stop'}]});
        });
    }
    const http = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const url = 'http://127.0.0.1:' + http.address().port;
    const headers = {...pwaHeaders, cookie};
    const observe = () => snapshot(store, portal.engine, before.workId, () => calls);
    try {
        const boot = observe();
        const replayResult = await fetch(url + '/mobile/api/conversations/' + topic + '/messages', {method: 'POST', headers, body: JSON.stringify(request)});
        assert.equal(replayResult.status, 202);
        const replayed = await replayResult.json();
        assert.equal(replayed.id, before.workId);
        assert.equal(replayed.replayed, true);
        assert.equal(replayed.state, boot.state);
        portal.engine.setEndpoint({url: url + '/v1/chat/completions', key: 'synthetic-only'});
        if (execute) await wait(() => calls === 1 && observe().state === 'completed', 'recovered PWA completion');
        else await new Promise(resolve => setTimeout(resolve, 250));
        const end = observe();
        process.stdout.write(JSON.stringify({boot, end}) + '\n');
    } finally {
        release();
        native.close();
        await portal.close();
        http.closeAllConnections();
        await new Promise(resolve => http.close(resolve));
        store.close();
    }
}

function run() {
    assert.equal(process.versions.node.split('.')[0], '24', 'Use Node 24');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-pwa-recovery-'));
    const server = path.join(root, 'apps/server');
    const environment = {PATH: process.env.PATH, HOME: root, TMPDIR: root,
        VCP_COLLABORATION_SERVER: server, FIX03_FIXTURE_ROOT: root};
    const spawn = (args, expected, input) => {
        const result = spawnSync(process.execPath, ['--require', path.join(fixtureDir, 'loopback.cjs'), __filename, ...args],
            {cwd: root, encoding: 'utf8', timeout: 10000, env: environment, input});
        assert.equal(result.signal ?? result.status, expected, result.stdout + result.stderr);
        return JSON.parse(result.stdout.trim());
    };
    try {
        const archive = execFileSync('git', ['archive', 'HEAD', 'apps/server'], {cwd: integrated, maxBuffer: 256 * 1024 * 1024});
        execFileSync('tar', ['-x', '-C', root], {input: archive});
        const modified = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', 'apps/server'], {cwd: integrated, encoding: 'utf8'}).trim();
        for (const file of modified.split('\n').filter(Boolean)) fs.copyFileSync(path.join(integrated, file), path.join(root, file));
        for (const rel of ['node_modules', 'Plugin/NativeSync/mobile-dist', 'Plugin/NativeSync/sync/contracts.generated.cjs']) {
            const target = path.join(server, rel);
            if (!fs.existsSync(target)) fs.symlinkSync(path.join(integrated, 'apps/server', rel), target);
        }
        const results = {};
        for (const kind of ['before-prepare', 'prepared', 'intent', 'in-flight', 'cancelled', 'wrong-principal', 'wrong-message', 'unshared']) {
            const evidence = spawn(['crash', kind], 'SIGKILL');
            const {before} = evidence;
            const execute = ['before-prepare', 'prepared'].includes(kind);
            assert.equal(before.kind, null);
            assert.equal(before.state, kind === 'cancelled' ? 'cancelled' : 'running');
            assert.equal(before.dispatch, kind === 'cancelled' ? null : Number(['intent', 'in-flight'].includes(kind)));
            assert.equal(before.providerCalls, Number(kind === 'in-flight'));
            assert.equal(before.native, kind === 'in-flight' ? 'dispatched' : ['before-prepare', 'cancelled', 'unshared'].includes(kind) ? null : 'prepared');
            assert.equal(before.journal.length, 1);
            const first = spawn(['restart'], 0, JSON.stringify({...evidence, execute}));
            const second = spawn(['restart'], 0, JSON.stringify({...evidence, execute: false}));
            const heldState = kind === 'cancelled' ? 'cancelled' : 'review_required';
            assert.equal(first.boot.state, execute ? 'queued' : heldState);
            assert.deepEqual(first.boot.journal, before.journal);
            assert.equal(first.end.state, execute ? 'completed' : heldState);
            assert.equal(first.end.providerCalls, Number(execute));
            assert.equal(first.end.attempts, before.attempts + Number(execute));
            assert.equal(first.end.journal.length, 1 + Number(execute));
            assert.deepEqual(first.end.journal[0], before.journal[0]);
            assert.equal(first.end.replyMessageId, execute ? 'reply_' + before.workId : null);
            assert.deepEqual(second.boot, {...first.end, providerCalls: 0});
            assert.deepEqual(second.end, second.boot);
            results[kind] = {before, first, second};
        }
        console.log(JSON.stringify(results, null, 2));
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
}

(async () => {
    if (process.argv[2] === 'crash') await crash(process.argv[3]);
    else if (process.argv[2] === 'restart') await restart();
    else run();
})().catch(error => { console.error(error); process.exitCode = 1; });

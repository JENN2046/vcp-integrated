'use strict';

// Preload for tests/integration/run.cjs lost-only. Uses its real Electron,
// ToolBox and loopback provider, with fault injection confined to its TLS proxy
// and disposable backend process environment.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const Module = require('node:module');
const path = require('node:path');

// The child hook changes only the disposable fixture's in-memory authority.
// Production grant changes continue through the host's normal configuration.
const livePolicyFile = process.env.NS_WATCH_FAULT_POLICY_FILE;
if (livePolicyFile) {
    const { SharedSpace } = require(path.resolve('Plugin/NativeSync/sync/sharedSpace.js'));
    const resolveDesktop = SharedSpace.prototype.desktop;
    let shared, last;
    SharedSpace.prototype.desktop = function (...args) {
        shared = this;
        return resolveDesktop.apply(this, args);
    };
    const applyFixturePolicy = setInterval(() => {
        if (!shared || !fs.existsSync(livePolicyFile)) return;
        const current = fs.readFileSync(livePolicyFile, 'utf8');
        if (current === last) return;
        const policy = JSON.parse(current);
        shared.readOnly = policy.readOnly;
        if (policy.revoked) shared.grants.get('sharedAB').delete('sourceB');
        last = current;
    }, 20);
    applyFixturePolicy.unref();
    return;
}
const targets = new Map();
const control = {
    watches: [], pulls: [], inspections: [], configReads: 0, cut: false, rejected: 0,
    preload: __filename,
    request(req, res, route) {
        if (req.headers['x-nativesync-device'] !== 'deviceB') return false;
        if (route.endsWith('/shared/info')) this.inspections.push(Date.now());
        if (route.endsWith('/shared/watch')) {
            if (this.cut) {
                this.rejected++;
                res.writeHead(503).end();
                return true;
            }
            const watch = {
                res, at: Date.now(), direct: req.headers['x-ns-fixture-probe'] === '1',
                since: new URL(req.url, 'https://localhost').searchParams.get('since'),
            };
            this.watches.push(watch);
            res.once('close', () => { watch.closed = true; });
            const write = res.write;
            res.write = function (chunk, ...args) {
                watch.initial ||= Date.now();
                return write.call(this, chunk, ...args);
            };
        }
        return false;
    },
    async response(req, upstream, downstream, route) {
        if (req.headers['x-nativesync-device'] !== 'deviceB') return false;
        let gateKey;
        if (route.endsWith('/shared/pull')) {
            this.pulls.push(Date.now());
            gateKey = 'hold';
        } else if (req.method === 'GET' && route.endsWith('/shared/config')) {
            this.configReads++;
            gateKey = 'holdConfig';
        }
        const gate = this[gateKey];
        if (!gate) return false;
        this[gateKey] = null;
        const chunks = [];
        for await (const chunk of upstream) chunks.push(chunk);
        gate.captured = Date.now();
        gate.status = upstream.statusCode;
        downstream.once('close', () => { gate.closedAt = Date.now(); });
        await gate.release.promise;
        if (!downstream.destroyed) downstream.writeHead(upstream.statusCode, upstream.headers).end(Buffer.concat(chunks));
        return true;
    },
    open() { return this.watches.findLast(watch => !watch.direct && watch.initial && !watch.closed); },
};

function replace(source, needle, value) {
    assert.equal(source.split(needle).length, 2, needle);
    return source.replace(needle, value);
}

targets.set('run.cjs', source => {
    source = replace(source, 'out, candidate, cert, key, trace, waitUntil, mode, ordinaryTools:',
        'out, candidate, cert, key, trace, waitUntil, mode, watchFaults:globalThis.nsWatchFaults, ordinaryTools:');
    return replace(source, "path.join(here, './electron.cjs')",
        "globalThis.nsWatchFaults.electronFixture || path.join(here, './electron.cjs')");
});
targets.set('service.cjs', source => {
    source = replace(source, 'expectedStartupError, streamInterrupt, toolHandoff})', 'expectedStartupError, streamInterrupt, toolHandoff, watchFaults})');
    source = replace(source, 'if (handleFixtureRequest &&', 'if (watchFaults?.request(req,res,route)) return;\n        if (handleFixtureRequest &&');
    source = replace(source, 'if (relevant || observeRecoveredRequest) {', 'if (await watchFaults?.response(req,response,res,route)) return;\n            if (relevant || observeRecoveredRequest) {');
    source = replace(source, "'server.js'], {", "...(watchFaults ? ['--require', watchFaults.preload] : []),'server.js'], {");
    source = replace(source, "PORT:String(backendPort)", "...(watchFaults && { NS_WATCH_FAULT_POLICY_FILE:path.join(out,'watch-live-policy.json') }),PORT:String(backendPort)");
    return replace(source, 'ordinaryTools || delegation || groupRelay || toolHandoff?.finalReceipt', 'watchFaults || ordinaryTools || delegation || groupRelay || toolHandoff?.finalReceipt');
});
targets.set('scenario.cjs', source => replace(source, "  if(result.mode==='lost-only'||result.mode==='shutdown-only'){",
    `  if(result.mode==='lost-only'){
        await globalThis.nsWatchFaultScenario({out,result,service,A,B,select,enter,click,history,journal,jobs,posts,calls,messageArea,selection,waitUntil,start,stop,contract,db,sha});
        return;
    }
  if(result.mode==='lost-only'||result.mode==='shutdown-only'){`));

async function scenario({out, result, service, A, B, select, enter, history, journal, jobs, posts, calls, messageArea, selection, waitUntil, start, stop, contract, db, sha}) {
    const subject = 'lostAck';
    const stateFile = path.join(out, 'profile-B', '.native-sync', 'shared', 'sharedAB', 'messages.json');
    const snapshot = () => {
        const { cursor, inbox, outbox, pending } = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        return { cursor, historyIds: history('B', subject).map(row => row.id), inbox: inbox.length, outbox: outbox.length, pending: pending === null };
    };
    const sendTurn = async (turn) => {
        await enter(A, contract.cases.lostAck);
        return waitUntil(() => {
            const rows = journal(subject);
            if (rows.length !== turn * 2) return;
            const work = jobs(subject);
            if (work.some(row => row.state !== 'completed')) return;
            assert.equal(work.length, turn);
            assert.deepEqual(rows.map(row => row.message.role), Array.from({ length: turn }, () => ['user', 'assistant']).flat());
            assert.equal(new Set(rows.map(row => row.msg_id)).size, rows.length);
            return { observedAt: Date.now(), rows: rows.map(row => ({ seq: row.seq, id: row.msg_id, role: row.message.role })) };
        }, 'committed turn ' + turn, 25000);
    };
    const caughtUp = async ({ rows }, label) => {
        const head = db.prepare('SELECT max(seq) AS seq FROM journal').get().seq;
        const expected = { cursor: head, historyIds: rows.map(row => row.id), inbox: 0, outbox: 0, pending: true };
        const actual = await waitUntil(() => {
            const state = snapshot();
            return state.cursor >= head && state.historyIds.length >= expected.historyIds.length && !state.inbox && state;
        }, label, 25000);
        assert.deepEqual(actual, expected);
        return { ...actual, observedAt: Date.now() };
    };
    service.disarmDrop();
    service.releaseLost();
    await select(A, 'A', subject);
    await select(B, 'B', 'preSubmit');
    await waitUntil(() => control.open(), 'B watch ready');
    const before = await caughtUp(await sendTurn(1), 'first B cursor and History');
    await stop('B');
    await waitUntil(() => !control.open(), 'B watch closed');
    const offline = await sendTurn(2);
    assert.deepEqual(snapshot().historyIds, before.historyIds);
    assert.ok(offline.rows.at(-1).seq > snapshot().cursor);
    const gate = control.hold = { release: Promise.withResolvers() };
    const reopening = start('B-reopened', 'B');
    reopening.catch(() => {});
    let raced;
    try {
        await waitUntil(() => gate.captured, 'first reopen pull response held');
        assert.equal(control.open(), undefined);
        raced = await sendTurn(3);
        assert.ok(raced.observedAt >= gate.captured);
    } finally { gate.release.resolve(); }
    const reopened = await reopening;
    assert.equal(result.B.profileDigest, result['B-reopened'].profileDigest);
    const recovered = await caughtUp(raced, 'both offline and racing commits materialized in order');
    assert.equal(recovered.historyIds.length, 6);
    const liveWatch = await waitUntil(() => control.open(), 'B reopened watch ready');
    assert.notEqual((await selection(reopened)).topicId, service.descriptors.B[subject].topicId);
    const verifiedSources = ['sharedRuntime.js', 'sharedWaitClient.js'].map(file =>
        'apps/desktop/modules/services/nativeSync/' + file);
    const loaded = await reopened.command('loaded-sources', { main: verifiedSources, renderer: [] });
    assert.equal(loaded.main.length, verifiedSources.length);
    for (const row of loaded.main) assert.equal(row.sha256, sha(path.join(result.candidate, row.file)));
    const live = await sendTurn(4);
    const liveObserved = await caughtUp(live, 'healthy watch drives fourth turn');
    const wakeMs = liveObserved.observedAt - live.observedAt;
    assert.ok(wakeMs <= 1000, 'healthy watch History wake took ' + wakeMs + 'ms');
    assert.equal(control.open(), liveWatch);

    control.cut = true;
    liveWatch.res.destroy();
    await waitUntil(() => control.rejected > 0, 'B notification-only reconnect rejected');
    const unavailable = await sendTurn(5);
    let restoredAt;
    try {
        const during = await caughtUp(unavailable, 'ordinary sync GET survives notification-only outage');
        assert.ok(during.observedAt >= unavailable.observedAt);
        assert.ok(control.rejected > 0 && control.pulls.some(at => at >= unavailable.observedAt - 250));
    } finally { control.cut = false; restoredAt = Date.now(); }
    const restored = await waitUntil(() => control.open(), 'B watch restored');
    assert.ok(restored.at >= restoredAt);
    const final = await sendTurn(6);
    await caughtUp(final, 'B receives new turn after watch reconnect');
    await select(reopened, 'B', subject);
    await waitUntil(async () => (await messageArea(reopened)).split(contract.completeText).length === 7,
        'B renders six replies once each');
    assert.equal(posts(subject).length, 6);
    assert.equal(calls(subject).length, 6);
    assert.deepEqual(jobs(subject).map(row => row.attempts), Array(6).fill(1));
    result.sharedWatch = {
        sameDesktopProfile: true, cursor: snapshot().cursor, historyIds: snapshot().historyIds, wakeMs,
        offlineCommit: offline.rows.at(-1).seq, duringFirstPullCommit: raced.rows.at(-1).seq,
        notificationOnlyRejected: control.rejected, durableHistoryRows: snapshot().historyIds.length,
        providerCalls: calls(subject).length, submitPosts: posts(subject).length, loadedDesktopSources: loaded.main,
    };

    const binding = JSON.parse(fs.readFileSync(path.join(out, 'profile-B', '.native-sync', 'connection.json')));
    const request = (suffix, body = undefined) => new Promise((resolve, reject) => {
        const req = https.request(service.origin + '/api/v1/sync/shared/' + suffix, {
            ca: fs.readFileSync(path.join(out, 'loopback-cert.pem')), signal: AbortSignal.timeout(22000),
            method: body ? 'POST' : 'GET',
            headers: {
                authorization: 'Bearer synthetic-only', 'x-nativesync-capabilities': 'shared-space-v1,shared-watch-v1', 'x-ns-fixture-probe': '1',
                'x-nativesync-source': binding.sourceId, 'x-nativesync-device': binding.deviceId,
                'x-nativesync-space': binding.spaceId, ...(body && { 'content-type': 'application/json' }),
            },
        }, resolve);
        req.on('error', reject);
        req.end(body ? JSON.stringify(body) : undefined);
    });
    const json = async (response) => {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        return JSON.parse(Buffer.concat(chunks).toString());
    };
    const watch = async (since) => {
        const response = await request('watch?sharedSpaceId=sharedAB' + (since ? '&since=' + since : ''));
        assert.equal(response.statusCode, 200);
        assert.match(response.headers['content-type'], /^text\/event-stream/);
        response.setEncoding('utf8');
        const chunks = response[Symbol.asyncIterator]();
        let buffered = '';
        return {
            async next() {
                while (!buffered.includes('\n\n')) {
                    const { done, value } = await chunks.next();
                    if (done) return null;
                    buffered += value;
                }
                const boundary = buffered.indexOf('\n\n');
                const frame = buffered.slice(0, boundary);
                buffered = buffered.slice(boundary + 2);
                if (frame.startsWith(':')) return this.next();
                const [event, data] = frame.split('\n');
                return { event: event.slice(7), data: JSON.parse(data.slice(6)) };
            },
            close: () => response.destroy(),
        };
    };
    const policy = path.join(out, 'watch-live-policy.json');
    const changePolicy = (value) => {
        fs.writeFileSync(policy + '.new', JSON.stringify(value));
        fs.renameSync(policy + '.new', policy);
        return Date.now();
    };
    const beforeReadOnly = await watch();
    const old = (await beforeReadOnly.next()).data.token;
    const readOnlyAt = changePolicy({ readOnly: true, revoked: false });
    assert.deepEqual(await beforeReadOnly.next(), { event: 'invalidate', data: { reason: 'capabilities_changed' } });
    const readOnlyInvalidateMs = Date.now() - readOnlyAt;
    assert.ok(readOnlyInvalidateMs <= 16000);
    assert.equal(await beforeReadOnly.next(), null);
    assert.equal((await json(await request('info'))).readOnly, true);
    const deniedConfig = await request('config', { sharedSpaceId: 'sharedAB', opId: 'watch-readonly-probe' });
    assert.equal(deniedConfig.statusCode, 409);
    assert.equal((await json(deniedConfig)).error.code, 'SHARED_READ_ONLY');

    const readOnlyWatch = await waitUntil(() => {
        const current = control.open();
        return current?.at >= readOnlyAt && current;
    }, 'read-only desktop watch reconnected');
    const beforeRevocation = await watch();
    assert.equal((await beforeRevocation.next()).event, 'hint');
    // The regular config GET times out after 8 s. Start it late in the
    // heartbeat period so there is time to prove the permission abort first.
    await waitUntil(() => Date.now() - readOnlyWatch.initial >= 10000,
        'late foreground GET falls inside desktop heartbeat deadline', 12000);
    assert.equal(control.open(), readOnlyWatch);
    const renderer = script => reopened.command('eval', script);
    const configCall = 'window.chatAPI.sharedConfigRequest(' + JSON.stringify({
        route: 'shared/config?' + new URLSearchParams({ sharedSpaceId: 'sharedAB', sharedId: service.topics[subject].parentId }),
    }) + ')';
    const late = control.holdConfig = { release: Promise.withResolvers() };
    let revokeInvalidateMs;
    try {
        await renderer('(() => { window.nsLateConfig = ' + configCall + '; return true; })()');
        await waitUntil(() => late.captured, 'ToolBox authorized a foreground config GET before revocation');
        assert.equal(late.status, 200);
        const revokedAt = changePolicy({ readOnly: true, revoked: true });
        assert.deepEqual(await beforeRevocation.next(), { event: 'invalidate', data: { reason: 'authorization_lost' } });
        revokeInvalidateMs = Date.now() - revokedAt;
        assert.ok(revokeInvalidateMs <= 16000);
        assert.equal(await beforeRevocation.next(), null);
        await waitUntil(async () => (await renderer('window.chatAPI.sharedConfigContext()'))?.error === 'SHARED_WATCH_PERMISSION_REQUIRED',
            'revocation invalidates the actual desktop renderer bridge');
        await waitUntil(() => late.closedAt, 'desktop aborts the pending foreground config GET');
        assert.ok(late.closedAt - late.captured < 7500, 'permission abort precedes the normal request timeout');
    } finally { late.release.resolve(); }
    const lateConfig = await renderer('window.nsLateConfig');
    assert.equal(lateConfig.success, false);
    assert.equal(lateConfig.object, undefined);
    const configReads = control.configReads;
    const deniedForeground = await renderer(configCall);
    assert.equal(deniedForeground.error, 'SHARED_WATCH_PERMISSION_REQUIRED');
    assert.equal(control.configReads, configReads, 'revoked foreground config reads stop at the desktop bridge');
    const target = service.descriptors.B[subject];
    const status = await renderer('window.chatAPI.getNativeExecutionStatus(' +
        [target.itemId, 'agent', target.topicId, true].map(value => JSON.stringify(value)).join(',') + ')');
    assert.equal(status.configurationError, 'SHARED_WATCH_PERMISSION_REQUIRED');
    assert.deepEqual(status.executions, []);
    const deniedWatch = await request('watch?sharedSpaceId=sharedAB');
    assert.equal(deniedWatch.statusCode, 403);
    assert.equal((await json(deniedWatch)).error.code, 'SHARED_SPACE_NOT_APPROVED');

    await service.restartWithUpgrade(() => fs.rmSync(policy));
    const rejoined = await watch(old);
    const refreshed = await rejoined.next();
    assert.equal(refreshed.event, 'hint');
    assert.notEqual(refreshed.data.token.split('.')[0], old.split('.')[0]);
    assert.deepEqual(refreshed.data.changed, ['matches', 'changes', 'pull']);
    rejoined.close();
    assert.equal((await json(await request('info'))).readOnly, false);
    await stop('B-reopened');
    const restoreStarted = Date.now();
    const restoredDesktop = await start('B-restored', 'B');
    assert.equal(result.B.profileDigest, result['B-restored'].profileDigest);
    assert.ok(restoredDesktop.events.some(event => event.event === 'runtime-factory-end' && event.data.ready && event.data.readOnly === false));
    await waitUntil(() => control.open()?.at >= restoreStarted, 'desktop watch restored after backend restart');
    assert.deepEqual(snapshot().historyIds, final.rows.map(row => row.id));
    Object.assign(result.sharedWatch, {
        readOnlyRead: true, readOnlyWriteDenied409: true, readOnlyInvalidateMs, revokeInvalidateMs,
        restartEpochReset: true, grantRevocation403: true, desktopRestoresAfterRestart: true,
        lateAuthorizedResponseSuppressed: true, foregroundConfigAndStatusDenied: true,
    });
}

globalThis.nsWatchFaults = control;
globalThis.nsWatchFaultScenario = scenario;
const compile = Module._extensions['.cjs'] || Module._extensions['.js'];
const integration = path.resolve(process.cwd(), 'tests/integration');
Module._extensions['.cjs'] = function (module, name) {
    const transform = path.dirname(name) === integration && targets.get(path.basename(name));
    if (!transform) return compile(module, name);
    module._compile(transform(fs.readFileSync(name, 'utf8')), name);
};

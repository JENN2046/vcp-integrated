'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync, spawnSync} = require('node:child_process');

const integrated = path.resolve(path.join(__dirname, '../..'));
const fixtureDir = path.join(integrated, 'tests/collaboration/fixtures');
const experimentCases = [['desktop', 'pre-dispatch'], ['pwa', 'pre-dispatch'], ['desktop', 'native-terminal']];

async function exitAtCutpoint(client, cutpoint) {
    const {fixture, ctx} = require(path.join(fixtureDir, 'sharedSingleHarness.cjs'));
    const f = await fixture({diagnostic() {}, after() {}});
    const requestId = 'ordinary-audit-recovery';
    const content = 'Synthetic recovery message';
    let workId;
    if (client === 'pwa') {
        const phone = await f.phone();
        const accepted = await phone.call('/conversations/' + f.topic.id + '/messages', {requestId, text: content}, 202);
        workId = accepted.id;
    } else {
        const d = await f.desktop('A');
        const accepted = await d.runtime.prepareSharedSend({
            descriptor: d.descriptor, serverSession: true,
            message: {id: requestId, role: 'user', content, timestamp: 1},
        });
        workId = accepted.admissionId;
    }

    const engine = f.portal.engine;
    function emitAndExit() {
        const row = engine.get(workId);
        const admission = engine.db.prepare('SELECT state,dispatched,native_terminal FROM shared_admissions WHERE id=?').get(workId);
        const native = engine.db.prepare('SELECT state FROM shared_native_requests WHERE admission_id=?').get(workId);
        const evidence = {
            root: f.root, workId, requestId, kind: row.kind, userMessageId: row.user_message_id,
            state: row.state, dispatch: row.request_dispatched, admission,
            nativeState: native?.state ?? null, pendingOperation: Boolean(row.pending_operation),
            providerCalls: f.calls(),
        };
        fs.writeSync(1, JSON.stringify(evidence) + '\n');
        process.exit(71);
    }

    if (cutpoint === 'pre-dispatch') {
        const verify = engine.configs.verify.bind(engine.configs);
        engine.configs.verify = (...args) => {
            if (engine.get(workId).state === 'running') emitAndExit();
            return verify(...args);
        };
    } else {
        f.control.nativeResponder = (_req, res) => {
            ctx.assertDispatch();
            res.once('finish', emitAndExit);
            res.json({choices: [{message: {role: 'assistant', content: 'Synthetic final reply'}, finish_reason: 'stop'}]});
        };
    }
    engine.db.prepare('UPDATE mobile_executions SET not_before=0 WHERE id=?').run(workId);
    engine.setEndpoint({url: f.url + '/v1/chat/completions', key: 'synthetic-only'});
    setTimeout(() => process.exit(72), 5000);
}

async function readRecovered(server, root, workId) {
    const nativeSync = path.join(server, 'Plugin/NativeSync');
    const {CentralStore} = require(nativeSync + '/sync/centralStore');
    const {SourceCatalog} = require(nativeSync + '/sync/sourceCatalog');
    const {SharedSpace} = require(nativeSync + '/sync/sharedSpace');
    const {SharedNative} = require(nativeSync + '/sync/sharedNative');
    const {MobilePortal} = require(nativeSync + '/mobile/portal');
    const config = {
        NativeSyncFullSources: JSON.stringify(['A', 'B'].map(x => ({
            sourceId: 'source' + x, deviceId: 'device' + x, executionMode: 'all-supported',
        }))),
        NativeSyncSharedSpaces: JSON.stringify([{id: 'sharedAB', sources: ['sourceA', 'sourceB']}]),
        NativeMobileOrigin: 'https://synthetic-shared.invalid',
        NativeMobileConfigSync: true, NativeMobileTopics: '[]', NativeMobileStartDelayMs: 10000,
    };
    const store = new CentralStore(path.join(root, 'central.sqlite'));
    store.sourceCatalog = new SourceCatalog(store, config);
    store.shared = new SharedSpace(store, config);
    const portal = new MobilePortal({store, config, agentManager: {isAgent: () => false}});
    const native = new SharedNative(store.shared, portal.engine);
    const row = portal.engine.get(workId);
    const admission = store.shared.db.prepare('SELECT state,dispatched,native_terminal FROM shared_admissions WHERE id=?').get(workId);
    const journal = store.shared.db.prepare('SELECT msg_id FROM journal ORDER BY seq').all().map(entry => entry.msg_id);
    const result = {workId: row.id, state: row.state, errorCode: row.error_code, admission, journal};
    native.close();
    await portal.close();
    store.close();
    return result;
}

async function run() {
    assert.equal(process.versions.node.split('.')[0], '24', 'Use Node 24');
    const root = fs.mkdtempSync(path.join(process.env.NS_REVIEW_TEMP_PARENT || os.homedir(), 'ns-ordinary-review-'));
    const server = path.join(root, 'apps/server');
    try {
        const archive = execFileSync('git', ['archive', 'HEAD', 'apps/server'], {cwd: integrated, maxBuffer: 256 * 1024 * 1024});
        execFileSync('tar', ['-x', '-C', root], {input: archive});
        for (const rel of ['node_modules', 'Plugin/NativeSync/mobile-dist', 'Plugin/NativeSync/sync/contracts.generated.cjs']) {
            const target = path.join(server, rel);
            if (!fs.existsSync(target)) fs.symlinkSync(path.join(integrated, 'apps/server', rel), target);
        }
        const revision = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: integrated, encoding: 'utf8'}).trim();
        const observations = [];
        for (const [client, cutpoint] of experimentCases) {
            const child = spawnSync(process.execPath, [
                '--require', path.join(fixtureDir, 'loopback.cjs'), __filename, client, cutpoint,
            ], {
                cwd: root, encoding: 'utf8', timeout: 10000,
                env: {
                    PATH: process.env.PATH, HOME: root, TMPDIR: root,
                    VCP_COLLABORATION_SERVER: server, FIX03_FIXTURE_ROOT: root,
                },
            });
            assert.equal(child.status, 71, child.stdout + child.stderr);
            const {root: fixtureRoot, ...before} = JSON.parse(child.stdout.trim());
            const atTerminal = cutpoint === 'native-terminal';
            assert.equal(before.kind, client === 'desktop' ? 'shared_session' : null);
            assert.equal(before.state, 'running');
            assert.equal(before.dispatch, Number(atTerminal));
            assert.equal(before.admission.dispatched, Number(atTerminal));
            assert.equal(before.admission.native_terminal, Number(atTerminal));
            assert.equal(before.nativeState, atTerminal ? 'model_terminal' : null);
            assert.equal(before.pendingOperation, false);
            assert.equal(before.providerCalls, Number(atTerminal));
            const after = await readRecovered(server, fixtureRoot, before.workId);
            assert.equal(after.workId, before.workId);
            assert.equal(after.state, client === 'desktop' && !atTerminal ? 'queued' : 'review_required');
            assert.deepEqual(after.journal, [before.userMessageId]);
            observations.push({client, cutpoint, before, after});
        }
        console.log(JSON.stringify({revision, observations}, null, 2));
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
}

const main = process.argv[2] ? exitAtCutpoint(process.argv[2], process.argv[3]) : run();
main.catch(error => { console.error(error); process.exitCode = 1; });

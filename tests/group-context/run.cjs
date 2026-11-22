'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');
const { start } = require('../integration/service.cjs');
const { launch, mobileControl, openPwa } = require('../group-relay/pwa.cjs');
const { makeFixture, sha256 } = require('./shared-fixture.cjs');
const spec = process.env.NS_GROUP_FIXTURE ? JSON.parse(fs.readFileSync(process.env.NS_GROUP_FIXTURE, 'utf8')) : require('./input.json');

const root = path.resolve(__dirname, '../..');
const server = path.join(root, 'apps/server');
const baseline = process.env.NS_GROUP_BASELINE_REVISION || '6f34d0c0a260';
const runRoot = path.join(root, '.runs/group-context');
const execute = promisify(execFile);
const text = value => JSON.stringify(value, null, 2) + '\n';
const dump = (file, value) => fs.writeFileSync(file, text(value), { mode: 0o600 });
const load = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const namedControlId = 'gc-named-control';
const lines = file => fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);

async function waitUntil(check, label, timeout = 18000) {
    const until = Date.now() + timeout;
    do {
        const result = await check();
        if (result) return result;
        await delay(30);
    } while (Date.now() < until);
    throw Error('Timed out waiting for ' + label);
}

function baselineDependencies(out, source) {
    const deps = path.join(out, 'server-deps');
    const current = path.join(server, 'node_modules');
    fs.mkdirSync(path.join(deps, '@vcp'), { recursive: true });
    for (const name of fs.readdirSync(current).filter(name => name !== '@vcp')) {
        fs.symlinkSync(path.join(current, name), path.join(deps, name));
    }
    for (const [name, rel] of [['core-rules', 'packages/core-rules'], ['native-history-window', 'apps/desktop/modules/chat/historyWindow']]) {
        const dir = path.join(source, rel);
        const entry = name === 'core-rules' ? 'group/groupContextWindow.js' : 'tavernContext.mjs';
        const git = execFileSync('git', ['show', baseline + ':' + rel + '/' + entry], { cwd: root });
        assert.equal(sha256(fs.readFileSync(path.join(dir, entry))), sha256(git));
        fs.symlinkSync(dir, path.join(deps, '@vcp', name));
    }
    return deps;
}

function readShared(db, topic) {
    const jobs = () => db.prepare(`SELECT id,request_id,state,kind,user_message_id,user_seq,request_dispatched,
        group_plan,group_position,reply_message_id,error_code FROM mobile_executions WHERE topic_key=? ORDER BY rowid`).all(topic.id)
        .map(({ group_plan, ...row }) => ({ ...row, plan: JSON.parse(group_plan) }));
    const journal = () => db.prepare(`SELECT seq,msg_id,action,message_json,metadata_hash FROM journal WHERE topic_id=? ORDER BY seq`)
        .all(topic.id).map(({ message_json, ...row }) => ({ ...row, message: JSON.parse(message_json) }));
    const job = () => jobs()[0];
    function snapshot() {
        const work = jobs();
        assert.equal(work.length, 1);
        const id = work[0].id;
        const steps = db.prepare(`SELECT id,step_index,agent_id,state,attempts,reply_message_id,error_code FROM mobile_execution_steps
            WHERE job_id=? ORDER BY step_index`).all(id);
        const { config_json, user_op, ...admission } = db.prepare(`SELECT id,request_id,context_head,user_seq,reply_seq,state,dispatched,
            native_terminal,config_json,user_op FROM shared_admissions WHERE id=?`).get(id);
        const config = JSON.parse(config_json);
        const nativeRequests = db.prepare(`SELECT id,member_id,ordinal,body_hash,state FROM shared_native_requests
            WHERE admission_id=? ORDER BY ordinal`).all(id);
        const phases = db.prepare('SELECT request_id,stage FROM shared_request_phases WHERE work_id=? ORDER BY at,rowid').all(id);
        return { work: work[0], admission: { ...admission, turn: JSON.parse(user_op).sharedTurn, configHash: config.hash }, steps, nativeRequests, phases, journal: journal() };
    }
    return { job, journal, snapshot };
}

async function main() {
    assert.equal(process.versions.node.split('.')[0], '24');
    const [variant = 'candidate', nativeSourceArg, command] = process.argv.slice(2);
    assert.ok(['baseline', 'candidate'].includes(variant));
    assert.ok(!command || command === '--shared-only');
    const isBaseline = variant === 'baseline';
    const nativeSource = isBaseline ? path.resolve(nativeSourceArg || path.join(runRoot, 'native-baseline-src')) : root;
    fs.mkdirSync(runRoot, { recursive: true });
    const out = fs.mkdtempSync(path.join(runRoot, variant + '-'));
    console.log(out);
    const file = name => path.join(out, name);
    const cert = file('cert.pem'), key = file('key.pem');
    const handlerLog = file('handler.jsonl');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=Synthetic group context fixture', '-addext', 'subjectAltName=IP:127.0.0.1', '-out', cert, '-keyout', key],
    { stdio: 'ignore' });
    const provider = [];
    let db, shared, service, browser;
    const fixture = makeFixture({ server, out, spec, onProvider(row) {
        provider.push({ ...row, committedJournal: shared.journal().map(({ seq, msg_id, message }) => ({
            seq, id: msg_id, role: message.role, content: message.content,
        })) });
    } });
    const exits = [];
    const evidence = { variant, revision: isBaseline ? baseline : execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(),
        nodeVersion: process.version };
    try {
        try {
            service = await start({ out, candidate: root, cert, key, waitUntil,
                trace(event, detail) { if (event === 'backend-exit') exits.push(detail); },
                serverRevision: isBaseline ? baseline : undefined,
                serverDependencies: isBaseline ? baselineDependencies(out, nativeSource) : undefined,
                groupRelay: fixture,
                observedContext: { seedCount: 0, seed: fixture.seedHistory, preload: process.env.NS_GROUP_CAPTURE || path.join(__dirname, 'server-capture.cjs'),
                    handlerLog, input: 'GC_CURRENT', recordProvider() {} },
            });
        } finally {
            fs.rmSync(key, { force: true });
        }
        service.disarmDrop();
        assert.equal((await service.checkMobile()).bundleStatus, 200);
        db = new DatabaseSync(path.join(service.data, 'central.sqlite'), { readOnly: true });
        const topic = service.topics.groupTopic;
        shared = readShared(db, topic);
        browser = await launch(createRequire(path.join(server, 'package.json'))('puppeteer'), cert);
        const mobile = await openPwa({ browser, service, request: mobileControl(service, cert, out),
            execute: true, groupName: spec.group.name });
        const route = 'conversations/' + topic.id + '/messages';
        const body = { requestId: spec.current.id, text: spec.input };
        const submit = () => mobile.request(route, body);
        const first = await submit();
        assert.equal(first.status, 202, text(first.data));
        assert.equal(first.data.replayed, false);
        const work = await waitUntil(() => {
            const job = shared.job();
            if (job?.error_code) throw Error(job.error_code);
            return job?.state === 'completed' && job;
        }, 'shared A then B completed');
        assert.equal(work.id, first.data.id);
        await mobile.text(spec.replyB);
        const before = shared.snapshot();
        const beforePackets = { handler: lines(handlerLog), provider: structuredClone(provider) };
        const lookup = await mobile.request('conversations/' + topic.id + '/execution-request?requestId=' + body.requestId);
        assert.equal(lookup.status, 200);
        assert.deepEqual(lookup.data.executions.map(({ id, state }) => ({ id, state })), [{ id: work.id, state: 'completed' }]);
        const replay = await submit();
        assert.equal(replay.status, 202);
        assert.equal(replay.data.replayed, true);
        assert.equal(replay.data.id, work.id);
        assert.equal(replay.data.state, 'completed');
        assert.deepEqual(shared.snapshot(), before);
        assert.deepEqual({ handler: lines(handlerLog), provider }, beforePackets);
        assert.deepEqual(before.work.plan, fixture.savedOrder);
        assert.deepEqual(before.admission.turn?.plan, before.work.plan);
        const fixtureIds = new Map(Object.entries(fixture.memberIds).map(([local, canonical]) => [canonical, local]));
        const plan = before.work.plan.map(id => fixtureIds.get(id));
        assert.deepEqual(plan, spec.plan);
        evidence.shared = { topicId: topic.id, memberIds: fixture.memberIds, savedOrder: fixture.savedOrder,
            planForNative: plan, attachment: fixture.attachment, ...before, mobile: { browser: await browser.version(), route, body,
                first: { status: first.status, id: first.data.id, state: first.data.state, replayed: first.data.replayed },
                lookup: { status: lookup.status, id: work.id, state: work.state },
                replay: { status: replay.status, id: replay.data.id, state: replay.data.state, replayed: replay.data.replayed },
                terminalVisible: true, sameLedgerAndPackets: true } };
        await browser.close();
        browser = null;
        dump(file('input.json'), { ...spec, plan });
        if (!command) {
            await execute(process.execPath, [path.join(__dirname, 'native-run.cjs'), file('input.json'),
                service.origin + '/v1/chat/completions', file('native.json'), cert, variant],
            { env: { ...process.env, NS_GROUP_SOURCE: nativeSource }, timeout: 110000 }).catch(error => {
                throw Error(error.stderr || error.message);
            });
            evidence.native = { ...load(file('native.json')), history: load(file('native.json.history.json')),
                dispatch: lines(file('native.json.dispatch.jsonl')) };
        }
        if (spec.namedControl) {
            const body = JSON.stringify({ model: 'synthetic', stream: true, requestId: namedControlId, messages: spec.namedControl });
            evidence.namedControl = await new Promise((resolve, reject) => {
                const request = https.request(service.origin + '/v1/chat/completions', {
                    method: 'POST', ca: fs.readFileSync(cert), timeout: 10000,
                    headers: { authorization: 'Bearer synthetic-only', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
                }, response => {
                    const chunks = [];
                    response.on('data', chunk => chunks.push(chunk));
                    response.on('error', reject);
                    response.on('end', () => resolve({ status: response.statusCode,
                        completed: Buffer.concat(chunks).toString().includes('data: [DONE]'), requestId: namedControlId }));
                });
                request.on('error', reject);
                request.on('timeout', () => request.destroy(Error('Named control timed out')));
                request.end(body);
            });
            assert.equal(evidence.namedControl.status, 200);
            assert.equal(evidence.namedControl.completed, true);
        }
        evidence.handler = lines(handlerLog);
        evidence.provider = provider;
    } finally {
        await browser?.close();
        db?.close();
        await service?.close();
    }
    assert.deepEqual(exits, [{ code: 0, signal: null }]);
    evidence.backend = load(file('backend-loaded.json'));
    const backendFiles = ['mobile/groupRequest.js', 'mobile/groupTurn.js', 'mobile/sharedGroups.js', 'mobile/portal.js', 'sync/sharedNative.js'];
    for (const rel of backendFiles) {
        const record = evidence.backend.find(row => row.file.endsWith('/' + rel));
        const name = 'apps/server/Plugin/NativeSync/' + rel;
        const bytes = isBaseline ? execFileSync('git', ['show', baseline + ':' + name], { cwd: root }) : fs.readFileSync(path.join(root, name));
        if (record) assert.equal(record.sha256, sha256(bytes));
        else {
            // The group capture observes the worker rule call from groupRequest itself.
            assert.equal(rel, 'mobile/groupRequest.js');
            assert.ok(evidence.handler.some(row => row.kind === 'worker-rules'));
            assert.equal(sha256(fs.readFileSync(file('runtime-box/Plugin/NativeSync/' + rel))), sha256(bytes));
        }
    }
    if (spec.namedControl) {
        const log = fs.readFileSync(file('backend.log'), 'utf8');
        evidence.fixtureLimits = log.split('\n').filter(line => line.startsWith('[Physical mobile fixture]'));
    }
    dump(file('evidence.json'), evidence);
    for (const name of ['seed', 'data', 'runtime-box', 'empty-diaries', 'server-deps', 'backend.log', 'cert.pem']) {
        fs.rmSync(file(name), { recursive: true, force: true });
    }
    console.log(file('evidence.json'));
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });

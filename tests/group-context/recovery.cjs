'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const { setTimeout: delay } = require('node:timers/promises');
const { start } = require('../integration/service.cjs');
const { createFixture } = require('../group-relay/fixture.cjs');
const { launch, mobileControl, openPwa } = require('../group-relay/pwa.cjs');

const candidate = path.resolve(__dirname, '../..');
const requireServer = createRequire(path.join(candidate, 'apps/server/package.json'));

async function waitUntil(check, label, timeout = 12000) {
    const until = Date.now() + timeout;
    do {
        const result = await check();
        if (result) return result;
        await delay(30);
    } while (Date.now() < until);
    throw Error('Timed out waiting for ' + label);
}

async function main() {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-group-context-recovery-'));
    console.log(out);
    const cert = path.join(out, 'fixture-cert.pem');
    const key = path.join(out, 'fixture-key.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=Synthetic group recovery fixture', '-addext', 'subjectAltName=IP:127.0.0.1',
        '-keyout', key, '-out', cert], { stdio: 'ignore' });
    const groupRelay = createFixture();
    const evidence = { scenario: 'SIGKILL shared group during B stream without cancellation', node: process.version };
    const exits = [];
    let service, browser, db;
    try {
        try {
            service = await start({ out, candidate, cert, key, waitUntil, groupRelay,
                trace: (event, data) => { if (event === 'backend-exit') exits.push(data); } });
        } finally {
            fs.rmSync(key, { force: true });
        }
        browser = await launch(requireServer('puppeteer'), cert);
        evidence.browser = await browser.version();
        const owner = await openPwa({ browser, service, request: mobileControl(service, cert, out), execute: true });
        const route = 'conversations/' + owner.topic;
        const submitUrl = service.origin + '/mobile/api/' + route + '/messages';
        const responsePromise = owner.page.waitForResponse(response =>
            response.url() === submitUrl && response.request().method() === 'POST');
        await owner.message('GROUP_RECOVERY_USER');
        const response = await responsePromise;
        assert.equal(response.status(), 202);
        const submitted = JSON.parse(response.request().postData());
        assert.equal(submitted.text, 'GROUP_RECOVERY_USER');
        const accepted = await response.json();
        assert.equal(accepted.replayed, false);
        const workId = accepted.id;
        evidence.accepted = { workId, requestId: submitted.requestId, status: response.status() };

        db = new DatabaseSync(path.join(service.data, 'central.sqlite'), { readOnly: true });
        const jobs = () => db.prepare('SELECT id,request_id,state,cancel_requested,group_stop_index,group_plan,user_message_id,user_seq,attempts FROM mobile_executions WHERE topic_key=? ORDER BY rowid').all(owner.topic);
        const steps = () => db.prepare('SELECT id,agent_id,state,attempts,reply_message_id FROM mobile_execution_steps WHERE job_id=? ORDER BY step_index').all(workId);
        const calls = () => service.calls.flatMap(call => call.member ? [call.member] : []);
        const snapshot = async () => {
            const history = await owner.request(route + '?after=0');
            assert.equal(history.status, 200);
            assert.equal(jobs().length, 1);
            const { group_plan, ...job } = jobs()[0];
            const { owner_type, owner_id, topic_id } = db.prepare('SELECT owner_type,owner_id,topic_id FROM journal WHERE msg_id=?').get(job.user_message_id);
            const journal = db.prepare('SELECT seq,msg_id,action FROM journal WHERE owner_type=? AND owner_id=? AND topic_id=? ORDER BY seq').all(owner_type, owner_id, topic_id);
            const admission = db.prepare('SELECT id,state,dispatched FROM shared_admissions WHERE id=?').get(workId);
            const native = db.prepare('SELECT id,ordinal,state FROM shared_native_requests WHERE admission_id=? ORDER BY ordinal').all(workId);
            return { job, plan: JSON.parse(group_plan), steps: steps().map(step => ({ ...step })),
                admission: { ...admission }, native, journal, calls: calls(),
                history: history.data.messages.map(row => ({ id: row.id, role: row.message.role, content: row.message.content })) };
        };

        await waitUntil(() => steps().map(step => step.state).join(',') === 'completed,running,queued',
            'A finalized, B running, C queued');
        await owner.page.waitForFunction(() => [...document.querySelectorAll('#shared-live-replies .bubble')]
            .some(node => node.textContent === 'RELAY_B_PARTIAL'));
        evidence.before = await snapshot();
        const { before } = evidence;
        assert.equal(groupRelay.closed, false);
        assert.equal(before.job.id, workId);
        assert.equal(before.job.state, 'running');
        assert.equal(before.job.request_id, submitted.requestId);
        assert.equal(before.job.cancel_requested, 0);
        assert.equal(before.job.group_stop_index, null);
        assert.deepEqual(before.plan, before.steps.map(step => step.agent_id));
        assert.deepEqual(before.calls, ['A', 'B']);
        assert.deepEqual(before.native.map(row => [row.id, row.state]), [
            [before.steps[0].id, 'model_terminal'], [before.steps[1].id, 'dispatched'],
        ]);
        evidence.observedLivePrefix = 'RELAY_B_PARTIAL';
        assert.deepEqual(before.history.map(row => [row.role, row.content]), [
            ['user', 'GROUP_RECOVERY_USER'], ['assistant', 'RELAY_A_FINAL'],
        ]);
        assert.deepEqual(before.journal.map(row => row.msg_id), before.history.map(row => row.id));

        evidence.crash = await service.restartAfterCrash();
        await waitUntil(() => groupRelay.closed && jobs()[0]?.state === 'review_required', 'original Work held for review');
        const reopened = await owner.request(route + '/execution-request?' + new URLSearchParams({ requestId: submitted.requestId }));
        assert.equal(reopened.status, 200);
        assert.deepEqual(reopened.data.executions.map(work => [work.id, work.state]), [[workId, 'review_required']]);
        const replay = await owner.request(route + '/messages', submitted);
        assert.equal(replay.status, 202);
        assert.equal(replay.data.replayed, true);
        assert.equal(replay.data.id, workId);
        assert.equal(replay.data.state, 'review_required');
        evidence.replay = { status: replay.status, replayed: replay.data.replayed, workId: replay.data.id, state: replay.data.state };
        await delay(500);
        evidence.after = await snapshot();
        const { after } = evidence;
        assert.deepEqual(after.job, { ...before.job, state: 'review_required' });
        assert.deepEqual(after.plan, before.plan);
        assert.deepEqual(after.steps, [before.steps[0], { ...before.steps[1], state: 'interrupted' }, before.steps[2]]);
        assert.deepEqual(after.steps.map(step => step.attempts), [1, 1, 0]);
        assert.equal(after.steps[1].reply_message_id, null);
        assert.equal(after.steps[2].reply_message_id, null);
        assert.deepEqual(after.admission, { ...before.admission, state: 'review_required' });
        assert.deepEqual(after.native.map(row => [row.id, row.state]), [
            [after.steps[0].id, 'model_terminal'], [after.steps[1].id, 'unknown'],
        ]);
        assert.deepEqual(after.calls, before.calls);
        assert.deepEqual(after.history, before.history);
        assert.deepEqual(after.journal, before.journal);
        assert.deepEqual(owner.errors, []);
        evidence.messageWrites = owner.writes;
        assert.deepEqual(evidence.messageWrites, [new URL(submitUrl).pathname, new URL(submitUrl).pathname]);
    } catch (error) {
        evidence.failure = error.message;
        throw error;
    } finally {
        db?.close();
        await browser?.close();
        await service?.close();
        evidence.backendExits = exits;
        const loaded = path.join(out, 'backend-loaded.json');
        if (fs.existsSync(loaded)) {
            evidence.backendSources = JSON.parse(fs.readFileSync(loaded));
            const source = 'packages/core-rules/group/groupContextWindow.js';
            const rules = path.join(candidate, source);
            evidence.candidateSharedRule = { source, sha256: createHash('sha256').update(fs.readFileSync(rules)).digest('hex') };
        }
        fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    }
    assert.deepEqual(exits, [{ code: null, signal: 'SIGKILL' }, { code: 0, signal: null }]);
}

main().catch(error => { console.error(error); process.exitCode = 1; });

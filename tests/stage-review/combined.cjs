'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const { setTimeout: delay } = require('node:timers/promises');
const { DatabaseSync } = require('node:sqlite');
const { createFixture } = require('../group-relay/fixture.cjs');
const { launch, mobileControl, openPwa } = require('../group-relay/pwa.cjs');
const { startFixture, waitUntil } = require('../aa-delegation/fixture.cjs');

const candidate = path.resolve(__dirname, '../..');
const serverRequire = createRequire(path.join(candidate, 'apps/server/package.json'));
const text = 'Synthetic cross-batch audit group round.';
const adminRoute = '/admin_api/agent-assistant/delegations';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function createGroupRelay() {
    const relay = createFixture();
    let finishB;
    return {
        finishB() {
            assert.ok(finishB, 'B continuation reached the provider');
            finishB();
        },
        seed: relay.seed,
        respond(body, row, res) {
            if (!JSON.stringify(body.messages.find(item => item.role === 'system') || {}).includes('GROUP_RELAY_MEMBER_B')) {
                return relay.respond(body, row, res);
            }
            row.member = 'B';
            const pending = JSON.stringify(body.messages).match(/\{\{VCP_ASYNC_RESULT::AgentAssistant::[^{}]+\}\}/)?.[0];
            row.phase = pending ? 'continuation' : 'tool-request';
            const content = pending ? 'SYNTHETIC_B_PENDING ' + pending : [
                '<<<[TOOL_REQUEST]>>>',
                'tool_name:「始」AgentAssistant「末」,',
                'agent_name:「始」SyntheticDelegate「末」,',
                'prompt:「始」AA_DELEGATION_CRASH「末」,',
                'task_delegation:「始」true「末」',
                '<<<[END_TOOL_REQUEST]>>>',
            ].join('\n');
            assert.equal(body.stream, true);
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            function finish() {
                for (const [delta, reason] of [[{ role: 'assistant', content }, null], [{}, 'stop']]) {
                    res.write('data: ' + JSON.stringify({ id: 'combined-relay', object: 'chat.completion.chunk',
                        created: 1, model: 'synthetic', choices: [{ index: 0, delta, finish_reason: reason }] }) + '\n\n');
                }
                res.end('data: [DONE]\n\n');
            }
            if (pending) {
                res.flushHeaders();
                finishB = finish;
            } else {
                finish();
            }
            return true;
        },
    };
}

async function main() {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-stage-combined-'));
    const [receiptPath, screenshot] = process.argv.slice(2);
    const parentTerminalBeforeCrash = process.env.CRASH_WITH_B_IN_FLIGHT !== '1';
    const groupRelay = createGroupRelay();
    console.log('Isolated combined scenario ' + out);
    const evidence = { revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: candidate }).toString().trim(),
        node: process.versions.node, parentTerminalBeforeCrash, result: 'FAIL' };
    let fx, browser, socket, db, pwa;
    try {
        fx = await startFixture({ out, candidate, groupRelay, ordinaryTools: {
            reply() {},
            stage(box) {
                fs.writeFileSync(path.join(box, 'toolApprovalConfig.json'), JSON.stringify({
                    enabled: true, timeoutMinutes: 2, approvalList: ['AgentAssistant'], whitelist: [],
                }));
            },
        } });
        const { service, cert, markers } = fx;
        const approvals = [];
        const WebSocket = serverRequire('ws');
        let connected = false;
        const connectApproval = async () => {
            connected = false;
            socket = new WebSocket(service.wsOrigin.replace(/^http:/, 'ws:') +
                '/VCPlog/VCP_Key=synthetic-sponsor-ws?deviceName=combined-stage-review');
            socket.on('message', bytes => {
                const event = JSON.parse(bytes);
                if (event.type === 'connection_ack') connected = true;
                if (event.type === 'tool_approval_request' && event.data.toolName === 'AgentAssistant') {
                    approvals.push(event.data.requestId);
                }
            });
            await once(socket, 'open');
            await waitUntil(() => connected, 'native approval client acknowledgment');
        };
        await connectApproval();
        browser = await launch(serverRequire('puppeteer'), cert);
        evidence.browser = await browser.version();
        pwa = await openPwa({ browser, service, request: mobileControl(service, cert, out), execute: true });
        const bundle = await pwa.page.evaluate(async () => {
            const entry = performance.getEntriesByType('resource').find(resource => {
                const url = new URL(resource.name);
                return url.pathname.startsWith('/mobile/assets/') && url.pathname.endsWith('.js');
            });
            if (!entry) return null;
            const response = await fetch(entry.name);
            return { file: new URL(entry.name).pathname, source: await response.text() };
        });
        assert.ok(bundle, 'Chromium loads the bundled PWA');
        evidence.pwaBundle = { file: bundle.file, sha256: sha(bundle.source) };
        assert.equal(evidence.pwaBundle.sha256, sha(fs.readFileSync(path.join(candidate,
            'apps/server/Plugin/NativeSync/mobile-dist', bundle.file.slice('/mobile/'.length)))));
        db = new DatabaseSync(path.join(service.data, 'central.sqlite'), { readOnly: true });
        const base = 'conversations/' + pwa.topic;
        const submission = { requestId: randomUUID(), text };
        const submitted = await pwa.request(base + '/messages', submission);
        assert.equal(submitted.status, 202);
        const workId = submitted.data.id;
        assert.ok(workId);
        evidence.workId = workId;
        evidence.requestId = submission.requestId;
        const action = 'executions/' + workId + '/cancel-remaining';
        const work = () => db.prepare('SELECT id,request_id,state,error_code,cancel_requested,group_stop_index FROM mobile_executions WHERE id=?').get(workId);
        const steps = () => db.prepare("SELECT id,state,attempts,reply_message_id,error_code FROM mobile_execution_steps WHERE job_id=? AND id GLOB 'gstep_*' ORDER BY step_index").all(workId);
        const childSteps = () => db.prepare("SELECT id,state,attempts,error_code FROM mobile_execution_steps WHERE job_id=? AND id NOT GLOB 'gstep_*'").all(workId);
        const tasks = () => db.prepare('SELECT native_task_id,step_id,state,native_status,result_ref,error_code,review_required FROM mobile_native_tasks WHERE execution_id=?').all(workId);
        const invocations = () => db.prepare('SELECT invocation_id,step_id,plugin_name,record_id,state,error_code FROM mobile_native_invocations WHERE execution_id=?').all(workId);
        const native = () => db.prepare('SELECT id,state,ordinal FROM shared_native_requests WHERE admission_id=? ORDER BY ordinal').all(workId);
        const counts = () => ({
            A: service.calls.filter(row => row.member === 'A').length,
            B: service.calls.filter(row => row.member === 'B').length,
            C: service.calls.filter(row => row.member === 'C').length,
            childRequests: fx.calls(markers.crash).filter(row => row.role === 'child').map(row => ({ id: row.id, launch: row.launch })),
        });
        async function snapshot() {
            const response = await pwa.request(base + '?after=0');
            assert.equal(response.status, 200);
            const history = response.data.messages.map(row => ({ id: row.id, role: row.message.role, content: row.message.content }));
            const journal = db.prepare('SELECT msg_id,action FROM journal WHERE topic_id=? ORDER BY seq').all(pwa.topic);
            return { work: work(), steps: steps(), childSteps: childSteps(), tasks: tasks(), invocations: invocations(), native: native(), counts: counts(), history, journal };
        }
        const approvalId = await waitUntil(() => approvals[0], 'AA tool approval request');
        await waitUntil(() => work()?.state === 'waiting_approval', 'B owns approval wait');
        evidence.beforeApproval = await snapshot();
        assert.deepEqual(steps().map(row => [row.state, row.attempts]), [['completed', 1], ['waiting_approval', 1], ['queued', 0]]);
        assert.deepEqual(counts(), { A: 1, B: 1, C: 0, childRequests: [] });
        socket.send(JSON.stringify({ type: 'tool_approval_response', data: { requestId: approvalId, approved: true } }));
        evidence.approval = { approvalId, allowResponsesSent: 1, transport: 'native VCPLog WebSocket' };

        const active = await waitUntil(() => tasks().find(row => row.state === 'running') && counts().childRequests.length &&
            steps()[1].state === 'running' && service.calls.some(call => call.member === 'B' && call.phase === 'continuation') && tasks()[0], 'B waits on its held native AA child');
        evidence.beforeCancel = await snapshot();
        assert.equal(active.step_id, steps()[1].id);
        assert.deepEqual(counts().childRequests, [{ id: active.native_task_id + '-round-1', launch: true }]);
        const directBefore = await fx.request(adminRoute);
        assert.equal(directBefore.status, 200);
        assert.equal(directBefore.body.data.active.find(row => row.id === active.native_task_id)?.status, 'running');
        const selector = '[data-cancel-remaining-id="' + workId + '"]';
        await pwa.page.waitForSelector(selector, { visible: true });
        await pwa.page.click(selector);
        await waitUntil(() => steps()[2].state === 'cancelled', 'C cancellation persisted');
        evidence.afterCancel = await snapshot();
        assert.equal(work().group_stop_index, 2);
        assert.equal(work().cancel_requested, 0);
        assert.deepEqual(evidence.afterCancel.steps.slice(0, 2), evidence.beforeCancel.steps.slice(0, 2));
        assert.deepEqual(evidence.afterCancel.tasks, evidence.beforeCancel.tasks);
        assert.deepEqual(evidence.afterCancel.counts, evidence.beforeCancel.counts);

        if (parentTerminalBeforeCrash) {
            groupRelay.finishB();
            await waitUntil(() => native().find(row => row.id === active.step_id)?.state === 'model_terminal',
                'B reaches its native model boundary');
            await waitUntil(() => Boolean(steps()[1].reply_message_id), 'B response is formally published');
            assert.equal(steps()[1].state, 'completed');
        }
        evidence.beforeCrash = await snapshot();
        const stillRunning = await fx.request(adminRoute);
        assert.equal(stillRunning.body.data.active.find(row => row.id === active.native_task_id)?.status, 'running');
        evidence.nativeActiveBeforeCrash = true;
        const firstPid = service.backendPid;
        evidence.crash = await service.restartAfterCrash();
        assert.notEqual(service.backendPid, firstPid);
        await connectApproval();
        await pwa.page.reload({ waitUntil: 'domcontentloaded' });
        await pwa.page.waitForFunction(topic => document.querySelector('#topic-select')?.value === topic, {}, pwa.topic);
        await waitUntil(() => tasks()[0]?.state === 'unknown', 'same child recovered unknown');
        evidence.recovered = await snapshot();
        const status = await pwa.request(base + '/execution-request?' + new URLSearchParams({ requestId: submission.requestId }));
        assert.equal(status.status, 200);
        assert.deepEqual(status.data.executions.map(row => row.id), [workId]);
        const submitRetry = await pwa.request(base + '/messages', submission);
        const cancelRetry = await pwa.request(action, {});
        evidence.retries = { sameWorkStatus: status.data.executions[0].state,
            submit: { status: submitRetry.status, id: submitRetry.data.id, error: submitRetry.data.error?.code },
            cancelRemaining: { status: cancelRetry.status, id: cancelRetry.data.id, remainingCancelled: cancelRetry.data.remainingCancelled,
                error: cancelRetry.data.error?.code } };
        assert.equal(submitRetry.status, 202);
        assert.equal(submitRetry.data.id, workId);
        assert.equal(cancelRetry.status, 202);
        assert.equal(cancelRetry.data.id, workId);
        assert.equal(cancelRetry.data.remainingCancelled, true);
        const unverified = await pwa.request(base + '/executions/' + workId + '/native-tasks/' + active.native_task_id + '/result');
        evidence.childResult = { status: unverified.status, error: unverified.data.error?.code };
        const nativeAfter = await fx.request(adminRoute);
        evidence.nativeActiveAfterRestart = nativeAfter.body.data?.active.length;
        await delay(2200);
        evidence.final = await snapshot();
        assert.deepEqual(evidence.final, evidence.recovered);
        assert.equal(evidence.final.work.state, 'review_required');
        const expectedB = parentTerminalBeforeCrash ? 'completed' : 'interrupted';
        assert.deepEqual(evidence.final.steps.map(row => [row.state, row.attempts]), [['completed', 1], [expectedB, 1], ['cancelled', 0]]);
        assert.equal(evidence.final.steps[1].reply_message_id, evidence.beforeCrash.steps[1].reply_message_id);
        assert.equal(evidence.final.steps[2].reply_message_id, null);
        assert.equal(evidence.final.native.find(row => row.id === active.step_id)?.state,
            parentTerminalBeforeCrash ? 'model_terminal' : 'unknown');
        assert.equal(evidence.final.tasks.length, 1);
        assert.equal(evidence.final.tasks[0].native_task_id, active.native_task_id);
        assert.equal(evidence.final.tasks[0].result_ref, null);
        assert.equal(evidence.final.tasks[0].review_required, 1);
        assert.equal(evidence.final.invocations.length, 1);
        assert.deepEqual(evidence.final.counts, evidence.beforeCancel.counts);
        assert.equal(evidence.final.counts.C, 0);
        assert.deepEqual(evidence.final.history.slice(0, 2), evidence.beforeApproval.history);
        assert.equal(evidence.final.history.length, parentTerminalBeforeCrash ? 3 : 2);
        if (parentTerminalBeforeCrash) {
            assert.match(evidence.final.history[2].content, /SYNTHETIC_B_PENDING/);
            assert.ok(evidence.final.history[2].content.includes(active.native_task_id));
        }
        assert.deepEqual(evidence.final.history, evidence.beforeCrash.history);
        assert.deepEqual(evidence.final.journal, evidence.beforeCrash.journal);
        assert.ok(evidence.final.history.every(row => !row.content.includes(fx.childReport)));
        assert.deepEqual(evidence.final.journal.map(row => row.msg_id), evidence.final.history.map(row => row.id));
        assert.equal(evidence.nativeActiveAfterRestart, 0);
        assert.equal(evidence.childResult.error, 'NATIVE_TASK_RESULT_UNVERIFIED');
        assert.deepEqual(approvals, [approvalId]);
        await pwa.text('后续接力已取消');
        await pwa.text('AA 状态未知，待核对');
        await pwa.text('C · 已取消');
        await pwa.text(parentTerminalBeforeCrash ? 'B · 回复已保存' : 'B · 已中断');
        evidence.phone = { groupRemainingCancelled: true, aaUnknown: true, memberB: expectedB, memberC: 'cancelled' };
        assert.deepEqual(pwa.errors, []);
        evidence.result = 'PASS';
    } catch (error) {
        evidence.failure = error.message;
        throw error;
    } finally {
        if (screenshot) await pwa?.page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
        socket?.terminate();
        db?.close();
        await browser?.close();
        evidence.finalToolBoxExit = await fx?.close();
        const loaded = path.join(out, 'backend-loaded.json');
        if (fs.existsSync(loaded)) {
            evidence.loadedSources = JSON.parse(fs.readFileSync(loaded));
            for (const row of evidence.loadedSources) {
                assert.equal(row.sha256, sha(execFileSync('git', ['show', 'HEAD:' + row.file], { cwd: candidate })), row.file);
            }
        }
        fs.writeFileSync(receiptPath || path.join(out, 'receipt.json'), JSON.stringify(evidence, null, 2) + '\n');
        if (!process.env.KEEP_SYNTHETIC_RUN) fs.rmSync(out, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

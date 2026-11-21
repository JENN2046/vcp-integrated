'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const tool = require('../ordinary-tools/fixture.cjs');
const fixture = require('./fixture.cjs');

const sharedSpaceId = 'sharedAB';
const panel = '.native-sync-controlled-work';
const quote = JSON.stringify;
const checkpointMarker = 'COMPACT_DESKTOP_CHECKPOINT';

function createApi(service, out, role) {
    const connection = JSON.parse(fs.readFileSync(path.join(out, 'seed', 'desktop' + role, '.native-sync', 'connection.json'), 'utf8'));
    const headers = {
        'content-type': 'application/json', authorization: 'Bearer synthetic-only',
        'x-nativesync-space': connection.spaceId, 'x-nativesync-source': 'source' + role, 'x-nativesync-device': 'device' + role,
        'x-nativesync-capabilities': 'shared-space-v1,shared-context-v1,shared-controlled-text-v1,shared-controlled-tools-v1,shared-steering-v1',
    };
    return (route, body) => fetch(service.wsOrigin + '/api/v1/sync/shared/' + route, {
        method: body ? 'POST' : 'GET', headers, body: body && JSON.stringify(body),
    });
}

async function baseline({ result, service, out, db }) {
    const scope = { sharedSpaceId, sharedId: service.topics.preSubmit.id };
    const api = createApi(service, out, 'A');
    const context = await api('context?' + new URLSearchParams(scope));
    assert.ok(context.ok);
    const { head, hash } = await context.json();
    const requestId = 'baseline-safe-tool-work';
    const response = await api('admit', {
        ...scope, requestId, expectedHead: head, configHash: hash, controlMode: 'safe-tools-v1',
        message: { id: requestId, role: 'user', content: 'ORDINARY_TOOL_LOCAL', timestamp: Date.now() },
    });
    assert.equal(response.ok, false);
    const { error } = await response.json();
    assert.equal(error.code, 'CONTROLLED_MODE_UNSUPPORTED');
    const count = db.prepare('SELECT COUNT(*) count FROM shared_admissions WHERE request_id=?').get(requestId).count;
    assert.equal(count, 0);
    assert.equal(service.calls.length, 0);
    result.toolHandoff = { requestId, status: response.status, error: error.code, admissions: count, providerCalls: service.calls.length };
}

async function loadedDesktop(client, sha, root) {
    const expected = {
        main: [
            'apps/desktop/modules/ipc/chatHandlers.js',
            'apps/desktop/modules/services/nativeSync/sharedRuntime.js',
            'apps/desktop/modules/services/nativeSync/sharedExecution.js',
            'apps/desktop/modules/services/nativeSync/sharedSteeringClient.js',
        ],
        renderer: [
            'apps/desktop/modules/renderer/controlledWorkView.mjs',
            'apps/desktop/modules/chatManager.js',
        ],
    };
    const loaded = await client.command('loaded-sources', expected);
    for (const [kind, files] of Object.entries(expected)) {
        for (const file of files) assert.ok(loaded[kind].some(row => row.file === file && row.sha256 === sha(path.join(root, file))), file);
    }
    return { main: loaded.main, renderer: loaded.renderer };
}

async function candidate({ result, service, out, clients: { A, B }, picture, click, evalJs, waitUntil, stop, start, profiles, sha, toolHandoff, db }) {
    const { marker, loseHandoff, stream } = toolHandoff;
    const read = {};
    const buttons = client => evalJs(client, `Object.fromEntries([...document.querySelectorAll(${quote(panel + ' button')})]
        .map(button => [button.textContent.trim(), !button.disabled]))`);
    const status = client => evalJs(client, `document.querySelector(${quote(panel + ' [role=status]')})?.innerText`);
    const action = async (client, label) => {
        await waitUntil(async () => (await buttons(client))[label], label + ' is enabled');
        await click(client, panel + ' button', label);
    };
    async function select(client, role) {
        const scope = service.descriptors[role].preSubmit;
        if (!await evalJs(client, "document.querySelector('#tabContentAgents').classList.contains('active')")) {
            await click(client, '.sidebar-tab-button[data-tab="agents"]');
        }
        await click(client, '#agentList > li .agent-name', 'Synthetic shared');
        await waitUntil(async () => (await evalJs(client, 'window.VCPStateChannels.get("conversation.current").get()')).topicId === scope.topicId,
            role + ' selected the shared topic');
        await waitUntil(() => evalJs(client, `document.querySelector(${quote(panel)})?.checkVisibility()`),
            role + ' sees controlled Work actions');
        if (!await evalJs(client, `document.querySelector(${quote(panel)}).open`)) await click(client, panel + ' summary');
        const file = path.join(profiles[role], 'UserData', scope.itemId, 'topics', scope.topicId, 'history.json');
        read[role] = () => JSON.parse(fs.readFileSync(file, 'utf8'));
        await waitUntil(() => read[role]().length >= 2, role + ' materializes the shared topic');
    }

    await select(B, 'B');
    await stop('B');
    await select(A, 'A');
    const sharedId = service.topics.preSubmit.id;
    const topicId = service.topics.preSubmit.topic.topicId;
    const admissions = () => db.prepare('SELECT id,request_id,principal,state,dispatched,native_terminal FROM shared_admissions WHERE topic_id=?').all(sharedId);
    const control = id => db.prepare('SELECT revision,generation,executor FROM shared_work_controls WHERE work_id=?').get(id);
    const generations = id => db.prepare('SELECT generation,executor,request_id,state,checkpoint_json FROM shared_work_generations WHERE work_id=? ORDER BY generation').all(id);
    const invocations = id => db.prepare('SELECT invocation_id,execution_id,native_request_id,plugin_name,record_id,state,error_code FROM mobile_native_invocations WHERE execution_id=?').all(id);
    const journal = () => db.prepare('SELECT seq,msg_id,action,hash FROM journal WHERE topic_id=? ORDER BY seq').all(topicId);
    const initialJournal = journal();
    await evalJs(A, `(() => {
        const input = document.querySelector(${quote(panel + ' textarea')});
        input.focus();
        input.value = ${quote(marker)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await action(A, '新建工具任务');
    const original = await waitUntil(() => admissions().at(0), 'A admits one controlled tool Work');
    assert.equal(original.principal, 'desktop:deviceA');
    assert.equal(original.state, 'accepted');
    assert.equal(original.dispatched, 0);
    assert.deepEqual(tool.counts(out), []);
    const workId = original.id;
    await action(A, '本端继续执行');
    await waitUntil(() => tool.counts(out).length === 1, 'A invokes the isolated fsync counter exactly once');

    if (result.mode === 'tool-handoff-unknown') {
        await waitUntil(() => admissions().at(0)?.state === 'review_required', 'ToolBox quarantines the unknown external outcome');
        const before = invocations(workId);
        assert.equal(before.length, 1);
        assert.equal(before[0].state, 'started', 'external result remains unconfirmed in the invocation ledger');
        await waitUntil(async () => (await status(A))?.includes('原任务需要核对'), 'A displays unresolved side effects');
        await picture(A, 'A-side-effect-needs-review');
        await stop('A');
        const other = await start('B-review', 'B');
        await select(other, 'B');
        const review = await waitUntil(async () => {
            const value = await status(other);
            return value?.includes('原任务需要核对') && value;
        }, 'B sees the original Work needs review');
        const visibleButtons = await buttons(other);
        assert.equal(visibleButtons['接管到本端'], false);
        assert.equal(visibleButtons['本端继续执行'], false);
        const ownership = control(workId);
        const api = createApi(service, out, 'B');
        const rejected = await api('steer-handoff', {
            sharedSpaceId, workId, opId: 'test-unsafe-handoff', expectedRevision: ownership.revision,
            expectedGeneration: ownership.generation, expectedExecutor: ownership.executor,
        });
        assert.equal(rejected.ok, false);
        const { error } = await rejected.json();
        assert.equal(error.code, 'WORK_SAFE_BOUNDARY_PENDING');
        assert.equal(admissions().length, 1);
        assert.equal(generations(workId).length, 1);
        assert.deepEqual(control(workId), ownership);
        assert.deepEqual(invocations(workId), before);
        assert.deepEqual(tool.counts(out), [{ marker }]);
        assert.deepEqual(service.calls.map(row => row.toolHandoffPhase), ['initial']);
        assert.deepEqual(journal().slice(0, initialJournal.length), initialJournal);
        const job = 'li[data-work-id="' + workId + '"]';
        await click(other, 'button', '查看并核对原请求');
        await click(other, job + ' details summary', '原生工具调用 1 项（返回不等于 AA 完成）');
        const callStatus = await waitUntil(async () => {
            const value = await evalJs(other, `document.querySelector(${quote(job + ' ul li')})?.innerText`);
            return value?.includes(before[0].invocation_id) && value;
        }, 'B displays the original uncertain tool invocation ID');
        assert.ok(callStatus.includes('结果待核对'));
        result.toolHandoff = {
            original, final: admissions().at(0), ownership, invocations: before, generations: generations(workId),
            review, callStatus, visibleButtons, rejectedHandoff: { httpStatus: rejected.status, error: error.code }, counter: tool.counts(out),
            desktopSources: await loadedDesktop(other, sha, result.candidate),
        };
        await picture(other, 'B-side-effect-needs-review');
        return;
    }

    const paused = await waitUntil(() => {
        const row = generations(workId).at(0);
        return row?.state === 'paused' && row.checkpoint_json && row;
    }, 'A durably pauses at the native tool boundary');
    const invocationsAtPause = invocations(workId);
    assert.equal(invocationsAtPause.length, 1);
    const [invocation] = invocationsAtPause;
    assert.equal(invocation.native_request_id, paused.request_id);
    assert.equal(invocation.state, 'returned');
    assert.equal(invocation.plugin_name, tool.name);
    const nativeProof = JSON.parse(db.prepare('SELECT proof_json FROM shared_native_checkpoints WHERE work_id=? AND generation=?')
        .get(workId, paused.generation).proof_json);
    assert.deepEqual(nativeProof.settledInvocationIds, [invocation.invocation_id]);
    assert.deepEqual(service.calls.map(row => row.toolHandoffPhase), ['initial']);
    await waitUntil(() => evalJs(A, `document.querySelector('[data-message-id="' + ${quote(paused.request_id)} + '"]')?.checkVisibility()`),
        'A renders the interrupted native Work before compaction');
    const transport = await waitUntil(() => service.requests.find(row => row.pauseTransport), 'original native request returns a typed pause');
    assert.equal(transport.device, 'deviceA');
    assert.equal(transport.pauseTransport, stream ? 'SSE' : 'HTTP');
    assert.equal(transport.status, stream ? 200 : 409);
    assert.deepEqual(transport.nativePause, { state: 'paused', code: 'WORK_SAFE_TOOL_BOUNDARY', requestId: paused.request_id });
    const streamTerminal = stream ? await waitUntil(() => A.events.find(row => row.event === 'renderer-event' &&
        row.data.channel === 'vcp-stream-event' && row.data.type === 'end' && row.data.modelFinishReason === 'interrupted'),
        'renderer receives native stream interruption as its terminal event') : null;
    assert.equal(JSON.parse(paused.checkpoint_json).finishReason, 'interrupted');
    const waitingCompaction = await waitUntil(async () => {
        const value = await status(A);
        return value?.includes('工具回执已确认') && value;
    }, 'A displays a confirmed tool receipt and waits for compaction');
    await waitUntil(() => evalJs(A, `!['VCP错误','原生执行中'].some(text => document.body.innerText.includes(text))`),
        'A clears the native error and live execution banners at a safe pause');
    const early = await createApi(service, out, 'B')('steer-handoff', {
        sharedSpaceId, workId, opId: 'test-handoff-before-compaction',
        expectedRevision: control(workId).revision, expectedGeneration: paused.generation, expectedExecutor: 'desktop:deviceA',
    });
    assert.equal(early.ok, false);
    const earlyHandoff = { httpStatus: early.status, error: (await early.json()).error.code };
    assert.equal(earlyHandoff.error, 'WORK_SAFE_BOUNDARY_PENDING');
    await picture(A, 'A-settled-tool-boundary');
    const point = await evalJs(A, `(() => {
        const row = document.querySelector('[data-message-id="' + ${quote(paused.request_id)} + '"]');
        row.scrollIntoView({block:'center',behavior:'instant'});
        const rect = row.getBoundingClientRect();
        return {x:Math.round(rect.left + rect.width / 2), y:Math.round(rect.top + rect.height / 2)};
    })()`);
    await A.command('mouse-right', point);
    await click(A, '.context-menu-item', '压缩前文');
    const committed = await waitUntil(() => db.prepare("SELECT message_id,committed_seq,proof_json FROM shared_compaction_intents WHERE work_id=? AND state='committed'").get(workId),
        'A compacts the original Work with the native receipt');
    assert.deepEqual(JSON.parse(committed.proof_json).native, [{requestId:paused.request_id,workId,hash:nativeProof.hash}]);
    const summary = service.calls.find(row => row.toolHandoffPhase === 'summary');
    assert.equal(summary.toolReceipt.invocationId, invocation.invocation_id);
    assert.equal(summary.toolReceipt.recordId, invocation.record_id);
    assert.ok(JSON.stringify(summary.toolReceipt.result).includes(fixture.toolResult(marker)));
    const card = client => evalJs(client, 'document.querySelector(".vcp-context-checkpoint")?.checkVisibility()');
    await waitUntil(() => card(A), 'A displays the committed compaction');
    const compactedHistory = read.A();
    const journalOnA = journal();
    assert.deepEqual(journalOnA.slice(0, initialJournal.length), initialJournal);
    assert.deepEqual(journalOnA.slice(initialJournal.length).map(row => row.msg_id),
        [original.request_id, paused.request_id, committed.message_id]);
    await picture(A, 'A-compacted-original-work');
    await stop('A');

    const other = await start('B-taking-over', 'B');
    assert.equal(result.B.profileDigest, result['B-taking-over'].profileDigest);
    await select(other, 'B');
    await waitUntil(() => card(other), 'B renders the checkpoint from A on reopening');
    assert.deepEqual(read.B(), compactedHistory);
    await action(other, '接管到本端');
    const dropped = await waitUntil(() => service.requests.find(row => row.route.endsWith('/steer-handoff') && row.dropped),
        'accepted B handoff receipt dropped at the loopback proxy');
    assert.ok(loseHandoff);
    assert.equal(dropped.body.workId, workId);
    assert.equal(dropped.device, 'deviceB');
    await waitUntil(() => control(workId).executor === 'desktop:deviceB', 'authoritative ownership moved to B');
    const unavailable = await waitUntil(() => other.events.find(row => row.event === 'ipc-result' &&
        row.data.channel === 'native-sync:handoff' && row.data.error === 'NETWORK_UNAVAILABLE'),
        'B receives the actual network loss');
    assert.deepEqual(invocations(workId), invocationsAtPause);
    assert.equal(generations(workId).length, 1);
    await stop('B-taking-over');

    const recovered = await start('B-recovered', 'B');
    assert.equal(result.B.profileDigest, result['B-recovered'].profileDigest);
    await select(recovered, 'B');
    await waitUntil(async () => (await buttons(recovered))['本端继续执行'], 'B recovers ownership by reading the original Work');
    await picture(recovered, 'B-recovered-handoff-after-lost-receipt');
    assert.equal(service.requests.filter(row => row.route.endsWith('/steer-handoff')).length, 1);
    assert.deepEqual(tool.counts(out), [{ marker }]);
    await action(recovered, '本端继续执行');
    const final = await waitUntil(() => admissions().find(row => row.id === workId && row.state === 'completed'),
        'B completes the original Work');
    const finished = generations(workId);
    assert.deepEqual(finished.map(row => [row.generation, row.executor]), [
        [paused.generation, 'desktop:deviceA'], [paused.generation + 1, 'desktop:deviceB'],
    ]);
    assert.equal(finished.at(0).request_id, paused.request_id);
    assert.equal(admissions().length, 1);
    assert.equal(service.calls[0].id, paused.request_id);
    assert.equal(service.calls.at(-1).id, finished.at(-1).request_id);
    assert.equal(service.requests.filter(row => row.route.endsWith('/admit') && row.device === 'deviceB').length, 0);
    assert.equal(final.request_id, original.request_id);
    assert.deepEqual(invocations(workId), invocationsAtPause);
    assert.deepEqual(tool.counts(out), [{ marker }]);
    assert.deepEqual(service.calls.map(row => row.toolHandoffPhase), ['initial', 'summary', 'resumed']);
    const resumed = service.calls.at(-1);
    const resumedContext = JSON.stringify(resumed.messages);
    assert.ok(resumedContext.includes(invocation.invocation_id));
    assert.ok(resumedContext.includes(invocation.record_id));
    assert.ok(resumedContext.includes(fixture.toolResult(marker)));
    assert.equal(resumedContext.split(checkpointMarker).length, 2);
    assert.ok(!resumedContext.includes('SYNTHETIC SAME TEXT'));
    assert.ok(!resumedContext.includes('<<<[TOOL_REQUEST]>>>'));
    assert.deepEqual(journal().slice(0, journalOnA.length), journalOnA);
    assert.deepEqual(journal().slice(journalOnA.length).map(row => row.msg_id), [finished.at(-1).request_id]);
    const saved = await waitUntil(() => {
        const history = read.B();
        const reply = history.at(-1);
        return reply?.id === finished.at(-1).request_id && JSON.stringify(reply.content).includes(fixture.finalText) && history;
    }, 'B writes the final original Work reply to its physical History');
    assert.deepEqual(saved.slice(0, -1), compactedHistory);
    await waitUntil(() => evalJs(recovered, `document.querySelector('#chatMessages').innerText.includes(${quote(fixture.finalText)})`),
        'B renders the completed original Work result');
    result.toolHandoff = {
        original, final, paused, nativeProof, committed, generations: finished, invocations: invocationsAtPause,
        waitingCompaction, earlyHandoff, ...(streamTerminal && { streamTerminal: streamTerminal.data.modelFinishReason }), nativePause: { transport: transport.pauseTransport, httpStatus: transport.status, ...transport.nativePause },
        droppedHandoff: { workId, status: dropped.status, executor: control(workId).executor, dropped: dropped.dropped, opId: dropped.body.opId, clientError: unavailable.data.error },
        desktopSources: await loadedDesktop(recovered, sha, result.candidate),
        counter: tool.counts(out), history: saved, journal: journal(), summaryReceipt: summary.toolReceipt,
    };
    await picture(recovered, 'B-completed-original-tool-work');
}

module.exports = async context => {
    const db = new DatabaseSync(path.join(context.service.data, 'central.sqlite'), { readOnly: true });
    try {
        const run = context.result.mode === 'tool-handoff-baseline' ? baseline : candidate;
        await run({ ...context, db });
    } finally {
        db.close();
    }
};

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { setTimeout: delay } = require('node:timers/promises');
const tool = require('../ordinary-tools/fixture.cjs');
const fixture = require('./fixture.cjs');

const sharedSpaceId = 'sharedAB';
const panel = '.native-sync-controlled-work';
const quote = JSON.stringify;
const checkpointMarker = 'COMPACT_DESKTOP_CHECKPOINT';

function createApi(service, out, role, duo = false) {
    const connection = JSON.parse(fs.readFileSync(path.join(out, 'seed', 'desktop' + role, '.native-sync', 'connection.json'), 'utf8'));
    const headers = {
        'content-type': 'application/json', authorization: 'Bearer synthetic-only',
        'x-nativesync-space': connection.spaceId, 'x-nativesync-source': 'source' + role, 'x-nativesync-device': 'device' + role,
        'x-nativesync-capabilities': 'shared-space-v1,shared-context-v1,shared-controlled-text-v1,shared-controlled-tools-v1,shared-steering-v1,message-intents-v1' +
            (duo ? ',shared-controlled-tool-pair-v1' : ''),
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
            'apps/desktop/modules/services/nativeSync/syncRequest.js',
            'apps/desktop/modules/services/nativeSync/sharedExecution.js',
            'apps/desktop/modules/services/nativeSync/sharedSteeringClient.js',
        ],
        renderer: [
            'apps/desktop/modules/renderer/controlledWorkView.mjs',
            'apps/desktop/modules/chatManager.js',
            'apps/desktop/modules/chat/chatHistoryPersistence.js',
            'apps/desktop/modules/renderer/mainChatSurfaceAdapter.js',
            'apps/desktop/modules/services/nativeSync/sharedSessionView.mjs',
        ],
    };
    const loaded = await client.command('loaded-sources', expected);
    for (const [kind, files] of Object.entries(expected)) {
        for (const file of files) assert.ok(loaded[kind].some(row => row.file === file && row.sha256 === sha(path.join(root, file))), file);
    }
    return { main: loaded.main, renderer: loaded.renderer };
}

async function candidate({ result, service, out, clients: { A, B }, picture, click, evalJs, waitUntil, stop, start, quitBeforeFinalReceipt, profiles, sha, toolHandoff, db, crash }) {
    const {
        marker, duo, duoBaseline, unknown, counts, expectedCounts, secondResult, loseHandoff, stream, finalReceipt, receipt,
        firstEffectReady, releaseFirstReceipt, secondEffectReady,
    } = toolHandoff;
    const read = {};
    const ledgerFile = path.join(profiles.B, '.native-sync', 'shared', sharedSpaceId, 'executions.json');
    const expectedObservedHash = createHash('sha256').update(fixture.finalText).digest('hex');
    function readFinalLedger(workId, requestId) {
        const state = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
        const work = Object.values(state.requests).find(row => row.accepted?.id === workId);
        const step = work?.generations?.find(row => row.requestId === requestId);
        return step && {
            generation: step.generation, requestId: step.requestId, workState: work.phase,
            readback: step.finalHistoryReadback === true, replyAccepted: step.replyAccepted === true,
            hasReplyIntent: Object.hasOwn(step, 'replyIntent'), observedFinalHash: step.observedFinalHash ?? null,
        };
    }
    async function checkFinalLedger(workId, requestId, { observed = false, legacy = false } = {}) {
        const value = await waitUntil(() => {
            const row = readFinalLedger(workId, requestId);
            if (observed && row?.observedFinalHash !== expectedObservedHash) return false;
            if (legacy && !row?.hasReplyIntent) return false;
            return row;
        }, 'B retains the expected original request ledger fields');
        assert.equal(value.generation, 1);
        assert.equal(value.readback, !legacy);
        assert.equal(value.hasReplyIntent, legacy);
        assert.equal(value.observedFinalHash, observed ? expectedObservedHash : null);
        return value;
    }
    const buttons = client => evalJs(client, `Object.fromEntries([...document.querySelectorAll(${quote(panel + ' button')})]
        .map(button => [button.textContent.trim(), !button.disabled]))`);
    const status = client => evalJs(client, `document.querySelector(${quote(panel + ' [role=status]')})?.innerText`);
    const renderedFinal = (client, requestId) =>
        evalJs(client, `[...document.querySelectorAll(${quote('#chatMessages .message-item[data-message-id="' + requestId + '"]')})]
            .map(item => ({ textShown: item.innerText.includes(${quote(fixture.finalText)}) }))`);
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
    const admissions = () => db.prepare('SELECT id,request_id,principal,state,dispatched,native_terminal,reply_seq FROM shared_admissions WHERE topic_id=?').all(sharedId);
    const control = id => db.prepare('SELECT revision,generation,executor FROM shared_work_controls WHERE work_id=?').get(id);
    const generations = id => db.prepare('SELECT generation,executor,request_id,state,checkpoint_json FROM shared_work_generations WHERE work_id=? ORDER BY generation').all(id);
    const invocations = id => db.prepare(`
        SELECT invocation_id,execution_id,native_request_id,plugin_name,record_id,state,error_code
        FROM mobile_native_invocations WHERE execution_id=? ORDER BY rowid
    `).all(id);
    const journal = () => db.prepare('SELECT seq,msg_id,action,hash FROM journal WHERE topic_id=? ORDER BY seq').all(topicId);
    function archiveSnapshot(requestId, rows) {
        const file = path.join(out, 'runtime-box', '.state', 'native-continuations',
            createHash('sha256').update(JSON.stringify(requestId)).digest('hex') + '.json');
        const archive = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.equal(archive.identity.workId, workId);
        assert.equal(archive.identity.requestId, requestId);
        const returned = rows.filter(row => row.state === 'returned');
        assert.deepEqual(archive.events.map(event => event.kind), ['assistant', ...returned.map(() => 'result')]);
        assert.deepEqual(archive.events.slice(1).map(event => event.invocationId), returned.map(row => row.invocation_id));
        assert.deepEqual(Object.values(archive.results).map(row => [row.invocationId, row.recordId]),
            returned.map(row => [row.invocation_id, row.record_id]));
        return { identity: archive.identity, events: archive.events, results: Object.values(archive.results) };
    }
    const initialJournal = journal();
    await evalJs(A, `(() => {
        const input = document.querySelector(${quote(panel + ' textarea')});
        input.focus();
        input.value = ${quote(marker)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await action(A, '新建工具任务');
    const original = await waitUntil(() => admissions().at(0), 'A admits one controlled tool Work');
    if (['tool-handoff', 'tool-handoff-stream'].includes(result.mode)) {
        const { user_op } = db.prepare('SELECT user_op FROM shared_admissions WHERE id=?').get(original.id);
        const turn = JSON.parse(user_op).sharedTurn;
        assert.equal(turn.controlMode, 'safe-tools-v1');
        assert.equal(Object.hasOwn(turn, 'toolBatchLimit'), false, 'single-tool compatibility uses an unnegotiated Work');
    }
    assert.equal(original.principal, 'desktop:deviceA');
    assert.equal(original.state, 'accepted');
    assert.equal(original.dispatched, 0);
    const noEffects = duo ? { first: [], second: [] } : [];
    assert.deepEqual(counts(), noEffects);
    const workId = original.id;
    await action(A, '本端继续执行');
    if (duoBaseline) {
        const attempted = await waitUntil(() => service.requests.find(row => row.nativeError === 'CONTROLLED_TOOL_CALL_LIMIT'), 'baseline rejects the two-tool batch');
        assert.equal(attempted.device, 'deviceA');
        assert.equal(attempted.status, 500);
        assert.deepEqual(counts(), noEffects);
        assert.deepEqual(invocations(workId), []);
        assert.deepEqual(service.calls.map(call => call.toolsRequested), [[tool.name, fixture.secondName]]);
        assert.equal(generations(workId).length, 1);
        await waitUntil(async () => (await status(A))?.includes('原任务需要核对'), 'A displays review after the original limit');
        await picture(A, 'A-baseline-two-tool-limit');
        await stop('A');
        const observer = await start('B-baseline', 'B');
        await select(observer, 'B');
        const statusB = await waitUntil(async () => {
            const value = await status(observer);
            return value?.includes('原任务需要核对') && value;
        }, 'B reads the original rejected Work');
        await picture(observer, 'B-baseline-observes-rejected-work');
        assert.deepEqual(counts(), noEffects);
        result.toolHandoff = { original, attempted, native: admissions().at(0), generations: generations(workId),
            invocations: invocations(workId), counters: counts(), statusB,
            desktopSources: await loadedDesktop(observer, sha, result.candidate) };
        return;
    }
    if (duo) {
        await waitUntil(firstEffectReady, 'first tool fsync completes while its receipt is held');
        await delay(200);
        const heldFirst = { counters: counts(), invocations: invocations(workId) };
        assert.deepEqual(heldFirst.counters, { first: [{ marker }], second: [] });
        assert.deepEqual(heldFirst.invocations.map(row => [row.plugin_name, row.state]), [[tool.name, 'started']]);
        result.heldFirst = heldFirst;
        releaseFirstReceipt();
    }
    await waitUntil(() => duo ? counts().second.length === 1 : counts().length === 1,
        'A invokes the isolated fsync counter(s) exactly once');

    if (unknown) {
        let interruption;
        if (duo) {
            await waitUntil(secondEffectReady, 'second counter fsync completed without returning a receipt');
            const before = invocations(workId);
            const generation = generations(workId).at(0);
            assert.equal(admissions().at(0).state, 'dispatched');
            assert.deepEqual(before.map(row => [row.plugin_name, row.state, row.native_request_id]), [
                [tool.name, 'returned', generation.request_id],
                [fixture.secondName, 'started', generation.request_id],
            ]);
            assert.deepEqual(counts(), expectedCounts);
            const archive = archiveSnapshot(generation.request_id, before);
            const backendBefore = service.backendPid;
            const exit = await service.restartAfterCrash();
            assert.notEqual(service.backendPid, backendBefore);
            assert.deepEqual(invocations(workId), before);
            assert.deepEqual(archiveSnapshot(generation.request_id, before), archive);
            interruption = { backendBefore, exit, backendAfter: service.backendPid, archive };
        }
        await waitUntil(() => admissions().at(0)?.state === 'review_required', 'ToolBox quarantines the unknown external outcome');
        const before = invocations(workId);
        assert.deepEqual(before.map(row => [row.plugin_name, row.state]), duo
            ? [[tool.name, 'returned'], [fixture.secondName, 'started']]
            : [[tool.name, 'started']]);
        assert.equal(before.at(-1).state, 'started', 'external result remains unconfirmed in the invocation ledger');
        if (duo) {
            const final = admissions().at(0);
            assert.equal(final.native_terminal, 0);
            assert.equal(final.reply_seq, null);
            assert.equal(generations(workId).at(0).checkpoint_json, null);
            assert.equal(db.prepare('SELECT count(*) AS n FROM shared_native_checkpoints WHERE work_id=?').get(workId).n, 0);
        }
        if (!duo) {
            await waitUntil(async () => (await status(A))?.includes('原任务需要核对'), 'A displays unresolved side effects');
            await picture(A, 'A-side-effect-needs-review');
        }
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
        const api = createApi(service, out, 'B', duo);
        const rejected = await api('steer-handoff', {
            sharedSpaceId, workId, opId: 'test-unsafe-handoff', expectedRevision: ownership.revision,
            expectedGeneration: ownership.generation, expectedExecutor: ownership.executor,
        });
        assert.equal(rejected.ok, false);
        const { error } = await rejected.json();
        assert.equal(error.code, 'WORK_SAFE_BOUNDARY_PENDING');
        let blockedOperations;
        if (duo) {
            const scope = { sharedSpaceId, sharedId };
            const originalApi = createApi(service, out, 'A', duo);
            const context = await originalApi('context?' + new URLSearchParams(scope));
            assert.equal(context.status, 200);
            const { head, hash } = await context.json();
            const rejectedCompaction = await originalApi('compact-prepare', {
                ...scope, expectedHead: head, opId: 'test-unknown-compact-prepare',
            });
            const compactionCode = (await rejectedCompaction.json()).error?.code;
            assert.equal(rejectedCompaction.status, 409);
            assert.equal(compactionCode, 'WORK_SAFE_BOUNDARY_PENDING');
            const rejectedContinue = await api('steer-prepare', {
                sharedSpaceId, workId, opId: 'test-unknown-continue', expectedRevision: ownership.revision,
                expectedGeneration: ownership.generation, expectedHead: head, configHash: hash,
            });
            const continueCode = (await rejectedContinue.json()).error?.code;
            assert.equal(rejectedContinue.ok, false);
            assert.equal(continueCode, 'SHARED_REQUEST_FENCED');
            assert.equal(db.prepare('SELECT count(*) AS n FROM shared_compaction_intents WHERE work_id=?').get(workId).n, 0);
            blockedOperations = {
                compactPrepare: { device: 'deviceA', httpStatus: rejectedCompaction.status, error: compactionCode },
                continue: { device: 'deviceB', httpStatus: rejectedContinue.status, error: continueCode },
            };
        }
        assert.equal(admissions().length, 1);
        assert.equal(generations(workId).length, 1);
        assert.deepEqual(control(workId), ownership);
        assert.deepEqual(invocations(workId), before);
        assert.deepEqual(counts(), expectedCounts);
        assert.deepEqual(service.calls.map(row => row.toolHandoffPhase), ['initial']);
        assert.deepEqual(journal().slice(0, initialJournal.length), initialJournal);
        if (duo) assert.deepEqual(journal().slice(initialJournal.length).map(row => row.msg_id), [original.request_id]);
        const job = 'li[data-work-id="' + workId + '"]';
        await click(other, 'button', '查看并核对原请求');
        await click(other, job + ' details summary', '原生工具调用 ' + before.length + ' 项（返回不等于 AA 完成）');
        const callStatuses = await waitUntil(async () => {
            const values = await evalJs(other, `[...document.querySelectorAll(${quote(job + ' ul li')})].map(row => row.innerText)`);
            return values.some(value => value.includes(before.at(-1).invocation_id)) && values;
        }, 'B displays the original uncertain tool invocation ID');
        const callStatus = callStatuses.find(value => value.includes(before.at(-1).invocation_id));
        assert.ok(callStatus.includes('结果待核对'));
        if (duo) assert.ok(callStatuses.some(value => value.includes(before[0].invocation_id) && value.includes('工具调用已返回')));
        result.toolHandoff = {
            original, final: admissions().at(0), ownership, invocations: before, generations: generations(workId),
            ...(interruption && { interruption, blockedOperations }),
            review, callStatus, ...(duo && { callStatuses, journal: journal() }), visibleButtons, rejectedHandoff: { httpStatus: rejected.status, error: error.code }, counter: counts(),
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
    assert.equal(invocationsAtPause.length, duo ? 2 : 1);
    const [invocation] = invocationsAtPause;
    assert.equal(invocation.native_request_id, paused.request_id);
    assert.equal(invocation.state, 'returned');
    assert.equal(invocation.plugin_name, tool.name);
    const archive = duo ? archiveSnapshot(paused.request_id, invocationsAtPause) : undefined;
    const readNativeProof = () => JSON.parse(db.prepare('SELECT proof_json FROM shared_native_checkpoints WHERE work_id=? AND generation=?')
        .get(workId, paused.generation).proof_json);
    const nativeProof = readNativeProof();
    assert.deepEqual(nativeProof.settledInvocationIds, invocationsAtPause.map(row => row.invocation_id));
    assert.deepEqual(invocationsAtPause.map(row => [row.plugin_name, row.state, row.native_request_id]), [
        [tool.name, 'returned', paused.request_id],
        ...(duo ? [[fixture.secondName, 'returned', paused.request_id]] : []),
    ]);
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
    const early = await createApi(service, out, 'B', duo)('steer-handoff', {
        sharedSpaceId, workId, opId: 'test-handoff-before-compaction',
        expectedRevision: control(workId).revision, expectedGeneration: paused.generation, expectedExecutor: 'desktop:deviceA',
    });
    assert.equal(early.ok, false);
    const earlyHandoff = { httpStatus: early.status, error: (await early.json()).error.code };
    assert.equal(earlyHandoff.error, 'WORK_SAFE_BOUNDARY_PENDING');
    await picture(A, 'A-settled-tool-boundary');
    if (duo) {
        const backendBefore = service.backendPid;
        const beforeRestart = { admission: admissions().at(0), control: control(workId), journal: journal() };
        const exit = await service.restartWithUpgrade();
        assert.deepEqual(exit, { code: 0, signal: null });
        assert.notEqual(service.backendPid, backendBefore);
        assert.deepEqual(admissions().at(0), beforeRestart.admission);
        assert.deepEqual(control(workId), beforeRestart.control);
        assert.deepEqual(journal(), beforeRestart.journal);
        assert.deepEqual(generations(workId), [paused]);
        assert.deepEqual(invocations(workId), invocationsAtPause);
        assert.deepEqual(archiveSnapshot(paused.request_id, invocationsAtPause), archive);
        assert.deepEqual(readNativeProof(), nativeProof);
        assert.deepEqual(counts(), expectedCounts);
        result.pausedRestart = { backendBefore, exit, backendAfter: service.backendPid, proof: readNativeProof() };
    }
    async function compact(client) {
        const point = await evalJs(client, `(() => {
            const row = document.querySelector('[data-message-id="' + ${quote(paused.request_id)} + '"]');
            row.scrollIntoView({block:'center',behavior:'instant'});
            const rect = row.getBoundingClientRect();
            return {x:Math.round(rect.left + rect.width / 2), y:Math.round(rect.top + rect.height / 2)};
        })()`);
        await client.command('mouse-right', point);
        await click(client, '.context-menu-item', '压缩前文');
    }
    let publisher = A;
    let publisherRole = 'A';
    await compact(publisher);
    const committed = await waitUntil(() => db.prepare("SELECT id,message_id,committed_seq,proof_json FROM shared_compaction_intents WHERE work_id=? AND state='committed'").get(workId),
        'A compacts the original Work with the native receipt');
    if (toolHandoff.loseCompactionAck) {
        const route = suffix => service.requests.filter(row => row.route.endsWith('/compact-' + suffix));
        const ipc = (client, suffix) => client.events.filter(row => row.event === 'ipc-result' && row.data.channel === 'native-sync:compact-' + suffix);
        const dropped = await waitUntil(() => route('commit').find(row => row.dropped), 'ToolBox commits before the ACK is cut');
        const failed = await waitUntil(() => ipc(A, 'commit')[0], 'desktop sees failed commit transport');
        const publicationFile = path.join(profiles.A, '.native-sync', 'shared', sharedSpaceId, 'executions.json');
        const localIntent = () => JSON.parse(fs.readFileSync(publicationFile, 'utf8')).compactions?.[committed.id];
        const calls = () => service.calls.filter(row => row.toolHandoffPhase === 'summary');
        const before = { local:localIntent(), journal:journal(), commit:structuredClone(dropped), ipc:failed.data, summaries:calls().length };
        assert.equal(before.ipc.success, false);
        assert.equal(before.local.awaitingConfirmation, true);
        assert.equal(before.summaries, 1);
        assert.equal(dropped.response.messageId, committed.message_id);
        assert.equal(dropped.response.seq, committed.committed_seq);
        await picture(A, 'A-central-compaction-ack-dropped');
        const crashReceipt = await crash('A');
        toolHandoff.releaseCompactionAck();
        publisherRole = 'A-compaction-reopened';
        publisher = await start(publisherRole, 'A');
        await select(publisher, 'A');
        await compact(publisher);
        const recovered = await waitUntil(() => ipc(publisher, 'prepare')[0], 'reopened A confirms the original compaction');
        const workLink = db.prepare('SELECT * FROM shared_work_compactions WHERE checkpoint_id=?').get(committed.message_id);
        const after = { local:localIntent(), recovered:recovered.data, workLink, journal:journal(), commits:route('commit'), summaries:calls().length };
        result.compactionAck = { workId, originalRequestId:paused.request_id, committed, before, after, crashReceipt };
        assert.equal(after.recovered.recovered, true);
        assert.equal(after.recovered.intentId, committed.id);
        assert.equal(after.recovered.checkpointId, committed.message_id);
        assert.equal(after.local.awaitingConfirmation, false);
        assert.equal(after.local.phase, 'completed');
        assert.equal(after.workLink.work_id, workId);
        assert.equal(after.workLink.journal_seq, committed.committed_seq);
        assert.deepEqual(after.journal, before.journal);
        assert.equal(after.summaries, 1);
        assert.ok(route('commit').length >= 2 && route('commit').some(row => !row.dropped));
        assert.ok(route('commit').every(row => row.bodySha256 === dropped.bodySha256 && row.response.seq === dropped.response.seq));
        assert.equal(route('prepare').length, 1);
    }
    assert.deepEqual(JSON.parse(committed.proof_json).native, [{requestId:paused.request_id,workId,hash:nativeProof.hash}]);
    const summary = service.calls.find(row => row.toolHandoffPhase === 'summary');
    assert.equal(summary.toolReceipt.invocationId, invocation.invocation_id);
    assert.equal(summary.toolReceipt.recordId, invocation.record_id);
    assert.ok(JSON.stringify(summary.toolReceipt.result).includes(fixture.toolResult(marker)));
    const card = client => evalJs(client, 'document.querySelector(".vcp-context-checkpoint")?.checkVisibility()');
    await waitUntil(() => card(publisher), 'A displays the committed compaction');
    const compactedHistory = read.A();
    const journalOnA = journal();
    assert.deepEqual(journalOnA.slice(0, initialJournal.length), initialJournal);
    assert.deepEqual(journalOnA.slice(initialJournal.length).map(row => row.msg_id),
        [original.request_id, paused.request_id, committed.message_id]);
    await picture(publisher, 'A-compacted-original-work');
    await stop(publisherRole);

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
    assert.deepEqual(counts(), expectedCounts);
    await action(recovered, '本端继续执行');
    const publicationsByB = () => service.requests.filter(row => row.device === 'deviceB' && row.route.endsWith('/steer-turn-complete'));
    const readbacks = () => service.requests.filter(row => row.device === 'deviceB' && row.route.endsWith('/final-reply'));
    const isCommittedReadback = (row, requestId) =>
        row.query?.requestId === requestId && row.response?.state === 'committed' && !row.dropped;
    const waitReadback = (requestId, after = 0) => waitUntil(
        () => readbacks().find(row => row.at >= after && isCommittedReadback(row, requestId)),
        'B successfully reads the committed final reply');
    function assertReadback(reply, generation, seq) {
        assert.equal(reply.method, 'GET');
        assert.equal(reply.status, 200);
        assert.deepEqual(reply.query, { sharedSpaceId, workId, requestId: generation.request_id, generation: String(generation.generation) });
        const { sharedId: repliedTopic, requestId, state, message, historyState } = reply.response;
        assert.equal(repliedTopic, sharedId);
        assert.equal(state, 'committed');
        assert.equal(historyState, 'original');
        assert.equal(requestId, generation.request_id);
        assert.equal(reply.response.workId, workId);
        assert.equal(reply.response.generation, generation.generation);
        assert.equal(reply.response.seq, seq);
        assert.equal(message.id, generation.request_id);
        assert.equal(message.content, fixture.finalText);
        assert.equal(message.finishReason, 'completed');
    }
    if (finalReceipt) {
        const resumed = await waitUntil(() => service.calls.find(call => call.toolHandoffPhase === 'resumed'), 'B reaches the actual Provider');
        assert.ok(receipt.releaseProvider, 'the final Provider response is held after dispatch');
        const requestId = resumed.id;
        const nativeRow = () => db.prepare('SELECT id,admission_id,principal,state FROM shared_native_requests WHERE id=?').get(requestId);
        const archiveFile = path.join(out, 'runtime-box', '.state', 'native-continuations',
            require('node:crypto').createHash('sha256').update(JSON.stringify(requestId)).digest('hex') + '.json');
        const observedPreview = client => evalJs(client, `(() => {
            const item = document.querySelector(${quote('.native-sync-live-message[data-native-sync-request="' + requestId + '"]')});
            return item ? { kind: item.dataset.nativeSyncPreview, status: item.querySelector('[role=status]')?.innerText,
                text: item.querySelector('pre')?.innerText } : null;
        })()`);
        async function snapshot(client) {
            const archive = JSON.parse(fs.readFileSync(archiveFile, 'utf8'));
            assert.equal(archive.identity.workId, workId);
            const history = read.B();
            const canonicalFinal = db.prepare('SELECT message_json FROM journal WHERE topic_id=? AND msg_id=? ORDER BY seq').all(topicId, requestId)
                .map(row => JSON.parse(row.message_json));
            const physicalFinal = history.filter(row => row.id === requestId);
            const value = {
                backendPid: service.backendPid, admission: admissions()[0], native: nativeRow(), control: control(workId),
                generations: generations(workId), journal: journal().map(row => row.msg_id), history: history.map(row => row.id),
                journalFinal: canonicalFinal.map(row => row.content),
                historyFinal: physicalFinal.map(row => row.content),
                journalFinishReasons: canonicalFinal.map(row => row.finishReason),
                historyFinishReasons: physicalFinal.map(row => row.finishReason),
                archive: { identity: archive.identity, assistant: archive.assistant, completion: archive.completion ?? null },
                phases: db.prepare('SELECT stage,at FROM shared_request_phases WHERE request_id=? ORDER BY at').all(requestId),
                counter: counts(), providerCalls: service.calls.map(row => ({ id: row.id, phase: row.toolHandoffPhase })),
                ...(client && { status: await status(client), buttons: await buttons(client), renderedFinal: await renderedFinal(client, requestId),
                    nativePreview: await observedPreview(client) }),
            };
            return value;
        }
        assert.deepEqual({ ...nativeRow() }, { id: requestId, admission_id: workId, principal: 'desktop:deviceB', state: 'dispatched' });
        const beforeExit = await snapshot(recovered);
        assert.equal(beforeExit.renderedFinal.some(item => item.textShown), false);
        assert.equal(beforeExit.admission.native_terminal, 0);
        await picture(recovered, 'B-final-dispatched-before-exit');
        async function finishUpstream() {
            receipt.releaseProvider();
            const upstream = await waitUntil(() => receipt.upstream, 'ToolBox sends a complete native final response to the detached proxy');
            assert.deepEqual({ ...upstream, at: undefined }, { at: undefined, status: 200, bodyComplete: true,
                finishReason: 'stop', text: fixture.finalText, ...(stream && { done: true }) });
        }
        let terminalBeforeExit;
        if (finalReceipt === 'terminal' && process.env.VCP_TEST_TERMINAL_BEFORE_CLOSE === '1') {
            await finishUpstream();
            await waitUntil(() => nativeRow().state === 'model_terminal' || admissions()[0]?.state === 'completed',
                'ToolBox records or publishes the model terminal before B quits');
            terminalBeforeExit = await snapshot(recovered);
            assert.equal(receipt.downstream, undefined, 'B remains connected without receiving the buffered model response');
        }
        const exit = await quitBeforeFinalReceipt('B-recovered');
        const publishedBeforeReopen = publicationsByB().length;
        assert.equal(publishedBeforeReopen, 0, 'B never received and submitted the model reply before it exited');
        await waitUntil(() => receipt.downstream, 'B downstream connection closed');
        assert.equal(receipt.downstream.headersSent, false);
        if (finalReceipt === 'terminal') {
            if (!terminalBeforeExit) await finishUpstream();
            const [first, second] = terminalBeforeExit ? [receipt.upstream, receipt.downstream] : [receipt.downstream, receipt.upstream];
            assert.ok(first.at <= second.at, 'The proxy observed the intended ordering between the native response and B disconnecting');
        } else {
            await waitUntil(() => receipt.providerClosed, 'B disconnect closes the Provider request');
            assert.equal(receipt.providerClosed.responseEnded, false);
        }
        const afterExit = await snapshot();
        const reopeningAt = Date.now();
        const restarted = await start('B-after-final-loss', 'B');
        assert.equal(result.B.profileDigest, result['B-after-final-loss'].profileDigest);
        await select(restarted, 'B');
        const selectedAt = Date.now();
        await delay(1600);
        const beforeManualCheck = await snapshot(restarted);
        const executionReads = () => restarted.events.filter(event => event.event === 'ipc-result' &&
            event.data.channel === 'native-sync:executions' && event.data.success !== false).length;
        const readsBefore = executionReads();
        await action(restarted, '核对任务');
        await waitUntil(() => executionReads() > readsBefore, 'B completes an explicit read-only Work refresh');
        const manualCheck = { selectedAt, checkedAt: Date.now(), readsBefore, readsAfter: executionReads(), beforeManualCheck };
        await waitUntil(async () => !(await status(restarted))?.startsWith('操作已确认'),
            'the periodic refresh renders the Work status after the check acknowledgement');
        const readbackBeforeReopen = terminalBeforeExit &&
            readbacks().find(row => row.at < reopeningAt && isCommittedReadback(row, requestId));
        const recoveredReply = toolHandoff.readback ?
            readbackBeforeReopen || await waitReadback(requestId, reopeningAt) : undefined;
        if (recoveredReply) {
            assertReadback(recoveredReply, generations(workId).at(-1), admissions()[0].reply_seq);
            await waitUntil(async () => (await renderedFinal(restarted, requestId)).some(row => row.textShown),
                'B shows the readback reply after reopening');
        }
        const reopened = await snapshot(restarted);
        const reopenedLedger = toolHandoff.readback || (finalReceipt === 'unknown' && !result.serverRevision)
            ? await checkFinalLedger(workId, requestId) : undefined;
        assert.equal(reopened.backendPid, beforeExit.backendPid);
        await picture(restarted, 'B-reopened-toolbox-kept-running');
        await stop('B-after-final-loss');
        const backendExit = await service.restartAfterCrash();
        const afterBackend = await start('B-after-toolbox-restart', 'B');
        assert.equal(result.B.profileDigest, result['B-after-toolbox-restart'].profileDigest);
        await select(afterBackend, 'B');
        await delay(1600);
        const reopenedAfterBackend = await snapshot(afterBackend);
        const reopenedAfterBackendLedger = reopenedLedger ? await checkFinalLedger(workId, requestId) : undefined;
        await picture(afterBackend, 'B-reopened-after-toolbox-restart');
        result.finalReceipt = {
            branch: finalReceipt, workId, requestId, receipt, exit, backendExit, beforeExit, terminalBeforeExit, afterExit, reopened, reopenedAfterBackend,
            manualCheck, recoveredReply, reopenedLedger, reopenedAfterBackendLedger,
            ...(recoveredReply && {readbackBeforeReopen: Boolean(readbackBeforeReopen)}), profileDigest: result.B.profileDigest, desktopSources: await loadedDesktop(afterBackend, sha, result.candidate),
            publishedBeforeReopen, publishedByB: publicationsByB().length,
        };
        assert.deepEqual(invocations(workId), invocationsAtPause);
        assert.deepEqual(counts(), expectedCounts);
        assert.equal(admissions().length, 1);
        assert.equal(admissions()[0].request_id, original.request_id);
        assert.deepEqual(generations(workId).map(({generation, executor, request_id}) => [generation, executor, request_id]),
            [[paused.generation, 'desktop:deviceA', paused.request_id], [paused.generation + 1, 'desktop:deviceB', requestId]]);
        assert.deepEqual(service.calls.map(row => row.toolHandoffPhase), ['initial', 'summary', 'resumed']);
        assert.deepEqual(journal().slice(0, journalOnA.length), journalOnA);
        if (finalReceipt === 'terminal') {
            const outcome = value => ({
                workState: value.admission.state,
                journalFinal: value.journalFinal,
                historyFinal: value.historyFinal,
                renderedFinal: value.renderedFinal,
            });
            const expected = { workState: 'completed', journalFinal: [fixture.finalText], historyFinal: [fixture.finalText], renderedFinal: [{ textShown: true }] };
            assert.deepEqual([outcome(reopened), outcome(reopenedAfterBackend)], [expected, expected],
                'Reopening should recover one final reply for the original Work in Journal, physical History and chat');
            const finalRows = journal().slice(journalOnA.length);
            assert.deepEqual(finalRows.map(row => row.msg_id), [requestId]);
            for (const value of [reopened, reopenedAfterBackend]) {
                assert.equal(value.admission.native_terminal, 1);
                assert.equal(value.native.state, 'model_terminal');
                assert.equal(value.admission.reply_seq, finalRows[0].seq);
                assert.deepEqual(value.journalFinishReasons, ['completed']);
                assert.deepEqual(value.historyFinishReasons, ['completed']);
                assert.equal(value.generations.at(-1).state, 'completed');
                assert.equal(value.archive.completion?.finishReason, 'stop');
                assert.equal(value.archive.completion?.workId, workId);
                assert.equal(value.archive.completion?.generation, paused.generation + 1);
                assert.equal(value.archive.completion?.requestId, requestId);
                assert.equal(value.archive.completion?.executor, 'desktop:deviceB');
                assert.equal(value.archive.completion?.content, fixture.finalText);
            }
            assert.equal(publicationsByB().length, 0, 'The recovered native reply needs no desktop publication');
        } else {
            assert.equal(result.finalReceipt.publishedByB, 0, 'B cannot publish a final reply with no authoritative model terminal');
            assert.deepEqual(journal(), journalOnA);
            for (const value of [reopened, reopenedAfterBackend]) {
                assert.equal(value.admission.state, 'review_required');
                assert.equal(value.admission.native_terminal, 0);
                assert.equal(value.native.state, 'unknown');
                assert.equal(value.admission.reply_seq, null);
                assert.equal(value.archive.completion, null);
                assert.deepEqual(value.historyFinal, []);
                assert.deepEqual(value.journalFinal, []);
                assert.deepEqual(value.renderedFinal, []);
                assert.equal(value.buttons['本端继续执行'] ?? false, false);
            }
        }
        return;
    }
    const final = await waitUntil(() => admissions().find(row => row.id === workId && row.state === 'completed'),
        'B completes the original Work');
    let finalReader = recovered;
    if (toolHandoff.losePublication) {
        const publication = await waitUntil(() => service.requests.find(row => row.device === 'deviceB' &&
            row.route.endsWith('/steer-turn-complete') && row.dropped && row.response?.workState === 'completed'),
        'B publication succeeded centrally and the proxy cut its ACK');
        const replyId = generations(workId).at(-1).request_id;
        const committedJournal = journal();
        assert.equal(publication.body.workId, workId);
        assert.equal(publication.body.message.id, replyId);
        assert.equal(committedJournal.at(-1).msg_id, replyId);
        assert.equal(committedJournal.at(-1).seq, publication.response.receipt.seq);
        const before = { historyIds: read.B().map(row => row.id), journal: committedJournal, calls: service.calls.length };
        await stop('B-recovered');
        finalReader = await start('B-reopened-final', 'B');
        assert.equal(result.B.profileDigest, result['B-reopened-final'].profileDigest);
        await select(finalReader, 'B');
        assert.deepEqual(journal(), committedJournal);
        result.publicationAck = { workId, replyId, opId:publication.body.opId, seq:publication.response.receipt.seq,
            originalInvocation:invocation.invocation_id, status:publication.status, dropped:publication.dropped,
            serverReplayed: publication.response.receipt.replayed === true, before };
    }
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
    assert.deepEqual(counts(), expectedCounts);
    assert.deepEqual(service.calls.map(row => row.toolHandoffPhase), ['initial', 'summary', 'resumed']);
    const resumed = service.calls.at(-1);
    const resumedContext = JSON.stringify(resumed.messages);
    assert.ok(resumedContext.includes(invocation.invocation_id));
    assert.ok(resumedContext.includes(invocation.record_id));
    assert.ok(resumedContext.includes(fixture.toolResult(marker)));
    if (duo) {
        const second = invocationsAtPause[1];
        assert.equal(summary.toolReceipts[1].invocationId, second.invocation_id);
        assert.equal(summary.toolReceipts[1].recordId, second.record_id);
        assert.ok(resumedContext.includes(second.invocation_id));
        assert.ok(resumedContext.includes(second.record_id));
        assert.ok(resumedContext.includes(secondResult));
    }
    assert.equal(resumedContext.split(checkpointMarker).length, 2);
    assert.ok(!resumedContext.includes('SYNTHETIC SAME TEXT'));
    assert.ok(!resumedContext.includes('<<<[TOOL_REQUEST]>>>'));
    assert.deepEqual(journal().slice(0, journalOnA.length), journalOnA);
    assert.deepEqual(journal().slice(journalOnA.length).map(row => row.msg_id), [finished.at(-1).request_id]);
    if (toolHandoff.finalMutation) {
        const replyId = finished.at(-1).request_id;
        const current = () => db.prepare('SELECT last_seq,hash,deleted,message_json FROM messages WHERE topic_id=? AND msg_id=?').get(topicId, replyId);
        const action = toolHandoff.finalMutation;
        const editedText = 'Synthetic human edit to the published Work reply.';
        const published = current();
        const originalMessage = JSON.parse(published.message_json);
        assert.equal(originalMessage.content, fixture.finalText);
        assert.equal(published.last_seq, final.reply_seq);
        const terminal = await waitUntil(() => toolHandoff.receipt.upstream, 'proxy holds the complete original native reply');
        const nativeTransport = service.requests.find(row => row.device === 'deviceB' && row.route === '/v1/chat/completions');
        assert.equal(nativeTransport.downstreamFinished, undefined);
        assert.equal(terminal.finishReason, 'stop');
        assert.equal(terminal.text, fixture.finalText);
        assert.equal(terminal.bodyComplete, true);
        if (stream) assert.equal(terminal.done, true);
        const { _nativeSyncMetadata, continuity, isThinking, ...editable } = originalMessage;
        const response = await createApi(service, out, 'A')('message', {
            sharedSpaceId, sharedId,
            operation: { opId: randomUUID(), deviceId: 'desktop:deviceA', msgId: replyId, action, baseHash: published.hash,
                ...(action === 'upsert' && { message: { ...editable, content: editedText } }),
            },
        });
        const mutation = await response.json();
        assert.equal(response.status, 200, JSON.stringify(mutation));
        const latest = current();
        const historyState = action === 'delete' ? 'deleted' : 'edited';
        assert.equal(latest.deleted, Number(action === 'delete'));
        assert.ok(latest.last_seq > final.reply_seq);
        const selector = '#chatMessages .message-item[data-message-id="' + replyId + '"]';
        await evalJs(recovered, `(() => {
            const original = ${quote(fixture.finalText)};
            const timeline = window.__nsFixtureFinalTimeline = [];
            const observer = new MutationObserver(() => {
                const rows = document.querySelectorAll(${quote(selector + ':not(.streaming):not(.thinking)')});
                const stale = [...rows].some(row => row.innerText.includes(original));
                if (timeline.at(-1)?.stale !== stale) timeline.push({ at: Date.now(), stale });
            });
            observer.observe(document.querySelector('#chatMessages'), {
                childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'],
            });
        })()`);
        const deliveredAt = Date.now();
        assert.equal(nativeTransport.downstreamFinished, undefined);
        toolHandoff.receipt.deliverFinalResponse();
        await waitUntil(() => nativeTransport.downstreamFinished, 'proxy delivers native final response to the same B window');
        const finalStreamEvent = stream ? await waitUntil(() => recovered.events.find(row => row.event === 'renderer-event' &&
            row.t >= deliveredAt && row.data.channel === 'vcp-stream-event' && row.data.type === 'end' && row.data.modelFinishReason === 'stop'),
        'B renderer receives the late native SSE stop') : null;
        const readback = await waitUntil(() => readbacks().find(row => row.at >= deliveredAt && isCommittedReadback(row, replyId) &&
            row.response.historyState === historyState), 'B reads the edited or deleted reply after native delivery');
        assert.equal(readback.response.seq, final.reply_seq);
        assert.equal(readback.response.currentSeq, latest.last_seq);
        assert.equal(readback.response.message?.content ?? null, action === 'delete' ? null : editedText);
        const commitResult = await waitUntil(() => recovered.events.find(row =>
            row.event === 'ipc-result' && row.t >= deliveredAt && row.data.channel === (stream ? 'native-history:terminal' : 'native-history:messages') &&
            row.data.success === true && row.data.authoritativeReply?.state === historyState),
        'renderer gets the authoritative result of its actual History commit');
        assert.equal(commitResult.data.authoritativeReply.seq, latest.last_seq);
        const view = async () => ({
            history: read.B().filter(row => row.id === replyId).map(row => row.content),
            chat: await evalJs(recovered, `[...document.querySelectorAll(${quote(selector)})].map(item => item.innerText)`),
        });
        const expected = action === 'delete' ? [] : [editedText];
        const matches = ({ history, chat }) => JSON.stringify(history) === JSON.stringify(expected) &&
            chat.length === expected.length && chat.every(item => item.includes(editedText) && !item.includes(fixture.finalText));
        await waitUntil(async () => matches(await view()), 'same B window and physical History preserve current canonical reply');
        await delay(350);
        const visible = await view();
        assert.ok(matches(visible), 'late renderer work must not resurrect the archived native reply');
        const timeline = await evalJs(recovered, 'window.__nsFixtureFinalTimeline');
        assert.equal(timeline.some(row => row.at >= commitResult.t && row.stale), false,
            'the renderer must not show the obsolete text as a settled bubble after receiving authoritative History');
        assert.deepEqual(current(), latest);
        const rows = journal().slice(journalOnA.length);
        assert.deepEqual(rows.map(({ msg_id, action }) => [msg_id, action]), [[replyId, 'upsert'], [replyId, action]]);
        assert.equal(publicationsByB().length, 0);
        assert.deepEqual(invocations(workId), invocationsAtPause);
        assert.deepEqual(counts(), expectedCounts);
        assert.equal(service.calls.length, 3);
        result.finalMutation = {
            workId, replyId, originalRequestId: original.request_id, originalReplySeq: final.reply_seq, action,
            latest: { seq: latest.last_seq, deleted: Boolean(latest.deleted) },
            generations: finished, invocation, terminal, deliveredAt, finalStreamEvent, readback, commitResult, visible, timeline, journal: rows,
            desktopLedger: await checkFinalLedger(workId, replyId, { observed: true }),
            completePosts: publicationsByB().length, desktopSources: await loadedDesktop(recovered, sha, result.candidate),
        };
        await picture(recovered, 'B-late-reply-preserves-' + historyState);
        return;
    }
    if (toolHandoff.readback) {
        const terminal = await waitUntil(() => toolHandoff.receipt.upstream, 'B receives the native provider terminal at the proxy');
        assert.deepEqual({ ...terminal, at: undefined }, { at: undefined, status: 200, bodyComplete: true,
            finishReason: 'stop', text: fixture.finalText, ...(stream && { done: true }) });
        await waitUntil(() => service.requests.find(row => row.device === 'deviceB' && row.route === '/v1/chat/completions' && row.downstreamFinished),
            'proxy delivers native final response to B');
        const finalStreamEvent = stream ? await waitUntil(() => recovered.events.find(row => row.event === 'renderer-event' &&
            row.data.channel === 'vcp-stream-event' && row.data.type === 'end' && row.data.modelFinishReason === 'stop'),
        'B renderer receives the native SSE stop event') : undefined;
        const lost = toolHandoff.loseReadback ? await waitUntil(() => readbacks().find(row => row.dropped),
            'proxy cuts the first committed final-reply response to B') : undefined;
        if (lost) assertReadback(lost, finished.at(-1), final.reply_seq);
        const readback = await waitReadback(finished.at(-1).request_id, lost?.at || 0);
        assertReadback(readback, finished.at(-1), final.reply_seq);
        assert.equal(final.reply_seq, journal().at(-1).seq);
        result.finalReadback = { workId, terminal, finalStreamEvent, lost, readback };
    }
    if (toolHandoff.legacyReadback) {
        const publication = await waitUntil(() => publicationsByB().find(row => row.response?.workState === 'completed'),
            'B still completes through the mutation against a ToolBox without the readback capability');
        assert.equal(publication.body.generation, finished.at(-1).generation);
        assert.equal(publication.body.message.id, finished.at(-1).request_id);
        assert.equal(publication.response.receipt.seq, final.reply_seq);
        assert.equal(readbacks().length, 0);
        result.legacyReadback = { serverRevision: result.serverRevision, publication,
            desktopLedger: await checkFinalLedger(workId, finished.at(-1).request_id, { legacy: true }) };
    }
    const saved = await waitUntil(() => {
        const history = read.B();
        const reply = history.at(-1);
        return reply?.id === finished.at(-1).request_id && JSON.stringify(reply.content).includes(fixture.finalText) && history;
    }, 'B writes the final original Work reply to its physical History');
    assert.deepEqual(saved.slice(0, -1), compactedHistory);
    const finalReplyId = finished.at(-1).request_id;
    const rendered = await waitUntil(async () => {
        const rows = await renderedFinal(finalReader, finalReplyId);
        return rows.some(item => item.textShown) && rows;
    }, 'B renders the completed original Work result');
    assert.deepEqual(rendered, [{ textShown: true }]);
    if (duo) {
        const beforeRestart = { providerCalls: service.calls.length, journal: journal(), invocations: invocations(workId) };
        await stop('B-recovered');
        finalReader = await start('B-reopened-final', 'B');
        await select(finalReader, 'B');
        const reopened = await waitUntil(async () => {
            const rows = await renderedFinal(finalReader, finalReplyId);
            return rows.some(item => item.textShown) && rows;
        }, 'B reopens the single original Work result');
        assert.equal(result.B.profileDigest, result['B-reopened-final'].profileDigest);
        assert.deepEqual(reopened, rendered);
        assert.deepEqual(read.B(), saved);
        assert.equal(service.calls.length, beforeRestart.providerCalls);
        assert.deepEqual(journal(), beforeRestart.journal);
        assert.deepEqual(invocations(workId), beforeRestart.invocations);
        assert.deepEqual(counts(), expectedCounts);
        result.completedRestart = {
            providerCalls: beforeRestart.providerCalls, journalRows: beforeRestart.journal.length, counters: counts(),
            chatFinalBubbleCount: reopened.length, historyFinalCount: read.B().filter(row => row.id === finalReplyId).length,
        };
    }
    result.toolHandoff = {
        original, final, paused, nativeProof, committed, generations: finished, invocations: invocationsAtPause, ...(archive && { archive }),
        waitingCompaction, earlyHandoff, ...(streamTerminal && { streamTerminal: streamTerminal.data.modelFinishReason }), nativePause: { transport: transport.pauseTransport, httpStatus: transport.status, ...transport.nativePause },
        droppedHandoff: { workId, status: dropped.status, executor: control(workId).executor, dropped: dropped.dropped, opId: dropped.body.opId, clientError: unavailable.data.error },
        desktopSources: await loadedDesktop(finalReader, sha, result.candidate),
        counter: counts(), history: saved, journal: journal(), summaryReceipt: duo ? summary.toolReceipts : summary.toolReceipt,
    };
    await picture(finalReader, 'B-completed-original-tool-work');
    if (result.finalReadback) {
        assert.equal(publicationsByB().length, 0, 'B never submits a completion mutation in readback mode');
        assert.equal(service.calls.length, 3);
        assert.deepEqual(counts(), expectedCounts);
        const historyReplies = saved.filter(row => row.id === finalReplyId);
        assert.deepEqual(historyReplies.map(row => [row.content, row.finishReason]), [[fixture.finalText, 'completed']]);
        const desktopLedger = await checkFinalLedger(workId, finalReplyId, { observed: true });
        Object.assign(result.finalReadback, { completePosts: publicationsByB().length, chatFinalBubbleCount: rendered.length, desktopLedger,
            historyFinalCount: historyReplies.length, journalFinalCount: journal().filter(row => row.msg_id === finalReplyId).length });
    }
    if (result.publicationAck) {
        const attempts = service.requests.filter(row=>row.device==='deviceB' && row.route.endsWith('/steer-turn-complete'));
        assert.ok(attempts.every(row=>row.dropped && row.body.opId===result.publicationAck.opId));
        assert.equal(service.calls.length,result.publicationAck.before.calls);
        const desktopLedger = await checkFinalLedger(workId, finalReplyId, { legacy: true });
        Object.assign(result.publicationAck, { exit:result.exits['B-recovered'], postAttempts:attempts.length, desktopLedger,
            workState:final.state, finalHistoryIds:saved.map(row=>row.id), chatFinalBubbleCount:rendered.length, counter:counts().length });
    }
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

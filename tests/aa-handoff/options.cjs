'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const q = JSON.stringify;
const panel = '.native-sync-controlled-work';
const execution = '.native-sync-execution-status';
const task = '.native-sync-aa-task';
const active = ['accepted', 'running', 'waiting'];
const space = 'sharedAB';
let sendParent;
const pendingParent = new Promise(resolve => { sendParent = resolve; });
const candidate = process.env.AA_ACCEPTANCE_CANDIDATE === '1';
let childFirstMarker;
const loseAck = { dropped: false };
const options = {
    async beforeParentFinal({ marker }) {
        if (marker === childFirstMarker) await pendingParent;
    },
    singleChildRound: true,
    toolHandoff: {
        ...(process.env.AA_ACCEPTANCE_SSE === '1' && { agentConfig:{ streamOutput:true } }),
        ...(candidate ? {
            env: { NativeSyncSharedAgentAssistantAgents: JSON.stringify(['SyntheticDelegate']) },
            stage(box) {
                const added = 'Plugin/NativeSync/sync/sharedDelegation.js';
                const repo = path.resolve(__dirname, '../..');
                fs.copyFileSync(path.join(repo, 'apps/server', added), path.join(box, added));
            },
        } : {}),
        observeNativeResponse(response, row) {
            if (!candidate) return;
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                try {
                    const text = Buffer.concat(chunks).toString('utf8');
                    if (response.headers['content-type']?.includes('text/event-stream')) {
                        const frame = text.match(/event: nativesync_work_paused\r?\ndata: ([^\r\n]+)/);
                        if (frame) row.aaNativeResponse = JSON.parse(frame[1]).nativeSync;
                    } else row.aaNativeResponse = JSON.parse(text).nativeSync;
                }
                catch {}
            });
        },
        observeRequest(method, route) {
            return /\/(steer[^/]*|compact-[^/]*|task-result|work-status|final-reply)$/.test(route);
        },
        dropResponse(row) {
            if (!candidate || loseAck.dropped || row.device !== 'deviceB' || row.status !== 200 ||
                !row.route.endsWith('/steer-handoff')) return false;
            loseAck.dropped = true;
            return true;
        },
    },
};

async function run({ clients: { A, B }, out, result, service, click, evalJs, waitUntil, stop, start, picture, aa, profiles, cert, sha }) {
    const { calls, childReport, markers, parentText, release } = aa;
    const db = new DatabaseSync(path.join(out, 'data', 'central.sqlite'), { readOnly:true });
    const quote = value => JSON.stringify(value);
    const parentFirst = process.env.AA_ACCEPTANCE_ORDER !== 'child';
    const marker = parentFirst ? markers.desktop : markers.complete;
    if (!parentFirst) childFirstMarker = marker;
    const workRows = () => db.prepare('SELECT id,request_id,principal,state,dispatched,native_terminal,reply_seq,user_op FROM shared_admissions WHERE topic_id=?').all(service.topics.preSubmit.id);
    const taskRows = work => db.prepare('SELECT native_task_id,execution_id,native_request_id,invocation_id,record_id,state,result_hash FROM mobile_native_tasks WHERE execution_id=?').all(work);
    const parentNative = work => db.prepare('SELECT id,state FROM shared_native_requests WHERE admission_id=? ORDER BY ordinal').all(work);
    const childNative = work => db.prepare('SELECT id,task_id,state FROM shared_native_child_requests WHERE work_id=?').all(work);
    const journal = () => db.prepare('SELECT seq,msg_id,action,hash FROM journal WHERE topic_id=? ORDER BY seq').all(service.topics.preSubmit.topic.topicId);
    const invocationRows = work => db.prepare('SELECT invocation_id,plugin_name,record_id,state FROM mobile_native_invocations WHERE execution_id=?').all(work);
    const control = id => db.prepare('SELECT revision,generation,executor FROM shared_work_controls WHERE work_id=?').get(id);
    const generations = id => db.prepare('SELECT generation,executor,request_id,state FROM shared_work_generations WHERE work_id=? ORDER BY generation').all(id);
    const reportCalls = () => service.requests.filter(row => row.route.endsWith('/task-result'));
    const receipt = result.aaHandoff = { order: parentFirst ? 'parent-first' : 'child-first', candidate };
    const measure = () => ({
        work: workRows(), journal: journal(), tasks: workRows().flatMap(r => taskRows(r.id)), invocations: workRows().flatMap(r => invocationRows(r.id)),
        provider: calls(marker).map(row => ({ role:row.role, round:row.round, launch: row.launch, delegationId:row.delegationId, resumedReportMarkerCount:row.resumedReportMarkerCount, resumedWithCommittedCheckpoint:row.resumedWithCommittedCheckpoint, summaryReportCount:row.summaryReportCount, summaryHasTypedReceipt:row.summaryHasTypedReceipt })),
    });
    const readHistory = role => {
        const { itemId, topicId } = service.descriptors[role].preSubmit;
        return JSON.parse(fs.readFileSync(path.join(profiles[role], 'UserData', itemId, 'topics', topicId, 'history.json')));
    };
    const buttons = client => evalJs(client, `Object.fromEntries([...document.querySelectorAll(${q(panel + ' button')})]
        .map(button => [button.textContent.trim(), !button.disabled && !button.hidden]))`);
    const action = async (client, label) => {
        await waitUntil(async () => (await buttons(client))[label], label + ' is enabled');
        await click(client, panel + ' button', label);
    };
    async function select(client, role) {
        const descriptor = service.descriptors[role].preSubmit;
        if (!await evalJs(client, "document.querySelector('#tabContentAgents').classList.contains('active')")) {
            await click(client, '.sidebar-tab-button[data-tab="agents"]');
        }
        await click(client, '#agentList > li .agent-name', 'Synthetic shared');
        await waitUntil(async () => (await evalJs(client,
            'window.VCPStateChannels.get("conversation.current").get()')).topicId === descriptor.topicId, role + ' shared topic selected');
        await waitUntil(async () => (await evalJs(client,
            'window.chatAPI.getNativeDeletionContext(' + q(descriptor) + ')'))?.kind === 'shared', role + ' shared ownership');
    }
    async function enter(client, selector, value) {
        await evalJs(client, `(() => {
            const input = document.querySelector(${q(selector)});
            input.focus();
            input.value = ${q(value)};
            input.dispatchEvent(new Event('input', {bubbles:true}));
        })()`);
    }
    async function desktopTask(client, id, states) {
        return waitUntil(async () => {
            const tasks = await evalJs(client, `[...document.querySelectorAll(${q(task)})].map(element => ({
                id: element.dataset.taskId, state: element.dataset.state,
                heading: element.querySelector('summary').textContent,
                work: element.closest('[data-work-id]')?.dataset.workId,
            }))`);
            return tasks.find(item => (!id || item.id === id) && states.includes(item.state));
        }, 'desktop AA task ' + states.join('/'), 30000);
    }
    async function reveal(client, id) {
        const row = task + '[data-task-id="' + id + '"]';
        if (!await evalJs(client, `document.querySelector(${q(execution)})?.open`)) await click(client, execution + ' > summary');
        if (!await evalJs(client, `document.querySelector(${q(row)})?.open`)) await click(client, row + ' > summary');
        return row;
    }
    async function controlPanel(client) {
        await waitUntil(() => evalJs(client, `document.querySelector(${q(panel)})?.checkVisibility()`), 'controlled panel');
        if (!await evalJs(client, `document.querySelector(${q(panel)}).open`)) await click(client, panel + ' > summary');
    }
    function api(role, route, body, extra = {}) {
        const conn = JSON.parse(fs.readFileSync(path.join(out,'seed','desktop'+role,'.native-sync','connection.json')));
        const context = require('node:https');
        return new Promise((resolve, reject) => {
            const req = context.request(service.origin + (route.startsWith('/') ? route : '/api/v1/sync/shared/' + route), {
                method: 'POST', ca: fs.readFileSync(cert),
                headers: {
                    authorization:'Bearer synthetic-only','content-type':'application/json',
                    'x-nativesync-space':conn.spaceId,'x-nativesync-source':'source'+role,'x-nativesync-device':'device'+role,
                    'x-nativesync-protocol':'2','x-nativesync-capabilities':'shared-space-v1,shared-context-v1,shared-controlled-text-v1,shared-controlled-tools-v1,shared-steering-v1,shared-controlled-aa-v1',...extra,
                },
            }, async res => {
                try {
                    const chunks = [];
                    for await (const chunk of res) chunks.push(chunk);
                    resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) });
                } catch (e) { reject(e); }
            });
            req.on('error', reject);
            req.setTimeout(15000, () => req.destroy(Error('Timed out requesting ' + route)));
            req.end(q(body));
        });
    }
    try {
        await select(B, 'B');
        await select(A, 'A');
        if (process.env.AA_ACCEPTANCE_TAMPER_ARCHIVE === '1') {
            const { stable, sha256 } = require('../../apps/server/Plugin/NativeSync/sync/protocol');
            const { randomUUID } = require('node:crypto');
            const scope = {sharedSpaceId:space, sharedId:service.topics.preSubmit.id};
            const initial = await aa.request('context?' + new URLSearchParams(scope), undefined, 'A');
            const requestId = randomUUID();
            const accepted = await api('A','admit', {
                ...scope,requestId,expectedHead:initial.body.head,configHash:initial.body.hash,
                controlMode:'agent-assistant-v1',delegation:{agentName:'SyntheticDelegate'},
                message:{id:requestId,role:'user',content:marker,timestamp:Date.now()},
            });
            assert.equal(accepted.status,200,q(accepted.body));
            const workId = accepted.body.id;
            const nativeId = 'reply_' + workId;
            const descriptor = service.descriptors.A.preSubmit;
            const packet = { requestId:nativeId, model:'synthetic', stream:false, messages:[{role:'user',content:marker}],
                vcpchatExtensions:{requestContext:{ownerType:'agent',agentId:descriptor.itemId,topicId:descriptor.topicId}} };
            const prepared = await api('A','native-request',{
                sharedSpaceId:space,admissionId:workId,requestId:nativeId,bodyHash:sha256(stable(packet)),generation:0,consumedInputSeq:0,
            });
            assert.equal(prepared.status,200,q(prepared.body));
            let transport;
            void api('A','/v1/chat/completions',packet,{
                'x-nativesync-admission':workId,'x-nativesync-generation':'0','x-nativesync-consumed-input-seq':'0',
            }).then(reply => { transport = reply; });
            await waitUntil(() => calls(marker).find(row => row.role === 'child'), 'true native AA child in server smoke');
            await waitUntil(() => transport, 'parent native wait response');
            release(marker);
            const checkpoint = await waitUntil(() => db.prepare('SELECT proof_json FROM shared_native_checkpoints WHERE work_id=? AND generation=0').get(workId), 'native checkpoint in server smoke');
            receipt.httpSmoke = { workId,transport,checkpoint:JSON.parse(checkpoint.proof_json),final:measure() };
            const { agentBaseName, nativeTaskId } = receipt.httpSmoke.checkpoint.delegationReceipt;
            const archive = path.join(out, 'runtime-box/file/document/AgentTask', agentBaseName + '_' + nativeTaskId + '.md');
            assert.ok(fs.readFileSync(archive, 'utf8').includes(childReport));
            fs.appendFileSync(archive, '\nSYNTHETIC_ARCHIVE_FAULT\n');
            const attempt = await api('B', 'steer-handoff', {
                sharedSpaceId:space,workId,opId:'probe-aa-tampered-handoff',
                expectedRevision:0,expectedGeneration:0,expectedExecutor:'desktop:deviceA',
            });
            assert.equal(attempt.status,409);
            assert.equal(attempt.body.error.code,'NATIVE_RESULT_HASH_MISMATCH');
            const reportRoute = 'task-result?' + new URLSearchParams({sharedSpaceId:space, workId, nativeTaskId});
            const reportAttempt = await aa.request(reportRoute, undefined, 'B');
            assert.equal(reportAttempt.status,409);
            assert.equal(reportAttempt.body.error.code,'NATIVE_RESULT_HASH_MISMATCH');
            assert.equal(control(workId).executor,'desktop:deviceA');
            assert.equal(generations(workId).length,1);
            await service.restartWithUpgrade();
            await waitUntil(() => workRows()[0]?.state === 'review_required', 'changed durable report is fenced for review after restart');
            assert.equal(control(workId).executor,'desktop:deviceA');
            assert.equal(generations(workId).length,1);
            assert.equal(calls(marker).filter(row => row.role === 'child').length,1);
            receipt.httpSmoke.tamperedArchive = { attempt, reportAttempt, final:measure(), generations:generations(workId) };
            return;
        } else if (candidate) {
            const desktopSourceFiles = {
                main: ['apps/desktop/modules/ipc/chatHandlers.js', 'apps/desktop/modules/services/nativeSync/sharedExecution.js',
                    'apps/desktop/modules/services/nativeSync/sharedRuntime.js', 'apps/desktop/modules/services/nativeSync/sharedSteeringClient.js',
                    'apps/desktop/modules/services/nativeSync/syncRequest.js','apps/desktop/modules/services/nativeSync/sharedEventClient.mjs'],
                renderer: ['apps/desktop/modules/chat/streamConsumerRegistry.js','apps/desktop/modules/chat/vcpStreamBridge.js',
                    'apps/desktop/modules/chatManager.js','apps/desktop/modules/renderer/controlledWorkView.mjs',
                    'apps/desktop/modules/renderer/mainChatStreamConsumer.js',
                    'apps/desktop/modules/services/nativeSync/sharedSessionView.mjs'],
            };
            const loaded = await waitUntil(async () => {
                const sources = await A.command('loaded-sources', desktopSourceFiles);
                return sources.main.some(file => file.file.endsWith('/sharedEventClient.mjs')) && sources;
            }, 'main-process event parser is loaded');
            const backend = path.join(out,'runtime-box');
            const backendFiles = ['Plugin.js','Plugin/AgentAssistant/AgentAssistant.js','Plugin/NativeSync/mobile/nativeTasks.js',
                'Plugin/NativeSync/sync/sharedCompaction.js','Plugin/NativeSync/sync/sharedControlledText.js','Plugin/NativeSync/sync/sharedDelegation.js',
                'Plugin/NativeSync/sync/sharedHttp.js','Plugin/NativeSync/sync/sharedNative.js','Plugin/NativeSync/sync/sharedSpace.js',
                'Plugin/NativeSync/sync/sharedSteering.js','Plugin/NativeSync/sync/sharedTaskRequests.js','modules/chatCompletionHandler.js',
                'modules/requestExecutionContext.js','modules/vcpLoop/toolExecutor.js'];
            for (const file of backendFiles) assert.equal(sha(path.join(backend,file)), sha(path.join(result.candidate,'apps/server',file)), file);
            receipt.serverSourceFiles = backendFiles.map(file=>'apps/server/'+file);
            for (const [kind, expected] of Object.entries(desktopSourceFiles)) {
                for (const file of expected) {
                    assert.ok(loaded[kind].some(entry => entry.file === file), file);
                }
            }
            for (const entry of [...loaded.main, ...loaded.renderer]) {
                assert.equal(entry.sha256, sha(path.join(result.candidate, entry.file)));
            }
            receipt.desktopSources = loaded;
            if (process.env.AA_ACCEPTANCE_SSE === '1') await evalJs(A, `(() => {
                const observed = window.__aaFixtureStream = [];
                window.chatAPI.onVCPStreamEvent(event => observed.push({
                    type:event.type, awaitingNativeTask:event.awaitingNativeTask, messageId:event.messageId,
                    modelFinishReason:event.modelFinishReason,
                }));
            })()`);
            await controlPanel(A);
            await enter(A, panel + ' textarea', marker);
            const agentInput = panel + ' input[aria-label="委托 Agent 名称"]';
            await enter(A, agentInput, 'SyntheticDelegate');
            await action(A, '新建 AA 委托');
            const sent = await waitUntil(() => A.events.find(event => event.event === 'ipc-result' &&
                event.data.channel === 'native-sync:prepare-send'), 'desktop admission receipt');
            assert.equal(sent.data.success, true, sent.data.error);
            await action(A, '本端继续执行');
        } else {
            await enter(A, '#messageInput', marker);
            await click(A, '#sendMessageBtn');
        }
        await waitUntil(() => calls(marker).some(row => row.role === 'child' && row.round === 1), 'first native child provider dispatch');
        const initial = await desktopTask(A, null, active);
        const { id, work } = initial;
        assert.equal(workRows().length, 1);
        assert.equal(workRows()[0].id, work);
        await reveal(A, id);
        await picture(A, 'A-original-aa-running');
        if (parentFirst) {
            if (candidate) {
                const pause = await waitUntil(() => service.requests.find(row => row.aaNativeResponse?.state === 'awaiting_native_task'), 'parent yields at its native wait marker');
                receipt.nativeWaitBeforeChild = { status: pause.status, value: pause.aaNativeResponse, providerStream: calls(marker).find(row => row.role === 'parent')?.stream };
                assert.equal(receipt.nativeWaitBeforeChild.providerStream, process.env.AA_ACCEPTANCE_SSE === '1');
                assert.equal(pause.status, process.env.AA_ACCEPTANCE_SSE === '1' ? 200 : 409);
                if (process.env.AA_ACCEPTANCE_SSE === '1') {
                    const terminal = await waitUntil(() => A.events.find(event => event.event === 'renderer-event' &&
                        event.data.channel === 'vcp-stream-event' && event.data.type === 'end' && event.data.awaitingNativeTask),
                        'SSE parent releases A’s renderer stream as awaiting native task');
                    assert.equal(terminal.data.modelFinishReason, 'interrupted');
                    const received = await waitUntil(() => evalJs(A, `window.__aaFixtureStream.find(event =>
                        event.messageId === ${q(pause.aaNativeResponse.requestId)} && event.type === 'end' && event.awaitingNativeTask)`),
                        'A’s renderer subscription receives the SSE wait terminal');
                    assert.equal(received.modelFinishReason, 'interrupted');
                    receipt.sseRendererTerminal = { type:terminal.data.type, awaitingNativeTask:terminal.data.awaitingNativeTask,
                        modelFinishReason:terminal.data.modelFinishReason };
                    const preview = '#chatMessages .message-item[data-message-id="' + pause.aaNativeResponse.requestId + '"]';
                    try {
                        await waitUntil(() => evalJs(A, `document.querySelectorAll(${q(preview)}).length === 0`),
                            'A releases the temporary preview before child terminal', 5000);
                    } catch (error) {
                        receipt.sseRendererTerminal.pendingPreview = await evalJs(A, `[...document.querySelectorAll(${q(preview)})]
                            .map(row => ({ className:row.className, finishReason:row.dataset.finishReason,
                                streamingState:row.dataset.streamingState, persistenceState:row.dataset.vcpPersistenceState,
                                visible:row.checkVisibility() }))`);
                        throw error;
                    }
                    const composerMode = await waitUntil(() => evalJs(A, `document.querySelector('#sendMessageBtn')?.dataset.mode === 'send' && 'send'`),
                        'A leaves the composer’s stop state before the child finishes', 5000);
                    receipt.sseRendererTerminal.previewRows = 0;
                    receipt.sseRendererTerminal.composerMode = composerMode;
                }
                assert.notEqual(generations(work)[0]?.state, 'paused');
            } else await waitUntil(() => evalJs(B, `document.querySelector('#chatMessages').innerText.includes(${q(parentText)})`), 'parent reply visible to B before child release');
            assert.ok(active.includes(taskRows(work)[0].state));
        }
        receipt.beforeAExit = { task:initial, state: measure(), generations:generations(work), parents:parentNative(work), children:childNative(work) };
        if (candidate) {
            const [generation] = generations(work);
            assert.equal(workRows()[0].reply_seq, null);
            assert.equal(journal().filter(row => row.msg_id === generation.request_id).length, 0);
            assert.equal(readHistory('A').filter(row => row.id === generation.request_id && row.finishReason === 'completed').length, 0);
        }
        if (candidate && !parentFirst) {
            const fence = path.join(out, 'held-parent-tool-settlement');
            await waitUntil(() => fs.existsSync(fence), 'parent actually held before tool ACK');
            receipt.parentSettlementHeld = JSON.parse(fs.readFileSync(fence));
        }
        const exitAfterParentSettlement = candidate && !parentFirst;
        if (!exitAfterParentSettlement) await stop('A');
        const observed = await aa.request('work?' + new URLSearchParams({sharedSpaceId:space, workId:work}), undefined, 'B');
        assert.equal(observed.status, 200);
        assert.equal(observed.body.request.id, work);
        const detached = observed.body.request.nativeTasks.find(task => task.nativeTaskId === id);
        assert.ok(active.includes(detached?.state));
        let bTaskDuring = await evalJs(B, `document.querySelector(${q(task + '[data-task-id="' + id + '"]')})?.dataset.state || null`);
        if (candidate && parentFirst) {
            const desktopObserved = await desktopTask(B, id, active);
            assert.equal(desktopObserved.work, work);
            bTaskDuring = desktopObserved.state;
            const firstId = generations(work)[0].request_id;
            const assistantRowSelector = '#chatMessages .message-item[data-message-id="' + firstId + '"]';
            const assistantRows = await evalJs(B, `document.querySelectorAll(${q(assistantRowSelector)}).length`);
            assert.equal(assistantRows, 0);
            assert.equal(readHistory('B').filter(row => row.id === firstId).length, 0);
            assert.equal(journal().filter(row => row.msg_id === firstId).length, 0);
            receipt.parentYieldedWithoutFinal = { assistantRows, persistedReplies:0, journalReplies:0 };
        }
        receipt.liveObservation = { afterAExit:!exitAfterParentSettlement, task: { id, work, state: detached.state, stopAllowed: detached.stopAllowed }, desktopTaskState: bTaskDuring };
        assert.equal(detached.stopAllowed, false);
        if (bTaskDuring) await reveal(B, id);
        const reportPath = 'task-result?' + new URLSearchParams({sharedSpaceId:space, workId:work, nativeTaskId:id});
        const activeReport = await aa.request(reportPath, undefined, 'B');
        assert.equal(activeReport.status, 409);
        assert.equal(activeReport.body.error.code, 'NATIVE_TASK_RESULT_UNVERIFIED');
        receipt.reportBeforeChildTerminal = activeReport;
        await picture(B, exitAfterParentSettlement ? 'B-observes-aa-while-parent-settlement-held' : 'B-after-A-quit-before-child-release');
        {
            const c = control(work);
            receipt.handoffWhileChildActive = await api('B','steer-handoff',{
                sharedSpaceId:space,workId:work,opId:'probe-aa-active-handoff',
                expectedRevision:c?.revision || 0,expectedGeneration:c?.generation || 0,expectedExecutor:c?.executor || 'desktop:deviceA',
            });
            assert.ok(receipt.handoffWhileChildActive.status >= 400);
            const context = await aa.request('context?' + new URLSearchParams({sharedSpaceId:space, sharedId:service.topics.preSubmit.id}), undefined, 'B');
            assert.equal(context.status, 200);
            receipt.continueWhileChildActive = await api('B', 'steer-prepare', {
                sharedSpaceId:space,workId:work,opId:'probe-aa-active-continue',
                expectedRevision:c?.revision || 0,expectedGeneration:c?.generation || 0,
                expectedHead:context.body.head,configHash:context.body.hash,
            });
            assert.ok(receipt.continueWhileChildActive.status >= 400);
            if (candidate) {
                const compactEarly = await api('A', 'compact-prepare', {
                    sharedSpaceId:space,sharedId:service.topics.preSubmit.id,opId:'probe-aa-active-compact',expectedHead:context.body.head,
                });
                assert.equal(compactEarly.status, 409);
                assert.equal(compactEarly.body.error.code, 'WORK_SAFE_BOUNDARY_PENDING');
                receipt.compactWhileChildActive = compactEarly;
                assert.equal(receipt.handoffWhileChildActive.body.error.code, 'WORK_SAFE_BOUNDARY_PENDING');
                await controlPanel(B);
                assert.equal((await buttons(B))['接管到本端'], false);
                assert.equal((await buttons(B))['本端继续执行'], false);
                assert.equal(generations(work).length, 1);
            }
        }
        if (process.env.AA_ACCEPTANCE_CRASH === '1') {
            const previousPid = service.backendPid;
            const crashed = await service.restartAfterCrash();
            const recovered = await waitUntil(async () => {
                const state = await aa.request('work?' + new URLSearchParams({ sharedSpaceId:space,workId:work }), undefined, 'B');
                assert.equal(state.status, 200);
                return state.body.request.steering?.applicationState === 'blocked' && state.body.request;
            }, 'same Work enters review after ToolBox crash');
            assert.notEqual(service.backendPid, previousPid);
            assert.equal(recovered.nativeTasks[0].nativeTaskId, id);
            assert.equal(recovered.nativeTasks[0].state, 'unknown');
            assert.equal(recovered.nativeTasks[0].reviewRequired, true);
            assert.equal(childNative(work)[0].state, 'unknown');
            const report = await aa.request(reportPath, undefined, 'B');
            const c = control(work);
            const handoff = await api('B','steer-handoff',{
                sharedSpaceId:space,workId:work,opId:'probe-aa-crashed-handoff',
                expectedRevision:c.revision,expectedGeneration:c.generation,expectedExecutor:c.executor,
            });
            assert.equal(report.status,409);
            assert.equal(handoff.status,409);
            assert.equal(control(work).executor,'desktop:deviceA');
            assert.equal(generations(work).length,1);
            assert.equal(childNative(work).length,1);
            assert.equal(calls(marker).filter(call => call.role === 'child').length,1);
            await controlPanel(B);
            await waitUntil(() => evalJs(B, `document.querySelector(${q(panel + ' [role=status]')})?.innerText.includes('核对')`), 'B shows original Work needs review');
            assert.equal((await buttons(B))['接管到本端'],false);
            assert.equal((await buttons(B))['本端继续执行'],false);
            await picture(B,'B-original-aa-needs-review-after-toolbox-crash');
            receipt.crash = { previousPid, currentPid:service.backendPid, crashed, task:{id,work,state:'unknown',reviewRequired:recovered.nativeTasks[0].reviewRequired}, workState:recovered.state, applicationState:recovered.steering.applicationState, report,handoff, children:childNative(work),
                generations:generations(work), final:measure() };
            return;
        }
        release(marker);
        const verifiedWork = await waitUntil(async () => {
            const state = await aa.request('work?' + new URLSearchParams({ sharedSpaceId:space, workId:work }), undefined, 'B');
            assert.equal(state.status, 200);
            return state.body.request.nativeTasks.find(nativeTask => nativeTask.nativeTaskId === id && nativeTask.state === 'completed');
        }, 'B device observes the original native child completed');
        assert.ok(verifiedWork.resultRef);
        if (!parentFirst) {
            receipt.childTerminalBeforeParent = { ...measure(), parents:parentNative(work), children:childNative(work) };
            if (candidate) {
                assert.ok(invocationRows(work).some(row => row.state === 'started'));
                assert.notEqual(generations(work)[0]?.state, 'paused');
                const c = control(work);
                const blocked = await api('B', 'steer-handoff', {
                    sharedSpaceId:space,workId:work,opId:'candidate-aa-child-only-handoff',
                    expectedRevision:c.revision,expectedGeneration:c.generation,expectedExecutor:c.executor,
                });
                assert.equal(blocked.status, 409);
                assert.equal(blocked.body.error.code, 'WORK_SAFE_BOUNDARY_PENDING');
                receipt.handoffAfterChildBeforeParent = blocked;
            }
            assert.ok(!readHistory('B').some(row => JSON.stringify(row.content).includes(parentText)));
            assert.ok(!calls(marker).some(row => row.role === 'parent' && row.delegationId));
            const reportBeforeParent = await aa.request(reportPath, undefined, 'B');
            assert.equal(reportBeforeParent.status, 200);
            assert.ok(reportBeforeParent.body.content.includes(childReport));
            receipt.verifiedReportBeforeParent = { status:reportBeforeParent.status, work, id, hash:reportBeforeParent.body.task.resultHash };
            await picture(B, 'B-child-terminal-while-parent-held');
            sendParent();
            if (candidate) {
                fs.writeFileSync(path.join(out, 'release-parent-tool-settlement'), '');
                await waitUntil(() => generations(work)[0]?.state === 'paused', 'parent settlement creates the verified checkpoint after child terminal');
                await stop('A');
                const reopenedState = await aa.request('work?' + new URLSearchParams({sharedSpaceId:space,workId:work}), undefined, 'B');
                assert.equal(reopenedState.status, 200);
                assert.ok(reopenedState.body.request.nativeTasks.some(task => task.nativeTaskId === id && task.state === 'completed'));
                receipt.afterAExit = { id, work, state:'completed' };
            }
        }
        const exactReport = await aa.request(reportPath, undefined, 'B');
        assert.equal(exactReport.status, 200);
        assert.ok(JSON.stringify(exactReport.body).includes(childReport));
        receipt.verifiedReport = { work, id, status:exactReport.status, hash:taskRows(work)[0].result_hash };
        if (!candidate) {
            await waitUntil(() => workRows().find(row => row.id === work)?.state === 'completed',
                'baseline original Work has settled for report discovery');
        }
        await stop('B');
        const reportClient = await start('B-report', 'B');
        await select(reportClient, 'B');
        const completed = await desktopTask(reportClient, id, ['completed']);
        assert.equal(completed.work, work);
        const row = await reveal(reportClient, id);
        await click(reportClient, row + ' button', '查看已核对报告');
        await waitUntil(async () => (await evalJs(reportClient, "document.querySelector('.native-sync-task-result pre')?.innerText"))?.includes(childReport), 'B reads original verified task report');
        await picture(reportClient, 'B-original-aa-verified-report');
        if (!candidate) {
            await waitUntil(() => evalJs(reportClient, `[...document.querySelectorAll('#chatMessages .message-item')].filter(row => row.innerText.includes(${q(parentText)})).length === 1`), 'B has the original parent reply');
            const c = control(work);
            receipt.handoffAfterVerifiedReport = await api('B','steer-handoff',{
                sharedSpaceId:space,workId:work,opId:'baseline-aa-terminal-handoff',
                expectedRevision:c?.revision || 0,expectedGeneration:c?.generation || 0,expectedExecutor:c?.executor || 'desktop:deviceA',
            });
            assert.ok(receipt.handoffAfterVerifiedReport.status >= 400);
            const context = await aa.request('context?' + new URLSearchParams({sharedSpaceId:space, sharedId:service.topics.preSubmit.id}), undefined, 'B');
            assert.equal(context.status, 200);
            receipt.continueAfterVerifiedReport = await api('B', 'steer-prepare', {
                sharedSpaceId:space,workId:work,opId:'baseline-aa-terminal-continue',
                expectedRevision:c?.revision || 0,expectedGeneration:c?.generation || 0,
                expectedHead:context.body.head,configHash:context.body.hash,
            });
            assert.equal(receipt.continueAfterVerifiedReport.status, 409);
            receipt.finalGenerations = generations(work);
        } else {
            await click(reportClient, '.native-sync-task-result button', '关闭报告');
            await click(reportClient, execution + ' > summary');
            await waitUntil(() => generations(work)[0]?.state === 'paused', 'verified native AA checkpoint');
            const proof = db.prepare('SELECT proof_json FROM shared_native_checkpoints WHERE work_id=? AND generation=0').get(work);
            assert.ok(proof);
            receipt.checkpoint = JSON.parse(proof.proof_json);
            const nativeReceipt = receipt.checkpoint.delegationReceipt;
            assert.equal(nativeReceipt.kind, 'AgentAssistantReport');
            assert.equal(nativeReceipt.nativeTaskId, id);
            assert.equal(nativeReceipt.workId, work);
            assert.equal(nativeReceipt.parentRequestId, generations(work)[0].request_id);
            assert.equal(nativeReceipt.resultHash, taskRows(work)[0].result_hash);
            assert.equal(nativeReceipt.childRequests.length, 1);
            assert.equal(nativeReceipt.childRequests[0].requestId, childNative(work)[0].id);
            await controlPanel(reportClient);
            assert.equal((await buttons(reportClient))['本端继续执行'], false);
            await picture(reportClient, 'B-aa-ready-for-handoff');
            await action(reportClient, '接管到本端');
            const dropped = await waitUntil(() => service.requests.find(row => row.route.endsWith('/steer-handoff') && row.dropped), 'proxy drops accepted handoff receipt');
            assert.equal(dropped.body.workId, work);
            assert.equal(dropped.status, 200);
            await waitUntil(() => reportClient.events.find(row => row.event === 'ipc-result' &&
                row.data.channel === 'native-sync:handoff' && row.data.error === 'NETWORK_UNAVAILABLE'), 'B actually sees network receipt loss');
            assert.equal(control(work).executor, 'desktop:deviceB');
            assert.equal(generations(work).length, 1);
            await stop('B-report');
            const recovered = await start('B-recovered', 'B');
            assert.equal(result.B.profileDigest, result['B-recovered'].profileDigest);
            await select(recovered, 'B');
            await controlPanel(recovered);
            await waitUntil(async () => await evalJs(recovered, `document.querySelector(${q(panel + ' [role=status]')})?.innerText.includes('压缩')`), 'reopened B recovers original Work ownership and must compact');
            assert.equal((await buttons(recovered))['本端继续执行'], false);
            await picture(recovered, 'B-original-aa-recovered-handoff');
            assert.equal(service.requests.filter(row => row.route.endsWith('/steer-handoff') && row.status === 200).length, 1);
            assert.equal(workRows().length, 1);
            const postHandoff = control(work);
            const context = await aa.request('context?' + new URLSearchParams({sharedSpaceId:space, sharedId:service.topics.preSubmit.id}), undefined, 'B');
            assert.equal(context.status, 200);
            const beforeCompaction = await api('B', 'steer-prepare', {
                sharedSpaceId:space,workId:work,opId:'probe-aa-before-compaction-continue',
                expectedRevision:postHandoff.revision,expectedGeneration:postHandoff.generation,
                expectedHead:context.body.head,configHash:context.body.hash,
            });
            assert.equal(beforeCompaction.status, 409);
            assert.equal(beforeCompaction.body.error.code, 'WORK_SAFE_BOUNDARY_PENDING');
            receipt.continueBeforeCompaction = beforeCompaction;
            const oldOwner = await api('A', 'steer-prepare', {
                sharedSpaceId:space,workId:work,opId:'probe-aa-old-owner-continue',
                expectedRevision:postHandoff.revision,expectedGeneration:postHandoff.generation,
                expectedHead:context.body.head,configHash:context.body.hash,
            });
            assert.equal(oldOwner.status, 409);
            assert.equal(oldOwner.body.error.code, 'WORK_EXECUTOR_HANDOFF_REQUIRED');
            receipt.oldExecutorContinue = oldOwner;
            const pauseReplyId = generations(work)[0].request_id;
            const pausedSelector = '[data-message-id="' + pauseReplyId + '"]';
            await waitUntil(() => evalJs(recovered, `document.querySelector(${q(pausedSelector)})?.checkVisibility()`), 'B renders original AA pause message');
            const pausedHistory = await waitUntil(() => readHistory('B').find(row => row.id === pauseReplyId), 'B materializes the original AA pause in native History');
            assert.equal(pausedHistory.finishReason, 'interrupted');
            assert.equal(pausedHistory.continuity.executionId, work);
            receipt.pauseHistory = { id:pausedHistory.id, finishReason:pausedHistory.finishReason, work };
            const point = await evalJs(recovered, `(() => {
                const target = document.querySelector(${q(pausedSelector)});
                target.scrollIntoView({block:'center',behavior:'instant'});
                const rect = target.getBoundingClientRect();
                return {x:Math.round(rect.left + rect.width / 2), y:Math.round(rect.top + rect.height / 2)};
            })()`);
            await recovered.command('mouse-right', point);
            await click(recovered, '.context-menu-item', '压缩前文');
            const compacted = await waitUntil(() => db.prepare("SELECT message_id,committed_seq,proof_json FROM shared_compaction_intents WHERE work_id=? AND state='committed'").get(work), 'B compacts verified native report on original Work');
            receipt.compaction = compacted;
            await picture(recovered, 'B-aa-compacted-original-work');
            await action(recovered, '本端继续执行');
            const finalText = 'AA_DELEGATION_B_FINAL_' + marker;
            await waitUntil(() => readHistory('B').filter(row => JSON.stringify(row.content).includes(finalText)).length === 1 &&
                workRows()[0].state === 'completed' && generations(work)[1]?.state === 'completed', 'B publishes final response once');
            assert.equal(generations(work).length, 2);
            const [first, second] = generations(work);
            assert.equal(second.executor, 'desktop:deviceB');
            assert.equal(second.generation, 1);
            assert.equal(calls(marker).filter(row => row.role === 'parent').length, 2);
            const resumed = calls(marker).find(row => row.role === 'parent' && row.round === 2);
            assert.equal(resumed.resumedReportMarkerCount, 1);
            assert.equal(resumed.resumedWithCommittedCheckpoint, true);
            const summaries = calls(marker).filter(row => row.role === 'summary');
            assert.equal(summaries.length, 1);
            assert.equal(summaries[0].summaryReportCount, 1);
            assert.equal(summaries[0].summaryHasTypedReceipt, true);
            assert.equal(journal().filter(row => row.msg_id === second.request_id).length, 1);
            assert.equal(readHistory('B').filter(row => row.id === second.request_id).length, 1);
            await picture(recovered, 'B-aa-completed-original-work');
            await stop('B-recovered');
            const final = await start('B-final-reopened', 'B');
            await select(final, 'B');
            await waitUntil(() => evalJs(final, `document.querySelector('#chatMessages').innerText.includes(${q(finalText)})`), 'B retains final on second reopen');
            assert.equal(readHistory('B').filter(row => row.id === second.request_id).length, 1);
            assert.equal(journal().filter(row => row.msg_id === second.request_id).length, 1);
            await picture(final, 'B-reopened-aa-completed-original-work');
            const finalReadbacks = service.requests.filter(row => row.route.endsWith('/final-reply') &&
                row.method === 'GET' && row.device === 'deviceB' && row.status === 200 &&
                row.response?.state === 'committed' && row.response?.requestId === second.request_id);
            assert.ok(finalReadbacks.length);
            assert.ok(finalReadbacks.every(row => row.response.workId === work && row.response.message.content === finalText));
            assert.equal(service.requests.filter(row => row.route.endsWith('/steer-turn-complete')).length, 0);
            receipt.finalReadbacks = finalReadbacks.map(row => ({ device:row.device, requestId:row.response.requestId, seq:row.response.seq }));
            receipt.finalGenerations = [first, second];
            receipt.handoff = { request: dropped.body, status: dropped.status, dropped: true, owner: control(work).executor };
        }
        receipt.reportReads = reportCalls().map(r => ({ device:r.device, status:r.status, query:r.query }));
        receipt.completed = completed;
        receipt.final = measure();
        assert.equal(calls(marker).filter(row => row.role === 'child').length, 1);
        assert.equal(calls(marker).filter(row => row.role === 'child' && row.launch).length, 1);
        assert.equal(workRows().length, 1);
        assert.equal(childNative(work).length, 1);
        assert.equal(invocationRows(work).length, 1);
        assert.equal(taskRows(work).length, 1);
        assert.equal(taskRows(work)[0].native_task_id, id);
    } finally {
        release(marker);
        sendParent();
        if (candidate && !parentFirst) fs.writeFileSync(path.join(out, 'release-parent-tool-settlement'), '');
        db.close();
    }
}
module.exports = { options, run };

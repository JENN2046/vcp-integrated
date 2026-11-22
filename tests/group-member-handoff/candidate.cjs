'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

module.exports = async function handoff({ clients, out, result, picture, click, evalJs, waitUntil, sha, service, start, stop, profiles, crash, groupRelay }) {
    const mode = process.env.NS_GROUP_HANDOFF_CASE;
    const input = 'GROUP_HANDOFF_BASELINE_INPUT';
    const panel = '.native-sync-controlled-work';
    const topic = service.topics.groupTopic;
    const db = new DatabaseSync(path.join(service.data, 'central.sqlite'), { readOnly: true });
    const evidence = result.groupMemberHandoff = {
        mode, providerPackets: groupRelay.requests, streamFrames: groupRelay.frames,
    };
    try {
        const { A, B } = clients;
        async function select(client) {
            await click(client, '#agentList > li[data-item-type="group"]');
            const scope = await waitUntil(() => evalJs(client, `(() => {
                const current = window.VCPStateChannels.get('conversation.current').get();
                const selected = [...document.querySelectorAll('#agentList li[data-item-type="group"]')]
                    .find(row => row.textContent.includes('Relay fixture A B'));
                return current.topicId && selected?.dataset.itemId && { groupId: selected.dataset.itemId, topicId: current.topicId };
            })()`), 'actual native group selection');
            await waitUntil(() => evalJs(client, `Boolean(document.querySelector('${panel} summary'))`), 'controlled group panel');
            if (!await evalJs(client, `document.querySelector('${panel}').open`)) await click(client, panel + ' summary');
            return scope;
        }
        const buttons = client => evalJs(client, `Object.fromEntries([...document.querySelectorAll('${panel} button')]
            .map(button => [button.textContent.trim(), !button.disabled]))`);
        async function action(client, name) {
            await waitUntil(async () => (await buttons(client))[name], name);
            await click(client, panel + ' button:not(:disabled)', name);
        }
        const admissions = () => db.prepare('SELECT id,request_id,principal,state,dispatched,user_seq FROM shared_admissions WHERE topic_id=? ORDER BY rowid').all(topic.id);
        const journal = () => db.prepare('SELECT seq,msg_id,device_id,action,message_json FROM journal WHERE topic_id=? ORDER BY seq').all(topic.topic.topicId)
            .map(({ message_json, ...row }) => ({ ...row, message: JSON.parse(message_json) }));
        const counts = () => ['A', 'B'].map(member => groupRelay.requests.filter(row => row.member === member).length);
        function capture() {
            const rows = admissions();
            assert.equal(rows.length, 1);
            const native = db.prepare('SELECT id,ordinal,principal,member_id,state FROM shared_native_requests WHERE admission_id=? ORDER BY ordinal').all(rows[0].id);
            const handoff = db.prepare('SELECT executor,executor_version,state,first_reply_seq FROM shared_group_handoffs WHERE work_id=?')
                .get(rows[0].id);
            assert.ok(handoff);
            return { admission: rows[0], handoff, native, journal: journal(), counts: counts() };
        }
        await select(A);
        await select(B);
        await evalJs(A, `(() => {
            const composer = document.querySelector('${panel} textarea[aria-label="受控任务文本"]');
            composer.value = ${JSON.stringify(input)};
            composer.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        })()`);
        await action(A, '开始两成员接力');
        const desktopFiles = {
            main: ['apps/desktop/Groupmodules/groupchat.js', 'apps/desktop/modules/ipc/groupChatHandlers.js',
                'apps/desktop/modules/services/nativeSync/sharedGroupHandoff.js',
                'apps/desktop/modules/services/nativeSync/sharedGroup.js',
                'apps/desktop/modules/services/nativeSync/sharedExecution.js',
                'apps/desktop/modules/services/nativeSync/sharedRuntime.js'],
            renderer: ['apps/desktop/modules/renderer/controlledWorkView.mjs',
                'apps/desktop/modules/renderer/nativeExecutionStatus.js',
                'apps/desktop/modules/services/nativeSync/sharedSessionView.mjs'],
        };
        async function desktopSources(client) {
            const report = await client.command('loaded-sources', desktopFiles);
            for (const [context, files] of Object.entries(desktopFiles)) {
                for (const file of files) assert.ok(report[context].some(row => row.file === file
                    && row.sha256 === sha(path.resolve(file))), file);
            }
            return report;
        }
        evidence.desktopSources = { original: await desktopSources(A) };
        function secondDeviceHeaders() {
            const connection = JSON.parse(fs.readFileSync(path.join(profiles.B, '.native-sync/connection.json'), 'utf8'));
            return {
                'content-type': 'application/json', authorization: 'Bearer synthetic-only',
                'x-nativesync-space': connection.spaceId, 'x-nativesync-source': connection.sourceId,
                'x-nativesync-device': connection.deviceId,
                'x-nativesync-capabilities': 'shared-space-v1,group-member-handoff-v1',
            };
        }
        function handlerEvidence() {
            const file = path.join(out, 'group-handler.jsonl');
            const handler = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
            for (const row of handler) assert.equal(row.handoffSource.sha256,
                sha(path.resolve('apps/server', row.handoffSource.file)));
            return handler;
        }
        if (mode === 'handoff-a-partial') {
            await waitUntil(() => groupRelay.frames.some(frame => frame.text === 'RELAY_A_PARTIAL'), 'first SSE prefix arrived');
            await waitUntil(() => evalJs(A, "document.body.innerText.includes('RELAY_A_PARTIAL')"), 'first SSE prefix visible on A');
            evidence.partial = capture();
            assert.equal(evidence.partial.handoff.state, 'first_member');
            assert.equal(evidence.partial.handoff.first_reply_seq, null);
            assert.deepEqual(evidence.partial.native.map(row => row.state), ['dispatched']);
            assert.deepEqual(evidence.partial.journal.map(row => row.message.content), [input]);
            assert.deepEqual(counts(), [1, 0]);
            evidence.observerButtons = await buttons(B);
            assert.equal(evidence.observerButtons['接管到本端'], false);
            const denied = await fetch(new URL('/api/v1/sync/shared/group-handoff', service.wsOrigin), {
                method: 'POST', headers: secondDeviceHeaders(),
                body: JSON.stringify({ sharedSpaceId: 'sharedAB', workId: evidence.partial.admission.id,
                    opId: 'fixture-premature-takeover', expectedExecutor: 'desktop:deviceA', expectedExecutorVersion: 0 }),
            });
            evidence.rejectedHandoff = { status: denied.status, response: await denied.json() };
            assert.equal(denied.status, 409);
            assert.equal(evidence.rejectedHandoff.response.error.code, 'SHARED_GROUP_HANDOFF_FENCED');
            assert.deepEqual(capture(), evidence.partial);
            await picture(A, 'A-first-member-partial');
            await picture(B, 'B-takeover-unavailable');
            evidence.firstExecutorExit = await crash('A');
            evidence.serverRestart = await service.restartAfterCrash();
            await waitUntil(() => admissions()[0]?.state === 'review_required', 'unknown first member fenced after restart');
            evidence.unknown = capture();
            evidence.handler = handlerEvidence();
            assert.deepEqual(evidence.handler.map(row => row.member), ['A']);
            assert.deepEqual(evidence.unknown.native.map(row => row.state), ['unknown']);
            assert.deepEqual(evidence.unknown.journal, evidence.partial.journal);
            assert.deepEqual(counts(), [1, 0]);
            return;
        }
        await waitUntil(() => journal().some(row => row.message?.content === 'RELAY_A_FINAL'), 'A identity committed');
        await waitUntil(async () => (await buttons(B))['接管到本端'], 'B can take over paused original Work');
        evidence.paused = capture();
        const original = evidence.paused.admission;
        const aReply = evidence.paused.journal.find(row => row.message?.content === 'RELAY_A_FINAL');
        assert.equal(evidence.paused.journal.length, 2);
        assert.equal(aReply.msg_id, 'reply_group_' + original.id + '_0');
        assert.equal(aReply.message.agentId, evidence.paused.native[0].member_id);
        assert.equal(aReply.message.name, 'A');
        assert.equal(aReply.device_id, 'desktop:deviceA');
        assert.deepEqual({ ...evidence.paused.handoff }, {
            executor: 'desktop:deviceA', executor_version: 0, state: 'awaiting_handoff', first_reply_seq: aReply.seq,
        });
        assert.deepEqual(evidence.paused.counts, [1, 0]);
        assert.ok(!evidence.paused.native.some(row => row.ordinal === 1 && row.state !== 'prepared'));
        await picture(A, 'A-paused-after-first-member');
        await stop('A');
        evidence.pausedToolBoxRestart = await service.restartAfterCrash();
        evidence.afterPausedRestart = capture();
        assert.deepEqual(evidence.afterPausedRestart, evidence.paused);
        await action(B, '接管到本端');
        const lost = await waitUntil(() => service.requests.find(row => row.route.endsWith('/group-handoff') && row.dropped), 'proxy truncates committed takeover ACK');
        assert.equal(lost.response.request.id, original.id);
        assert.equal(lost.response.request.groupHandoff.state, 'awaiting_continue');
        assert.equal(lost.response.request.groupHandoff.executor, 'desktop:deviceB');
        evidence.lostAck = lost;
        assert.deepEqual(counts(), [1, 0]);
        evidence.takeoverRecipientExit = await crash('B');
        let reopened = await start('B');
        let scope = await select(reopened);
        await waitUntil(async () => (await buttons(reopened))['本端继续执行'], 'reopened B discovers original takeover');
        evidence.reopened = capture();
        assert.deepEqual(evidence.reopened.journal, evidence.paused.journal);
        assert.deepEqual({ ...evidence.reopened.handoff }, {
            executor: 'desktop:deviceB', executor_version: 1, state: 'awaiting_continue', first_reply_seq: aReply.seq,
        });
        const visibleFirstReplyCount = client => evalJs(client, "document.body.innerText.split('RELAY_A_FINAL').length - 1");
        await waitUntil(async () => await visibleFirstReplyCount(reopened) === 1,
            'one visible committed A reply without stale observer preview');
        evidence.reopened.visibleFirstReplyCount = await visibleFirstReplyCount(reopened);
        await picture(reopened, 'B-reopened-after-lost-ack');
        await action(reopened, '本端继续执行');
        if (mode === 'handoff') {
            const lostContinue = await waitUntil(() => service.requests.find(row => row.route.endsWith('/group-continue') && row.dropped),
                'proxy truncates committed Continue ACK');
            evidence.lostContinueAck = lostContinue;
            evidence.beforeContinueReopen = capture();
            assert.deepEqual(evidence.beforeContinueReopen.counts, [1, 0]);
            assert.equal(evidence.beforeContinueReopen.handoff.state, 'continuing');
            assert.ok(!evidence.beforeContinueReopen.native.some(row => row.ordinal === 1));
            evidence.continueRecipientExit = await crash('B');
            reopened = await start('B');
            scope = await select(reopened);
            await waitUntil(async () => (await buttons(reopened))['本端继续执行'], 'reopen discovers pre-dispatch Continue receipt');
            assert.deepEqual(capture(), evidence.beforeContinueReopen);
            await picture(reopened, 'B-reopened-after-lost-continue');
            await action(reopened, '本端继续执行');
        }
        await waitUntil(() => groupRelay.frames.some(frame => frame.text === 'RELAY_B_PARTIAL'), 'B receives second member SSE');
        if (mode === 'handoff') {
            const continueRequests = service.requests.filter(row => row.route.endsWith('/group-continue'));
            assert.equal(continueRequests.length, 2);
            assert.deepEqual(continueRequests[1].body, continueRequests[0].body);
            assert.equal(continueRequests[1].status, 200);
            evidence.continueRequests = continueRequests;
        }
        evidence.handler = handlerEvidence();
        assert.deepEqual(evidence.handler.map(row => row.member), ['A', 'B']);
        const handlerB = evidence.handler[1];
        evidence.desktopSources.continuing = await desktopSources(reopened);
        const providerB = groupRelay.requests[1].packet;
        assert.equal(handlerB.workId, original.id);
        assert.equal(handlerB.device, 'deviceB');
        assert.equal(handlerB.body.requestId, lost.response.request.groupHandoff.nextRequestId);
        const bindings = handlerB.body.vcpchatExtensions.messageTimestampBindings.filter(binding => binding.messageId === aReply.msg_id);
        assert.equal(bindings.length, 1);
        const binding = bindings[0];
        const sent = handlerB.body.messages[binding.sentMessageIndex];
        assert.equal(sent.role, 'assistant');
        const text = message => typeof message.content === 'string' ? message.content
            : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
        const sentText = `[${aReply.message.name}的发言]: ${aReply.message.content}`;
        const firstMember = message => message.role === 'assistant' && text(message).includes(aReply.message.content);
        const handlerMatches = handlerB.body.messages.filter(firstMember);
        const providerMatches = providerB.messages.filter(firstMember);
        assert.deepEqual(handlerMatches, [sent]);
        assert.equal(providerMatches.length, 1);
        assert.equal(text(sent), sentText);
        assert.equal(text(providerMatches[0]), sentText);
        assert.equal(binding.timestamp, aReply.message.timestamp);
        assert.equal(binding.sentMessageHash, 'sha256:' + createHash('sha256').update(sentText).digest('hex'));
        evidence.sentFirstMember = { committed: aReply, binding, handlerMessage: sent, providerMessage: providerMatches[0] };
        assert.deepEqual(counts(), [1, 1]);
        await waitUntil(() => evalJs(reopened, "document.querySelector('#chatMessages').innerText.includes('RELAY_B_PARTIAL')"), 'B displays second member SSE');
        assert.equal(await visibleFirstReplyCount(reopened), 1);
        await picture(reopened, 'B-streaming-second-member');
        if (mode === 'handoff-unknown') {
            evidence.beforeUnknown = capture();
            groupRelay.cutB();
            evidence.secondExecutorExit = await crash('B');
            evidence.serverRestart = await service.restartAfterCrash();
            await waitUntil(() => admissions()[0]?.state === 'review_required', 'unknown second member fences original Work');
            const review = await start('B');
            await select(review);
            await waitUntil(() => evalJs(review, `document.querySelector('${panel} [role="status"]')
                ?.innerText.includes('原回复结果待核对')`), 'reopened B displays unknown original Work');
            evidence.unknown = capture();
            evidence.reviewButtons = await buttons(review);
            assert.equal(evidence.unknown.admission.id, original.id);
            assert.equal(evidence.unknown.native[1].state, 'unknown');
            assert.deepEqual(evidence.unknown.journal, evidence.paused.journal);
            assert.equal(evidence.reviewButtons['本端继续执行'], false);
            assert.equal(evidence.reviewButtons['接管到本端'], false);
            if (evidence.reviewButtons['核对任务']) await action(review, '核对任务');
            const replay = await fetch(new URL(handlerB.route, service.wsOrigin), {
                method: 'POST',
                headers: { ...secondDeviceHeaders(), 'x-nativesync-admission': original.id },
                body: JSON.stringify(handlerB.body),
            });
            evidence.rejectedNativeReplay = { status: replay.status, response: await replay.json() };
            assert.equal(evidence.rejectedNativeReplay.status, 409);
            assert.equal(evidence.rejectedNativeReplay.response.error.code, 'SHARED_GROUP_HANDOFF_FENCED');
            assert.deepEqual(capture(), evidence.unknown);
            assert.deepEqual(counts(), [1, 1]);
            await picture(review, 'B-original-work-needs-review');
            return;
        }
        groupRelay.finishB();
        await waitUntil(() => admissions()[0]?.state === 'completed', 'original group Work completes');
        evidence.finished = capture();
        assert.equal(evidence.finished.admission.id, original.id);
        assert.equal(evidence.finished.handoff.executor, 'desktop:deviceB');
        assert.equal(evidence.finished.handoff.executor_version, 1);
        assert.deepEqual(evidence.finished.counts, [1, 1]);
        assert.deepEqual(evidence.finished.journal.map(row => row.message.content), [input, 'RELAY_A_FINAL', 'RELAY_B_PARTIAL RELAY_B_FINAL']);
        assert.equal(evidence.finished.journal[1].msg_id, aReply.msg_id);
        assert.equal(new Set(evidence.finished.journal.map(row => row.msg_id)).size, 3);
        const localFile = path.join(profiles.B, 'UserData', scope.groupId, 'topics', scope.topicId, 'history.json');
        await waitUntil(() => {
            try {
                return JSON.parse(fs.readFileSync(localFile, 'utf8')).at(-1)?.content === 'RELAY_B_PARTIAL RELAY_B_FINAL';
            } catch (error) {
                if (error.code === 'ENOENT' || error instanceof SyntaxError) return false;
                throw error;
            }
        }, 'native local History receives committed second member');
        await waitUntil(() => evalJs(reopened, "document.querySelector('#chatMessages').innerText.includes('RELAY_B_FINAL')"), 'B displays committed final');
        await picture(reopened, 'B-original-work-completed');
    } finally {
        db.close();
    }
};

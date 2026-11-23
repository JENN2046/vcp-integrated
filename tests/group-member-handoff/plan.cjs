'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const input = 'GROUP_HANDOFF_BASELINE_INPUT';
const panel = '.native-sync-controlled-work';
const members = ['A', 'B', 'C'];
const replies = members.map(member => 'RELAY_' + member + '_FINAL');
const textOf = message => typeof message.content === 'string' ? message.content
    : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');

module.exports = async function plan({ clients, out, result, picture, click, evalJs, waitUntil, sha,
    service, start, stop, profiles, crash, groupRelay }) {
    const mode = process.env.NS_GROUP_HANDOFF_CASE;
    const baseline = mode === 'plan-baseline';
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (baseline) {
        assert.equal(revision, 'af17c99e784fd1afd5b127fcf8a467f06ef8423d');
        assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=no', '--', 'apps'],
            { encoding: 'utf8' }), '');
    }
    const topic = service.topics.groupTopic;
    const db = new DatabaseSync(path.join(service.data, 'central.sqlite'), { readOnly: true });
    const evidence = result.groupPlanHandoff = { mode, revision, providerPackets: groupRelay.requests };
    async function select(client) {
        await click(client, '#agentList > li[data-item-type="group"]');
        const scope = await waitUntil(() => evalJs(client, `(() => {
            const current = window.VCPStateChannels.get('conversation.current').get();
            const group = document.querySelector('#agentList li[data-item-type="group"]');
            return current.topicId && group?.textContent.includes('Relay fixture A B C')
                && { groupId: group.dataset.itemId, topicId: current.topicId };
        })()`), 'seeded three-member group selected');
        if (!baseline) {
            await waitUntil(() => evalJs(client, `Boolean(document.querySelector('${panel}:not([hidden]) summary'))`),
                'sequential handoff panel visible');
            if (!await evalJs(client, `document.querySelector('${panel}').open`)) await click(client, panel + ' summary');
        }
        return scope;
    }
    const admissions = () => db.prepare('SELECT id,request_id,principal,state,dispatched,user_seq FROM shared_admissions WHERE topic_id=? ORDER BY rowid').all(topic.id);
    const journal = () => db.prepare('SELECT seq,msg_id,device_id,action,message_json FROM journal WHERE topic_id=? ORDER BY seq')
        .all(topic.topic.topicId).map(({ message_json, ...row }) => ({ ...row, message: JSON.parse(message_json) }));
    const counts = () => groupRelay.requests.map(row => row.member);
    function capture() {
        const rows = admissions();
        assert.equal(rows.length, 1);
        const admission = rows[0];
        const native = db.prepare('SELECT id,ordinal,principal,member_id,state FROM shared_native_requests WHERE admission_id=? ORDER BY ordinal').all(admission.id);
        const handoff = db.prepare('SELECT * FROM shared_group_handoffs WHERE work_id=?').get(admission.id);
        assert.ok(handoff);
        const replySlots = db.prepare('SELECT ordinal,reply_seq FROM shared_group_handoff_replies WHERE work_id=? ORDER BY ordinal')
            .all(admission.id);
        return { admission, handoff, native, replySlots, journal: journal(), counts: counts() };
    }
    async function desktopSources(client) {
        const files = {
            main: ['apps/desktop/Groupmodules/groupchat.js',
                'apps/desktop/modules/services/nativeSync/sharedGroup.js',
                'apps/desktop/modules/services/nativeSync/sharedGroupHandoff.js'],
            renderer: ['apps/desktop/modules/renderer/controlledWorkView.mjs'],
        };
        const loaded = await client.command('loaded-sources', files);
        for (const [context, sources] of Object.entries(files)) {
            for (const file of sources) {
                assert.ok(loaded[context].some(row => row.file === file && row.sha256 === sha(path.resolve(file))), file);
            }
        }
        return loaded;
    }
    async function action(client, label) {
        await waitUntil(() => evalJs(client, `[...document.querySelectorAll('${panel} button:not(:disabled)')]
            .some(button => button.checkVisibility() && button.textContent.trim() === ${JSON.stringify(label)})`), label);
        await click(client, panel + ' button:not(:disabled)', label);
    }
    try {
        let A = clients.A;
        let B = clients.B;
        let scopeA = await select(A);
        if (baseline) {
            const ready = await waitUntil(() => evalJs(A, `window.electronAPI.groupMemberHandoff && Boolean(document.querySelector('${panel} summary'))`),
                'baseline group entry initialized');
            assert.equal(ready, true);
            evidence.desktopSources = { A: await desktopSources(A) };
            evidence.panelHidden = await evalJs(A, `document.querySelector('${panel}').hidden`);
            assert.equal(evidence.panelHidden, true);
            const payload = { descriptor: { itemType: 'group', itemId: scopeA.groupId, topicId: scopeA.topicId },
                action: 'start', message: { id: 'fixture-three-member-input', role: 'user', content: input, timestamp: Date.now(), attachments: [] } };
            evidence.desktopResult = await evalJs(A, `window.electronAPI.groupMemberHandoff(${JSON.stringify(payload)})`);
            assert.deepEqual(evidence.desktopResult, { success: false, error: 'SHARED_GROUP_HANDOFF_UNSUPPORTED' });
            evidence.admissionWire = service.requests.find(row => row.route.endsWith('/shared/admit') && row.body.message?.content === input);
            assert.equal(evidence.admissionWire.status, 409);
            assert.equal(evidence.admissionWire.response.error.code, 'SHARED_GROUP_HANDOFF_UNSUPPORTED');
            evidence.state = { admissions: admissions(), journal: journal(), counts: counts() };
            assert.deepEqual(evidence.state, { admissions: [], journal: [], counts: [] });
            await picture(A, 'baseline-three-member-rejected');
            return;
        }
        const liveScopeB = await select(B);
        evidence.desktopSources = { A: await desktopSources(A), B: await desktopSources(B) };
        await evalJs(A, `(() => {
            const composer = document.querySelector('${panel} textarea[aria-label="受控任务文本"]');
            composer.value = ${JSON.stringify(input)};
            composer.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        })()`);
        await action(A, '开始顺序接力');
        await waitUntil(() => journal().some(row => row.message?.content === replies[0]), 'first formal group reply committed');
        evidence.firstBoundary = capture();
        const workId = evidence.firstBoundary.admission.id;
        assert.deepEqual(evidence.firstBoundary.counts, ['A']);
        await waitUntil(() => evalJs(A, `document.querySelector('${panel} [role="status"]').innerText.includes('第2位，共3位')`),
            'first boundary visible on A');
        await picture(A, 'first-boundary-A');
        await stop('A');
        await action(B, '接管到本端');
        await action(B, '本端继续执行');
        await waitUntil(() => journal().some(row => row.message?.content === replies[1]), 'second formal group reply committed');
        evidence.secondBoundary = capture();
        assert.equal(evidence.secondBoundary.admission.id, workId);
        assert.deepEqual(evidence.secondBoundary.counts, ['A', 'B']);
        assert.deepEqual(evidence.secondBoundary.journal.slice(0, 2), evidence.firstBoundary.journal);
        await waitUntil(() => evalJs(B, `document.querySelector('${panel} [role="status"]').innerText.includes('第3位，共3位')`),
            'second boundary visible on B');
        await picture(B, 'second-boundary-B');

        A = await start('A');
        scopeA = await select(A);
        await action(A, '接管到本端');
        await action(A, '本端继续执行');
        evidence.lostContinue = await waitUntil(() => service.requests.find(row => row.route.endsWith('/group-continue') && row.dropped),
            'second Continue commits but desktop loses ACK');
        const received = evidence.lostContinue.response.request;
        assert.equal(received.id, workId);
        assert.equal(received.groupHandoff.nextOrdinal, 2);
        assert.equal(received.groupHandoff.executorVersion, 2);
        assert.equal(received.groupHandoff.state, 'continuing');
        assert.deepEqual(received.groupHandoff.confirmedReplies, evidence.secondBoundary.journal.slice(1).map(row => row.seq));
        evidence.beforeReopen = capture();
        assert.deepEqual(evidence.beforeReopen.counts, ['A', 'B']);
        assert.ok(!evidence.beforeReopen.native.some(row => row.ordinal === 2 && row.state !== 'prepared'));
        assert.deepEqual(evidence.beforeReopen.journal, evidence.secondBoundary.journal);
        evidence.thirdExecutorCrash = await crash('A');
        A = await start('A');
        scopeA = await select(A);
        evidence.afterReopen = capture();
        assert.deepEqual(evidence.afterReopen, evidence.beforeReopen);
        await waitUntil(() => evalJs(A, `document.querySelector('${panel} [role="status"]').innerText.includes('等待本端执行')`),
            'reopened A shows acknowledged Continue before the third call');
        await picture(A, 'second-continue-ack-lost-A-reopened');
        await action(A, '本端继续执行');
        await waitUntil(() => admissions()[0]?.state === 'completed', 'original Work completed');
        evidence.completed = capture();
        assert.equal(evidence.completed.admission.id, workId);
        assert.deepEqual(evidence.completed.counts, members);
        assert.deepEqual(evidence.completed.native.map(row => row.state), Array(3).fill('model_terminal'));
        assert.deepEqual(evidence.completed.native.map(row => row.principal), ['desktop:deviceA', 'desktop:deviceB', 'desktop:deviceA']);
        assert.equal(new Set(evidence.completed.native.map(row => row.id)).size, 3);
        assert.equal(new Set(evidence.completed.native.map(row => row.member_id)).size, 3);
        assert.deepEqual(evidence.completed.journal.map(row => row.message.content), [input, ...replies]);
        assert.equal(new Set(evidence.completed.journal.map(row => row.msg_id)).size, 4);
        assert.deepEqual(evidence.completed.journal.map(row => row.action), Array(4).fill('upsert'));
        assert.deepEqual(evidence.completed.journal.slice(0, 3), evidence.secondBoundary.journal);
        for (const [i, snapshot] of [evidence.firstBoundary, evidence.secondBoundary, evidence.completed].entries()) {
            assert.deepEqual(snapshot.replySlots.map(row => [row.ordinal, row.reply_seq]),
                snapshot.journal.slice(1).map((row, ordinal) => [ordinal, row.seq]));
            assert.equal(snapshot.handoff.state, i < 2 ? 'awaiting_handoff' : 'completed');
            assert.equal(snapshot.handoff.executor_version, i);
        }
        for (const [ordinal, step] of evidence.completed.native.entries()) {
            const row = evidence.completed.journal[ordinal + 1];
            assert.equal(row.msg_id, 'reply_' + step.id);
            assert.equal(row.message.agentId, step.member_id);
            assert.equal(row.message.name, members[ordinal]);
            assert.equal(row.device_id, step.principal);
        }

        evidence.handler = fs.readFileSync(path.join(out, 'group-handler.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
        assert.deepEqual(evidence.handler.map(row => row.member), members);
        for (const [ordinal, row] of evidence.handler.entries()) {
            assert.equal(row.workId, workId);
            const step = evidence.completed.native[ordinal];
            assert.equal(row.device, step.principal.slice('desktop:'.length));
            assert.equal(row.body.requestId, step.id);
            assert.equal(row.body.messageId, evidence.completed.journal[ordinal + 1].msg_id);
            assert.equal(groupRelay.requests[ordinal].packet.requestId, row.body.requestId);
            assert.equal(row.handoffSource.sha256, sha(path.resolve('apps/server', row.handoffSource.file)));
        }
        const handlerC = evidence.handler[2].body;
        const providerC = groupRelay.requests[2].packet;
        evidence.thirdContext = evidence.completed.journal.slice(1, 3).map(committed => {
            const bound = handlerC.vcpchatExtensions.messageTimestampBindings.filter(binding => binding.messageId === committed.msg_id);
            assert.equal(bound.length, 1);
            const [binding] = bound;
            const assistant = handlerC.messages[binding.sentMessageIndex];
            const text = `[${committed.message.name}的发言]: ${committed.message.content}`;
            const matches = message => message.role === 'assistant' && textOf(message).includes(committed.message.content);
            assert.deepEqual(handlerC.messages.filter(matches), [assistant]);
            const providerIndexes = providerC.messages.flatMap((message, index) => matches(message) ? [index] : []);
            assert.equal(providerIndexes.length, 1);
            const [providerIndex] = providerIndexes;
            assert.equal(textOf(assistant), text);
            assert.equal(textOf(providerC.messages[providerIndex]), text);
            assert.equal(binding.timestamp, committed.message.timestamp);
            assert.equal(binding.sentMessageHash, 'sha256:' + createHash('sha256').update(text).digest('hex'));
            return { committed, binding, providerIndex };
        });
        assert.ok(evidence.thirdContext[0].binding.sentMessageIndex < evidence.thirdContext[1].binding.sentMessageIndex);
        assert.ok(evidence.thirdContext[0].providerIndex < evidence.thirdContext[1].providerIndex);
        evidence.continueOperations = service.requests.filter(row => row.route.endsWith('/group-continue'));
        assert.equal(evidence.continueOperations.length, 3);
        assert.deepEqual(evidence.continueOperations[1].body, evidence.continueOperations[2].body);
        assert.equal(evidence.continueOperations[2].status, 200);
        evidence.takeovers = service.requests.filter(row => row.route.endsWith('/group-handoff'));
        assert.deepEqual(evidence.takeovers.map(row => row.device), ['deviceB', 'deviceA']);
        assert.deepEqual(evidence.takeovers.map(row => row.response.request.groupHandoff.executorVersion), [1, 2]);
        for (const [i, takeover] of evidence.takeovers.entries()) {
            const publicControl = takeover.response.request.groupHandoff;
            assert.equal(publicControl.nextOrdinal, i + 1);
            assert.equal(publicControl.nextRequestId, evidence.completed.native[i + 1].id);
            assert.deepEqual(publicControl.confirmedReplies,
                evidence.completed.journal.slice(1, i + 2).map(row => row.seq));
        }
        assert.ok(evidence.takeovers.every(row => row.response.request.id === workId));
        const beforeReopenB = await waitUntil(() => evalJs(B, `(() => {
            const topicId = window.VCPStateChannels.get('conversation.current').get().topicId;
            const chat = document.querySelector('#chatMessages').innerText;
            const status = document.querySelector('${panel} [role="status"]').innerText;
            return status.includes('3/3') && { topicId, chat, status };
        })()`), 'live B observes original Work completed');
        assert.equal(beforeReopenB.topicId, liveScopeB.topicId);
        evidence.liveObserver = beforeReopenB;
        evidence.liveObserver.chat = await waitUntil(() => evalJs(B, `(() => {
            const chat = document.querySelector('#chatMessages').innerText;
            return chat.includes('${replies[2]}') && chat;
        })()`), 'live B displays third formal reply');
        for (const reply of replies) assert.equal(evidence.liveObserver.chat.split(reply).length - 1, 1);
        await picture(B, 'original-work-completed-B-live');
        await stop('B');
        B = await start('B');
        const scopeB = await select(B);
        evidence.history = {};
        for (const [role, client, scope] of [['A', A, scopeA], ['B', B, scopeB]]) {
            const file = path.join(profiles[role], 'UserData', scope.groupId, 'topics', scope.topicId, 'history.json');
            const history = await waitUntil(() => {
                if (!fs.existsSync(file)) return false;
                const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
                return rows.at(-1)?.content === replies[2] && rows;
            }, role + ' native History includes final reply');
            assert.deepEqual(history.map(row => [row.id, row.role, row.content, row.agentId, row.name, row.timestamp]),
                evidence.completed.journal.map(row => [row.msg_id, row.message.role, row.message.content,
                    row.message.agentId, row.message.name, row.message.timestamp]));
            evidence.history[role] = history;
            await waitUntil(() => evalJs(client, `document.querySelector('#chatMessages').innerText.includes('${replies[2]}')`),
                role + ' displays third formal reply');
        }
        await picture(A, 'original-work-completed-A');
        await picture(B, 'original-work-completed-B');
        assert.deepEqual(counts(), members);
    } finally {
        db.close();
    }
};

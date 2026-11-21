'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { cases } = require('./fixture.cjs');

module.exports = async ({ clients, out, result, picture, click, evalJs, waitUntil, sha, desktopStreamClose, start, stop }) => {
    const { streams, receipts } = desktopStreamClose;
    const observations = result.desktopStreamClose = {
        revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: result.candidate, encoding: 'utf8' }).trim(),
        streams, receipts, windows: {},
    };
    const send = '#sendMessageBtn';
    const transcript = client => evalJs(client, "document.querySelector('#chatMessages').innerText");
    const composer = client => evalJs(client, `(() => {
        const button = document.querySelector('#sendMessageBtn');
        return { disabled:button.disabled, label:button.getAttribute('aria-label'),
            mode:button.dataset.composerMode || button.dataset.mode };
    })()`);
    const isStop = state => !state.disabled && (state.mode === 'interrupt' || /停|中断/.test(state.label || ''));
    const sources = {
        main: ['apps/desktop/modules/ipc/chatHandlers.js', 'apps/desktop/modules/services/senderTaskRegistry.js'],
        renderer: ['apps/desktop/modules/renderer/mainChatStreamConsumer.js'],
    };
    async function select(client, role) {
        if (!await evalJs(client, "document.querySelector('#tabContentAgents').classList.contains('active')")) {
            await click(client, '.sidebar-tab-button[data-tab="agents"]');
        }
        await click(client, '#agentList > li .agent-name', 'Synthetic local');
        await waitUntil(async () => (await evalJs(client, 'window.VCPStateChannels.get("conversation.current").get()')).topicId === 'local-topic',
            role + ' local topic');
    }
    const queueReview = client => evalJs(client, "document.querySelector('.topic-admission-review pre')?.innerText");
    async function run(role) {
        const client = clients[role];
        const { prompt, text } = cases[role];
        const profile = path.join(out, 'profile-' + role);
        const history = () => JSON.parse(fs.readFileSync(path.join(profile, 'UserData/local-agent/topics/local-topic/history.json'), 'utf8'));
        const admission = () => JSON.parse(fs.readFileSync(path.join(profile, 'TopicMessageQueue/pending.json'), 'utf8'));
        const rendererTerminals = () => evalJs(client, 'window.desktopStreamCloseTerminals');
        const wireEvents = () => client.events.filter(({ event, data }) =>
            event === 'renderer-event' && data.channel === 'vcp-stream-event');
        const terminalEvents = () => wireEvents().filter(({ data }) => ['end', 'error'].includes(data.type));
        const events = name => client.events.filter(({ event }) => event === name);
        const evidence = observations.windows[role] = {};
        try {
            await select(client, role);
            await evalJs(client, `(() => {
                window.desktopStreamCloseTerminals = [];
                window.addEventListener('vcp-chat-stream-terminal', ({ detail }) => {
                    const { type, messageId } = detail;
                    window.desktopStreamCloseTerminals.push({ type, messageId });
                });
            })()`);
            evidence.loaded = await client.command('loaded-sources', sources);
            for (const kind of Object.keys(sources)) {
                assert.equal(evidence.loaded[kind].length, sources[kind].length);
                for (const source of evidence.loaded[kind]) assert.equal(source.sha256, sha(path.join(result.candidate, source.file)));
            }
            await evalJs(client, `(() => {
                const input = document.querySelector('#messageInput');
                input.value = ${JSON.stringify(prompt)};
                input.dispatchEvent(new Event('input', { bubbles: true }));
            })()`);
            await click(client, send);
            await waitUntil(async () => (await transcript(client)).includes(text), role + ' visible before fault');
            const stream = streams[role];
            assert.ok(stream?.requestId);
            const [begin] = events('desktop-stream-task');
            assert.equal(begin.data.method, 'begin');
            assert.equal(begin.data.active[0].requestId, stream.requestId);
            assert.equal(begin.data.active[0].state, 'running');
            evidence.liveHistory = history();
            assert.deepEqual(evidence.liveHistory.map(row => [row.role, row.content]), [['user', prompt]]);
            assert.ok(isStop(await composer(client)));
            assert.deepEqual(terminalEvents(), []);
            await picture(client, role + '-live');
            if (role === 'A') desktopStreamClose.done();
            if (role === 'B') desktopStreamClose.cut();
            if (role === 'C') await click(client, send);

            const release = await waitUntil(() => events('desktop-stream-reader').find(({ data }) => data.method === 'releaseLock'),
                role + ' reader released', 12000);
            assert.equal(release.data.locked, false);
            assert.equal(release.data.requestId, stream.requestId);
            const reader = events('desktop-stream-reader');
            assert.deepEqual(reader.map(({ data }) => data.method), ['cancel', 'releaseLock']);
            const task = events('desktop-stream-task');
            assert.deepEqual(task.map(({ data }) => data.method), role === 'C' ? ['begin', 'cancel', 'finish'] : ['begin', 'finish']);
            assert.deepEqual(task.at(-1).data.active, []);
            assert.ok(task.every(({ data }) => data.requestId === stream.requestId));

            await waitUntil(() => stream.closedAt, role + ' server socket closed', 7000);
            assert.equal(stream.serverEnded, false);
            assert.equal(stream.attempts, 1);
            if (role === 'A') {
                const assistant = await waitUntil(() => history().find(row => row.role === 'assistant'), role + ' physical terminal History');
                assert.deepEqual(history().map(row => row.role), ['user', 'assistant']);
                assert.equal(assistant.id, stream.requestId);
                assert.equal(assistant.content, text);
                assert.equal(assistant.finishReason, 'completed');
                assert.notEqual(assistant.isThinking, true);
                assert.notEqual(assistant.isPendingStream, true);
                await waitUntil(() => admission().entries.length === 0, role + ' cleared admission');
                assert.deepEqual(terminalEvents().map(({ data }) => [data.type, data.messageId]), [['end', stream.requestId]]);
                assert.deepEqual(stream.frames.map(({ kind }) => kind), ['delta', 'done']);
            } else {
                const entry = await waitUntil(() => admission().entries.find(row => row.state === 'uncertain'), role + ' durable review');
                assert.deepEqual(history().map(row => [row.role, row.content]), [['user', prompt]]);
                assert.equal(entry.requestId, history()[0].id);
                assert.equal('admission_' + entry.leaseToken, stream.requestId);
                assert.equal(entry.error, 'MODEL_RESPONSE_INCOMPLETE_REVIEW_REQUIRED');
                assert.deepEqual(entry.reviewPartial, { text, truncated: false });
                assert.equal(admission().entries.length, 1);
                await waitUntil(async () => await queueReview(client) === text, role + ' partial in review UI');
                assert.deepEqual(stream.frames.map(({ kind }) => kind), ['delta']);
                if (role === 'B') {
                    assert.deepEqual(terminalEvents().map(({ data }) => [data.type, data.code, data.messageId]),
                        [['error', 'STREAM_READ_ERROR', stream.requestId]]);
                    assert.ok(stream.cutAt <= stream.closedAt);
                } else {
                    const [receipt] = receipts;
                    assert.equal(receipt.requestId, stream.requestId);
                    assert.equal(receipt.acceptedStatus, 200);
                    assert.equal(receipt.ackTruncated, true);
                    const [ipc] = events('desktop-stop-receipt');
                    assert.equal(ipc.data.requestId, stream.requestId);
                    assert.equal(ipc.data.success, false);
                    assert.equal(task[1].data.reason, 'interrupt-local-fallback');
                    assert.deepEqual(terminalEvents(), []);
                }
            }
            const expectedTerminal = { A: 'completed', B: 'error', C: 'failed' }[role];
            await waitUntil(async () => (await rendererTerminals()).length, role + ' renderer terminal');
            assert.deepEqual(await rendererTerminals(), [{ type: expectedTerminal, messageId: stream.requestId }]);
            await waitUntil(async () => !isStop(await composer(client)), role + ' composer released');
            await picture(client, role + '-settled');
        } finally {
            evidence.history = history();
            evidence.admission = fs.existsSync(path.join(profile, 'TopicMessageQueue/pending.json')) ? admission() : undefined;
            evidence.rendererTerminals = await rendererTerminals();
            evidence.reader = events('desktop-stream-reader');
            evidence.tasks = events('desktop-stream-task');
            evidence.stopResults = events('desktop-stop-receipt');
            evidence.desktopTerminals = terminalEvents();
            evidence.transcript = await transcript(client);
            evidence.composer = await composer(client);
        }
        await stop(role);
        const reopened = await start(role + '-reopened', role);
        await select(reopened, role);
        const textVisible = role === 'A'
            ? await waitUntil(async () => (await transcript(reopened)).includes(text), role + ' saved final after reopen')
            : await waitUntil(async () => await queueReview(reopened) === text, role + ' durable review after reopen');
        assert.deepEqual(history(), evidence.history);
        assert.deepEqual(admission(), evidence.admission);
        evidence.reopened = { textVisible, historyUnchanged: true, admissionUnchanged: true };
        assert.equal(streams[role].attempts, 1);
        await picture(reopened, role + '-reopened');
        await stop(role + '-reopened');
    }
    for (const role of Object.keys(cases)) await run(role);
    assert.equal(receipts.length, 1);
};

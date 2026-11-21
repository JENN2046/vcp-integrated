'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const fixture = require('./fixture.cjs');
const ordinary = require('../ordinary-tools/fixture.cjs');

module.exports = async ({ clients:{A}, out, result, service, picture, click, evalJs, waitUntil, sha, start, stop, profiles }) => {
    const observation = result.streamInterrupt = {
        revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd:result.candidate, encoding:'utf8' }).trim(),
        roleDivider:service.streamInterrupt.roleDivider,
        summarySnapshots:service.streamInterrupt.summarySnapshots,
        summaryRequests:service.streamInterrupt.summaryRequests,
    };
    const history = () => fixture.history(out);
    const transcript = (client = A) => evalJs(client, "document.querySelector('#chatMessages').innerText");
    const stopReceipts = () => service.requests.filter(row => row.route === '/v1/interrupt');
    const checkpoint = row => row.contextCompaction?.kind === 'vchat-context-checkpoint';
    const assistant = row => row.role === 'assistant' && row.content?.includes(fixture.prefix);
    async function select(client) {
        if (!await evalJs(client, "document.querySelector('#tabContentAgents').classList.contains('active')")) {
            await click(client, '.sidebar-tab-button[data-tab="agents"]');
        }
        await click(client, '#agentList > li .agent-name', 'Synthetic local');
        await waitUntil(async () => (await evalJs(client, 'window.VCPStateChannels.get("conversation.current").get()')).topicId === 'local-topic',
            'local topic selected');
    }
    await select(A);
    observation.loaded = await A.command('loaded-sources', {
        main:['apps/desktop/modules/ipc/chatHandlers.js','apps/desktop/modules/vcpClient.js',
            'apps/desktop/modules/ipc/nativeHistoryHandlers.js','apps/desktop/modules/services/topicMessageAdmissionHost.js',
            'apps/desktop/modules/services/topicMessageAdmission.js'],
        renderer:['apps/desktop/modules/chatManager.js','apps/desktop/modules/renderer/mainChatStreamConsumer.js',
            'apps/desktop/modules/chat/contextCompactionService.js','apps/desktop/modules/renderer/mainChatSurfaceAdapter.js',
            'apps/desktop/modules/chat/vcpStreamBridge.js','apps/desktop/modules/chat/streamCoordinator.js',
            'apps/desktop/modules/chat/chatHistoryPersistence.js'],
    });
    assert.equal(observation.loaded.main.length, 5);
    assert.equal(observation.loaded.renderer.length, 7);
    for (const source of [...observation.loaded.main, ...observation.loaded.renderer]) {
        assert.equal(source.sha256, sha(path.join(result.candidate, source.file)));
    }
    try {
        await evalJs(A, `(() => {
            const input = document.querySelector('#messageInput');
            input.value = ${JSON.stringify(fixture.marker)};
            input.dispatchEvent(new Event('input', { bubbles:true }));
        })()`);
        await click(A, '#sendMessageBtn');
        await waitUntil(async () => (await transcript()).includes('SYNTHETIC PARTIAL BEFORE TOOL'), 'live provider prefix rendered');
        assert.deepEqual(history().map(row => row.role), ['user']);
        assert.deepEqual(ordinary.counts(out), []);
        assert.equal(stopReceipts().length, 0);
        assert.equal(service.calls.filter(row => row.phase === 'summary').length, 0);
        await picture(A, 'provider-prefix-live');
        service.streamInterrupt.releaseTool();
        await waitUntil(() => stopReceipts().some(row => row.status === 200), 'real Toolbox interrupt acknowledgement', 8000);
        await waitUntil(() => history().some(checkpoint), 'one auto-compaction checkpoint in physical History', 12000);
        await waitUntil(() => evalJs(A, 'document.querySelector(".vcp-context-checkpoint")?.checkVisibility()'), 'checkpoint card');
        await picture(A, 'checkpoint-after-interrupt');
        const saved = await waitUntil(() => {
            const rows = history();
            return rows.at(-1)?.content === fixture.resumedText && rows;
        }, 'resumed reply written to physical History');
        const [interrupt] = stopReceipts();
        const [initial, continuation, summary, resumed] = service.calls;
        const [snapshot] = observation.summaryRequests;
        assert.equal(observation.summaryRequests.length, 1);
        assert.equal(observation.summarySnapshots.length, 1);
        assert.deepEqual(observation.summarySnapshots[0].history, snapshot.history);
        assert.ok(snapshot.at <= summary.at);
        assert.deepEqual(service.calls.map(row => row.phase), ['tool-request','held-continuation','summary','resumed']);
        assert.ok(service.calls.every(row => row.stream));
        assert.equal(continuation.id, initial.id);
        assert.equal(continuation.hasToolResult, true);
        assert.equal(continuation.providerEndedNormally, false);
        assert.equal(interrupt.method, 'POST');
        assert.equal(interrupt.body.requestId, initial.id);
        assert.equal(interrupt.response.status, 'success');
        assert.ok(continuation.at <= interrupt.at);
        assert.ok(interrupt.at <= continuation.closedAt && continuation.closedAt <= snapshot.at);
        const terminal = snapshot.history.find(assistant);
        assert.ok(terminal, 'partial was on disk when the compaction HTTP request entered the proxy');
        assert.equal(terminal.id, initial.id);
        assert.equal(terminal.isThinking, false);
        assert.notEqual(terminal.isPendingStream, true);
        assert.deepEqual(snapshot.history.map(row => row.role), ['user','assistant']);
        assert.equal(snapshot.history[0].content, fixture.marker);
        assert.deepEqual(saved.slice(0, 2), snapshot.history);
        assert.equal(saved.filter(checkpoint).length, 1);
        assert.equal(saved[2].contextCompaction.checkpoint, fixture.checkpoint);
        assert.equal(saved[2].contextCompaction.sourceCount, snapshot.history.length);
        assert.equal(summary.includesPartial, true);
        assert.equal(resumed.includesInterruptedPrefix, false);
        assert.equal(saved.at(-1).id, resumed.id);
        assert.equal(saved.at(-1).finishReason, 'completed');
        assert.deepEqual(ordinary.counts(out).map(row => row.marker), [fixture.marker]);
        assert.equal(service.requests.filter(row => row.route.endsWith('/session-send')).length, 0);
        assert.equal(stopReceipts().length, 1);
        observation.desktopTerminals = A.events.filter(({event,data}) => event === 'renderer-event'
            && data.channel === 'vcp-stream-event' && ['end','error'].includes(data.type))
            .map(({t,data}) => ({at:t,type:data.type}));
        assert.deepEqual(observation.desktopTerminals.map(row => row.type), ['end','end']);
        const initialWire = service.requests.find(row => row.route === '/v1/chatvcp/completions').streamWire;
        assert.ok(initialWire.closedAt);
        assert.equal(initialWire.toolResults, 1);
        assert.equal(initialWire.toolResultIncluded, true);
        assert.equal(initialWire.toolReturnWrapped, observation.roleDivider);
        assert.ok(initialWire.toolReturnAt <= interrupt.at);
        assert.equal(initialWire.invalidFrame, undefined);
        const toolDB = new DatabaseSync(path.join(out, 'runtime-box/config/tool-call-records.sqlite3'), { readOnly:true });
        try {
            observation.toolRecords = toolDB.prepare('SELECT tool_name, status, success FROM tool_call_records ORDER BY started_at_ms').all();
            assert.deepEqual(observation.toolRecords.map(row => [row.tool_name, row.success]), [[ordinary.name, 1]]);
        } finally { toolDB.close(); }
        const centralDB = new DatabaseSync(path.join(service.data, 'central.sqlite'), { readOnly:true });
        try {
            observation.sharedCounts = Object.fromEntries(['mobile_executions','journal','shared_compaction_intents'].map(table =>
                [table,centralDB.prepare('SELECT COUNT(*) AS count FROM ' + table).get().count]));
            assert.deepEqual(observation.sharedCounts, {mobile_executions:0, journal:0, shared_compaction_intents:0});
        } finally { centralDB.close(); }
        await stop('A');
        const reopened = await start('A-reopened','A');
        await select(reopened);
        await waitUntil(async () => (await transcript(reopened)).includes(fixture.resumedText), 'resumed reply after reopening');
        assert.equal(result.A.profileDigest, result['A-reopened'].profileDigest);
        assert.deepEqual(history(), saved);
        assert.equal(service.calls.length, 4);
        assert.equal(stopReceipts().length, 1);
        assert.deepEqual(ordinary.counts(out).map(row => row.marker), [fixture.marker]);
        const admissionState = JSON.parse(fs.readFileSync(path.join(profiles.A, 'TopicMessageQueue/pending.json'), 'utf8'));
        observation.admissionCounts = { entries:admissionState.entries.length, leases:admissionState.standaloneLeases.length };
        assert.deepEqual(observation.admissionCounts, { entries:0, leases:0 });
        observation.profileReopened = true;
        await picture(reopened, 'checkpoint-reopened');
        assert.equal(terminal.finishReason, 'interrupted', 'the partial must retain the explicit end reason');
        const endFrames = initialWire.framesAfterToolReturn.filter(frame => frame.choiceFinishReason);
        assert.deepEqual(endFrames.map(frame => frame.choiceFinishReason), ['interrupted']);
        assert.match(endFrames[0].id, /^chatcmpl-interrupt-/);
        assert.equal(endFrames[0].text, undefined);
        assert.deepEqual(initialWire.framesAfterToolReturn.at(-1), {type:'done'});
    } finally {
        service.streamInterrupt.releaseTool();
        Object.assign(observation, {history:history(), calls:service.calls, requests:service.requests, counter:ordinary.counts(out)});
    }
};

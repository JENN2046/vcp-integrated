'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const test = require('node:test');
const { fixture, wait, BOX } = require('../native/fixtures/sharedSingleHarness.cjs');
const { envelopeFor } = require(BOX + '/Plugin/NativeSync/sync/metadata');
const { effectiveRequest } = require(BOX + '/Plugin/NativeSync/mobile/effectiveContext');

const readTexts = messages => messages.map(message =>
    typeof message.content === 'string' ? message.content : message.content.map(part => part.text).join(''));

async function probe(t, variant) {
    const f = await fixture(t);
    const actor = f.actor('A');
    const scope = { sharedSpaceId: 'sharedAB', sharedId: f.topic.id };
    const topic = f.shared.topic(actor, scope.sharedSpaceId, scope.sharedId, 'execute');
    const checkpoint = { id: 'checkpoint', role: 'user', content: 'PORTABLE_SUMMARY', timestamp: 2,
        contextCompaction: { kind: 'vchat-context-checkpoint', version: 1, checkpoint: 'PORTABLE_SUMMARY' } };
    const archive = { id: 'archive', role: 'user', timestamp: variant === 'retained-reference' ? 3 : 1,
        content: variant === 'archived-placeholder' ? 'ARCHIVED {{VCPChatCanvas}}' : 'ARCHIVED_BODY' };
    if (variant.endsWith('reference')) archive.desktopReferences = [{
        id: 'synthetic-ref', name: 'synthetic.txt', kind: 'file', index: 0, availability: 'desktop-only',
        target: '/SYNTHETIC-ONLY/synthetic.txt',
    }];
    const rows = variant === 'retained-reference' ? [checkpoint, archive] : [archive, checkpoint];
    for (const message of rows) {
        if (message === checkpoint) {
            const intent = f.shared.compactPrepare(actor, { ...scope, expectedHead:f.shared.head(topic), opId:'review-prepare' });
            const input = f.shared.compactInput(actor, { ...scope, id:intent.id });
            if (variant !== 'retained-reference') assert.ok(input.history.some(row => row.id === archive.id));
            checkpoint.id = intent.messageId;
            const commit = f.shared.compactCommit(actor, { ...scope, id:intent.id, opId:'review-commit', sourceHash:intent.sourceHash, message:checkpoint });
            assert.equal(commit.messageId, checkpoint.id);
            continue;
        }
        const metadata = envelopeFor(message, 1);
        f.store.apply({
            ownerType: topic.owner_type, ownerId: topic.owner_id, topicId: topic.topic_id,
            msgId: message.id, deviceId: actor.principal, opId: 'seed-' + message.id, baseHash: null,
            action: 'upsert', message, ...(metadata ? { metadata } : {}),
        }, { sharedSpace: scope.sharedSpaceId, metadataPublisher: true });
    }

    const message = { id: 'desktop-user', role: 'user', content: 'PORTABLE_CURRENT', timestamp: 4 };
    const selectedTexts = readTexts(await effectiveRequest([...rows, message], { systemPrompt: 'PROMPT' }, message.id));
    assert.equal(selectedTexts.includes(archive.content), variant === 'retained-reference');

    let desktopPreparation;
    if (variant !== 'portable-control') {
        const desktop = await f.desktop('A');
        assert.equal(desktop.runtime.sessions.enabled(), true);
        const mapping = desktop.runtime.execution.mapping(desktop.descriptor);
        const context = await desktop.runtime.sessions.context(desktop.descriptor, mapping);
        assert.deepEqual(context.history.map(m => m.id), rows.map(m => m.id));
        const value = await desktop.runtime.sessions.prepare(desktop.descriptor, message);
        assert.equal(value, null);
        desktopPreparation = 'null; server-session path declined';
    }

    const context = f.shared.executionConfig(actor, scope);
    const response = await fetch(f.url + '/api/v1/sync/shared/session-send', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-nativesync-source': 'sourceA',
            'x-nativesync-device': 'deviceA', 'x-nativesync-space': f.store.sourceCatalog.spaceId,
            'x-nativesync-capabilities': 'shared-space-v1,shared-context-v1,shared-session-v1' },
        body: JSON.stringify({ ...scope, requestId: 'desktop-request', message, expectedHead: context.head,
            configHash: context.hash }),
    });
    const result = await response.json();
    const payloads = [];
    f.control.modelResponse = packet => {
        payloads.push(readTexts(packet.messages));
        return { choices: [{ message: { content: 'SYNTHETIC_REPLY' }, finish_reason: 'stop' }] };
    };

    let id = result.workId;
    let mobileAccepted;
    if (variant === 'portable-control') {
        assert.equal(response.status, 200, JSON.stringify(result));
        assert.ok(id);
    } else {
        assert.equal(response.status, 409, JSON.stringify(result));
        assert.equal(result.error.code, 'DESKTOP_CONTEXT_REQUIRED');
        assert.equal(f.store.metrics().journalRows, 2);
        assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM mobile_executions').get().n, 0);
        const phone = await f.phone();
        const accepted = await phone.call('/conversations/' + f.topic.id + '/messages',
            { requestId: 'mobile-request', text: message.content }, 202);
        id = accepted.id;
        mobileAccepted = 202;
    }
    f.portal.engine.db.prepare('UPDATE mobile_executions SET not_before=0 WHERE id=?').run(id);
    f.portal.engine.setEndpoint({ url: f.url + '/v1/chat/completions', key: 'synthetic-only' });
    await wait(() => ['completed', 'review_required'].includes(f.portal.engine.get(id).state), 'terminal');
    const job = f.portal.engine.get(id);
    const blocked = variant.endsWith('reference');
    assert.equal(job.state, blocked ? 'review_required' : 'completed');
    assert.equal(job.request_dispatched, blocked ? 0 : 1);
    assert.equal(f.calls(), blocked ? 0 : 1);
    if (blocked) assert.equal(job.error_code, 'EXECUTION_INTERRUPTED_REVIEW_REQUIRED');
    else assert.deepEqual(payloads, [['FROZEN_SHARED_PROMPT', 'PORTABLE_SUMMARY', message.content]]);
    const journal = f.store.db.prepare('SELECT msg_id FROM journal WHERE topic_id=? ORDER BY seq').all(topic.topic_id)
        .map(row => row.msg_id);
    assert.deepEqual(journal.slice(0, 2), rows.map(row => row.id));
    return {
        variant, seedOrder: rows.map(row => row.id), selectedTexts, desktopPreparation,
        sessionSend: { status: response.status, error: result.error?.code },
        mobileAccepted, terminal: { state: job.state, dispatched: Boolean(job.request_dispatched), error: job.error_code },
        workerCalls: f.calls(), workerTexts: payloads, journalRows: journal.length,
    };
}

test('shared single portability around the persisted native checkpoint', async t => {
    const cases = ['portable-control', 'archived-placeholder', 'archived-reference', 'retained-reference'];
    const observations = [];
    for (const variant of cases) await t.test(variant, async subtest => observations.push(await probe(subtest, variant)));
    assert.equal(observations.length, cases.length);
    if (process.env.CONTEXT_REVIEW_EVIDENCE) {
        await fs.writeFile(process.env.CONTEXT_REVIEW_EVIDENCE, JSON.stringify({
            environment: 'Local NativeSync CentralStore, runtime client, shared HTTP service and mobile worker on loopback; synthetic model responder',
            revision:require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{cwd:__dirname,encoding:'utf8'}).trim(),
            checkpoint: 'Server prepare/input/commit with a fixed synthetic summary; no summarization model was called.',
            node: process.version, observations,
        }, null, 2) + '\n');
    }
});

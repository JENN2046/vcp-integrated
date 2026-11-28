'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { BOX, coreFixture, localProvider, host, wait } = require('../native/fixtures/coreSingleHarness.cjs');
const recovery = require(BOX + '/Plugin/NativeSync/mobile/submissionRecovery');
const origin = 'https://recovery.example.invalid';
const backend = 'http://toolbox.example.invalid:6005';
const sha = value => createHash('sha256').update(value).digest('hex');
const contextHeaders = context => ({ 'X-NativeSync-Entry-Id': context.entryId, 'X-NativeSync-Session-Marker': context.sessionMarker });

test('recovery fingerprints use canonical original payload, preserve attachment order and separate kind/topic/request identity', () => {
    const input = { topicKey: 'first', kind: 'message', payload: { requestId: 'recovery-request-001', text: '原文\n👋' } };
    const canonical = '{"kind":"message","payload":{"attachments":[],"requestId":"recovery-request-001","text":"原文\\n👋"},"topicKey":"first"}';
    assert.deepEqual(recovery.normalizeSubmission(input), { ...input, payload: { ...input.payload, attachments: [] } });
    assert.equal(recovery.payloadHash(input), sha(canonical));
    assert.equal(recovery.payloadHash(input), recovery.payloadHash({ ...input, payload: { attachments: [], text: input.payload.text, requestId: input.payload.requestId } }));
    const original = recovery.payloadHash(input);
    for (const changed of [
        { ...input, topicKey: 'second' }, { ...input, payload: { ...input.payload, requestId: 'recovery-request-002' } },
        { ...input, payload: { ...input.payload, text: 'different' } }, { topicKey: 'first', kind: 'invitation', payload: { requestId: input.payload.requestId, agentId: 'One' } }
    ]) assert.notEqual(recovery.payloadHash(changed), original);
    assert.notEqual(recovery.payloadHash({ ...input, payload: { ...input.payload, attachments: ['upload-a', 'upload-b'] } }), recovery.payloadHash({ ...input, payload: { ...input.payload, attachments: ['upload-b', 'upload-a'] } }));
    for (const payload of [{ ...input.payload, credentials: 'fixture-key' }, { ...input.payload, attachments: null }, { ...input.payload, requestId: '' }]) assert.throws(() => recovery.payloadHash({ ...input, payload }), /INVALID_RECOVERY_SUBMISSION/);
    assert.equal(recovery.sessionMarker('session-one'), sha('native-sync-mobile-session-v1\0session-one'));
    assert.equal(recovery.entryId(origin, backend), sha('native-sync-mobile-entry-v1\0' + origin + '\0' + backend));
    assert.notEqual(recovery.entryId(origin, backend), recovery.entryId('https://other.example.invalid', backend));
    assert.notEqual(recovery.entryId(origin, backend), recovery.entryId(origin, 'http://other.example.invalid'));
});


test('real Core accepts one mobile submission across a restart and rejects a changed device context', async t => {
    const provider = await localProvider(t);
    const f = await coreFixture(t, host(provider).chat);
    const { route } = await f.define({});
    const owner = await f.mobile();
    const other = await f.mobile();
    const reader = await f.mobile(['read']);
    const path = '/mobile/api' + route + '/send';
    const body = { requestId: 'same-device-request', text: 'Keep one original Work' };
    const request = (headers, payload = body) => f.request(path, { body: payload, headers });
    const valid = { cookie: owner.cookie, ...contextHeaders(owner.identity) };
    const first = await request(valid);
    assert.equal(first.status, 202);
    const accepted = await first.json();
    await wait(() => f.core.store.work(accepted.id)?.status === 'completed', 'original mobile Work');
    await f.restart();
    const replay = await request(valid);
    assert.equal(replay.status, 202);
    assert.equal((await replay.json()).id, accepted.id);

    for (const [headers, status, code] of [
        [contextHeaders(owner.identity), 401, 'PAIR_REQUIRED'],
        [{ ...valid, origin: 'https://other.invalid' }, 403, 'ORIGIN_REJECTED'],
        [{ ...valid, cookie: reader.cookie }, 403, 'CORE_WORKSPACE_FORBIDDEN'],
        [{ ...valid, cookie: other.cookie }, 409, 'SUBMISSION_CONTEXT_CHANGED'],
        [{ cookie: owner.cookie, 'X-NativeSync-Entry-Id': owner.identity.entryId }, 409, 'SUBMISSION_CONTEXT_CHANGED']
    ]) {
        const denied = await request(headers, { ...body, requestId: 'denied-recovery-request' });
        assert.equal(denied.status, status);
        assert.equal((await denied.json()).error.code, code);
    }
    assert.equal(f.core.store.db.prepare('SELECT count(*) n FROM works').get().n, 1);
    assert.equal(provider.calls.length, 1);
});

test('the PWA releases only a verified desktop-only rejection and serializes same-request posts', async () => {
    const {createSubmissionRecovery, restoreRejectedDraft} = await import('../../apps/mobile/src/submissionRecovery.js');
    let saved = null, failWrite = false;
    const tails = new Map();
    const storage = {getItem: () => saved, setItem: (_key, value) => {
        if (failWrite) throw Error('synthetic storage quota');
        saved = value;
    }};
    const locks = {request(name, _options, run) {
        const next = (tails.get(name) || Promise.resolve()).catch(() => {}).then(run);
        tails.set(name, next);
        return next;
    }};
    const session = {version:1, entryId:'a'.repeat(64), sessionMarker:'b'.repeat(64)};
    const first = createSubmissionRecovery({origin, getStorage:() => storage, getLocks:() => locks});
    const otherPage = createSubmissionRecovery({origin, getStorage:() => storage, getLocks:() => locks});
    const record = await first.prepare({...session, topicKey:'core-fixture', kind:'message',
        payload:{requestId:'desktop-only', text:'{{VCPChatCanvas}}', attachments:['ready-upload']}});
    const rejection = {status:409, code:'DESKTOP_CONTEXT_REQUIRED'};
    assert.equal(await first.releaseRejectedMessage(record, {status:409, code:'SHARED_TOPIC_BUSY'}, [], session), false);
    assert.equal(await first.releaseRejectedMessage(record, {code:'NETWORK_UNAVAILABLE'}, [], session), false);
    assert.equal(await first.releaseRejectedMessage(record, rejection, [], {...session, sessionMarker:'c'.repeat(64)}), false);
    assert.equal(await first.releaseRejectedMessage(record, rejection, undefined, session), false);
    const prior = {id:'accepted-earlier', state:'queued', topicKey:record.topicKey, requestId:record.requestId,
        recovery:{version:1, kind:record.kind, payloadHash:record.payloadHash, sessionMarker:session.sessionMarker}};
    assert.equal(await first.releaseRejectedMessage(record, rejection, [prior], session), false);
    assert.deepEqual(first.current(record), record);
    failWrite = true;
    await assert.rejects(first.releaseRejectedMessage(record, rejection, [], session), {code:'SUBMISSION_STORE_UNAVAILABLE'});
    failWrite = false;
    assert.deepEqual(otherPage.current(record), record);
    assert.equal(otherPage.rejectedDraft(record), null);

    let settle;
    const waitForResponse = new Promise(resolve => { settle = resolve; });
    const answer = first.withSendLock(record, async () => {
        await waitForResponse;
        return first.releaseRejectedMessage(record, rejection, [], session);
    });
    const queuedRetry = otherPage.withSendLock(record, () => assert.fail('released request posted again'));
    const stopped = assert.rejects(queuedRetry, {code:'SUBMISSION_RECORD_CHANGED'});
    settle();
    const releasedDraft = await answer;
    assert.equal(releasedDraft.requestId, record.requestId);
    await stopped;
    assert.equal(first.current(record), null);
    const restored = otherPage.rejectedDraft({...session, topicKey:record.topicKey});
    assert.equal(restored.text, record.payload.text);
    assert.deepEqual(restored.attachments, ['ready-upload']);
    assert.equal(otherPage.rejectedDraft({...session, topicKey:'other'}), null);
    assert.equal(otherPage.rejectedDraft({...session, entryId:'c'.repeat(64), topicKey:record.topicKey}), null);
    assert.equal(otherPage.rejectedDraft({...session, sessionMarker:'c'.repeat(64), topicKey:record.topicKey}), null);
    const file = {uploadId:'ready-upload', file:{name:'original.txt'}};
    const liveDraft = {text:'already edited', revision:2, files:[file], submitted:{requestId:record.requestId}};
    restoreRejectedDraft(liveDraft, record);
    assert.deepEqual(liveDraft, {text:'already edited', revision:2, files:[file]});
    const reloadedDraft = {text:'', revision:0, files:[]};
    restoreRejectedDraft(reloadedDraft, record);
    assert.equal(reloadedDraft.text, record.payload.text);
    assert.deepEqual(reloadedDraft.files, [{uploadId:'ready-upload', uploadSessionMarker:session.sessionMarker, progress:100, error:''}]);
    const editedDraft = await first.updateRejectedDraft(restored, {text:'edited text', attachments:['ready-upload']});
    assert.deepEqual(otherPage.rejectedDraft(record), editedDraft);
    await assert.rejects(otherPage.updateRejectedDraft(restored, {text:'stale other tab', attachments:[]}), {code:'SUBMISSION_RECORD_CHANGED'});
    const edited = await first.prepare({...session, topicKey:record.topicKey, kind:record.kind, rejected:editedDraft,
        payload:{requestId:'edited-request', text:'edited text', attachments:reloadedDraft.files.map(item => item.uploadId)}});
    assert.deepEqual(edited.payload.attachments, ['ready-upload']);
    assert.deepEqual(otherPage.current(record), edited);
    assert.deepEqual(otherPage.rejectedDraft(record), editedDraft);
    assert.equal((await otherPage.inspect(edited, [], session)).state, 'absent');
    assert.deepEqual(otherPage.current(record), edited);
    assert.deepEqual(otherPage.rejectedDraft(record), editedDraft);
    const accepted = {...prior, id:'accepted-edit', requestId:edited.requestId,
        recovery:{...prior.recovery, payloadHash:edited.payloadHash}};
    const newerDraft = await otherPage.updateRejectedDraft(editedDraft, {text:'newer unsent edit', attachments:[]});
    await otherPage.confirm(edited, accepted, session);
    assert.equal(first.current(record), null);
    assert.deepEqual(first.rejectedDraft(record), newerDraft);
    const final = await first.prepare({...session, topicKey:record.topicKey, kind:record.kind, rejected:newerDraft,
        payload:{requestId:'newest-request', text:newerDraft.text, attachments:newerDraft.attachments}});
    await otherPage.confirm(final, {...accepted, id:'accepted-newest', requestId:final.requestId,
        recovery:{...accepted.recovery, payloadHash:final.payloadHash}}, session);
    assert.equal(first.current(record), null);
    assert.equal(first.rejectedDraft(record), null);
});

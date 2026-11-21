'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./fixture.cjs');
const tool = require('../ordinary-tools/fixture.cjs');

const text = row => Array.isArray(row.content)
    ? row.content.filter(part => part.type === 'text').map(part => part.text).join('')
    : row.content;
const marker = 'COMPACT_DESKTOP_CHECKPOINT';

module.exports = async ({
    out,result,service,picture,click,evalJs,waitUntil,start,stop,profiles,sha,select,db,
    works,journal,intents,prior,compacted,originalJournal,checkpoint,
}) => {
    const descriptor = service.descriptors.B.preSubmit;
    const historyPath = path.join(profiles.B, 'UserData', descriptor.itemId, 'topics', descriptor.topicId, 'history.json');
    const history = () => JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    const calls = () => service.calls.filter(row => row.ordinaryCase === fixture.toolInput);
    const card = client => waitUntil(() => evalJs(client,
        'document.querySelector(".vcp-context-checkpoint")?.checkVisibility()'), 'B sees the shared checkpoint');
    const verified = result.crossDevice = {
        revision:execFileSync('git', ['rev-parse','HEAD'], {cwd:result.candidate,encoding:'utf8'}).trim(),
        aExitedBeforeBReopened:result.exits.A.code === 0,
        originalBProfileReused:true,
        skewedPrefix: { id:prior.at(-1).id, timestamp:prior.at(-1).timestamp, checkpointTimestamp:checkpoint.timestamp },
    };
    const B = await start('B-reopened', 'B');
    assert.equal(result.B.profileDigest, result['B-reopened'].profileDigest);
    await select(B, descriptor);
    await waitUntil(() => history().some(row => row.id === checkpoint.id), 'B projected A checkpoint into its own History');
    assert.deepEqual(history(), compacted);
    await card(B);
    await picture(B, 'B-reopened-with-A-checkpoint');

    await evalJs(B, `(() => {
        const input = document.querySelector('#messageInput');
        input.focus();
        input.value = ${JSON.stringify(fixture.toolInput)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await click(B, '#sendMessageBtn');
    const posts = () => service.requests.filter(row => row.route.endsWith('/session-send') &&
        row.body?.message?.content === fixture.toolInput);
    const lost = await waitUntil(() => posts().find(row => row.dropped), 'B accepted send receipt cut at the proxy');
    assert.equal(lost.device, 'deviceB');
    assert.ok(lost.status >= 200 && lost.status < 300);
    const { requestId } = lost.body;
    const { workId } = lost.response;
    verified.lostReceipt = { status:lost.status, requestId, workId, device:lost.device, dropped:true };
    const ledgerPath = path.join(profiles.B, '.native-sync', 'shared', 'sharedAB', 'session-records',
        createHash('sha256').update(requestId).digest('hex') + '.json');
    const ledger = () => fs.existsSync(ledgerPath) && JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).record;
    await waitUntil(() => ledger()?.admitStarted && !ledger()?.accepted?.id, 'B leaves durable unconfirmed intent');
    assert.equal(ledger().body.requestId, requestId);
    assert.equal(ledger().localMessage.content, fixture.toolInput);
    verified.durablePending = { requestId, phase:ledger().phase, message:ledger().localMessage.content,
        admitStarted:ledger().admitStarted, acceptedId:null };
    const failure = await waitUntil(() => B.events.find(row => row.event === 'ipc-result' &&
        row.data.channel === 'native-sync:prepare-send' && row.data.error === 'NETWORK_UNAVAILABLE'), 'B composer sees a lost receipt');
    verified.composerFailure = failure.data.error;

    await waitUntil(() => works().some(row => row.id === workId && row.state === 'completed'), 'original Work completed while its receipt was unavailable');
    const providerViews = calls().map(({ ordinaryPhase, hasToolResult, messages }) => ({ ordinaryPhase, hasToolResult, messages }));
    verified.provider = providerViews;
    verified.workBeforeRecovery = works();
    verified.toolBeforeRecovery = tool.counts(out);
    assert.deepEqual(providerViews.map(row => [row.ordinaryPhase,row.hasToolResult]),
        [['tool-request',false],['continuation',true]]);
    assert.equal(verified.toolBeforeRecovery.length, 1);
    await waitUntil(() => evalJs(B, 'document.querySelector(".native-sync-local-recovery")?.checkVisibility()'),
        'B shows the unresolved receipt in the composer');
    await picture(B, 'B-receipt-lost-after-tool');

    await stop('B-reopened');
    service.disarmDrop();
    const recoveredClient = await start('B-recovered', 'B');
    assert.equal(result.B.profileDigest, result['B-recovered'].profileDigest);
    await select(recoveredClient, descriptor);
    await waitUntil(() => ledger()?.accepted?.id === workId, 'B recovers original accepted Work', 18000);
    const recovery = service.requests.find(row => row.route.endsWith('/shared/request') &&
        row.query?.requestId === requestId && row.status === 200 && !row.injected);
    assert.ok(recovery);
    assert.equal(recovery.device, 'deviceB');
    assert.deepEqual(recovery.response.request, { id:workId, requestId, state:'completed' });
    verified.recovery = { requestId, workId:ledger().accepted.id, status:recovery.status, device:recovery.device,
        response:recovery.response.request };

    const work = await waitUntil(() => works().find(row => row.id === workId && row.state === 'completed'), 'original Work completed');
    const turnIds = [work.user_message_id, work.reply_message_id];
    const saved = await waitUntil(() => {
        const rows = history();
        return turnIds.every(id => rows.some(row => row.id === id)) && rows;
    }, 'B persisted the original Work reply');
    assert.ok(text(saved.find(row => row.id === work.reply_message_id)).endsWith(tool.finalText));
    assert.deepEqual(saved.filter(row => !turnIds.includes(row.id)), compacted);
    assert.deepEqual(journal().slice(0, originalJournal.length), originalJournal);
    assert.deepEqual(journal().slice(originalJournal.length).map(row => row.msg_id),
        [checkpoint.id, ...turnIds]);
    assert.equal(intents().length, 1);
    assert.equal(works().length, 1);
    assert.equal(work.request_id, requestId);
    assert.equal(work.attempts, 1);
    assert.equal(work.request_dispatched, 1);
    assert.equal(posts().length, 1);
    assert.equal(calls().length, 2);
    assert.deepEqual(tool.counts(out), verified.toolBeforeRecovery);
    assert.equal(tool.counts(out)[0].marker, fixture.toolInput);
    const admission = db.prepare('SELECT id, request_id, principal, state, dispatched, native_terminal FROM shared_admissions WHERE id=?').get(workId);
    assert.equal(admission.principal, 'desktop:deviceB');
    assert.equal(admission.request_id, requestId);
    assert.equal(admission.dispatched, 1);
    assert.equal(admission.native_terminal, 1);
    const native = db.prepare('SELECT id, admission_id, state FROM shared_native_requests WHERE admission_id=?').all(workId);
    const invocations = db.prepare('SELECT invocation_id, execution_id, native_request_id, plugin_name, state FROM mobile_native_invocations WHERE execution_id=?').all(workId);
    assert.equal(native.length, 1);
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].native_request_id, native[0].id);
    assert.equal(invocations[0].plugin_name, tool.name);
    assert.equal(invocations[0].state, 'returned');
    Object.assign(verified, { admission, native, invocations });
    verified.work = work;
    verified.history = saved.map(({id,role,content}) => ({id,role,content}));
    verified.journal = journal().map(({seq,msg_id,action,hash}) => ({seq,msg_id,action,hash}));
    verified.sendPosts = posts().length;
    verified.toolInvocations = tool.counts(out);
    const loaded = await recoveredClient.command('loaded-sources', {
        main:[
            'apps/desktop/modules/services/nativeSync/sharedRuntime.js',
            'apps/desktop/modules/services/nativeSync/sharedSessionClient.js',
            'apps/desktop/modules/services/historyAuthority.js',
            'apps/desktop/modules/ipc/nativeHistoryHandlers.js',
        ],
        renderer:['apps/desktop/modules/renderer/mainChatSendOwner.js'],
    });
    assert.equal(loaded.main.length, 4);
    assert.equal(loaded.renderer.length, 1);
    for (const source of [...loaded.main, ...loaded.renderer]) assert.equal(source.sha256, sha(path.join(result.candidate, source.file)));
    verified.loaded = loaded;

    const captured = fs.readFileSync(fixture.capturePath(out), 'utf8').trim().split('\n').map(JSON.parse);
    const handlers = captured.filter(row => row.kind === 'handler-input');
    assert.equal(handlers.length, 1);
    assert.equal(handlers[0].workId, workId);
    assert.equal(handlers[0].requestId, verified.native[0].id);
    const selection = captured.find(row => row.kind === 'checkpoint-selection' && row.beforeIds.includes(work.user_message_id));
    assert.ok(selection, 'observed the loaded native history window');
    const nativeWindow = 'apps/desktop/modules/chat/historyWindow/index.mjs';
    assert.ok(selection.module.endsWith(nativeWindow));
    assert.equal(selection.sha256, sha(path.join(result.candidate, nativeWindow)));
    verified.selection = { ...selection, module:nativeWindow };
    verified.handler = { route:handlers[0].route, workId, messages:handlers[0].messages };
    const compactedText = [...prior.map(text), ...fixture.replies];
    verified.windowChecks = [];
    for (const [stage, messages] of [['handler',handlers[0].messages],
        ...providerViews.map(row => [row.ordinaryPhase,row.messages])]) {
        const contents = messages.map(text);
        verified.windowChecks.push({
            stage, checkpointCount:contents.join('\n').split(marker).length - 1,
            leakedCompactedText:[...new Set(compactedText.filter(value => contents.some(content => content?.includes(value))))],
            hasNewInput:contents.some(content => content?.includes(fixture.toolInput)),
        });
    }
    await waitUntil(() => evalJs(recoveredClient, `(() => {
        const messages = document.querySelector('#chatMessages');
        const rendered = new Set([...messages.querySelectorAll('[data-message-id]')].map(row => row.dataset.messageId));
        return ${JSON.stringify([checkpoint.id, ...turnIds])}.every(id => rendered.has(id)) &&
            messages.querySelector('.vcp-context-checkpoint')?.checkVisibility() &&
            messages.innerText.includes(${JSON.stringify(tool.finalText)}) &&
            !document.body.innerText.includes('HISTORY_AUTHORITY_PENDING') &&
            document.querySelector('.native-sync-local-recovery')?.hidden;
    })()`), 'B renders checkpoint, user input and original reply after automatic recovery', 18000);
    verified.recoveredUi = { messageIds:[checkpoint.id, ...turnIds], pendingHistoryError:false, pendingReceipt:false };
    await picture(recoveredClient, 'B-recovered-original-work');
    for (const { stage, checkpointCount, leakedCompactedText, hasNewInput } of verified.windowChecks) {
        assert.equal(checkpointCount, 1, stage + ' checkpoint appears exactly once');
        assert.deepEqual(leakedCompactedText, [], stage + ' excludes compressed text');
        assert.ok(hasNewInput, stage + ' retains B input');
    }
    assert.deepEqual(selection.afterIds, [checkpoint.id, work.user_message_id]);
};

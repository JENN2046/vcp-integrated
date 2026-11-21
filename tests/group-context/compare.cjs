'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { sha256 } = require('./shared-fixture.cjs');
const spec = require('./input.json');
const { stable } = require('../../apps/server/Plugin/NativeSync/sync/protocol');

const [before, after] = process.argv.slice(2).map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
assert.ok(before && after, 'Supply the baseline and candidate evidence paths');
assert.equal(before.variant, 'baseline');
assert.equal(after.variant, 'candidate');

const textOf = ({ content }) => typeof content === 'string' ? content : content.filter(part => part.type === 'text').map(part => part.text).join('\n');
const marker = row => textOf(row).match(/GC_[A-Z0-9_]+/)?.[0];
const abbreviations = {
    GC_MEMBER_A: 'system prompt A', GC_MEMBER_B: 'system prompt B', GC_HISTORY_USER: 'old user + attachment',
    GC_HISTORY_ASSISTANT: 'old assistant', GC_HISTORY_SYSTEM: 'old system', GC_DEPTH_INJECTION: 'depth 4',
    GC_CURRENT: 'current user', GC_INVITATION: 'invitation', GC_REPLY_A_UNIQUE: 'committed A',
};
const members = ['A', 'B'];
const seedIds = spec.history.map(row => row.id);
const diskHistoryText = [...spec.history.map(row => row.content), spec.input, spec.replyA, spec.replyB];
const normalizedMessageId = (id, ids) => ({
    [ids.input]: 'fixture-current-user', [ids.replyA]: 'fixture-reply-a', [ids.replyB]: 'fixture-reply-b',
})[id] || id;

function expectedOrder(member, legacy) {
    const a = member === 'A', prompt = 'GC_MEMBER_' + member;
    const [user, assistant, system] = spec.history.map(row => row.content);
    const depth = 'GC_DEPTH_INJECTION', current = 'GC_CURRENT', invite = 'GC_INVITATION';
    const history = legacy
        ? (a ? [user, depth, assistant, system] : [user, assistant, depth, system])
        : (a ? [system, depth, user, assistant] : [system, user, depth, assistant]);
    return [prompt, ...history, current, ...(!a ? [spec.replyA] : []), invite];
}

function normalizeBody(body, ids, member, transport = false) {
    const copy = structuredClone(body);
    for (const key of ['messageId', 'requestId']) {
        if (copy[key]) copy[key] = 'fixture-request-' + member.toLowerCase();
    }
    const label = /file:\/\/\/tmp\/vcp-group-context-native-[^/]+\/profile\/UserData\/attachments\/[0-9a-f]+\.txt/;
    for (const row of copy.messages) {
        if (marker(row) === 'GC_HISTORY_USER') {
            for (const part of row.content) if (part.type === 'text') part.text = part.text.replace(label, spec.attachment.name);
        }
    }
    const ext = copy.vcpchatExtensions;
    if (ext) {
        if (ext.requestContext) {
            const ctx = ext.requestContext;
            assert.equal(ctx.requestId, ids.requests[member]);
            assert.equal(ctx.agentId, ids.members[member]);
            assert.equal(ctx.topicId, ids.topic);
            ctx.requestId = 'fixture-request-' + member.toLowerCase();
            ctx.agentId = spec.speakers[members.indexOf(member)].id;
            ctx.topicId = 'fixture-group-topic';
        }
        for (const binding of ext.messageTimestampBindings) {
            binding.messageId = normalizedMessageId(binding.messageId, ids);
            if (['fixture-current-user', 'fixture-reply-a'].includes(binding.messageId)) {
                binding.timestamp = binding.messageId === 'fixture-current-user' ? 1 : 2;
                binding.timestampIso = new Date(binding.timestamp).toISOString();
            }
            binding.sentMessageHash = 'sha256:' + sha256(textOf(copy.messages[binding.sentMessageIndex]));
        }
    }
    if (transport) {
        delete copy.messageId;
        delete copy.requestId;
        if (ext) delete ext.requestContext;
    }
    return copy;
}

function reorder(body, order) {
    const copy = structuredClone(body);
    const oldOrder = copy.messages.map(marker);
    copy.messages = order.map(name => copy.messages[oldOrder.indexOf(name)]);
    const ext = copy.vcpchatExtensions;
    if (ext) {
        for (const binding of ext.messageTimestampBindings) {
            binding.sentMessageIndex = order.indexOf(oldOrder[binding.sentMessageIndex]);
        }
        ext.messageTimestampBindings.sort((a, b) => a.sentMessageIndex - b.sentMessageIndex);
    }
    return copy;
}

function verifyBindings(packet, history, member) {
    const { messages, vcpchatExtensions: ext } = packet;
    const prefix = history.slice(0, member === 'A' ? 4 : 5);
    const bindings = ext.messageTimestampBindings;
    const idByMarker = new Map(prefix.map(row => [marker(row), row.id]));
    const expected = messages.map((row, index) => [index, idByMarker.get(marker(row))]).filter(([, id]) => id);
    assert.deepEqual(bindings.map(row => [row.sentMessageIndex, row.messageId]), expected);
    assert.equal(ext.schemaVersion, 1);
    assert.equal(ext.messageMetadataMode, 'hash_only');
    for (const binding of bindings) {
        const row = prefix.find(item => item.id === binding.messageId);
        const sent = messages[binding.sentMessageIndex];
        assert.equal(binding.timestamp, row.timestamp);
        assert.equal(binding.timestampIso, new Date(row.timestamp).toISOString());
        assert.equal(binding.role, sent.role);
        assert.equal(binding.role, row.role);
        assert.equal(binding.source, 'client_history');
        assert.equal(binding.sentMessageHash, 'sha256:' + sha256(textOf(sent)));
    }
}

function verifyRun(evidence) {
    const { native, shared } = evidence;
    const isBaseline = evidence.variant === 'baseline';
    const { journal, steps, nativeRequests, work, admission, phases, mobile } = shared;
    assert.ok(native.renderer.sandbox && native.terminalVisible && mobile.terminalVisible);
    assert.deepEqual(shared.planForNative, spec.plan);
    assert.deepEqual(native.configuredPlan.speakerOrder, spec.plan);
    assert.equal(native.configuredPlan.mode, 'sequential');
    assert.deepEqual(work.plan, spec.plan.map(id => shared.memberIds[id]));
    assert.deepEqual(shared.savedOrder, work.plan);
    assert.deepEqual(admission.turn.plan, work.plan);
    assert.equal(admission.turn.userMessageId, work.user_message_id);
    assert.equal(admission.state, 'completed');
    assert.equal(admission.id, work.id);
    assert.equal(admission.dispatched, 1);
    assert.equal(admission.native_terminal, 1);
    assert.equal(work.group_position, 2);
    assert.equal(work.reply_message_id, steps[1].reply_message_id);
    assert.equal(journal.at(-1).seq, admission.reply_seq);
    assert.equal(journal[3].seq, work.user_seq);
    assert.equal(admission.context_head, journal[2].seq);
    const sharedHistory = journal.map(row => row.message);
    assert.deepEqual(sharedHistory.map(row => row.content), diskHistoryText);
    assert.deepEqual(native.history.map(row => row.content), diskHistoryText);
    assert.deepEqual(journal.map(row => row.msg_id), [...seedIds, work.user_message_id, ...steps.map(step => step.reply_message_id)]);
    assert.deepEqual(native.history.map(row => row.id), [...seedIds, native.inputId, ...native.replyIds]);
    assert.ok(journal.every(row => row.action === 'upsert' && row.message.id === row.msg_id));
    assert.deepEqual(steps.map(row => row.agent_id), work.plan);
    assert.deepEqual(steps.map(row => [row.step_index, row.state, row.attempts, row.error_code]), [
        [0, 'completed', 1, null], [1, 'completed', 1, null],
    ]);
    assert.equal(mobile.first.status, 202);
    assert.equal(mobile.first.id, work.id);
    assert.equal(mobile.first.replayed, false);
    assert.equal(mobile.lookup.id, work.id);
    assert.deepEqual(mobile.replay, { status: 202, id: work.id, state: work.state, replayed: true });
    assert.ok(mobile.sameLedgerAndPackets);
    assert.equal(native.attachment.sha256, shared.attachment.sha256);
    assert.equal(native.attachment.sha256, sha256(spec.attachment.text));
    assert.equal(native.attachment.bytes, 22);
    assert.equal(shared.attachment.bytes, 22);
    assert.equal(shared.attachment.boundBlobHash, shared.attachment.sha256);
    const { dispatch } = native;
    assert.deepEqual(dispatch.map(row => row.kind), ['group-send-ipc', 'dispatch', 'dispatch']);
    assert.equal(dispatch[0].inputId, native.inputId);
    assert.deepEqual(dispatch[0].content, { text: spec.input });
    const ids = {
        shared: { input: work.user_message_id, replyA: steps[0].reply_message_id, replyB: steps[1].reply_message_id,
            requests: { A: steps[0].id, B: steps[1].id }, members: { A: work.plan[0], B: work.plan[1] }, topic: shared.topicId },
        native: { input: native.inputId, replyA: native.replyIds[0], replyB: native.replyIds[1] },
    };
    const rules = evidence.handler.filter(row => row.kind === 'worker-rules');
    assert.equal(rules.filter(row => row.method === 'applyContextInject').length, 2);
    const workerHelpers = rules.filter(row => row.method === 'applyGroupContextRules');
    const desktopHelper = native.coverage.find(row => row.file === 'packages/core-rules/group/groupContextWindow.js')
        .hitFunctions.find(row => row.name === 'applyGroupContextRules');
    assert.equal(workerHelpers.length, isBaseline ? 0 : 2);
    assert.equal(desktopHelper?.count ?? 0, isBaseline ? 0 : 2);
    if (!isBaseline) {
        const source = native.sources.main.find(row => row.file === 'packages/core-rules/group/groupContextWindow.js');
        assert.ok(workerHelpers.every(row => row.sha256 === source.sha256));
    }
    const packets = evidence.handler.filter(row => row.kind === 'handler');
    assert.deepEqual(packets.map(row => row.member), ['A', 'B', 'A', 'B']);
    assert.deepEqual(evidence.provider.map(row => row.member), ['A', 'B', 'A', 'B']);
    const result = { shared: {}, native: {} };
    for (const [index, packet] of packets.entries()) {
        const member = packet.member;
        const lane = index < 2 ? 'shared' : 'native';
        const provider = evidence.provider[index];
        const body = packet.body;
        const history = lane === 'shared' ? sharedHistory : native.history;
        assert.equal(packet.route, '/v1/chat/completions');
        assert.equal(provider.route, packet.route);
        assert.equal(packet.workId, lane === 'shared' ? work.id : null);
        const { vcpchatExtensions, ...expectedProvider } = structuredClone(body);
        assert.equal(expectedProvider.messages.at(-1).name, '用户');
        delete expectedProvider.messages.at(-1).name;
        assert.deepEqual(provider.body, expectedProvider);
        assert.deepEqual(body.messages.map(marker), expectedOrder(member, isBaseline && lane === 'shared'));
        verifyBindings(body, history, member);
        assert.equal(body.messages.filter(row => textOf(row).includes(spec.replyA)).length, member === 'A' ? 0 : 1);
        assert.ok(textOf(body.messages[0]).endsWith('GC_SYSTEM_SUFFIX'));
        assert.ok(textOf(body.messages.find(row => marker(row) === 'GC_CURRENT')).endsWith('GC_USER_SUFFIX'));
        assert.ok(textOf(body.messages.find(row => marker(row) === 'GC_HISTORY_USER')).includes(spec.attachment.text));
        assert.equal(textOf(body.messages.at(-1)), 'GC_INVITATION Fixture ' + member);
        assert.deepEqual([body.model, body.temperature, body.max_tokens, body.stream], ['synthetic', 0.5, 128, true]);
        if (lane === 'shared') {
            assert.equal(body.requestId, steps[index].id);
            assert.deepEqual([nativeRequests[index].id, nativeRequests[index].member_id, nativeRequests[index].ordinal,
                nativeRequests[index].state], [body.requestId, steps[index].agent_id, index, 'model_terminal']);
            assert.equal(nativeRequests[index].body_hash, sha256(stable(body)));
            assert.deepEqual(phases.filter(row => row.request_id === body.requestId).map(row => row.stage),
                ['native_prepared', 'native_entered', 'provider_attempt', 'native_settled']);
            assert.deepEqual(provider.committedJournal.map(row => row.id), history.slice(0, 4 + index).map(row => row.id));
            const reply = history[4 + index];
            assert.deepEqual(reply.continuity, { version: 1, known: true, requestId: body.requestId, executionId: work.id,
                dependsOnMessageIds: history.slice(0, 4 + index).map(row => row.id) });
        } else {
            const sent = dispatch[index - 1];
            assert.deepEqual(sent.body, body);
            assert.equal(body.messageId, native.replyIds[index - 2]);
            assert.equal(sent.committed.filter(row => row.id === native.replyIds[0] && row.content === spec.replyA).length, index - 2);
        }
        result[lane][member] = {
            handler: normalizeBody(body, ids[lane], member),
            provider: normalizeBody(provider.body, ids[lane], member),
            commonHandler: normalizeBody(body, ids[lane], member, true),
            commonProvider: normalizeBody(provider.body, ids[lane], member, true),
            order: body.messages.map(marker),
        };
    }
    return result;
}

const baseline = verifyRun(before);
const candidate = verifyRun(after);
const summary = {};
for (const member of members) {
    const newer = candidate.shared[member];
    const older = baseline.shared[member];
    for (const key of ['handler', 'provider']) {
        assert.deepEqual(baseline.native[member][key], candidate.native[member][key]);
        assert.notDeepEqual(older.order, newer.order);
        assert.deepEqual(reorder(older[key], newer.order), newer[key]);
    }
    for (const key of ['commonHandler', 'commonProvider']) {
        assert.deepEqual(candidate.native[member][key], newer[key]);
    }
    const readable = order => order.map(token => abbreviations[token]);
    summary[member] = { nativeBeforeAndAfter: readable(candidate.native[member].order), sharedBefore: readable(older.order), sharedAfter: readable(newer.order) };
}
console.log(JSON.stringify({
    status: 'PASS', orders: summary,
    normalizedNativeHandlerAndProviderBodiesUnchanged: true,
    sharedHandlerAndProviderOnlyReorderedWithBindingIndexes: true,
    candidateCommonHandlerAndProviderBodiesMatch: true,
    verifiedPerRun: { handlerBodies: 4, providerBodies: 4, sharedWorks: 1, sharedMemberAttempts: [1, 1],
        sharedJournalRows: 6, sameWorkReplay: true, committedAOnceInB: true, candidateOwnerSourceSha256Matches: true },
    observedTransportDifferences: { nativeRequestField: 'messageId', sharedRequestField: 'requestId',
        requestContextOnlyInSharedHandler: true, attachmentHeader: ['native file URI', 'shared filename'],
        invitationNameRemovedByToolBoxBeforeProviderOnBothPaths: true },
}, null, 2));

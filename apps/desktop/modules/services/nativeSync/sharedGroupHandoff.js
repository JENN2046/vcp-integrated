'use strict';

const { fail, sha256, messageHash, messageKey, wireTopic } = require('./protocol');
const capability = 'group-member-handoff-v1';
const planCapability = 'group-member-handoff-v2';
const isMode = mode => mode === planCapability || mode === capability;
const endpoint = '/api/v1/sync/shared/';
const settled = new Set(['completed', 'abandoned']);
const rejected = new Set([
    'CONTROLLED_TEXT_PORTABLE_REQUIRED', 'INVALID_SHARED_SUBMISSION',
    'SHARED_CLIENT_UPGRADE_REQUIRED', 'SHARED_GROUP_HANDOFF_UNSUPPORTED',
]);

function enabled(runtime) {
    return runtime.capabilities.features?.some(isMode) === true;
}

function startMode(runtime, config) {
    const features = runtime.capabilities.features || [];
    if (config?.mode !== 'sequential' || !config.members?.length) return null;
    if (features.includes(planCapability)) return planCapability;
    return features.includes(capability) && config.members.length === 2 ? capability : null;
}

function confirmedReplies(request) {
    const control = request.groupHandoff;
    if (!control) return [];
    if (request.turn.controlMode === planCapability) return control.confirmedReplies || [];
    if (!control.firstReplySeq) return [];
    return request.replySeq > control.firstReplySeq ? [control.firstReplySeq, request.replySeq] : [control.firstReplySeq];
}

function executor(runtime) {
    return 'desktop:' + runtime.connection.deviceId;
}

function canDispatch(request, ordinal) {
    const native = request.nativeRequests?.find(step => step.ordinal === ordinal);
    return Number.isSafeInteger(ordinal) && ordinal >= 0 && ordinal < request.turn?.plan?.length
        && request.groupHandoff?.state === (ordinal === 0 ? 'first_member' : 'continuing')
        && request.groupHandoff.nextOrdinal === ordinal
        && (!native || native.state === 'prepared');
}

function pathFor(runtime, route, scope) {
    return endpoint + route + '?' + new URLSearchParams({ sharedSpaceId: runtime.connection.sharedSpaceId, ...scope });
}

async function readWork(runtime, mapping, workId) {
    const route = workId ? pathFor(runtime, 'work', { workId }) : pathFor(runtime, 'active', { sharedId: mapping.sharedId });
    const { request } = await runtime.send(route);
    if (request && request.sharedId !== mapping.sharedId) throw fail('SHARED_REQUEST_NOT_FOUND');
    return request;
}

function localRecord(execution, mapping, workId) {
    return Object.values(execution.state.requests).find(record => record.sharedId === mapping.sharedId
        && isMode(record.body?.controlMode) && (!workId || record.accepted?.id === workId)
        && (workId || !settled.has(record.phase) && !(record.phase === 'local_pending' && record.rejected)));
}

async function observe(execution, mapping, { refresh, connection }) {
    const runtime = execution.runtime;
    const access = runtime.accessController?.signal;
    const denied = () => runtime.backgroundDenied || access?.aborted;
    if (denied() || !enabled(runtime) || mapping.local.itemType !== 'group') return null;
    execution.groupHandoffObserved ||= new Map();
    const observed = execution.groupHandoffObserved;
    const cached = observed.get(mapping.sharedId);
    const pending = localRecord(execution, mapping);
    const latest = pending?.accepted ?? Object.values(execution.state.requests)
        .filter(record => record.sharedId === mapping.sharedId && record.accepted?.groupHandoff)
        .sort((a, b) => b.accepted.userSeq - a.accepted.userSeq)[0]?.accepted;
    let request = cached ? cached.request : latest;
    let fresh = connection === 'online' && cached?.confirmed === true;
    if (refresh && connection === 'online') {
        try {
            let active = await readWork(runtime, mapping);
            if (denied()) return null;
            if (!active && (request?.id || latest?.id)) {
                active = await readWork(runtime, mapping, request?.id || latest.id);
                if (denied()) return null;
            }
            request = active?.groupHandoff ? active : null;
            observed.set(mapping.sharedId, { request, confirmed: true });
            fresh = true;
        } catch {
            if (denied()) return null;
            fresh = false;
            observed.set(mapping.sharedId, { request, confirmed: false });
        }
    }
    if (!request) {
        if (pending && !pending.accepted) {
            return { state: 'submission_unconfirmed', canRetryFirst: fresh, inputId: pending.body.requestId };
        }
        return null;
    }
    const control = request.groupHandoff;
    const mode = request.turn.controlMode;
    const { nextOrdinal } = control;
    const owned = control.executor === executor(runtime);
    const live = execution.liveGroups.has(request.id);
    const unknown = request.nativeRequests?.find(step => step.state === 'unknown');
    const member = unknown && localRecord(execution, mapping, request.id)?.config?.members
        ?.find(entry => entry.id === unknown.memberId);
    // Closing the Work does not resolve the original member request.
    const reviewing = !settled.has(request.state) && (request.state === 'review_required' || unknown
        || owned && !live && request.nativeRequests?.some(step =>
            ['dispatched', 'model_terminal'].includes(step.state) && step.ordinal === control.nextOrdinal));
    return {
        id: request.id,
        requestId: request.requestId,
        state: reviewing ? 'review_required' : control.state,
        executor: control.executor,
        executorVersion: control.executorVersion,
        owned,
        fresh,
        nextRequestId: control.nextRequestId,
        mode,
        nextOrdinal,
        memberCount: request.turn.plan.length,
        confirmedCount: confirmedReplies(request).length,
        previousReplySeq: control.previousReplySeq ?? control.firstReplySeq,
        ...(unknown && Number.isSafeInteger(unknown.ordinal) && unknown.ordinal >= 0 && unknown.ordinal < request.turn.plan.length && { unknownMember: { ordinal: unknown.ordinal, name: member?.config?.name } }),
        canRetryFirst: fresh && owned && !live && canDispatch(request, 0)
            && Boolean(localRecord(execution, mapping, request.id) || !pending?.accepted && pending?.body.requestId === request.requestId),
        canHandoff: fresh && !owned && !reviewing && control.state === 'awaiting_handoff',
        canContinue: fresh && owned && !live && !reviewing && nextOrdinal > 0 && (control.state === 'awaiting_continue' || canDispatch(request, nextOrdinal)),
    };
}

function assertReplyPrefix(runtime, mapping, request, rows, ordinal) {
    const seqs = confirmedReplies(request);
    if (seqs.length !== ordinal) throw fail('SHARED_GROUP_HISTORY_NOT_CONFIRMED');
    const adapter = runtime.adapter;
    const byId = new Map(rows.map(row => [row.id, row]));
    let previousSeq = request.userSeq;
    for (let index = 0; index < ordinal; index++) {
        const msgId = 'reply_group_' + request.id + '_' + index;
        const reply = byId.get(msgId);
        const seq = seqs[index];
        const ack = adapter.state.acked[messageKey({ ...wireTopic(mapping.shared), msgId })];
        if (!Number.isSafeInteger(seq) || seq <= previousSeq || !ack || ack.deleted || ack.seq !== seq
            || reply?.role !== 'assistant' || reply.agentId !== request.turn.plan[index]
            || messageHash(adapter.canonical(reply, mapping.shared.topicId)) !== ack.hash) {
            throw fail('SHARED_GROUP_HISTORY_NOT_CONFIRMED');
        }
        previousSeq = seq;
    }
}

async function loadPrepared(execution, descriptor, mapping, request, record, ordinal) {
    const runtime = execution.runtime;
    const { config } = await runtime.send(pathFor(runtime, 'request-config', { admissionId: request.id }));
    if (config?.hash !== request.configHash || config.owner?.kind !== 'group') throw fail('SHARED_CONFIG_RESPONSE_INVALID');
    const minSeq = ordinal > 0 ? confirmedReplies(request)[ordinal - 1] : request.userSeq;
    if (!Number.isSafeInteger(minSeq) || minSeq <= 0) throw fail('SHARED_GROUP_HISTORY_NOT_CONFIRMED');
    await runtime.syncExecutionTopic(mapping, { minSeq });
    const history = await runtime.replica.queue.read(mapping.shared);
    const user = history.find(message => message.id === request.turn.userMessageId && message.role === 'user');
    if (!user) throw fail('SHARED_GROUP_HISTORY_NOT_CONFIRMED');
    assertReplyPrefix(runtime, mapping, request, history, ordinal);
    record ||= {
        descriptor: { ...descriptor },
        sharedId: mapping.sharedId,
        phase: 'accepted',
        adoptGroupWork: true,
        body: { controlMode: request.turn.controlMode, requestId: request.requestId, message: user },
    };
    record.accepted = request;
    record.config = config;
    if (record.adoptGroupWork) execution.state.requests['group-handoff:' + request.id] = record;
    await execution.save();
    return execution.groupResult(record, config, user, history);
}

async function executeAction(execution, payload, invoke) {
    const { descriptor, action, workId, expectedExecutor, expectedExecutorVersion, expectedNextOrdinal, expectedPreviousReplySeq, message } = payload;
    const runtime = execution.runtime;
    runtime.assertSharedAccess();
    if (runtime.closed || !runtime.ready) throw fail('APPLICATION_SHUTTING_DOWN');
    if (runtime.readOnly) throw fail('SHARED_READ_ONLY');
    if (!enabled(runtime)) throw fail('SHARED_GROUP_HANDOFF_UNAVAILABLE');
    if (descriptor?.itemType !== 'group' || !['start', 'handoff', 'continue'].includes(action)) throw fail('INVALID_SHARED_SUBMISSION');
    const mapping = await runtime.executionMapping(descriptor);
    if (!runtime.isLocalVisible(mapping.sharedId)) throw fail('SHARED_LOCAL_REMOVED');
    const groupId = runtime.state.objects[mapping.sharedId].parentId;
    runtime.matching.assert([mapping.sharedId, groupId]);
    return execution.run('group-handoff:' + mapping.sharedId, async () => {
        if (action === 'start') {
            let record = localRecord(execution, mapping, workId);
            if (workId && !record) {
                const pending = localRecord(execution, mapping);
                if (!pending?.admitStarted || pending.accepted) throw fail('SHARED_REQUEST_NOT_FOUND');
                const known = await readWork(runtime, mapping, workId);
                if (known?.requestId !== pending.body.requestId || known?.turn?.controlMode !== pending.body.controlMode) {
                    throw fail('SHARED_REQUEST_NOT_FOUND');
                }
                record = pending;
            }
            if (record?.admitStarted) await execution.refresh(record);
            if (workId && record.accepted?.id !== workId) throw fail('SHARED_REQUEST_NOT_FOUND');
            if (record && message && settled.has(record.phase) && record.body.requestId !== message.id) record = null;
            if (record && message && record.localMessage?.content !== message.content) throw fail('SHARED_TOPIC_BUSY');
            if (message?.id && execution.state.requests[message.id]?.accepted && !record) {
                throw fail('SHARED_REQUEST_ALREADY_FINISHED');
            }
            if (record?.accepted) {
                const request = record.accepted;
                if (!canDispatch(request, 0) || request.groupHandoff.executor !== executor(runtime)) {
                    return { success: true, workId: request.id };
                }
                const prepared = await loadPrepared(execution, descriptor, mapping, request, record, 0);
                return invoke(prepared, 0);
            }
            const user = record?.localMessage || message;
            if (typeof user?.id !== 'string' || user?.role !== 'user' || typeof user.content !== 'string'
                || !user.content.trim() || user.attachments?.length) throw fail('INVALID_SHARED_SUBMISSION');
            let prepared;
            try {
                const mode = record?.body.controlMode || startMode(runtime, runtime.configs.state.objects[groupId]?.config);
                if (!mode || !runtime.capabilities.features.includes(mode)) throw fail('SHARED_GROUP_HANDOFF_UNSUPPORTED');
                prepared = await execution.prepare(descriptor, user, { controlMode: mode });
            } catch (error) {
                const attempt = execution.state.requests[user.id];
                if (attempt && !attempt.accepted && rejected.has(error.code) && error.status >= 400 && error.status < 500) {
                    attempt.phase = 'local_pending';
                    attempt.admitStarted = false;
                    attempt.rejected = error.code;
                    await execution.save();
                }
                throw error;
            }
            return invoke(prepared, 0);
        }

        if (typeof workId !== 'string' || typeof expectedExecutor !== 'string' || !Number.isSafeInteger(expectedExecutorVersion)) {
            throw fail('INVALID_SHARED_SUBMISSION');
        }
        const original = await readWork(runtime, mapping, workId);
        if (!original?.groupHandoff) throw fail('SHARED_REQUEST_NOT_FOUND');
        const v2 = original.turn.controlMode === planCapability;
        const ordinal = v2 ? expectedNextOrdinal : 1;
        const prefix = v2 ? { expectedNextOrdinal, expectedPreviousReplySeq } : {};
        if (v2 && (!Number.isSafeInteger(ordinal) || ordinal < 1
            || !Number.isSafeInteger(expectedPreviousReplySeq) || expectedPreviousReplySeq <= 0)) {
            throw fail('INVALID_SHARED_SUBMISSION');
        }
        const opScope = [workId, executor(runtime), expectedExecutor, expectedExecutorVersion];
        if (v2) opScope.push(ordinal, expectedPreviousReplySeq);
        const body = { sharedSpaceId: runtime.connection.sharedSpaceId, workId, expectedExecutor, expectedExecutorVersion, ...prefix,
            opId: 'desktop-group-' + action + '_' + sha256(JSON.stringify(opScope)).slice(0, 48) };
        await runtime.send(endpoint + 'group-' + action, { body });
        // A replayed receipt can outlive its slot. Re-read the Work and fence dispatch to the clicked checkpoint.
        const request = await readWork(runtime, mapping, workId);
        if (!request?.groupHandoff) throw fail('SHARED_REQUEST_NOT_FOUND');
        const control = request.groupHandoff;
        if (action === 'handoff' || !canDispatch(request, ordinal) || control.executor !== executor(runtime)
            || control.executorVersion !== expectedExecutorVersion || v2 && control.previousReplySeq !== expectedPreviousReplySeq) {
            return { success: true, workId, state: control.state };
        }
        const prepared = await loadPrepared(execution, descriptor, mapping, request, localRecord(execution, mapping, workId), ordinal);
        return invoke(prepared, ordinal);
    });
}

module.exports = { planCapability, capability, isMode, enabled, startMode, executor, canDispatch, confirmedReplies, observe, executeAction, assertReplyPrefix };

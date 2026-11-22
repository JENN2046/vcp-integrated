'use strict';

const { fail, sha256, messageHash, messageKey, wireTopic } = require('./protocol');
const capability = 'group-member-handoff-v1';
const endpoint = '/api/v1/sync/shared/';
const settled = new Set(['completed', 'abandoned']);
const rejected = new Set([
    'CONTROLLED_TEXT_PORTABLE_REQUIRED', 'INVALID_SHARED_SUBMISSION',
    'SHARED_CLIENT_UPGRADE_REQUIRED', 'SHARED_GROUP_HANDOFF_UNSUPPORTED',
]);

function enabled(runtime) {
    return runtime.capabilities.features?.includes(capability) === true;
}

function executor(runtime) {
    return 'desktop:' + runtime.connection.deviceId;
}

function canDispatch(request, ordinal) {
    const native = request.nativeRequests?.find(step => step.ordinal === ordinal);
    return request.groupHandoff?.state === (ordinal === 0 ? 'first_member' : 'continuing')
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
        && record.body?.controlMode === capability && (!workId || record.accepted?.id === workId)
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
    const owned = control.executor === executor(runtime);
    const live = execution.liveGroups.has(request.id);
    const reviewing = request.state === 'review_required'
        || request.nativeRequests?.some(step => step.state === 'unknown'
            || owned && !live && ['dispatched', 'model_terminal'].includes(step.state) && step.ordinal === control.nextOrdinal);
    return {
        id: request.id,
        requestId: request.requestId,
        state: reviewing ? 'review_required' : control.state,
        executor: control.executor,
        executorVersion: control.executorVersion,
        owned,
        fresh,
        nextRequestId: control.nextRequestId,
        canRetryFirst: fresh && owned && !live && canDispatch(request, 0) && Boolean(localRecord(execution, mapping, request.id)),
        canHandoff: fresh && !owned && !reviewing && control.state === 'awaiting_handoff',
        canContinue: fresh && owned && !live && !reviewing && (control.state === 'awaiting_continue' || canDispatch(request, 1)),
    };
}

function assertFirstReply(runtime, mapping, request, rows) {
    const msgId = 'reply_group_' + request.id + '_0';
    const first = rows.find(row => row.id === msgId);
    const seq = request.groupHandoff.firstReplySeq;
    const adapter = runtime.adapter;
    const ack = adapter.state.acked[messageKey({ ...wireTopic(mapping.shared), msgId })];
    if (!Number.isSafeInteger(seq) || seq <= 0 || !ack || ack.deleted || ack.seq !== seq
        || first?.role !== 'assistant' || first.agentId !== request.turn.plan[0]
        || messageHash(adapter.canonical(first, mapping.shared.topicId)) !== ack.hash) {
        throw fail('SHARED_GROUP_HISTORY_NOT_CONFIRMED');
    }
}

async function loadPrepared(execution, descriptor, mapping, request, record, ordinal) {
    const runtime = execution.runtime;
    const { config } = await runtime.send(pathFor(runtime, 'request-config', { admissionId: request.id }));
    if (config?.hash !== request.configHash || config.owner?.kind !== 'group') throw fail('SHARED_CONFIG_RESPONSE_INVALID');
    const minSeq = ordinal === 1 ? request.groupHandoff.firstReplySeq : request.userSeq;
    if (!Number.isSafeInteger(minSeq) || minSeq <= 0) throw fail('SHARED_GROUP_HISTORY_NOT_CONFIRMED');
    await runtime.syncExecutionTopic(mapping, { minSeq });
    const history = await runtime.replica.queue.read(mapping.shared);
    const user = history.find(message => message.id === request.turn.userMessageId && message.role === 'user');
    if (!user) throw fail('SHARED_GROUP_HISTORY_NOT_CONFIRMED');
    if (ordinal === 1) assertFirstReply(runtime, mapping, request, history);
    record ||= {
        descriptor: { ...descriptor },
        sharedId: mapping.sharedId,
        phase: 'accepted',
        adoptGroupWork: true,
        body: { controlMode: capability, requestId: request.requestId, message: user },
    };
    record.accepted = request;
    record.config = config;
    if (record.adoptGroupWork) execution.state.requests['group-handoff:' + request.id] = record;
    await execution.save();
    return execution.groupResult(record, config, user, history);
}

async function executeAction(execution, payload, invoke) {
    const { descriptor, action, workId, expectedExecutor, expectedExecutorVersion, message } = payload;
    const runtime = execution.runtime;
    runtime.assertSharedAccess();
    if (runtime.closed || !runtime.ready) throw fail('APPLICATION_SHUTTING_DOWN');
    if (runtime.readOnly) throw fail('SHARED_READ_ONLY');
    if (!enabled(runtime)) throw fail('SHARED_GROUP_HANDOFF_UNAVAILABLE');
    if (descriptor?.itemType !== 'group' || !['start', 'handoff', 'continue'].includes(action)) throw fail('INVALID_SHARED_SUBMISSION');
    const mapping = await runtime.executionMapping(descriptor);
    if (!runtime.isLocalVisible(mapping.sharedId)) throw fail('SHARED_LOCAL_REMOVED');
    runtime.matching.assert([mapping.sharedId, runtime.state.objects[mapping.sharedId].parentId]);
    return execution.run('group-handoff:' + mapping.sharedId, async () => {
        if (action === 'start') {
            let record = localRecord(execution, mapping, workId);
            if (workId && !record) throw fail('SHARED_REQUEST_NOT_FOUND');
            if (record?.admitStarted) await execution.refresh(record);
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
                prepared = await execution.prepare(descriptor, user, { controlMode: capability });
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
        const body = { sharedSpaceId: runtime.connection.sharedSpaceId, workId, expectedExecutor, expectedExecutorVersion,
            opId: 'desktop-group-' + action + '_' + sha256(JSON.stringify([workId, executor(runtime), expectedExecutor, expectedExecutorVersion])).slice(0, 48) };
        await runtime.send(endpoint + 'group-' + action, { body });
        // Read the current Work instead of treating a replayed receipt as current ownership.
        const request = await readWork(runtime, mapping, workId);
        if (!request?.groupHandoff) throw fail('SHARED_REQUEST_NOT_FOUND');
        if (action === 'handoff') return { success: true, workId, state: request?.groupHandoff?.state };
        if (!canDispatch(request, 1) || request.groupHandoff.executor !== executor(runtime)) {
            return { success: true, workId, state: request?.groupHandoff?.state };
        }
        const prepared = await loadPrepared(execution, descriptor, mapping, request, localRecord(execution, mapping, workId), 1);
        return invoke(prepared, 1);
    });
}

module.exports = { capability, enabled, executor, canDispatch, observe, executeAction, assertFirstReply };

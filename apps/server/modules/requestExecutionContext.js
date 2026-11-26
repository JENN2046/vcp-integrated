'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');

const local = new AsyncLocalStorage();
const events = new EventEmitter();
const registered = new Map();
const nativeTaskProviders = new Map();
const activeContexts = new Map();
// A completed HTTP response is not proof that the native model/tool loop
// completed. The host handler records its own outcome before releasing it.
const modelResponses = new WeakMap();
function requireModelOutcome(res) {
    const state = modelResponses.get(res);
    if (state) state.required = true;
}
function recordModelOutcome(res, completed) {
    const state = modelResponses.get(res);
    if (!state || state.settled) return;
    state.outcome = completed === true;
    state.check();
}
let sharedBoundary = null;
function setSharedBoundary(boundary){
    if(sharedBoundary&&boundary&&sharedBoundary!==boundary)throw new Error('SHARED_NATIVE_BOUNDARY_ALREADY_ATTACHED');
    sharedBoundary=boundary;
    return ()=>{if(sharedBoundary===boundary)sharedBoundary=null;};
}

function note(type, data) {
    const context = local.getStore();
    if (!context) return;
    try { events.emit(type, { requestId: context.requestId, ...data }); }
    catch { console.warn('[NativeExecution] OBSERVER_FAILED'); }
}
// Keep a reference to this request's fence when a later approval arrives on
// a different socket, outside the request's AsyncLocalStorage context.
function approvalOwner() {
    const scope = local.getStore();
    if (!scope?.workId) return null;
    const { workId, signal, fence } = scope;
    return { workId, isCurrent() {
        if (signal.aborted) return false;
        try { fence(); return true; }
        catch { return false; }
    } };
}
function withTurnSignal(signal, execute) {
    const scope = local.getStore();
    if (scope?.signal) {
        const combined = AbortSignal.any([scope.signal, signal]);
        return local.run({ ...scope, signal: combined }, () => execute(combined));
    }
    return local.run({ ...scope, signal, toolRun: { waiting: 0 } }, () => execute(signal));
}

function runCoreTurn(scope, execute) {
    return local.run({ ...scope, requestId: scope.requestId || scope.workId, core: true, toolRun: { waiting: 0 } }, execute);
}

function notifyCoreApproval(type, details) {
    const scope = local.getStore();
    if (scope?.core) scope.observe(type, details);
}

function cancellation() {
    return Object.assign(new Error('NATIVE_EXECUTION_CANCELLED'), { code: 'NATIVE_EXECUTION_CANCELLED', name: 'AbortError' });
}
function throwIfCancelled() {
    if (local.getStore()?.signal?.aborted) throw cancellation();
}
function assertDispatch() {
    assertToolOutcomeKnown();
    throwIfCancelled();
    const scope = local.getStore();
    if (!scope?.workId) return;
    if (typeof scope.fence !== 'function') {
        throw Object.assign(new Error('SHARED_REQUEST_FENCED'), { code: 'SHARED_REQUEST_FENCED' });
    }
    scope.fence();
    scope.applied?.();
    scope.phase?.('provider_attempt');
}
function middleware(req, res, next) {
    const requestId = req.body?.requestId, snapshot = registered.get(requestId);
    let shared;
    if(snapshot?.sharedAuthority&&!sharedBoundary)return res.status(409).json({error:{code:'SHARED_READ_ONLY'}});
    if(sharedBoundary&&/^\/v1\/(?:chat\/completions(?:-no-vcp)?|chatvcp\/completions)\/?$/i.test(req.path||req.url||'')){
        try{const authority=snapshot?.sharedAuthority;
            if(authority&&req.headers?.['x-nativesync-native-proof']!==snapshot.nativeProof)throw Object.assign(Error('SHARED_NATIVE_ADMISSION_REQUIRED'),{code:'SHARED_NATIVE_ADMISSION_REQUIRED'});
            shared=authority?.kind==='native-task'?sharedBoundary.taskRequests.enter(req,authority):sharedBoundary.enter(req,authority?.actor,authority?.replyOperation);}
        catch(e){return res.status(e.status||409).json({error:{code:e.code||'SHARED_NATIVE_ADMISSION_REQUIRED'}});}
    }
    if (!snapshot&&!shared) return next();
    if (typeof shared?.observeAssistantText === 'function') Object.defineProperty(req, 'nativeSyncObserveAssistantText', { value: shared.observeAssistantText });
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', abort);
    res.once('close', abort);
    const releaseContext = () => { if (activeContexts.get(requestId)?.controller === controller) activeContexts.delete(requestId); };
    activeContexts.set(requestId, { controller, shared });
    res.once('close', releaseContext);
    let scope;
    const outcome = { required: false, outcome: undefined, settled: false };
    outcome.check = () => {
        if (!scope?.transportEnded || outcome.settled || (scope.executionTracked && !scope.executionSettled)) return;
        if (scope.transportSuccess && outcome.required && outcome.outcome === undefined) return;
        outcome.settled = true;
        modelResponses.delete(res);
        shared?.finish(scope.transportSuccess && (!outcome.required || outcome.outcome === true));
    };
    modelResponses.set(res, outcome);
    const finishNative=success=>{if(!scope)return;scope.transportEnded=true;scope.transportSuccess=success;outcome.check();};
    res.once('finish', () => { releaseContext();finishNative(res.statusCode>=200&&res.statusCode<300);req.removeListener('aborted', abort); res.removeListener('close', abort); });
    if(shared)res.once('close',()=>{if(!res.writableFinished)finishNative(false);});
    scope={ toolRun: { waiting: 0 },finishNative,requestId, signal: controller.signal, ...snapshot,...(shared?{bridge:shared.bridge,sponsorAuthority:shared.sponsorAuthority,sponsorBoundary:sharedBoundary,textOnly:shared.textOnly===true,safeTools:shared.safeTools,delegation:shared.delegation,beginToolBatch:shared.beginToolBatch,settleToolPause:shared.settleToolPause,canSteer:shared.steeringEnabled===true,workId:shared.workId,generation:shared.generation,phase:shared.phase,fence:shared.fence,applied:shared.applied,continuation:shared.continuation,checkpoint:shared.checkpoint,sessionFinalReply:shared.sessionFinalReply}:{}) };
    return local.run(scope,next);
}
async function waitForApproval(promise, onCancel) {
    const context = local.getStore();
    if (!context?.signal) return promise;
    const state = context.toolRun;
    state.waiting++;
    let abort;
    const cancelled = new Promise((_resolve, reject) => {
        abort = () => { try { onCancel?.(); } finally { reject(cancellation()); } };
        context.signal.addEventListener('abort', abort, { once: true });
        if (context.signal.aborted) abort();
    });
    try {
        if (state.waiting === 1 && !context.signal.aborted) note('approval', { waiting: true });
        const result = await Promise.race([promise, cancelled]);
        throwIfCancelled();
        return result;
    } finally {
        context.signal.removeEventListener('abort', abort);
        if (--state.waiting === 0) note('approval', { waiting: false });
    }
}

// The bridge is supplied by the registered host request, never from tool arguments.
function register(requestId, config, bridge, sharedAuthority = null) {
    if (typeof requestId !== 'string' || registered.has(requestId)) throw new Error('NATIVE_EXECUTION_CONTEXT_CONFLICT');
    if (bridge && ['onToolDispatch', 'onToolSettled', 'onTaskAccepted', 'onTaskObserved'].some(key => typeof bridge[key] !== 'function')) {
        throw new Error('NATIVE_EXECUTION_BRIDGE_INVALID');
    }
    const prompt = config?.promptPolicy === 'native-alias-snapshot'
        ? { agentAlias: config.agentAlias, agentPrompt: config.systemPrompt } : {};
    const nativeProof=sharedAuthority?randomUUID():null;
    registered.set(requestId, { ...prompt, bridge,...(sharedAuthority?{sharedAuthority,nativeProof}:{}) });
    const release=() => registered.delete(requestId);
    if(sharedAuthority)release.headers={'x-nativesync-native-proof':nativeProof,'x-nativesync-admission':sharedAuthority.admissionId};
    return release;
}
function agentPrompt(alias) {
    const context = local.getStore();
    return context && context.agentAlias === alias ? context.agentPrompt : undefined;
}

function assertDelegationArgs(scope, pluginName, args, allowToolPassword = false) {
    if (pluginName !== 'AgentAssistant' || !args ||
        Object.keys(args).some(key => !['agent_name', 'prompt', 'task_delegation'].includes(key) &&
            !(allowToolPassword && key === 'tool_password')) ||
        !['agent_name', 'prompt', 'task_delegation'].every(key => Object.hasOwn(args, key)) ||
        args.agent_name !== scope.delegation.agentName || typeof args.prompt !== 'string' ||
        args.prompt !== scope.delegation.prompt || ![true, 'true'].includes(args.task_delegation)) {
        throw toolError('CONTROLLED_TOOL_FORBIDDEN');
    }
}

function assertToolsAllowed(pluginName, args, { indirect = false, allowToolPassword = false } = {}) {
    assertToolOutcomeKnown();
    throwIfCancelled();
    const scope = local.getStore();
    if (scope?.core && (pluginName === 'TopicSponsor' && !scope.coreSponsor || Object.hasOwn(args || {}, 'timely_contact'))) {
        throw toolError('CORE_TOOL_NOT_MIGRATED');
    }
    if (scope?.textOnly) throw Object.assign(Error('CONTROLLED_TEXT_TOOLS_FORBIDDEN'), { code: 'CONTROLLED_TEXT_TOOLS_FORBIDDEN' });
    if (scope?.safeTools && (!scope.safeTools.has(pluginName) || scope.invocation || indirect
        || Object.hasOwn(args || {}, 'timely_contact') || /file:\/\//i.test(JSON.stringify(args || {})))) {
        throw toolError('CONTROLLED_TOOL_FORBIDDEN');
    }
    if (scope?.delegation) assertDelegationArgs(scope, pluginName, args, allowToolPassword);
}

function controlledDelegation() { return Boolean(local.getStore()?.delegation); }

function assertDelegationDispatch(pluginName) {
    const scope = local.getStore();
    if (scope?.delegation && (pluginName !== 'AgentAssistant' || !scope.toolBatch || scope.invocation)) {
        throw toolError('CONTROLLED_TOOL_FORBIDDEN');
    }
}

function assertDelegationInvocation(args) {
    const scope = local.getStore();
    if (scope?.textOnly) throw toolError('CONTROLLED_TEXT_TOOLS_FORBIDDEN');
    if (!scope?.delegation) return false;
    if (scope.invocation?.pluginName !== 'AgentAssistant' || !scope.toolBatch?.dispatched) {
        throw toolError('CONTROLLED_TOOL_FORBIDDEN');
    }
    assertDelegationArgs(scope, 'AgentAssistant', args);
    return true;
}

function controlledToolWork() { return Boolean(local.getStore()?.safeTools); }
function toolError(code) { return Object.assign(Error(code), { code }); }
function assertToolBatch(calls) {
    const scope = local.getStore();
    if (scope?.textOnly && scope.sharedAuthority?.kind === 'native-task' && calls.length) {
        throw toolError('CONTROLLED_TEXT_TOOLS_FORBIDDEN');
    }
    if (scope?.core && calls.some(call => call.archery || call.archeryNoReply)) {
        throw toolError('CORE_ASYNC_TOOL_NOT_MIGRATED');
    }
    if (!controlledToolWork()) return;
    if (scope.delegation) {
        if (calls.length !== 1) throw toolError('CONTROLLED_TOOL_CALL_LIMIT');
        const [call] = calls;
        assertToolsAllowed(call.name, call.args, {
            indirect: Boolean(call.archery || call.archeryNoReply || call.markHistory || call.river || call.vref),
            allowToolPassword: true
        });
    }
    if (calls.length > 2 || calls.some(call => call.archery) ||
        (calls.length === 2 && (typeof scope.beginToolBatch !== 'function' || typeof scope.checkpoint?.result !== 'function' ||
            calls[0].name === calls[1].name))) {
        throw toolError('CONTROLLED_TOOL_CALL_LIMIT');
    }
}

async function executeControlledToolBatch(calls, execute) {
    const scope = local.getStore();
    const names = Object.freeze(calls.map(call => call.name));
    scope.beginToolBatch?.(names);
    const results = [];
    for (const [ordinal, call] of calls.entries()) {
        const toolBatch = { names, ordinal, dispatched: false, settled: false };
        results.push(await local.run({ ...scope, toolBatch }, () => execute(call)));
        if (names.length === 2) {
            // ToolExecutor can turn transport failures into displayable errors.
            // Only a durable native settlement lets the batch advance.
            assertToolOutcomeKnown();
            if (!toolBatch.settled) throw toolError('CONTROLLED_TOOL_BATCH_UNSETTLED');
        }
    }
    return results;
}

function assertToolBoundary() {
    const scope = local.getStore();
    if (!scope?.safeTools) return;
    assertToolOutcomeKnown();
    scope.fence();
}

function assertToolOutcomeKnown() {
    const error = local.getStore()?.toolRun?.unconfirmed;
    if (error) throw error;
}

// Only the selected transport calls dispatch. Approval, bridge selection and
// result formatting stay with PluginManager. Checkpoint the same filtered
// value the manager returns to its caller, never the raw plugin response.
async function trackToolInvocation({ pluginName, recordId = null }, process, isUnconfirmed = () => true) {
    const context = local.getStore();
    if (!context?.bridge) return process(fn => fn());
    let invocation, began = false, unconfirmed = false;
    const dispatch = async fn => {
        assertToolOutcomeKnown();
        throwIfCancelled();
        const batch = context.toolBatch;
        if (batch) {
            if (batch.dispatched || batch.names[batch.ordinal] !== pluginName) throw toolError('CONTROLLED_TOOL_CALL_LIMIT');
            batch.dispatched = true;
        }
        const identity = Object.freeze({
            requestId: context.requestId, nativeRequestId: context.requestId,
            invocationId: randomUUID(), pluginName,
            recordId: typeof recordId === 'string' && recordId ? recordId : null,
            ...(batch && { batchOrdinal: batch.ordinal, batchSize: batch.names.length, batchNames: batch.names })
        });
        await context.bridge.onToolDispatch(identity);
        invocation = identity;
        return local.run({ ...context, invocation }, async () => {
            assertToolOutcomeKnown();
            throwIfCancelled();
            context.fence?.();
            began = true;
            try { return await fn(invocation); }
            catch (error) {
                // A direct plugin can throw or time out after its action took
                // effect. A specialised transport can identify a lost receipt.
                unconfirmed = isUnconfirmed(error);
                if (unconfirmed) {
                    const code = 'NATIVE_TOOL_RESULT_UNCONFIRMED';
                    context.toolRun.unconfirmed = Object.assign(Error(code), { code });
                }
                throw error;
            }
        });
    };
    let value, outcome = 'returned', errorCode = null;
    try {
        value = await process(dispatch);
        return value;
    } catch (error) {
        outcome = 'error';
        errorCode = began ? error?.code || 'NATIVE_TOOL_ERROR' : 'NATIVE_CANCELLED_BEFORE_EXECUTION';
        throw error;
    } finally {
        if (invocation && !unconfirmed) {
            try {
                if (outcome === 'returned') {
                    if (context.toolBatch?.names.length === 2 && value === undefined) throw toolError('NATIVE_TOOL_RESULT_UNCONFIRMED');
                    context.checkpoint?.result(invocation, value);
                } else if (!began) context.checkpoint?.result(invocation, { nativeOutcome: 'not_executed', errorCode });
                await confirmToolSettlement(context.bridge, { ...invocation, outcome, errorCode, ...(context.core && { value }) });
                if (context.toolBatch && outcome === 'returned') context.toolBatch.settled = true;
            } catch (error) {
                context.toolRun.unconfirmed = error;
                throw error;
            }
        }
    }
}

async function runToolInvocation({ pluginName, recordId, unconfirmedError }, fn) {
    assertToolsAllowed(pluginName, null, { indirect: true });
    return trackToolInvocation({ pluginName, recordId }, dispatch => dispatch(fn), error => error === unconfirmedError);
}

function currentTopicSponsorCall() {
    const scope = local.getStore();
    if (!scope?.sponsorAuthority) return null;
    return {
        authority: scope.sponsorAuthority,
        isCurrent: () => scope === local.getStore(),
        requireOwner() {
            const owner = scope.sponsorBoundary;
            if (!scope.bridge || !owner || owner !== sharedBoundary || owner.closed || owner.draining) {
                throw Object.assign(new Error('TOPIC_SPONSOR_AUTHORITY_REQUIRED'), {code: 'TOPIC_SPONSOR_AUTHORITY_REQUIRED'});
            }
            return owner.shared;
        },
    };
}

async function confirmToolSettlement(bridge, event) {
    try { await bridge.onToolSettled(event); }
    catch (cause) {
        throw Object.assign(new Error('NATIVE_TOOL_SETTLEMENT_UNCONFIRMED'), {
            code: 'NATIVE_TOOL_SETTLEMENT_UNCONFIRMED', nativeOutcome: event.outcome, cause
        });
    }
}

async function acceptNativeTask({ pluginName, nativeTaskId, agentBaseName }) {
    const context = local.getStore();
    if (context?.safeTools && (!context.delegation || pluginName !== 'AgentAssistant' ||
        !context.toolBatch?.dispatched || context.toolBatch.accepted)) throw toolError('CONTROLLED_TOOL_FORBIDDEN');
    if(context?.textOnly)throw Object.assign(Error('CONTROLLED_TEXT_TOOLS_FORBIDDEN'),{code:'CONTROLLED_TEXT_TOOLS_FORBIDDEN'});
    if (!context?.bridge) return null;
    if (!context.invocation || context.invocation.pluginName !== pluginName) {
        throw Object.assign(new Error('NATIVE_TASK_INVOCATION_REQUIRED'), { code: 'NATIVE_TASK_INVOCATION_REQUIRED' });
    }
    throwIfCancelled();
    const identity = Object.freeze({ ...context.invocation, pluginName, nativeTaskId, agentBaseName });
    if (context.delegation) context.toolBatch.accepted = true;
    if (context.core) return context.coreAA.accept(identity);
    await context.bridge.onTaskAccepted(identity);
    // The child outlives the parent response. Each new model round still
    // passes through the original Work's request registry and dispatch fence.
    const boundary = context.sponsorBoundary || sharedBoundary;
    if (context.workId && (!boundary || boundary.closed || boundary !== sharedBoundary)) throw Error('SHARED_NATIVE_CLOSED');
    const actor = context.sharedAuthority?.actor || context.sponsorAuthority?.actor;
    if (context.workId && !actor) throw Error('SHARED_REQUEST_OWNER_REQUIRED');
    const binding = context.workId && boundary.taskRequests.binding(context.workId, identity, actor);
    return Object.freeze({ identity, observe: result => context.bridge.onTaskObserved({ ...result, ...identity }),
        ...(binding && { requests: {
            register: body => binding.registerRequest(body, 0),
            confirmFinal(requestId) {
                if (requestId && !['not_started', 'safe'].includes(binding.childState(requestId).state)) {
                    throw Object.assign(Error('NATIVE_TASK_RESULT_REQUIRES_REVIEW'), { code: 'NATIVE_TASK_RESULT_REQUIRES_REVIEW' });
                }
                binding.claimFinal(0);
                return 0;
            },
        } }),
        ...(context.canSteer && binding && { control: binding }),
    });
}

function registerNativeTaskProvider(pluginName, provider) {
    if (typeof pluginName !== 'string' || !(typeof provider === 'function' || provider && typeof provider.read === 'function')) throw new Error('NATIVE_TASK_PROVIDER_INVALID');
    const entry = { provider };
    nativeTaskProviders.set(pluginName, entry);
    return () => { if (nativeTaskProviders.get(pluginName) === entry) nativeTaskProviders.delete(pluginName); };
}
async function queryNativeTask(pluginName, identity) {
    const entry = nativeTaskProviders.get(pluginName);
    if (!entry) return { ...identity, pluginName, state: 'unknown', revision: 0, code: 'NATIVE_TASK_PROVIDER_UNAVAILABLE' };
    return (typeof entry.provider === 'function' ? entry.provider : entry.provider.read)({ ...identity, pluginName });
}

function hasNativeTaskProvider(pluginName) {
    return nativeTaskProviders.has(pluginName);
}

function verifyNativeTaskArchive(pluginName, identity) {
    const provider = nativeTaskProviders.get(pluginName)?.provider;
    const receipt = provider?.readArchive?.({ ...identity, pluginName });
    if (receipt?.revision !== 1 || !['completed', 'failed', 'cancelled', 'stopped'].includes(receipt.state) ||
        typeof receipt.resultContent !== 'string') return null;
    return receipt;
}

async function controlNativeTask(pluginName, identity, request) {
    const entry = nativeTaskProviders.get(pluginName);
    if (!entry || typeof entry.provider.control !== 'function') throw Object.assign(Error('NATIVE_TASK_CONTROL_UNAVAILABLE'), { code: 'NATIVE_TASK_CONTROL_UNAVAILABLE' });
    return entry.provider.control({ ...identity, pluginName }, request);
}
function interruptWork(workId) {
    let count = 0;
    for (const { controller, shared } of activeContexts.values()) if (shared?.workId === workId && !controller.signal.aborted) {
        controller.abort(Object.freeze({ code: 'WORK_STEERING_PENDING' })); count++;
    }
    return count;
}

module.exports = {
    requireModelOutcome, recordModelOutcome, withTurnSignal, runCoreTurn, notifyCoreApproval,
    isCoreTurn: () => local.getStore()?.core === true,
    middleware, events, waitForApproval, throwIfCancelled, register, agentPrompt,setSharedBoundary,
    interruptWork, controlNativeTask,
    sharedTaskLink(pluginName, nativeTaskId) {
        const scope = local.getStore();
        if (scope?.core) return scope.coreAA?.link(pluginName, nativeTaskId) || null;
        if (!sharedBoundary || typeof nativeTaskId !== 'string') return null;
        const tasks = sharedBoundary.engine.nativeTasks;
        const row = tasks.get(pluginName, nativeTaskId);
        if (!row || !sharedBoundary.shared.nativeJob(row.execution_id)) return null;
        return { workId: row.execution_id, identity: { ...tasks.queryInput(row), pluginName } };
    },
    runNativeHandler:async fn=>{const scope=local.getStore();if(!scope?.workId)return fn();scope.executionTracked=true;try{return await fn();}finally{scope.executionSettled=true;if(scope.transportEnded)scope.finishNative(scope.transportSuccess);}},
    phase:stage=>local.getStore()?.phase?.(stage),
    assertDispatch,
    prepareContinuationBody: body => local.getStore()?.continuation?.(body) || body,
    recoverNativeTask:(identity,workId)=>{
        const boundary=sharedBoundary;if(!boundary||boundary.closed)throw Object.assign(Error('NATIVE_TASK_CONTROL_UNAVAILABLE'),{code:'NATIVE_TASK_CONTROL_UNAVAILABLE'});
        const row=boundary.taskControls.row(workId,identity),base=boundary.engine.nativeTasks.hooks(workId,row.step_id);
        return Object.freeze({identity,control:boundary.taskRequests.binding(workId,identity),observe:result=>base.onTaskObserved({...result,...identity})});
    },
    finalReplyPublisher: () => { const scope=local.getStore(); return scope?.checkpoint?.finalReply||scope?.sessionFinalReply; },
    checkpointCompletion:value=>local.getStore()?.checkpoint?.completion?.(value),
    checkpointAssistant: content => local.getStore()?.checkpoint?.assistant(content),
    markModelTerminal: () => { const scope=local.getStore();if(scope)scope.modelTerminalKnown=true; },
    currentSignal: () => local.getStore()?.signal, currentWork: () => local.getStore()?.workId || null,
    assertToolsAllowed, controlledToolWork, assertToolBatch, assertToolBoundary, executeControlledToolBatch, trackToolInvocation,
    settleToolPause: () => local.getStore()?.settleToolPause?.(),
    currentTopicSponsorCall, approvalOwner,
    currentCoreSponsor: () => local.getStore()?.coreSponsor,
    controlledDelegation, assertDelegationDispatch, assertDelegationInvocation,
    runToolInvocation, acceptNativeTask, registerNativeTaskProvider, queryNativeTask, hasNativeTaskProvider, verifyNativeTaskArchive,
    toolStarted: () => note('tool', { started: true }),
    run: (requestId, signal, fn) => local.run({ toolRun: { waiting: 0 }, requestId, signal, ...registered.get(requestId) }, fn)
};

// Data-only native message operations. Used by the renderer fallback and the
// main Queue; transport never accepts executable transforms.
const editable = new Set(['continuity','role','name','content','timestamp','updatedAt','attachments','contextCompaction','isThinking','isPendingStream','finishReason','streamOperationId','replyToMessageId','parentMessageId','requestId','executionId','agentId','groupId','topicId','context','avatarUrl','avatarColor','model','modelSource','tool_calls','tool_call_id','reasoning_content','thoughtSignature','interrupted','error','notice','_metadata','_nativeSyncMetadata','isGroupMessage','hideToolResults','toolResultsHidden','originalContent','usage','metrics','tokenUsage']);
const fail = code => Object.assign(new Error(code), { code });
function validateUpdatedAt(fields) {
    if (Object.hasOwn(fields,'updatedAt') && (!Number.isSafeInteger(fields.updatedAt) || fields.updatedAt < 0)) throw fail('INVALID_MESSAGE_UPDATED_AT');
}
export function stableValue(value) {
    return JSON.stringify(value, (_key, item) => item && !Array.isArray(item) && typeof item === 'object'
        ? Object.fromEntries(Object.keys(item).sort().map(key => [key,item[key]])) : item);
}
// These two fields belong to the sync representation, not the user's edit
// precondition. Business controls (attachments/Checkpoint/etc.) remain compared.
export function messagePreconditionValue(message) {
    const value={...message};delete value.continuity;delete value._nativeSyncMetadata;
    return stableValue(value);
}
export function captureNativeCausalContext(history, context = {}) {
    const parents=new Set();let known=true;
    for(const message of history){
        if(message?.isThinking||message?.isPendingStream||(context.topicId&&message?.topicId&&message.topicId!==context.topicId)){known=false;continue;}
        if(typeof message?.id!=='string'||!message.id||message.id.length>512){known=false;continue;}
        parents.add(message.id);
    }
    if(parents.size>1000)return Object.freeze({version:1,known:false,dependsOnMessageIds:Object.freeze([])});
    return Object.freeze({version:1,known,dependsOnMessageIds:Object.freeze([...parents])});
}
function indexed(history) {
    if (!Array.isArray(history)) throw fail('INVALID_HISTORY');
    const result = new Map();
    for (const message of history) {
        if (!message || typeof message.id !== 'string' || !message.id || message.id.length > 512 || result.has(message.id)) throw fail('INVALID_MESSAGE_ID');
        result.set(message.id,message);
    }
    return result;
}
export function deriveMessageOperations(before, after, { deleteIds = [] } = {}) {
    const old = indexed(before), next = indexed(after), deleted = new Set(deleteIds), operations = [];
    for (const [id,message] of next) {
        const previous = old.get(id);
        if (!previous) { validateUpdatedAt(message); operations.push({ kind:'append', message:structuredClone(message) }); continue; }
        if (Object.hasOwn(message,'updatedAt') && (!Object.hasOwn(previous,'updatedAt') || !Object.is(previous.updatedAt,message.updatedAt))) validateUpdatedAt(message);
        if (stableValue(previous) === stableValue(message)) continue;
        const set = {}, unset = [];
        for (const key of new Set([...Object.keys(previous),...Object.keys(message)])) {
            if (stableValue(previous[key]) === stableValue(message[key])) continue;
            if (!editable.has(key)) throw fail('HISTORY_FIELD_NOT_EDITABLE');
            if (Object.hasOwn(message,key)) {
                if (key==='updatedAt') validateUpdatedAt(message);
                set[key] = structuredClone(message[key]);
            } else unset.push(key);
        }
        operations.push({kind:'edit',id,expected:structuredClone(previous),set,unset});
    }
    const removed = [...old.keys()].filter(id => !next.has(id));
    if (removed.some(id => !deleted.has(id))) throw fail('EXPLICIT_DELETE_REQUIRED');
    if (removed.length) operations.push({kind:'delete',ids:removed,expected:removed.map(id=>structuredClone(old.get(id)))});
    return operations;
}
export function applyMessageOperations(history, operations) {
    if (!Array.isArray(operations) || operations.length > 20000) throw fail('INVALID_MESSAGE_OPERATIONS');
    const next = structuredClone(history); indexed(next);
    for (const operation of operations) {
        if (!operation || !['append','edit','delete'].includes(operation.kind)) throw fail('INVALID_MESSAGE_OPERATION');
        if (operation.kind === 'append') {
            indexed([operation.message]);
            validateUpdatedAt(operation.message);
            const previous = next.find(m=>m.id===operation.message.id);
            const identityValue = message => { const copy={...message};delete copy.continuity;delete copy._nativeSyncMetadata;return stableValue(copy); };
            if (previous && identityValue(previous)!==identityValue(operation.message)) throw fail('HISTORY_MESSAGE_CONFLICT');
            if (!previous) next.push(structuredClone(operation.message));
        } else if (operation.kind === 'edit') {
            const index = next.findIndex(m=>m.id===operation.id);
            if (index<0) throw fail('HISTORY_MESSAGE_NOT_FOUND');
            if (!operation.expected || messagePreconditionValue(next[index])!==messagePreconditionValue(operation.expected)) throw fail('HISTORY_MESSAGE_CONFLICT');
            if (!operation.set || typeof operation.set!=='object' || Array.isArray(operation.set) || !Array.isArray(operation.unset||[])) throw fail('INVALID_MESSAGE_OPERATION');
            for (const key of [...Object.keys(operation.set),...(operation.unset||[])]) if (!editable.has(key)) throw fail('HISTORY_FIELD_NOT_EDITABLE');
            validateUpdatedAt(operation.set);
            next[index] = {...next[index],...structuredClone(operation.set)};
            for (const key of operation.unset||[]) delete next[index][key];
        } else {
            if (!Array.isArray(operation.ids) || operation.ids.some(id=>typeof id!=='string'||!id)) throw fail('INVALID_EXPLICIT_DELETE');
            for (const expected of operation.expected||[]) {
                const current = next.find(m=>m.id===expected.id);
                if (current && messagePreconditionValue(current)!==messagePreconditionValue(expected)) throw fail('HISTORY_MESSAGE_CONFLICT');
            }
            const ids = new Set(operation.ids);
            for (let i=next.length-1;i>=0;i--) if (ids.has(next[i].id)) next.splice(i,1);
        }
    }
    return next;
}

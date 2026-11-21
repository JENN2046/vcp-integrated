'use strict';
const fs = require('node:fs'), path = require('node:path'), { createHash, randomUUID } = require('node:crypto');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => Object.assign(Error(code), { code });
const MAX = 32 * 1024 * 1024;
function createNativeContinuationStore(directory) {
    const file = requestId => path.join(directory, hash(String(requestId)) + '.json');
    const read = requestId => {
        const p = file(requestId); let data;
        try { const meta = fs.lstatSync(p); if (!meta.isFile() || meta.isSymbolicLink() || meta.size > MAX) throw fail('NATIVE_CHECKPOINT_INVALID'); data = JSON.parse(fs.readFileSync(p, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        if (data.version !== 1 || data.identity.requestId !== requestId) throw fail('NATIVE_CHECKPOINT_IDENTITY_CHANGED');
        return data;
    };
    const proofSource = (requestId, workId, settledInvocationIds = []) => {
        const data = read(requestId);
        if (!data || data.identity.workId !== workId) throw fail('NATIVE_CHECKPOINT_REQUIRED');
        if (settledInvocationIds.some(id => !data.results[id])) throw fail('NATIVE_CHECKPOINT_RESULTS_UNCONFIRMED');
        return data;
    };
    const write = data => {
        const bytes = Buffer.from(JSON.stringify(data)); if (bytes.length > MAX) throw fail('NATIVE_CHECKPOINT_TOO_LARGE');
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const p = file(data.identity.requestId), temporary = p + '.' + randomUUID() + '.tmp';
        let fd;
        try {
            fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
            fs.renameSync(temporary, p); const d = fs.openSync(directory, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
        } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
        return { requestId: data.identity.requestId, revision: data.revision, hash: hash(data), settledInvocationIds: Object.keys(data.results) };
    };
    return Object.freeze({
        begin(identity, messages, metadata = {}) {
            if (!identity?.workId || !identity.requestId || !Number.isSafeInteger(identity.controlRevision)) throw fail('NATIVE_CHECKPOINT_IDENTITY_REQUIRED');
            const prior = read(identity.requestId);
            if (prior) { if (hash(prior.identity) !== hash(identity) || hash(prior.messages) !== hash(messages)) throw fail('NATIVE_CHECKPOINT_IDENTITY_CHANGED'); return; }
            write({ version: 1, identity, messages, metadata, assistant: [], results: {}, events: [], revision: 0 });
        },
        assistant(requestId, content) {
            const data = read(requestId); if (!data) throw fail('NATIVE_CHECKPOINT_REQUIRED');
            if (typeof content !== 'string') throw fail('NATIVE_CHECKPOINT_INVALID');
            if (!content) return;
            if (data.assistant.at(-1) !== content) { data.assistant.push(content); data.events.push({kind:'assistant',content}); data.revision++; write(data); }
        },
        completion(requestId,response){const data=read(requestId);if(!data)throw fail('NATIVE_CHECKPOINT_REQUIRED');if(data.completion&&hash(data.completion)!==hash(response))throw fail('NATIVE_COMPLETION_CHANGED');if(!data.completion){data.completion=response;data.revision++;write(data);}},
        result(requestId, invocation, result) {
            const data = read(requestId); if (!data || invocation.nativeRequestId !== requestId) throw fail('NATIVE_CHECKPOINT_IDENTITY_CHANGED');
            const value = { invocationId: invocation.invocationId, pluginName: invocation.pluginName, recordId: invocation.recordId, result };
            const prior = data.results[invocation.invocationId];
            if (prior && hash(prior) !== hash(value)) throw fail('NATIVE_CHECKPOINT_RESULT_CHANGED');
            if (!prior) { data.results[invocation.invocationId] = value; data.events.push({kind:'result',invocationId:invocation.invocationId}); data.revision++; write(data); }
        },
        read,
        update(requestId, mutate) {
            const data=read(requestId);if(!data)throw fail('NATIVE_CHECKPOINT_REQUIRED');const identityHash=hash(data.identity);
            mutate(data);if(hash(data.identity)!==identityHash)throw fail('NATIVE_CHECKPOINT_IDENTITY_CHANGED');data.revision++;write(data);return data;
        },
        proof(requestId, workId, settledInvocationIds = []) {
            const data = proofSource(requestId, workId, settledInvocationIds);
            return {requestId,hash:hash(data),settledInvocationIds};
        },
        compactionToolResults(requestId, workId, proof) {
            const data = proofSource(requestId, workId, proof.settledInvocationIds);
            if (proof.requestId !== requestId || hash(data) !== proof.hash) throw fail('NATIVE_CHECKPOINT_CHANGED');
            const settled = new Set(proof.settledInvocationIds);
            const results = [];
            for (const [index, event] of data.events.entries()) {
                // Assistant events belong to the generation's one Journal reply.
                // Only independently settled tool invocations supply extra rows.
                if (event.kind === 'assistant') continue;
                const result = data.results[event.invocationId];
                if (event.kind !== 'result' || !settled.has(event.invocationId) || result?.invocationId !== event.invocationId) {
                    throw fail('NATIVE_CHECKPOINT_RESULTS_UNCONFIRMED');
                }
                results.push({ index, result });
            }
            return results;
        },
        mergeBody(requestId, body, {workId,expectedHash,inputIds,partialMessageId}={}) {
            const data=read(requestId);if(!data||data.identity.workId!==workId||hash(data)!==expectedHash)throw fail('NATIVE_CHECKPOINT_CHANGED');
            const bindings=body.vcpchatExtensions?.messageTimestampBindings||[];
            const indexes=inputIds.map(id=>bindings.find(b=>b.messageId===id)?.sentMessageIndex);
            if(indexes.some(i=>!Number.isSafeInteger(i)||body.messages[i]?.role!=='user'))throw fail('NATIVE_STEERING_INPUT_MISSING');
            const events=data.events.map(event=>event.kind==='assistant'?{role:'assistant',content:event.content}:{role:'user',content:'[已结清的原生工具结果；用于接续，不要重复执行]\n'+JSON.stringify(data.results[event.invocationId])});
            const systems=body.messages.filter(m=>m.role==='system'||m.role==='developer');
            const baseIndexes=data.messages.map((m,i)=>({m,i})).filter(v=>v.m.role!=='system'&&v.m.role!=='developer');
            const messages=[...systems,...baseIndexes.map(v=>v.m),...events,...indexes.map(i=>body.messages[i])];
            const map=new Map(baseIndexes.map((v,i)=>[v.i,systems.length+i]));
            const oldBindings=(data.metadata?.messageTimestampBindings||[]).filter(b=>map.has(b.sentMessageIndex)).map(b=>({...b,sentMessageIndex:map.get(b.sentMessageIndex)}));
            const offset=systems.length+baseIndexes.length+events.length;
            const inputBindings=inputIds.map((id,i)=>({...bindings.find(b=>b.messageId===id),sentMessageIndex:offset+i}));
            return {...body,messages,vcpchatExtensions:{...body.vcpchatExtensions,messageTimestampBindings:[...oldBindings,...inputBindings]}};
        },
        mergeCompactedBody(requestId,body,{workId,expectedHash,checkpoint,inputIds=[]}){
            const data=read(requestId);if(!data||data.identity.workId!==workId||hash(data)!==expectedHash)throw fail('NATIVE_CHECKPOINT_CHANGED');
            const bindings=body.vcpchatExtensions?.messageTimestampBindings||[],checkpointIndex=bindings.find(v=>v.messageId===checkpoint.id)?.sentMessageIndex;
            if(!Number.isSafeInteger(checkpointIndex)||body.messages[checkpointIndex]?.role!=='user'||body.messages[checkpointIndex].content!==checkpoint.content)throw fail('NATIVE_COMPACTION_CHECKPOINT_MISSING');
            const indexes=inputIds.map(id=>bindings.find(v=>v.messageId===id)?.sentMessageIndex);if(indexes.some(i=>!Number.isSafeInteger(i)||body.messages[i]?.role!=='user'))throw fail('NATIVE_STEERING_INPUT_MISSING');
            const systems=body.messages.filter(v=>v.role==='system'||v.role==='developer'),messages=[...systems,{role:'user',content:checkpoint.content},...indexes.map(i=>body.messages[i])];
            return {...body,messages,vcpchatExtensions:{...body.vcpchatExtensions,messageTimestampBindings:[{...bindings.find(v=>v.messageId===checkpoint.id),sentMessageIndex:systems.length},...inputIds.map((messageId,i)=>({...bindings.find(v=>v.messageId===messageId),sentMessageIndex:systems.length+1+i}))]}};
        },
        context(requestId, { workId, settledInvocationIds = [] } = {}) {
            const data = read(requestId); if (!data || data.identity.workId !== workId) throw fail('NATIVE_CHECKPOINT_REQUIRED');
            if (settledInvocationIds.some(id => !data.results[id])) throw fail('NATIVE_CHECKPOINT_RESULTS_UNCONFIRMED');
            return [...data.messages, ...data.events.map(event => event.kind === 'assistant'
                ? { role: 'assistant', content: event.content }
                : { role: 'user', content: '[已结清的原生工具结果；用于接续，不要重复执行这些动作]\n' + JSON.stringify(data.results[event.invocationId]) })];
        },
    });
}
module.exports = { createNativeContinuationStore };

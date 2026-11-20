const problem = code => Object.assign(new Error(code), {code});
const hex = bytes => [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
async function verifyHash(text, hash) {
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw problem('SHARED_EVENT_HASH_INVALID');
    const actual = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
    if (actual !== hash) throw problem('SHARED_EVENT_HASH_INVALID');
}

const nativeIdentity = (request, value) => {
    if(!value || typeof value.nativeRequestId!=='string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(value.nativeRequestId)
        || !Number.isSafeInteger(value.ordinal) || value.ordinal<0
        || typeof value.memberName!=='string' || value.memberName.length>160)throw problem('SHARED_EVENT_NATIVE_INVALID');
    if(value.kind==='controlled-text'){
        if(request?.turn?.controlMode!=='text-only-v1'||request.turn.steeringCapable!==true
            ||value.memberId!==undefined||!Number.isSafeInteger(value.nativeGeneration)||value.nativeGeneration!==value.ordinal)throw problem('SHARED_EVENT_NATIVE_INVALID');
        const generations=request.steering?.generations;
        if(!Array.isArray(generations))throw problem('SHARED_EVENT_NATIVE_INVALID');
        const generation=generations.find(row=>row.generation===value.nativeGeneration);
        if(!generation){
            if(value.nativeGeneration>request.steering.generation)throw problem('SHARED_EVENT_RESET_REQUIRED');
            throw problem('SHARED_EVENT_NATIVE_INVALID');
        }
        if(generation.noDispatch===true||generation.requestId!==value.nativeRequestId)throw problem('SHARED_EVENT_NATIVE_INVALID');
        return {kind:value.kind,nativeRequestId:value.nativeRequestId,nativeGeneration:value.nativeGeneration,ordinal:value.ordinal,memberName:value.memberName};
    }
    if(value.kind!==undefined||!Array.isArray(request?.turn?.plan)||request.turn.plan[value.ordinal]!==value.memberId
        ||typeof value.memberId!=='string')throw problem('SHARED_EVENT_NATIVE_INVALID');
    return {nativeRequestId:value.nativeRequestId,memberId:value.memberId,ordinal:value.ordinal,memberName:value.memberName};
};
const sameNative = (a,b) => a.nativeRequestId===b.nativeRequestId&&a.memberId===b.memberId&&a.ordinal===b.ordinal&&a.kind===b.kind&&a.nativeGeneration===b.nativeGeneration;
async function nativeSnapshot(request, values, previous, maxChars) {
    const result=new Map();let chars=0;
    if(values===undefined)return result;
    if(!Array.isArray(values)||values.length>32)throw problem('SHARED_EVENT_NATIVE_INVALID');
    for(const value of values){
        const identity=nativeIdentity(request,value),old=previous.get(identity.nativeRequestId);
        if(result.has(identity.nativeRequestId)||[...result.values(),...previous.values()].some(row=>row.ordinal===identity.ordinal&&!sameNative(row,identity))
            ||old&&!sameNative(old,identity)||typeof value.text!=='string'||!Number.isSafeInteger(value.offset)||value.offset!==value.text.length
            ||typeof value.gap!=='boolean'||(chars+=value.text.length)>maxChars)throw problem('SHARED_EVENT_NATIVE_INVALID');
        await verifyHash(value.text,value.hash);result.set(identity.nativeRequestId,{...identity,text:value.text,offset:value.offset,gap:value.gap});
    }
    return result;
}

// Shared execution events are projections, never History writes or dispatches.
// The same parser runs in Electron's main process and the mobile browser.
export async function consumeSharedEvents(response, onEvent, {signal, maxFrameBytes = 2 * 1024 * 1024, idleMs = 45000} = {}) {
    if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
        const code = response.status === 401 || response.status === 403 ? 'SHARED_EVENT_PERMISSION_REQUIRED' : 'SHARED_EVENTS_UNAVAILABLE';
        await response.body?.cancel(); throw problem(code);
    }
    const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', {fatal: true});
    if (!Number.isSafeInteger(idleMs) || idleMs < 1) throw problem('INVALID_SHARED_EVENT_IDLE_TIMEOUT');
    const read = async () => {
        let timer;
        try {
            return await Promise.race([reader.read(),new Promise((_resolve,reject)=>{
                timer=setTimeout(()=>{reject(problem('SHARED_EVENT_IDLE_TIMEOUT'));void reader.cancel().catch(()=>{});},idleMs);
            })]);
        } finally { clearTimeout(timer); }
    };
    let buffer = '';
    const frame = async raw => {
        const lines = raw.split(/\r?\n/), data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) return;
        let event; try { event = JSON.parse(data); } catch { throw problem('SHARED_EVENT_MALFORMED'); }
        const type = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
        if (!event || typeof event !== 'object' || Array.isArray(event) || (type && event.type !== type)) throw problem('SHARED_EVENT_MALFORMED');
        await onEvent(event);
    };
    try {
        while (!signal?.aborted) {
            const {value, done} = await read();
            buffer += done ? decoder.decode() : decoder.decode(value, {stream: true});
            let boundary;
            while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
                const raw = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
                if (new TextEncoder().encode(raw).length > maxFrameBytes) throw problem('SHARED_EVENT_BUDGET');
                await frame(raw);
            }
            if (new TextEncoder().encode(buffer).length > maxFrameBytes) throw problem('SHARED_EVENT_BUDGET');
            if (done) {
                if (buffer.trim()) throw problem('SHARED_EVENT_INCOMPLETE');
                if (!signal?.aborted) throw problem('SHARED_EVENT_DISCONNECTED');
                break;
            }
        }
    } finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
}

export class SharedEventProjection {
    constructor({executionId, sharedId, sharedSpaceId, maxTextChars = 256 * 1024}) {
        Object.assign(this, {executionId, sharedId, sharedSpaceId, maxTextChars});
        this.epoch = null; this.seq = 0; this.offset = 0; this.text = ''; this.gap = false;
        this.nativeBodies=new Map();
        this.request = null; this.native = null; this.activity = null; this.connection = 'connecting'; this.partialResult = null;
    }
    async apply(event) {
        if (event.executionId !== this.executionId || event.generation !== 0 || typeof event.epoch !== 'string'
            || !event.epoch || event.epoch.length > 100 || !Number.isSafeInteger(event.seq) || event.seq < 0) throw problem('SHARED_EVENT_IDENTITY_MISMATCH');
        if (event.sharedId !== undefined && event.sharedId !== this.sharedId
            || event.sharedSpaceId !== undefined && event.sharedSpaceId !== this.sharedSpaceId) throw problem('SHARED_EVENT_IDENTITY_MISMATCH');
        if (event.type === 'gap' || event.type === 'reset') {
            this.epoch = null; this.seq = 0; this.gap = true; return true;
        }
        if (event.type === 'snapshot') {
            if (event.epoch === this.epoch && event.seq < this.seq) return false;
            const body = event.body;
            if (!event.request || event.request.id !== this.executionId || !body || typeof body.text !== 'string'
                || !Number.isSafeInteger(body.endOffset) || body.endOffset < 0 || body.offset !== 0
                || typeof body.complete !== 'boolean' || body.complete && body.text.length !== body.endOffset) throw problem('SHARED_EVENT_SNAPSHOT_INVALID');
            if (body.complete) await verifyHash(body.text, body.hash);
            const partial = event.partialResult;
            if (partial !== undefined) {
                if (!partial || partial.version !== 1 || partial.kind !== 'length' || partial.finishReason !== 'length'
                    || partial.committed !== false || partial.source !== 'pending_operation' || body.source !== 'pending_operation'
                    || event.request.state !== 'review_required' || event.native?.id !== this.executionId || event.native.state !== 'review_required'
                    || partial.executionId !== this.executionId || partial.sharedId !== this.sharedId || partial.sharedSpaceId !== this.sharedSpaceId
                    || typeof partial.requestId !== 'string' || !partial.requestId || partial.requestId !== event.request.requestId
                    || typeof partial.userMessageId !== 'string' || !partial.userMessageId
                    || partial.messageId !== 'reply_' + this.executionId || body.messageId !== partial.messageId
                    || !body.complete || body.text.length !== body.endOffset || body.text.length > this.maxTextChars
                    || partial.contentHash !== body.hash) throw problem('SHARED_EVENT_PARTIAL_INVALID');
            }
            const activity=event.activity;
            if(activity!==undefined&&!(activity?.type==='tool'&&['started','accepted','settled','observed'].includes(activity.state)
                ||activity?.type==='approval'&&['waiting_approval','running'].includes(activity.state)))throw problem('SHARED_EVENT_SNAPSHOT_INVALID');
            if(this.request&&this.request.turn?.controlMode!==event.request.turn?.controlMode)throw problem('SHARED_EVENT_NATIVE_INVALID');
            if(Array.isArray(this.request?.turn?.plan)&&JSON.stringify(this.request.turn.plan)!==JSON.stringify(event.request.turn?.plan))throw problem('SHARED_EVENT_NATIVE_INVALID');
            const nativeBodies=await nativeSnapshot(event.request,event.nativeBodies,this.nativeBodies,this.maxTextChars-body.text.length);
            this.text = body.complete ? body.text.slice(-this.maxTextChars) : '';
            this.gap = !body.complete || body.text.length > this.maxTextChars;
            this.nativeBodies=nativeBodies;
            this.offset = body.endOffset; this.request = event.request; this.native = event.native; this.activity = activity?{type:activity.type,state:activity.state}:null; this.partialResult = partial || null;
            this.epoch = event.epoch; this.seq = event.seq; this.connection = 'online'; return true;
        }
        if (event.epoch !== this.epoch) throw problem('SHARED_EVENT_RESET_REQUIRED');
        if (event.seq <= this.seq) return false;
        if (event.seq !== this.seq + 1) throw problem('SHARED_EVENT_GAP');
        if (this.partialResult && event.type === 'delta') throw problem('SHARED_EVENT_PARTIAL_CONFLICT');
        if (this.partialResult && event.type === 'state') {
            // Once a partial body is attested, hints cannot mutate its proof or
            // native state. Re-read the existing authoritative snapshot.
            this.epoch = null; throw problem('SHARED_EVENT_TERMINAL_REFRESH');
        }
        if(['native_start','native_delta','native_gap'].includes(event.type)){
            if(['completed','abandoned','failed','cancelled','review_required'].includes(this.request?.state))throw problem('SHARED_EVENT_NATIVE_INVALID');
            const value=event.payload,identity=nativeIdentity(this.request,value),old=this.nativeBodies.get(identity.nativeRequestId);
            if(identity.kind==='controlled-text'&&identity.nativeGeneration!==this.request.steering.generation)throw problem('SHARED_EVENT_NATIVE_INVALID');
            if([...this.nativeBodies.values()].some(row=>row.ordinal===identity.ordinal&&!sameNative(row,identity))||old&&!sameNative(old,identity))throw problem('SHARED_EVENT_NATIVE_INVALID');
            let next;
            if(event.type==='native_start'){
                if(!old&&this.nativeBodies.size>=32)throw problem('SHARED_EVENT_BUDGET');
                next=old||{...identity,text:'',offset:0,gap:false};
            }else{
                if(!old||old.gap||value.offset!==old.offset)throw problem('SHARED_EVENT_NATIVE_INVALID');
                if(event.type==='native_gap'){
                    await verifyHash(old.text,value.hash);next={...old,gap:true};
                }else{
                    if(typeof value.text!=='string'||value.endOffset!==old.offset+value.text.length
                        ||this.text.length+[...this.nativeBodies.values()].reduce((n,row)=>n+row.text.length,0)+value.text.length>this.maxTextChars)throw problem('SHARED_EVENT_NATIVE_INVALID');
                    await verifyHash(value.text,value.hash);next={...old,text:old.text+value.text,offset:value.endOffset};
                }
            }
            this.nativeBodies.set(identity.nativeRequestId,next);this.seq=event.seq;this.connection='online';this.activity=null;return true;
        }
        if (event.type === 'delta') {
            if(this.nativeBodies.size)throw problem('SHARED_EVENT_NATIVE_INVALID');
            const delta = event.payload;
            if (!delta || typeof delta.text !== 'string' || delta.offset !== this.offset || delta.endOffset !== this.offset + delta.text.length) throw problem('SHARED_EVENT_GAP');
            await verifyHash(delta.text, delta.hash);
            this.text += delta.text; this.offset = delta.endOffset;
            if (this.text.length > this.maxTextChars) { this.text = this.text.slice(-this.maxTextChars); this.gap = true; }
        }
        if(event.type === 'state' && ['queued','running','publishing','waiting_approval','cancelling','review_required','failed','cancelled'].includes(event.payload?.state)) {
            this.native={...(this.native||{}),id:this.executionId,state:event.payload.state};
        }
        if(event.type === 'tool' && ['started','accepted','settled','observed'].includes(event.payload?.state)
            || event.type === 'approval' && ['waiting_approval','running'].includes(event.payload?.state)) {
            this.activity={type:event.type,state:event.payload.state};
        }
        if(event.type === 'delta' || event.type === 'state') this.activity=null;
        this.seq = event.seq; this.connection = 'online'; return true;
    }
    value() {
        return {executionId: this.executionId, sharedId: this.sharedId, sharedSpaceId: this.sharedSpaceId,
            epoch: this.epoch, seq: this.seq, generation: 0, text: this.text, offset: this.offset,
            gap: this.gap, connection: this.connection, nativeBodies:[...this.nativeBodies.values()].map(row=>({...row})), request: this.request, native: this.native, activity: this.activity,
            ...(this.partialResult ? {partialResult: this.partialResult} : {})};
    }
}

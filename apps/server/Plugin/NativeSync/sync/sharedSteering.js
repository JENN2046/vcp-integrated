'use strict';
const { stable, sha256 } = require('./protocol');
const controlled=require('./sharedControlledText');
const fail = (code, status = 409) => Object.assign(Error(code), { code, status });
const id = value => { if (typeof value !== 'string' || !value || value.length > 256 || /[\0\r\n]/.test(value)) throw fail('INVALID_STEERING_INPUT', 400); return value; };

/** Control facts belong to NativeSync; execution and task checkpoints stay native. */
class SharedSteering {
    constructor(shared, { enabled = false, now = Date.now } = {}) {
        this.shared = shared; this.db = shared.db; this.enabled = enabled; this.now = now;
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS shared_native_no_dispatch(work_id TEXT NOT NULL,generation INTEGER NOT NULL,PRIMARY KEY(work_id,generation));
          CREATE TABLE IF NOT EXISTS shared_native_checkpoints(work_id TEXT NOT NULL,generation INTEGER NOT NULL,proof_json TEXT NOT NULL,PRIMARY KEY(work_id,generation));
          CREATE TABLE IF NOT EXISTS shared_work_controls(
            work_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, generation INTEGER NOT NULL,
            consumed_seq INTEGER NOT NULL, executor TEXT NOT NULL, updated_at INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS shared_work_inputs(
            work_id TEXT NOT NULL, input_id TEXT NOT NULL, principal TEXT NOT NULL, input_hash TEXT NOT NULL,
            input_seq INTEGER NOT NULL, message_json TEXT NOT NULL, attachments_ready INTEGER NOT NULL,
            journal_seq INTEGER, PRIMARY KEY(work_id,input_id), UNIQUE(work_id,input_seq));
          CREATE TABLE IF NOT EXISTS shared_work_generations(
            work_id TEXT NOT NULL, generation INTEGER NOT NULL, revision INTEGER NOT NULL,
            consumed_seq INTEGER NOT NULL, executor TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
            config_json TEXT NOT NULL, state TEXT NOT NULL, checkpoint_json TEXT,
            PRIMARY KEY(work_id,generation));`);
    }
    requireEnabled() { if (!this.enabled || this.shared.readOnly) throw fail('SHARED_STEERING_UNAVAILABLE'); }
    admission(actor, space, work, {existing=false,observe=false}={}) {
        if(!existing)this.requireEnabled();
        if(actor?.kind!=='desktop')throw fail('SHARED_STEERING_DEVICE_REQUIRED',403);
        const row = this.shared.admission(actor, space, id(work));if(existing&&!this.enabled&&!this.db.prepare('SELECT 1 FROM shared_work_controls WHERE work_id=?').get(row.id))throw fail('SHARED_STEERING_UNAVAILABLE');
        const topic = this.shared.topic(actor, space, row.topic_id, 'execute');
        if(!require('./sharedTurns').intent(row).steeringCapable)throw fail('SHARED_STEERING_TARGET_UNSUPPORTED');
        if(!observe&&!controlled.enabled(this.shared,require('./sharedTurns').intent(row).controlMode))throw fail('SHARED_STEERING_UNAVAILABLE');
        if (topic.owner_type !== 'agent') throw fail('SHARED_STEERING_SINGLE_CHAT_ONLY');
        return { row, topic };
    }
    control(row) {
        let c = this.db.prepare('SELECT * FROM shared_work_controls WHERE work_id=?').get(row.id);
        if (!c) {
            this.db.prepare('INSERT INTO shared_work_controls VALUES(?,0,0,0,?,?)').run(row.id, row.principal, this.now());
            this.db.prepare("INSERT INTO shared_work_generations VALUES(?,0,0,0,?,?,?,'prepared',NULL)")
                .run(row.id, row.principal, 'reply_' + row.id, row.config_json);
            c = this.db.prepare('SELECT * FROM shared_work_controls WHERE work_id=?').get(row.id);
        }
        return c;
    }
    public(row, c) {
        if (!c) return {workId:row.id,revision:0,generation:0,consumedInputSeq:0,latestInputSeq:0,executor:row.principal,applicationState:'unstarted',inputs:[]};
        const pending = this.db.prepare('SELECT input_id,input_seq,attachments_ready,journal_seq FROM shared_work_inputs WHERE work_id=? AND input_seq>? ORDER BY input_seq').all(row.id, c.consumed_seq);
        const current = this.db.prepare('SELECT state,revision,config_json,checkpoint_json FROM shared_work_generations WHERE work_id=? AND generation=?').get(row.id, c.generation);
        const native = this.shared.native?.engine.nativeTasks;
        const safeToolMode=require('./sharedTurns').intent(row).controlMode===controlled.TOOLS_MODE;
        const unknown = row.state === 'review_required' || native?.needsReview(row.id) ||
            (native?.uncertainTools(row.id) && !(safeToolMode&&row.state==='dispatched'&&native.unsettledTools(row.id)));
        // Child tools already bound to the new revision can continue independently.
        const busy = this.db.prepare("SELECT 1 FROM mobile_native_invocations i LEFT JOIN shared_native_child_requests r ON r.id=i.native_request_id WHERE i.execution_id=? AND i.state='started' AND (r.id IS NULL OR r.control_revision<?) LIMIT 1").get(row.id,c.revision);
        const tasks = native?.list(row.id) || [];
        const waitingTasks = tasks.some(t => !['completed','failed','cancelled','stopped'].includes(t.state) && (t.appliedControlRevision < c.revision || t.safeBoundary !== true));
        const controlError=tasks.find(t=>!['completed','failed','cancelled','stopped'].includes(t.state)&&t.controlError)?.controlError;
        const compaction=this.shared.compaction?.active(row.id);
        const safeToolBoundary=safeToolMode&&c.generation===0&&current?.state==='paused'&&Boolean(current.checkpoint_json);
        const compacted=safeToolBoundary&&this.hasToolCompaction(row.id);
        const state = unknown||controlError ? 'blocked' : compaction?'compacting':safeToolBoundary?(!compacted?'awaiting_compaction':c.executor===row.principal?'awaiting_handoff':'ready'):pending.some(p => !p.attachments_ready || !p.journal_seq) ? 'attachments_pending'
            : pending.length ? (busy || waitingTasks || !['paused','paused_terminal'].includes(current?.state) || !current?.checkpoint_json ? 'waiting_safe_boundary' : 'ready') : current?.state==='paused'&&current.checkpoint_json&&JSON.parse(current.checkpoint_json).noDispatch?'ready':['prepared','preprocessing'].includes(current?.state) ? 'applying' : 'applied';
        return { workId: row.id, ...(safeToolMode?{controlMode:controlled.TOOLS_MODE,safeToolBoundary,
            requiresCompaction:safeToolBoundary&&!compacted,requiresHandoff:safeToolBoundary&&compacted&&c.executor===row.principal}:{}), revision: c.revision, generation: c.generation, consumedInputSeq: c.consumed_seq,
            generations:this.db.prepare('SELECT generation,request_id,state,config_json,checkpoint_json FROM shared_work_generations WHERE work_id=? ORDER BY generation').all(row.id).map(g=>({generation:g.generation,requestId:g.request_id,state:g.state,model:JSON.parse(g.config_json).owner.config.model,noDispatch:Boolean(g.checkpoint_json&&JSON.parse(g.checkpoint_json).noDispatch)})),generationRevision:current?.revision,frozenConfigHash:current?JSON.parse(current.config_json).hash:null,compaction,latestInputSeq: c.revision, noDispatch:Boolean(current?.checkpoint_json&&JSON.parse(current.checkpoint_json).noDispatch), executor: c.executor, applicationState: state,
            ...(unknown||controlError ? { blockedReason: controlError||'NATIVE_RESULT_REQUIRES_REVIEW' } : {}),
            inputs: pending.map(p => ({ inputId: p.input_id, inputSeq: p.input_seq, attachmentsReady: Boolean(p.attachments_ready), journalSeq: p.journal_seq })) };
    }
    status(actor, body) {
        const { row, topic } = this.admission(actor, body.sharedSpaceId, body.workId,{existing:true,observe:true});
        const status=this.public(row,this.db.prepare('SELECT * FROM shared_work_controls WHERE work_id=?').get(row.id));
        if(body.pausedRequestId===undefined)return status;
        // Confirm the exact native generation against its committed Journal projection.
        // A renderer may receive the stop before its local History has caught up.
        const first=status.generations?.find(g=>g.generation===0 && g.requestId===body.pausedRequestId);
        if(status.controlMode!==controlled.TOOLS_MODE || row.state==='review_required' || first?.state!=='paused' || first.noDispatch)
            return {...status,pausedReply:null};
        const [record]=this.shared.store.readProjected(()=>this.db.prepare(
            'SELECT * FROM messages WHERE owner_type=? AND owner_id=? AND topic_id=? AND msg_id=? AND deleted=0'
        ).all(topic.owner_type,topic.owner_id,topic.topic_id,first.requestId));
        const message=record?.message;
        if(message?.role!=='assistant'||message.finishReason!=='interrupted'||message.continuity?.executionId!==row.id)
            throw fail('NATIVE_CHECKPOINT_CHANGED');
        return {...status,pausedReply:{message,seq:record.row.last_seq}};
    }
    submit(actor, body) {
        const { row, topic } = this.admission(actor, body.sharedSpaceId, body.workId);
        require('./sharedControlledText').assertWork(this.shared,row,topic,actor,body.message);
        const mode=require('./sharedTurns').intent(row).controlMode;
        if(mode===controlled.TOOLS_MODE)throw fail('CONTROLLED_TOOL_STEERING_UNAVAILABLE');
        if(mode===controlled.MODE&&body.attachmentManifest?.length)throw fail('CONTROLLED_TEXT_PORTABLE_REQUIRED');
        id(body.inputId); id(body.message?.id);
        if (body.message.id !== body.inputId || body.message.role !== 'user' || typeof body.message.content !== 'string') throw fail('INVALID_STEERING_INPUT', 400);
        if (!Number.isSafeInteger(body.observedRevision) || body.observedRevision < 0) throw fail('INVALID_STEERING_REVISION', 400);
        if (JSON.stringify(body.message).length > 512 * 1024) throw fail('BODY_TOO_LARGE', 413);
        const manifest=body.attachmentManifest||null;if(manifest&&(!Array.isArray(manifest)||manifest.length>8||manifest.some(a=>typeof a.name!=='string'||typeof a.type!=='string'||!Number.isSafeInteger(a.size)||a.size<0)))throw fail('INVALID_STEERING_ATTACHMENT_MANIFEST',400);
        const modelSave=body.modelSaveRef||null;if(modelSave&&(!modelSave.opId||typeof modelSave.model!=='string'||!modelSave.model))throw fail('INVALID_MODEL_SAVE_REFERENCE',400);
        const hash = sha256(stable({message:body.message,manifest,modelSave}));
        const result = this.shared.receipt(actor, body, 'steer', () => {
            if (!['accepted','dispatched','review_required'].includes(row.state)) throw fail('STEERING_TARGET_FINISHED');
            let c = this.control(row);
            if (body.observedRevision > c.revision) throw fail('STEERING_REVISION_CHANGED');
            const old = this.db.prepare('SELECT * FROM shared_work_inputs WHERE work_id=? AND input_id=?').get(row.id, body.inputId);
            if (old) {
                if (old.principal !== actor.principal || old.input_hash !== hash) throw fail('REQUEST_ID_REUSED');
                return { ...this.public(row, c), inputId: old.input_id, inputSeq: old.input_seq };
            }
            const revision = c.revision + 1;
            this.db.prepare('INSERT INTO shared_work_inputs VALUES(?,?,?,?,?,?,?,NULL)').run(row.id, body.inputId, actor.principal, hash, revision, JSON.stringify({...body.message,...(manifest?{_steeringAttachmentManifest:manifest}:{}),...(modelSave?{_steeringModelSave:modelSave}:{})}), body.attachmentsReady === false ? 0 : 1);
            this.db.prepare('UPDATE shared_work_controls SET revision=?,updated_at=? WHERE work_id=?').run(revision, this.now(), row.id);this.shared.compaction?.invalidate(row.id);
            this.commitReadyInputs(row, topic);
            if (!this.db.prepare("SELECT 1 FROM shared_native_requests WHERE admission_id=? AND state IN ('dispatched','unknown')").get(row.id)) {
                const current=this.generation(row.id,c.generation);
                const knownTerminal=this.db.prepare("SELECT 1 FROM shared_native_requests WHERE admission_id=? AND id=? AND state='model_terminal'").get(row.id,current.request_id);
                if(!knownTerminal){
                    this.db.prepare('INSERT OR IGNORE INTO shared_native_no_dispatch VALUES(?,?)').run(row.id,c.generation);
                    const proof={requestId:current.request_id,hash:null,settledInvocationIds:[],noDispatch:true};
                    this.db.prepare('INSERT OR REPLACE INTO shared_native_checkpoints VALUES(?,?,?)').run(row.id,c.generation,JSON.stringify(proof));
                    // Internal safe marker only: no synthetic assistant message in history.
                    this.db.prepare('UPDATE shared_work_generations SET checkpoint_json=? WHERE work_id=? AND generation=?').run(JSON.stringify({noDispatch:true}),row.id,c.generation);
                }
                this.db.prepare('UPDATE shared_work_generations SET state=? WHERE work_id=? AND generation=?').run(knownTerminal?'paused_terminal':'paused',row.id,c.generation);
                this.db.prepare("UPDATE shared_native_requests SET state='model_terminal' WHERE admission_id=? AND state='prepared'").run(row.id);
            }
            c = this.db.prepare('SELECT * FROM shared_work_controls WHERE work_id=?').get(row.id);
            return { ...this.public(row, c), inputId: body.inputId, inputSeq: revision };
        });
        // The durable revision is already visible to every dispatch fence. Notification
        // failure cannot undo acceptance, repeat the input, or restore old authority.
        Promise.resolve().then(() => this.onInput?.(row.id, result.revision)).catch(() => {});
        return result;
    }
    commitReadyInputs(row, topic) {
        for (const input of this.db.prepare('SELECT * FROM shared_work_inputs WHERE work_id=? AND journal_seq IS NULL ORDER BY input_seq').all(row.id)) {
            if (!input.attachments_ready) break;
            const message = JSON.parse(input.message_json);
            const source = input.principal.startsWith('desktop:') ? this.db.prepare('SELECT source_id,device_id FROM shared_members WHERE space_id=? AND device_id=?').get(row.space_id, input.principal.slice(8)) : null;
            if (!source) throw fail('SHARED_STEERING_DEVICE_REQUIRED');
            const actor = { kind: 'desktop', principal: input.principal, sourceId: source.source_id, deviceId: source.device_id };
            require('./sharedAttachments').validate(this.shared, actor, topic, message, this.shared.freezeForExecution(actor,topic), { kind: 'message' });
            const metadata = require('./metadata'), normalized = { ...message,continuity:{version:1,known:true,executionId:row.id,requestId:input.input_id,dependsOnMessageIds:[...new Set([require('./sharedTurns').intent(row).userMessageId,this.db.prepare('SELECT input_id FROM shared_work_inputs WHERE work_id=? AND input_seq<? AND journal_seq IS NOT NULL ORDER BY input_seq DESC LIMIT 1').get(row.id,input.input_seq)?.input_id].filter(Boolean))].slice(-1000)}}; delete normalized._nativeSyncMetadata;delete normalized._steeringAttachmentManifest;delete normalized._steeringModelSave;
            const receipt = this.shared.store.apply({ ownerType: topic.owner_type, ownerId: topic.owner_id, topicId: topic.topic_id,
                msgId: message.id, deviceId: input.principal, opId: 'shared-steer:' + row.id + ':' + input.input_id,
                baseHash: null, action: 'upsert', message: normalized, metadata: metadata.envelopeFor(normalized, 1) },
                { sharedSpace: row.space_id, attachmentPrincipal: input.principal, metadataPublisher: true });
            this.db.prepare('UPDATE shared_work_inputs SET journal_seq=? WHERE work_id=? AND input_id=?').run(receipt.seq, row.id, input.input_id);
        }
    }
    ready(actor, body) {
        const { row, topic } = this.admission(actor, body.sharedSpaceId, body.workId);
        const result=this.shared.receipt(actor, body, 'steer-ready', () => {
            const input = this.db.prepare('SELECT * FROM shared_work_inputs WHERE work_id=? AND input_id=?').get(row.id, id(body.inputId));
            if (!input || input.principal !== actor.principal) throw fail('SHARED_REQUEST_OWNER_REQUIRED', 403);
            const prior = JSON.parse(input.message_json), message = body.message;
            require('./sharedControlledText').assertWork(this.shared,row,topic,actor,message);
            if (!message || message.id !== prior.id || message.role !== 'user' || message.content !== prior.content) throw fail('STEERING_INPUT_CHANGED');
            const shape = a => (a || []).map(v => ({ name: v.name, type: v.type, size: v.size, hash: v.blobHash || v.hash }));
            if(prior._steeringAttachmentManifest){const actual=shape(message.attachments),manifest=prior._steeringAttachmentManifest;if(manifest.length!==actual.length||manifest.some((a,i)=>a.name!==actual[i].name||a.type!==actual[i].type||a.size!==actual[i].size||a.hash&&a.hash!==actual[i].hash))throw fail('STEERING_ATTACHMENT_CHANGED');}
            else if (stable(shape(prior.attachments)) !== stable(shape(message.attachments))) throw fail('STEERING_ATTACHMENT_CHANGED');
            if(prior._steeringModelSave){if(stable(body.modelSaveRef)!==stable(prior._steeringModelSave))throw fail('MODEL_SAVE_REFERENCE_CHANGED');this.shared.checkModelSave(actor,topic,prior._steeringModelSave,this.shared.freezeForExecution(actor,topic),body.modelSaveResolutionRef);}
            require('./sharedAttachments').validate(this.shared, actor, topic, message, this.shared.freezeForExecution(actor,topic), { kind: 'message' });
            if (!input.journal_seq) this.db.prepare('UPDATE shared_work_inputs SET attachments_ready=1,message_json=? WHERE work_id=? AND input_id=?').run(JSON.stringify({...message,...(prior._steeringModelSave?{_steeringModelSave:prior._steeringModelSave}:{})}), row.id, input.input_id);
            this.commitReadyInputs(row, topic);
            return this.public(row, this.control(row));
        });
        Promise.resolve().then(()=>this.onInput?.(row.id,result.revision)).catch(()=>{});return result;
    }
    fence(workId, generation = 0, executor = null) {
        const c = this.db.prepare('SELECT * FROM shared_work_controls WHERE work_id=?').get(workId);
        if(c&&executor&&c.executor!==executor)throw fail('WORK_EXECUTOR_HANDOFF_REQUIRED');
        if (c && (generation !== c.generation || c.revision > c.consumed_seq)) throw fail('WORK_STEERING_PENDING');
        if(c&&!['prepared','preprocessing','running'].includes(this.generation(workId,generation)?.state))throw fail('SHARED_GENERATION_FENCED');
    }
    modelStopped(workId, requestId) {
        const c = this.db.prepare('SELECT * FROM shared_work_controls WHERE work_id=?').get(workId);
        if (!c || c.revision <= c.consumed_seq) return false;
        const generation = this.db.prepare('SELECT * FROM shared_work_generations WHERE work_id=? AND request_id=?').get(workId, requestId);
        if (!generation) return false;
        this.db.prepare("UPDATE shared_work_generations SET state='paused' WHERE work_id=? AND generation=?").run(workId, generation.generation);
        return true;
    }
    decorateReply(row,generation,message){
        if(!generation||!message)return message;
        const root=require('./sharedTurns').intent(row).userMessageId,inputs=this.db.prepare('SELECT input_id FROM shared_work_inputs WHERE work_id=? AND input_seq<=? AND journal_seq IS NOT NULL ORDER BY input_seq').all(row.id,generation.consumed_seq).map(v=>v.input_id);
        const data=this.shared.native?.continuations.read(generation.request_id),sourceIds=(data?.metadata?.messageTimestampBindings||[]).map(v=>v.messageId).filter(id=>id!==message.id&&!this.db.prepare('SELECT 1 FROM shared_work_inputs WHERE work_id=? AND input_id=? AND input_seq>?').get(row.id,id,generation.consumed_seq));
        return {...message,continuity:{version:1,known:true,executionId:row.id,requestId:generation.request_id,dependsOnMessageIds:[...new Set([root,inputs.at(-1),...sourceIds].filter(id=>id&&id!==message.id))].slice(0,1000)}};
    }
    hasToolCompaction(workId){
        return Boolean(this.db.prepare('SELECT 1 FROM shared_work_compactions WHERE work_id=?').get(workId));
    }
    checkpointSettledTool(actor,row,generation){
        const data=this.shared.native.continuations.read(generation.request_id);
        if(!data)throw fail('NATIVE_CHECKPOINT_REQUIRED');
        // Model tool envelopes can include private arguments. Journal only the
        // visible assistant prefix, while the native archive retains the exact source.
        const text=data.assistant.at(-1)||'';
        const parser=require('../../../modules/vcpLoop/toolCallParser');
        const firstTool=parser.extractNextToolBlock(text);
        const content=firstTool?text.slice(0,firstTool.startIndex):'';
        return this.checkpoint(actor,{sharedSpaceId:row.space_id,workId:row.id,opId:'safe_tool_checkpoint_'+sha256(generation.request_id).slice(0,40),
            generation:generation.generation,message:{id:generation.request_id,role:'assistant',content,timestamp:this.now(),finishReason:'interrupted'}});
    }
    checkpoint(actor, body) {
        const { row, topic } = this.admission(actor, body.sharedSpaceId, body.workId,{existing:true});
        return this.shared.receipt(actor, body, 'steer-checkpoint', () => {
            if(!['accepted','dispatched'].includes(row.state))throw fail('SHARED_REQUEST_FENCED');
            const generation = this.db.prepare('SELECT * FROM shared_work_generations WHERE work_id=? AND generation=?').get(row.id, body.generation);
            if (!generation || generation.executor !== actor.principal) throw fail('SHARED_REQUEST_OWNER_REQUIRED', 403);
            if (!['paused','paused_terminal'].includes(generation.state)) throw fail('WORK_SAFE_BOUNDARY_PENDING');
            const native = this.shared.native?.engine.nativeTasks;
            if (native?.unsettledTools(row.id) || native?.needsReview(row.id)||native?.uncertainTools(row.id)) throw fail('WORK_SAFE_BOUNDARY_PENDING');
            const message = this.decorateReply(row,generation,body.message);
            if (message?.id !== generation.request_id || message.role !== 'assistant' || (generation.state==='paused' ? message.finishReason !== 'interrupted' : !['completed','failed','interrupted','cancelled','length'].includes(message.finishReason))) throw fail('INVALID_STEERING_CHECKPOINT');
            if (generation.checkpoint_json && stable(JSON.parse(generation.checkpoint_json)) !== stable(message)) throw fail('SHARED_REPLY_INTENT_CHANGED');
            const settled=this.db.prepare("SELECT invocation_id FROM mobile_native_invocations WHERE execution_id=? AND native_request_id=? AND (state='returned' OR (state='error' AND error_code='NATIVE_CANCELLED_BEFORE_EXECUTION')) ORDER BY invocation_id").all(row.id,generation.request_id).map(r=>r.invocation_id);
            const proof=require('./sharedTurns').intent(row).controlMode===controlled.TOOLS_MODE
                ? this.shared.native.verifiedToolBoundary(row.id,generation.request_id)
                : this.shared.native.checkpointProof(row.id,generation.request_id,settled);
            this.db.prepare('INSERT OR REPLACE INTO shared_native_checkpoints VALUES(?,?,?)').run(row.id,body.generation,JSON.stringify(proof));
            const normalized = { ...message }; delete normalized._nativeSyncMetadata;
            const metadata = require('./metadata');
            this.shared.store.apply({ ownerType: topic.owner_type, ownerId: topic.owner_id, topicId: topic.topic_id,
                msgId: message.id, deviceId: actor.principal, opId: 'steer-checkpoint:' + row.id + ':' + body.generation,
                baseHash: null, action: 'upsert', message: normalized, metadata: metadata.envelopeFor(message, 1) },
                { sharedSpace: row.space_id, metadataPublisher: true });
            this.db.prepare('UPDATE shared_work_generations SET checkpoint_json=? WHERE work_id=? AND generation=?').run(JSON.stringify(message), row.id, body.generation);
            return this.public(row, this.control(row));
        });
    }
    finalReply(actor, {sharedSpaceId,workId,requestId,generation}) {
        if(generation!=='1')throw fail('INVALID_SHARED_REQUEST',400);
        id(requestId);
        const store=this.shared.store;
        return store.readSnapshot(()=>{
            const {row,topic}=this.admission(actor,sharedSpaceId,workId,{existing:true,observe:true});
            const step=this.generation(workId,1);
            if(require('./sharedTurns').intent(row).controlMode!==controlled.TOOLS_MODE||step?.request_id!==requestId)
                throw fail('SHARED_REQUEST_NOT_FOUND',404);
            if(step.executor!==actor.principal)throw fail('SHARED_REQUEST_OWNER_REQUIRED',403);

            const identity={workId,sharedId:topic.id,requestId,generation:1};
            if(['review_required','abandoned'].includes(row.state))return {...identity,state:'review_required',workState:row.state};
            if(row.state!=='completed')return {...identity,state:'pending'};

            const seq=row.reply_seq;
            const op=store.findOp.get(step.executor,'work-reply:'+workId+':1');
            const receipt=op&&JSON.parse(op.result_json);
            const key=[topic.owner_type,topic.owner_id,topic.topic_id,requestId];
            if(step.state!=='completed'||!row.native_terminal||!Number.isSafeInteger(seq)||seq<1||
                receipt?.seq!==seq||receipt.deleted!==false)throw fail('NATIVE_CHECKPOINT_CHANGED');
            const [original]=store.readProjected(()=>this.db.prepare(
                'SELECT * FROM journal WHERE seq=? AND owner_type=? AND owner_id=? AND topic_id=? AND msg_id=?'
            ).all(seq,...key));
            const currentRow=store.findMessage.get(...key);
            const initial=original?.message;
            if(original?.row.action!=='upsert'||original.row.hash!==receipt.hash||original.row.device_id!==step.executor||
                original.row.metadata_version!==receipt.metadataVersion||original.row.metadata_hash!==receipt.metadataHash||
                initial?.id!==requestId||initial.role!=='assistant'||initial.finishReason!=='completed'||
                initial.continuity?.executionId!==workId||initial.continuity.requestId!==requestId||
                typeof initial.content!=='string'||!currentRow||currentRow.last_seq<seq)throw fail('NATIVE_CHECKPOINT_CHANGED');

            const message=store.projectMessage(currentRow),currentSeq=currentRow.last_seq;
            const historyState=currentRow.deleted?'deleted':currentSeq===seq?'original':'edited';
            return {...identity,state:'committed',seq,currentSeq,historyState,contentHash:sha256(initial.content),message};
        });
    }
    completeTurn(actor, body) {
        const {row:admission,topic}=this.admission(actor,body.sharedSpaceId,body.workId,{existing:true});
        let row=admission;
        const action='steer-turn-complete',safeFinal=require('./sharedTurns').intent(row).controlMode===controlled.TOOLS_MODE&&body.generation===1;
        let intent=body;
        if(safeFinal){
            const message=body.message;
            if(message?.nativeFailure||message?.error||message?.isThinking===true||message?.attachments?.length||message?.desktopReferences?.length||
                ![undefined,'completed','stop'].includes(message?.finishReason))throw fail('SHARED_REPLY_INTENT_CHANGED');
            const generation=this.generation(row.id,body.generation);
            if(!generation||generation.executor!==actor.principal||message?.id!==generation.request_id||message.role!=='assistant')throw fail('INVALID_SHARED_REPLY');
            if(row.state==='dispatched'&&this.shared.native.tryFinalReply(row.id,generation.request_id))
                row=this.db.prepare('SELECT * FROM shared_admissions WHERE id=?').get(row.id);
            const prior=typeof body.opId==='string'&&this.db.prepare('SELECT request_hash FROM shared_receipts WHERE principal=? AND op_id=?').get(actor.principal,body.opId);
            // Preserve exact replays of receipts recorded before native publication.
            if(prior?.request_hash!==sha256(stable({action,body})))intent={...body,message:{id:message?.id,role:message?.role,content:message?.content,finishReason:'completed'}};
        }
        const result=this.shared.receipt(actor,intent,action,()=>{
            const generation=this.generation(row.id,body.generation);
            const native=this.shared.native.engine.nativeTasks;
            if(safeFinal){
                const checkpoint=generation?.checkpoint_json&&JSON.parse(generation.checkpoint_json),message=body.message;
                if(generation.executor!==actor.principal||message.id!==generation.request_id)throw fail('INVALID_SHARED_REPLY');
                if(row.state==='dispatched')throw fail('SHARED_NATIVE_TERMINAL_REQUIRED');
                if(row.state!=='completed'||generation.state!=='completed'||!row.reply_seq||!checkpoint)throw fail('SHARED_REQUEST_FENCED');
                // The device may submit after the native writer, with its own
                // local timestamp and display fields. Replay the committed op.
                if(message.content!==checkpoint.content||![undefined,'completed','stop'].includes(checkpoint.finishReason))throw fail('SHARED_REPLY_INTENT_CHANGED');
                const opId='work-reply:'+row.id+':'+generation.generation;
                if(!this.shared.store.findOp.get(generation.executor,opId))throw fail('NATIVE_CHECKPOINT_CHANGED');
                const receipt=this.applyTurnReply(row,topic,generation,checkpoint);
                if(receipt.seq!==row.reply_seq)throw fail('NATIVE_CHECKPOINT_CHANGED');
                return this.turnResult(row,checkpoint,receipt,native);
            }
            if(!['accepted','dispatched'].includes(row.state))throw fail('SHARED_REQUEST_FENCED');
            const message=this.decorateReply(row,generation,body.message);
            if(!generation||generation.executor!==actor.principal||message?.id!==generation.request_id||message.role!=='assistant')throw fail('INVALID_SHARED_REPLY');
            const request=this.db.prepare('SELECT state FROM shared_native_requests WHERE id=? AND admission_id=?').get(generation.request_id,row.id);
            if(request?.state!=='model_terminal')throw fail('SHARED_NATIVE_TERMINAL_REQUIRED');
            if(native.unsettledTools(row.id,generation.request_id))throw fail('WORK_SAFE_BOUNDARY_PENDING');
            if(require('./sharedTurns').intent(row).controlMode===controlled.TOOLS_MODE&&generation.state==='paused')throw fail('SHARED_NATIVE_TERMINAL_REQUIRED');
            if(generation.checkpoint_json&&stable(JSON.parse(generation.checkpoint_json))!==stable(message))throw fail('SHARED_REPLY_INTENT_CHANGED');
            const settled=this.db.prepare("SELECT invocation_id FROM mobile_native_invocations WHERE execution_id=? AND native_request_id=? AND (state='returned' OR (state='error' AND error_code='NATIVE_CANCELLED_BEFORE_EXECUTION')) ORDER BY invocation_id").all(row.id,generation.request_id).map(r=>r.invocation_id);
            const proof=this.shared.native.checkpointProof(row.id,generation.request_id,settled);
            const receipt=this.commitTurnReply(row,topic,generation,message,proof);
            return this.turnResult(this.db.prepare('SELECT * FROM shared_admissions WHERE id=?').get(row.id),message,receipt,native);
        });
        if(result.workState==='completed'&&!result.receipt?.replayed)this.notifyCompleted(row.id);
        return result;
    }
    applyTurnReply(row,topic,generation,message){
        const metadata=require('./metadata'),value={...message};delete value._nativeSyncMetadata;
        return this.shared.store.apply({ownerType:topic.owner_type,ownerId:topic.owner_id,topicId:topic.topic_id,
            msgId:message.id,deviceId:generation.executor,opId:'work-reply:'+row.id+':'+generation.generation,action:'upsert',
            baseHash:null,message:value,metadata:metadata.envelopeFor(message,1)},{sharedSpace:row.space_id,metadataPublisher:true});
    }
    commitTurnReply(row,topic,generation,message,proof){
        const receipt=this.applyTurnReply(row,topic,generation,message),c=this.control(row);
        const state=c.revision>generation.consumed_seq?'paused_terminal':'completed';
        this.db.prepare('INSERT OR REPLACE INTO shared_native_checkpoints VALUES(?,?,?)').run(row.id,generation.generation,JSON.stringify(proof));
        this.db.prepare('UPDATE shared_work_generations SET state=?,checkpoint_json=? WHERE work_id=? AND generation=?').run(state,JSON.stringify(message),row.id,generation.generation);
        this.db.prepare('UPDATE shared_admissions SET reply_seq=? WHERE id=?').run(receipt.seq,row.id);
        this.closeIfFinished(row.id);
        this.shared.native.phase(row.id,generation.request_id,'final_persisted');
        return receipt;
    }
    turnResult(row,message,receipt,native){
        return {turnState:message.finishReason||'completed',workState:row.state==='completed'?'completed':native.needsReview(row.id)||native.uncertainTools(row.id)?'review_required':'background',
            steering:this.public(row,this.control(row)),receipt};
    }
    publishNativeFinal(workId,requestId,data){
        const shared=this.shared,native=shared.native;
        shared.atomic(()=>{
            const row=this.db.prepare('SELECT * FROM shared_admissions WHERE id=?').get(workId);
            const generation=this.generation(workId,1),c=this.db.prepare('SELECT * FROM shared_work_controls WHERE work_id=?').get(workId);
            const request=this.db.prepare('SELECT * FROM shared_native_requests WHERE id=? AND admission_id=?').get(requestId,workId);
            const {digest,...final}=data.completion,identity=data.identity;
            if(!this.enabled||shared.readOnly||!controlled.enabled(shared,controlled.TOOLS_MODE)||row?.state!=='dispatched'||!row.dispatched||row.reply_seq!==null||
                require('./sharedTurns').intent(row).controlMode!==controlled.TOOLS_MODE||generation?.state!=='running'||generation.request_id!==requestId||
                generation.checkpoint_json!==null||c?.generation!==1||c.revision!==generation.revision||c.consumed_seq!==generation.consumed_seq||
                c.revision!==c.consumed_seq||c.executor!==generation.executor||c.executor===row.principal||
                !['dispatched','model_terminal'].includes(request?.state)||request.ordinal!==1||request.principal!==generation.executor||request.member_id!==null||
                final.version!==1||final.workId!==workId||final.requestId!==requestId||final.generation!==1||final.executor!==generation.executor||
                final.finishReason!=='stop'||typeof final.content!=='string'||!final.content.trim()||!Number.isSafeInteger(final.timestamp)||final.timestamp<0||digest!==sha256(stable(final))||
                identity.workId!==workId||identity.requestId!==requestId||identity.generation!==1||identity.controlRevision!==generation.revision)
                throw fail('NATIVE_COMPLETION_INVALID');

            const member=c.executor.startsWith('desktop:')&&this.db.prepare('SELECT source_id,device_id FROM shared_members WHERE space_id=? AND device_id=?').get(row.space_id,c.executor.slice(8));
            if(!member)throw fail('SHARED_MEMBERSHIP_REQUIRED',403);
            const actor={kind:'desktop',principal:c.executor,sourceId:member.source_id,deviceId:member.device_id};
            const topic=shared.topic(actor,row.space_id,row.topic_id,'execute');
            if(topic.id!==row.topic_id||topic.owner_type!=='agent')throw fail('NATIVE_COMPLETION_INVALID');
            this.verifyFinalToolBoundary(row,topic,generation,data);

            const owner=JSON.parse(generation.config_json).owner;
            const message=this.decorateReply(row,generation,{id:requestId,role:'assistant',agentId:topic.owner_id,topicId:topic.topic_id,
                name:owner.config.name,content:final.content,timestamp:final.timestamp,finishReason:'completed',isThinking:false});
            const proof=native.checkpointProof(workId,requestId,[]);
            this.db.prepare("UPDATE shared_native_requests SET state='model_terminal' WHERE id=?").run(requestId);
            native.phase(workId,requestId,'native_settled');
            this.commitTurnReply(row,topic,generation,message,proof);
        });
        this.notifyCompleted(workId);
        return true;
    }
    verifyFinalToolBoundary(row,topic,generation,data){
        const native=this.shared.native,tasks=native.engine.nativeTasks,first=this.generation(row.id,0);
        const firstRequest=first&&this.db.prepare('SELECT * FROM shared_native_requests WHERE id=? AND admission_id=?').get(first.request_id,row.id);
        const saved=this.db.prepare('SELECT proof_json FROM shared_native_checkpoints WHERE work_id=? AND generation=0').get(row.id);
        if(first?.state!=='paused'||!first.checkpoint_json||first.executor!==row.principal||firstRequest?.state!=='model_terminal'||firstRequest.ordinal!==0||
            firstRequest.principal!==first.executor||!saved||this.db.prepare('SELECT count(*) n FROM shared_native_requests WHERE admission_id=?').get(row.id).n!==2||
            this.db.prepare('SELECT 1 FROM shared_native_child_requests WHERE work_id=?').get(row.id)||
            tasks.list(row.id).length||tasks.unsettledTools(row.id)||tasks.uncertainTools(row.id)||tasks.needsReview(row.id)||
            Object.keys(data.results).length||data.events.some(event=>event.kind!=='assistant'))
            throw fail('NATIVE_CHECKPOINT_RESULTS_UNCONFIRMED');
        const proof=native.verifiedToolBoundary(row.id,first.request_id,JSON.parse(saved.proof_json));
        const link=this.db.prepare(`SELECT l.* FROM shared_compaction_native_links l JOIN shared_work_compactions w
            ON w.work_id=? AND w.checkpoint_id=l.checkpoint_id AND w.journal_seq=l.journal_seq
            WHERE l.request_id=? AND l.proof_hash=? AND l.through_input_seq<=? ORDER BY l.journal_seq DESC LIMIT 1`).get(row.id,first.request_id,proof.hash,generation.consumed_seq);
        if(!link)throw fail('NATIVE_COMPACTION_CHECKPOINT_MISSING');
        const [checkpoint]=this.shared.store.readProjected(()=>this.db.prepare('SELECT * FROM messages WHERE owner_type=? AND owner_id=? AND topic_id=? AND msg_id=? AND deleted=0').all(topic.owner_type,topic.owner_id,topic.topic_id,link.checkpoint_id));
        if(checkpoint?.row.last_seq!==link.journal_seq||!checkpoint.message?.contextCompaction)throw fail('NATIVE_COMPACTION_CHECKPOINT_MISSING');
    }
    notifyCompleted(workId){
        // A hint follows the authoritative transaction. It never creates a
        // terminal fact or certifies an uncommitted outer savepoint.
        if(this.db.isTransaction)return;
        try{this.shared.native?.engine.emitEvent?.(workId,'completed',{});}catch{/* Observation cannot change a committed outcome. */}
    }
    closeIfFinished(workId){
        const row=this.db.prepare('SELECT * FROM shared_admissions WHERE id=?').get(workId),c=row&&this.db.prepare('SELECT * FROM shared_work_controls WHERE work_id=?').get(workId);if(!c||c.revision!==c.consumed_seq)return;
        const generation=this.generation(workId,c.generation),native=this.shared.native?.engine.nativeTasks;
        if(generation?.state!=='completed'||this.shared.native?.taskRequests?.pending(workId)||native?.unsettledTools(workId)||native?.needsReview(workId)||native?.uncertainTools(workId)||native?.list(workId).some(t=>!['completed','failed','cancelled','stopped'].includes(t.state)))return;
        const updated=this.db.prepare("UPDATE shared_admissions SET state='completed',native_terminal=1 WHERE id=? AND state IN ('accepted','dispatched')").run(workId);
        if(updated.changes)this.notifyCompleted(workId);
    }
    prepare(actor, body) {
        this.shared.authorize(actor,body.sharedSpaceId,'config');
        const { row, topic } = this.admission(actor, body.sharedSpaceId, body.workId);
        require('./sharedControlledText').assertWork(this.shared,row,topic,actor);
        return this.shared.receipt(actor, body, 'steer-generation', () => {
            if(!['accepted','dispatched'].includes(row.state))throw fail('SHARED_REQUEST_FENCED');
            const c = this.control(row), status = this.public(row, c);
            if (c.executor !== actor.principal) throw fail('WORK_EXECUTOR_HANDOFF_REQUIRED');
            if (body.expectedRevision !== c.revision) throw fail('STEERING_REVISION_CHANGED');
            if(body.expectedGeneration!==undefined&&body.expectedGeneration!==c.generation)throw fail('STEERING_GENERATION_CHANGED');
            if (status.applicationState !== 'ready') throw fail(status.blockedReason || 'WORK_SAFE_BOUNDARY_PENDING');
            if (this.now() - c.updated_at < 150) throw fail('WORK_STEERING_COALESCING');
            const previous=this.generation(row.id,c.generation),config=c.revision===previous.revision&&status.noDispatch?JSON.parse(previous.config_json):this.shared.freezeForExecution(actor,topic),generation=c.generation+1;
            if (body.expectedHead !== this.shared.head(topic) || body.configHash !== config.hash) throw fail('SHARED_CONTEXT_CHANGED');
            for (const input of this.db.prepare('SELECT * FROM shared_work_inputs WHERE work_id=? AND input_seq>? ORDER BY input_seq').all(row.id,c.consumed_seq)) {
                const member=this.db.prepare('SELECT source_id,device_id FROM shared_members WHERE space_id=? AND device_id=?').get(row.space_id,input.principal.slice(8));
                if(!member)throw fail('SHARED_STEERING_DEVICE_REQUIRED');
                require('./sharedAttachments').validate(this.shared,{kind:'desktop',principal:input.principal,sourceId:member.source_id,deviceId:member.device_id},topic,JSON.parse(input.message_json),config,{kind:'message',accepted:true});
            }
            const modelInput=this.db.prepare('SELECT message_json FROM shared_work_inputs WHERE work_id=? AND input_seq>? ORDER BY input_seq DESC').all(row.id,c.consumed_seq).map(v=>JSON.parse(v.message_json)._steeringModelSave).find(Boolean);
            if(modelInput&&config.owner.config.model!==modelInput.model)throw fail('MODEL_SAVE_NOT_CURRENT');
            const inputIds=this.db.prepare('SELECT input_id FROM shared_work_inputs WHERE work_id=? AND input_seq>? AND input_seq<=? ORDER BY input_seq').all(row.id,c.consumed_seq,c.revision).map(v=>v.input_id);
            const requestId = 'reply_' + row.id + '_g' + generation;
            this.db.prepare("INSERT INTO shared_work_generations VALUES(?,?,?,?,?,?,?,'prepared',NULL)")
                .run(row.id, generation, c.revision, c.revision, actor.principal, requestId, JSON.stringify(config));
            this.db.prepare('UPDATE shared_work_controls SET generation=?,consumed_seq=? WHERE work_id=?').run(generation, c.revision, row.id);
            const contextCheckpoint=this.db.prepare('SELECT checkpoint_id AS messageId,through_seq AS throughInputSeq FROM shared_work_compactions WHERE work_id=? ORDER BY journal_seq DESC LIMIT 1').get(row.id);
            return { ...this.public(row, this.control(row)), inputIds,...(contextCheckpoint?{contextCheckpoint}:{}), requestId, replyId: requestId, config, contextHead: body.expectedHead };
        });
    }
    quiesceUnstarted(row,c){
        const generation=this.generation(row.id,c.generation),request=this.db.prepare('SELECT state FROM shared_native_requests WHERE id=?').get(generation.request_id);
        if(request&&request.state!=='prepared')return false;
        if(this.db.prepare("SELECT 1 FROM shared_native_requests WHERE admission_id=? AND state IN ('dispatched','unknown')").get(row.id))throw fail('WORK_SAFE_BOUNDARY_PENDING');
        this.db.prepare('INSERT OR IGNORE INTO shared_native_no_dispatch VALUES(?,?)').run(row.id,c.generation);
        this.db.prepare('INSERT OR REPLACE INTO shared_native_checkpoints VALUES(?,?,?)').run(row.id,c.generation,JSON.stringify({requestId:generation.request_id,hash:null,settledInvocationIds:[],noDispatch:true}));
        this.db.prepare("UPDATE shared_native_requests SET state='model_terminal' WHERE id=? AND state='prepared'").run(generation.request_id);
        this.db.prepare("UPDATE shared_work_generations SET state='paused',checkpoint_json=? WHERE work_id=? AND generation=?").run(JSON.stringify({noDispatch:true}),row.id,c.generation);
        let applied=0;for(let n=c.generation-1;n>=0;n--){const proof=this.db.prepare('SELECT proof_json FROM shared_native_checkpoints WHERE work_id=? AND generation=?').get(row.id,n);if(proof&&!JSON.parse(proof.proof_json).noDispatch){applied=this.generation(row.id,n).consumed_seq;break;}}
        this.db.prepare('UPDATE shared_work_controls SET consumed_seq=? WHERE work_id=?').run(applied,row.id);return true;
    }
    handoff(actor,body){
        this.shared.authorize(actor,body.sharedSpaceId,'config');
        const {row,topic}=this.admission(actor,body.sharedSpaceId,body.workId);
        require('./sharedControlledText').assertWork(this.shared,row,topic,actor);
        return this.shared.receipt(actor,body,'steer-handoff',()=>{
            const c=this.control(row);if(c.revision!==body.expectedRevision||c.generation!==body.expectedGeneration||c.executor!==body.expectedExecutor)throw fail('WORK_HANDOFF_STATE_CHANGED');
            if(!['accepted','dispatched'].includes(row.state))throw fail('WORK_SAFE_BOUNDARY_PENDING');
            const current=this.generation(row.id,c.generation),native=this.shared.native.engine.nativeTasks;
            const safeToolMode=require('./sharedTurns').intent(row).controlMode===controlled.TOOLS_MODE;
            if(safeToolMode&&(c.generation!==0||c.executor!==row.principal||actor.principal===row.principal||current.state!=='paused'||!current.checkpoint_json||!this.hasToolCompaction(row.id)))throw fail('WORK_SAFE_BOUNDARY_PENDING');
            if(native.needsReview(row.id)||native.uncertainTools(row.id)||this.db.prepare("SELECT 1 FROM shared_native_requests WHERE admission_id=? AND state IN ('dispatched','unknown')").get(row.id))throw fail('WORK_SAFE_BOUNDARY_PENDING');
            if(native.unsettledTools(row.id,current.request_id))throw fail('WORK_SAFE_BOUNDARY_PENDING');
            // Local-only resource references have no verified receiver-side grant.
            const messages=this.shared.store.readProjected(()=>this.db.prepare('SELECT * FROM messages WHERE owner_type=? AND owner_id=? AND topic_id=? AND deleted=0').all(topic.owner_type,topic.owner_id,topic.topic_id));
            if(messages.some(v=>v.message?.desktopReferences?.length)||this.db.prepare('SELECT message_json FROM shared_work_inputs WHERE work_id=? AND journal_seq IS NULL').all(row.id).some(v=>JSON.parse(v.message_json).desktopReferences?.length))throw fail('WORK_HANDOFF_REQUIRES_ORIGINAL_DEVICE');
            this.shared.freezeForExecution(actor,topic);
            const request=this.db.prepare('SELECT state FROM shared_native_requests WHERE id=?').get(current.request_id);
            if(!safeToolMode&&!this.quiesceUnstarted(row,c)&&(!current.checkpoint_json||!['paused','paused_terminal','completed'].includes(current.state)))throw fail('WORK_SAFE_BOUNDARY_PENDING');
            this.db.prepare('UPDATE shared_work_controls SET executor=? WHERE work_id=?').run(actor.principal,row.id);this.shared.compaction?.invalidate(row.id);
            return this.public(row,this.control(row));
        });
    }
    generation(workId, number) { return this.db.prepare('SELECT * FROM shared_work_generations WHERE work_id=? AND generation=?').get(workId, number); }
    requestGeneration(workId, requestId) { return this.db.prepare('SELECT * FROM shared_work_generations WHERE work_id=? AND request_id=?').get(workId, requestId); }
}
module.exports = { SharedSteering };

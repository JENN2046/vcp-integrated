'use strict';
const context = require('../../../modules/requestExecutionContext');
const controlled = require('./sharedControlledText');
const {sha256, stable} = require('./protocol');
const {intent} = require('./sharedTurns');
const {archiveReadError} = require('../mobile/nativeTasks');

const pluginName = 'AgentAssistant';
const conflict = code => Object.assign(Error(code), {code,status:409});
const pending = () => conflict('WORK_SAFE_BOUNDARY_PENDING');
const unverified = () => conflict('NATIVE_CHECKPOINT_RESULTS_UNCONFIRMED');

function linkageHash(proof) {
    return proof.delegationReceipt ? sha256(stable(proof)) : proof.hash;
}

class SharedDelegation {
    constructor(native) {
        this.native = native;
        this.shared = native.shared;
        this.db = native.db;
        this.pendingBoundaries = new Map(this.recoverableWorks().map(work => [work.id,work.generationState]));
    }

    trackAwaiting(workId) {
        this.pendingBoundaries.set(workId,'awaiting_native_task');
    }

    ownsWork(workId) {
        const work = this.db.prepare('SELECT user_op FROM shared_admissions WHERE id=?').get(workId);
        return Boolean(work && intent(work).controlMode === controlled.AA_MODE);
    }

    checkpoint(workId, requestId, savedProof) {
        const {native, db} = this;
        const tasks = native.engine.nativeTasks;
        const work = db.prepare('SELECT * FROM shared_admissions WHERE id=?').get(workId);
        const generation = this.shared.steering.generation(workId, 0);
        const parent = db.prepare('SELECT * FROM shared_native_requests WHERE id=? AND admission_id=?').get(requestId, workId);
        if (!work || intent(work).controlMode !== controlled.AA_MODE || generation?.request_id !== requestId ||
            generation.executor !== work.principal || parent?.principal !== work.principal ||
            parent.state !== 'model_terminal' || parent.ordinal !== 0 || parent.member_id !== null) throw unverified();

        const [call, extraCall] = native.toolLedger(workId);
        const links = db.prepare('SELECT * FROM mobile_native_tasks WHERE execution_id=?').all(workId);
        const [link] = links;
        if (!call || extraCall || call.plugin_name !== pluginName || call.native_request_id !== requestId ||
            call.state !== 'returned' || links.length !== 1 || link.plugin_name !== pluginName ||
            link.step_id !== requestId || link.native_request_id !== requestId ||
            link.invocation_id !== call.invocation_id || link.record_id !== call.record_id ||
            link.review_required || tasks.needsReview(workId)) throw unverified();
        if (['accepted','running','waiting','cancelling'].includes(link.state)) throw pending();
        if (link.state !== 'completed' || link.revision !== 1) throw unverified();

        const identity = native.taskControls.identity(link);
        const close = native.taskControls.get(identity);
        if (close?.work_id !== workId || close.final_revision !== 0) throw unverified();
        let archive;
        try {
            archive = context.verifyNativeTaskArchive(pluginName, identity);
        } catch (error) {
            throw archiveReadError(error, native.isStorageFailure(error));
        }
        if (!archive) throw conflict('NATIVE_RESULT_UNCONFIRMED');
        if (!tasks.matches(link, archive) || archive.state !== 'completed' || archive.nativeStatus !== 'Succeed' ||
            archive.controlRevision !== close.final_revision || archive.resultHash !== link.result_hash ||
            archive.resultRef !== link.result_ref || !/^[a-f0-9]{64}$/.test(archive.archiveHash || '') ||
            typeof archive.resultContent !== 'string' || !archive.resultContent.trim() ||
            Buffer.byteLength(archive.resultContent) > 2 * 1024 * 1024 ||
            sha256(archive.resultContent) !== archive.resultHash) throw unverified();

        const children = db.prepare('SELECT * FROM shared_native_child_requests WHERE work_id=? ORDER BY rowid').all(workId);
        if (!children.length || children.some(row => row.plugin_name !== pluginName || row.task_id !== link.native_task_id ||
            row.control_revision !== 0 || row.state !== 'model_terminal')) throw unverified();
        const childRequests = children.map(row => {
            const data = native.continuations.read(row.id);
            if (data?.identity.workId !== workId || data.identity.generation !== 0 || data.identity.controlRevision !== 0 ||
                !data.assistant.length || Object.keys(data.results).length || data.events.some(event => event.kind !== 'assistant')) throw unverified();
            const proof = native.continuations.proof(row.id, workId, []);
            return {requestId:row.id,hash:proof.hash};
        });

        const {proof, receipts} = native.checkedToolCheckpoint(workId, requestId);
        const submission = receipts[0].result;
        const parentIdentity = native.continuations.read(requestId)?.identity;
        if (parentIdentity?.generation !== 0 || parentIdentity.controlRevision !== 0 ||
            submission.batchOrdinal !== 0 || submission.batchSize !== 1 ||
            stable(submission.batchNames) !== stable([pluginName])) throw unverified();
        const delegationReceipt = {version:1, kind:'AgentAssistantReport', workId, parentRequestId:requestId,
            nativeTaskId:link.native_task_id, invocationId:call.invocation_id, recordId:call.record_id,
            agentBaseName:link.agent_base_name, resultHash:archive.resultHash, archiveHash:archive.archiveHash, childRequests};
        const result = {...proof, delegationReceipt};
        if (savedProof && stable(result) !== stable(savedProof)) throw unverified();
        return {proof:result, report:archive.resultContent};
    }

    advance(work) {
        const {native, db, shared} = this;
        const control = shared.steering.control(work);
        const generation = shared.steering.generation(work.id, 0);
        if (work.state !== 'dispatched' || control.generation !== 0 || generation?.state !== 'awaiting_native_task') {
            if (this.pendingBoundaries.get(work.id) === 'awaiting_native_task') this.pendingBoundaries.delete(work.id);
            return;
        }
        if (!context.hasNativeTaskProvider(pluginName)) return;
        try {
            if (!controlled.enabled(shared, controlled.AA_MODE)) throw unverified();
            const member = db.prepare('SELECT source_id,device_id FROM shared_members WHERE space_id=? AND device_id=?').get(work.space_id, work.principal.slice(8));
            if (!member) throw unverified();
            const actor = {kind:'desktop',principal:work.principal,sourceId:member.source_id,deviceId:member.device_id,capabilities:controlled.AA_CAPABILITY};
            shared.atomic(() => {
                const result = db.prepare("UPDATE shared_work_generations SET state='paused' WHERE work_id=? AND generation=0 AND state='awaiting_native_task'").run(work.id);
                if (!result.changes) throw pending();
                shared.steering.checkpointSettledTool(actor, work, generation);
            });
            this.pendingBoundaries.delete(work.id);
            native.engine.emitEvent?.(work.id, 'state', {state:'dispatched'});
        } catch (error) {
            if (error.code === 'WORK_SAFE_BOUNDARY_PENDING' || native.isStorageFailure(error)) return;
            console.warn('[NativeSync] DELEGATION_CHECKPOINT_FAILED', error.code || 'UNEXPECTED');
            if (native.requireFinalReview(work.id)) native.engine.emitEvent?.(work.id, 'state', {state:'review_required'});
            this.pendingBoundaries.delete(work.id);
        }
    }

    recoverableWorks() {
        return this.db.prepare(`SELECT a.id,g.state AS generationState FROM shared_admissions a
            JOIN shared_work_generations g ON g.work_id=a.id AND g.generation=0
            JOIN shared_work_controls c ON c.work_id=a.id
            WHERE a.state='dispatched' AND json_extract(a.user_op,'$.sharedTurn.controlMode')=?
              AND (g.state='awaiting_native_task' OR (g.state='paused' AND
                (c.generation=0 OR EXISTS (SELECT 1 FROM shared_work_generations next
                    WHERE next.work_id=a.id AND next.generation=1 AND next.state='prepared'))))`).all(controlled.AA_MODE);
    }

    reconcile(unavailable = new Set()) {
        const {native} = this;
        if (native.closed || native.draining || !context.hasNativeTaskProvider(pluginName)) return;
        for (const [workId, state] of this.pendingBoundaries) {
            if (unavailable.has(workId)) continue;
            const work = this.db.prepare('SELECT * FROM shared_admissions WHERE id=?').get(workId);
            if (work?.state !== 'dispatched') {
                this.pendingBoundaries.delete(workId);
                continue;
            }
            if (state === 'awaiting_native_task') {
                this.advance(work);
                continue;
            }
            try {
                const saved = this.shared.steering.savedCheckpoint(workId, 0);
                const first = this.shared.steering.generation(workId, 0);
                if (!saved || !first) throw unverified();
                this.checkpoint(workId, first.request_id, saved);
            } catch (error) {
                if (native.isStorageFailure(error)) continue;
                native.requireFinalReview(workId);
            }
            this.pendingBoundaries.delete(workId);
        }
        if (native.recoveryFinals.size) native.recoverFinalReplies({delegation:true});
    }
}
module.exports = {SharedDelegation, linkageHash};

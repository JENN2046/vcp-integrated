'use strict';
const {isDeepStrictEqual} = require('node:util');
const {nativeReference} = require('./metadata');
const {wireTopic} = require('./protocol');

const attachmentId = a => a.id || a._fileManagerData?.id || 'attachment_' + (a.hash || a._fileManagerData?.hash);
const topicKey = d => JSON.stringify(wireTopic(d));
const workKey = (messageId, id) => JSON.stringify([messageId, id]);
const references = message => new Map((message?.attachments || []).filter(a => !nativeReference(a)).map(a => [attachmentId(a), a]));

function changedReferences(before, after) {
    if (!before?.attachments?.length && !after?.attachments?.length) return [];
    const old = references(before), next = references(after);
    return [...new Set([...old.keys(), ...next.keys()])].filter(id => !isDeepStrictEqual(old.get(id), next.get(id)));
}

// Disposable work derived from committed native History. A new runtime or binding
// inventories the current topic once, including a commit interrupted before notification.
class AttachmentWork {
    constructor(owner) {
        this.owner = owner;
        this.groups = new Map();
        this.nextCheck = 0;
    }
    shouldRun() { return Boolean(this.running) || this.owner.now() >= this.nextCheck; }

    group(d) {
        const key = topicKey(d);
        let g = this.groups.get(key);
        if (!g) {
            g = {descriptor:{itemType:d.itemType || 'agent', itemId:d.itemId, topicId:d.topicId}, jobs:new Map(), scanned:false};
            this.groups.set(key,g);
        }
        return g;
    }
    offer(d, messageId, ids, message, upload) {
        if (!ids.length) return;
        this.nextCheck=0;
        const g = this.group(d), refs = references(message);
        for (const id of ids) {
            const key = workKey(messageId,id), ref = refs.get(id);
            g.duringScan?.add(key);
            if (g.topic) this.owner.forgetReference(g.topic, messageId, id);
            if (!ref) { g.jobs.delete(key); continue; }
            const raw = {id:messageId, attachments:[ref], _nativeSyncMetadata:message._nativeSyncMetadata};
            g.jobs.set(key,{id,messageId,raw,upload,due:0});
        }
    }
    missingOnOpen(d, message, ref) {
        const key=workKey(message.id,attachmentId(ref));
        const group=this.group(d);
        if (!group.jobs.has(key)) this.offer(d,message.id,[attachmentId(ref)],message,false);
    }
    invalidate(topic) {
        this.nextCheck=0;
        for (const [key,g] of this.groups) if (g.topic===topic) this.groups.delete(key);
    }
    wakeReference(topic, messageId, id) {
        for (const g of this.groups.values()) if (g.topic===topic) {
            const job=g.jobs.get(workKey(messageId,id));
            if (job) {this.nextCheck=0;job.due=0;job.wake=(job.wake || 0)+1;}
        }
    }
    removeMessage(d,messageId) {
        const g=this.groups.get(topicKey(d));
        if (!g) return;
        g.duringScan?.add(JSON.stringify([messageId]));
        for (const [key,j] of g.jobs) if (j.messageId===messageId) {
            g.jobs.delete(key);
            if (g.topic) this.owner.forgetReference(g.topic,messageId,j.id);
        }
    }
    wake(topic) {
        this.nextCheck=0;
        for (const g of this.groups.values()) if (topic === undefined || g.topic === topic) {
            for (const job of g.jobs.values()) { job.due=0; job.wake=(job.wake || 0)+1; }
        }
    }
    async inventory(g) {
        const touched = g.duringScan = new Set();
        try {
            const {history} = await this.owner.queue.readSnapshot(g.descriptor);
            for (const m of history) for (const [id,ref] of references(m)) {
                const key = workKey(m.id,id);
                if (touched.has(key) || touched.has(JSON.stringify([m.id])) || g.jobs.has(key)) continue;
                g.jobs.set(key,{id,messageId:m.id,raw:{id:m.id,attachments:[ref],_nativeSyncMetadata:m._nativeSyncMetadata},upload:true,due:0});
            }
            g.scanned=true;
        } finally { delete g.duringScan; }
    }
    run(topics, options={}) {
        if (this.running) return this.running;
        this.running=this.drain(topics,options).finally(()=>{this.running=null;});
        return this.running;
    }
    async drain(topics,{readOnly=false}={}) {
        this.nextCheck=this.owner.now()+5000;
        const owner=this.owner, active=new Set(topics.map(topicKey));
        for (const [key,g] of this.groups) if (!active.has(key)) {
            this.groups.delete(key);
            if (g.topic) owner.retryMissing(g.topic);
        }
        let mappings, firstError, started=false;
        for (const d of topics) {
            let g=this.group(d);
            if (d.attachmentBinding && g.topic && g.topic!==d.attachmentBinding) {
                this.groups.delete(topicKey(d));owner.retryMissing(g.topic);g=this.group(d);
            }
            if (g.scanned && ![...g.jobs.values()].some(job=>job.due<=owner.now())) continue;
            if (!started) {owner.skipped=0;owner.skippedDetails=[];started=true;}
            mappings ??= await owner.mapping();
            const topic=owner.find(mappings,d);g.topic=topic.key;
            if (!g.scanned) await this.inventory(g);
            // Each due message shares its topic read with other due exceptions.
            // Newly committed attachments already have their native input.
            let snapshot;
            for (const [key,job] of [...g.jobs]) {
                if (this.groups.get(topicKey(d))!==g) break;
                if (job.due>owner.now() || g.jobs.get(key)!==job) continue;
                const wake=job.wake;
                try {
                    let raw=job.raw;
                    if (!raw) {
                        snapshot ??= new Map((await owner.queue.readSnapshot(g.descriptor)).history.map(m=>[m.id,m]));
                        const m=snapshot.get(job.messageId),ref=references(m).get(job.id);
                        if (ref) raw={id:m.id,attachments:[ref],_nativeSyncMetadata:m._nativeSyncMetadata};
                    }
                    if (g.jobs.get(key)!==job) continue;
                    if (!raw) {owner.forgetReference(g.topic,job.messageId,job.id);g.jobs.delete(key);continue;}
                    const selection={descriptor:g.descriptor, messageId:job.messageId, snapshot:{history:[raw]}, topic,
                        current:()=>g.jobs.get(key)===job && this.groups.get(topicKey(d))===g};
                    if (!readOnly && job.upload) await owner.uploadLocal(selection);
                    if (!selection.current()) continue;
                    const due=await owner.restoreRemote(selection);
                    if (!selection.current()) continue;
                    if (due === undefined) g.jobs.delete(key);
                    else {job.due=job.wake===wake?due:0;delete job.raw;}
                } catch (err) {
                    // A failed transfer has no authority over History or the message cursor.
                    firstError ??= err;
                    if (g.jobs.get(key)===job) {job.due=job.wake===wake?owner.now()+5000:0;delete job.raw;}
                }
            }
        }
        if (firstError) throw firstError;
    }
}
module.exports={AttachmentWork,attachmentId,changedReferences};

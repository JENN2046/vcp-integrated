'use strict';
const {resolveEffectiveModel}=require('@vcp/core-rules/group/modelSelection');
const fail=(code,status=409)=>Object.assign(Error(code),{code,status});
function authorize(shared,storage,req){
 if(!shared)throw fail('SHARED_SPACE_UNAVAILABLE');
 const actor=shared.desktop({sourceId:req.headers['x-nativesync-source'],deviceId:req.headers['x-nativesync-device'],spaceId:req.headers['x-nativesync-space'],scopeHash:req.headers['x-nativesync-scope']},req.headers['x-nativesync-capabilities']);
 const original=shared.db.prepare('SELECT space_id FROM shared_objects WHERE id=?').get(req.params.key);
 if(!original)throw fail('SHARED_OBJECT_NOT_FOUND',404);
 shared.authorize(actor,original.space_id);const row=shared.canonical(original.space_id,req.params.key);shared.topic(actor,original.space_id,row.id);
 if(shared.requiresCore(row))throw fail('CORE_ROUTE_REQUIRED');
 if(req.method!=='GET'&&req.path!=='/status'){
  if(shared.readOnly)throw fail('SHARED_READ_ONLY');shared.assertNotPrepared?.([row.id,row.parent_id]);
 }
 req.sharedAttachmentTopic=row;req.sharedAttachmentActor=actor;storage.topic(row.id);
}
function validate(shared,actor,topic,message,config,turn){
 const files=message?.attachments||[];if(!files.length)return;
 if(files.length>8||!shared.store.attachments)throw fail('ATTACHMENTS_NOT_ENABLED');
 const storage=shared.store.attachments;
 for(const a of files){
  const grant=turn.accepted ? storage.locate(topic.id,message.id,a.id,false).blob : shared.db.prepare("SELECT * FROM attachment_uploads WHERE principal=? AND topic_key=? AND hash=? AND state='ready' AND expires>? LIMIT 1").get(actor.principal,topic.id,a.blobHash||a.hash,Date.now());
  if(!grant||grant.size!==a.size)throw fail('ATTACHMENT_NOT_ALLOWED',403);storage.readBlob(grant.hash);
 }
 if(config.owner.kind==='group'&&files.some(a=>String(a.type).startsWith('image/'))){
  const models=shared.catalog.grants.get(topic.origin_source)?.imageModels||[];
  const required=(turn.plan||[]).map(id=>resolveEffectiveModel(config.owner.config,config.members.find(m=>m.id===id).config).effectiveModel);
  if(required.some(model=>!models.includes(model)))throw fail('MODEL_IMAGE_UNSUPPORTED');
 }
}
module.exports={authorize,validate};

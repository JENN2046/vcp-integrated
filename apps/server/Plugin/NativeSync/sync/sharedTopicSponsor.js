'use strict';
const {randomUUID,timingSafeEqual}=require('node:crypto');
const {stable,sha256}=require('./protocol');
const {formatTopicRiverQuote}=require('./topicRiverQuote');
const CAPABILITY='shared-topic-sponsor-v1';
const fail=(code,status=409)=>Object.assign(Error(code),{code,status});
const ENVELOPE='_nativeSyncTopicSponsor';
// Internal only. HTTP admission always passes through accept() and its grant check.
const dispatchKey=Symbol('authorized TopicSponsor session input');
function schema(db){
 db.exec(`CREATE TABLE IF NOT EXISTS shared_topic_sponsor_grants(
  operation_id TEXT PRIMARY KEY, proof_hash TEXT NOT NULL, args_hash TEXT NOT NULL,
  space_id TEXT NOT NULL, source_id TEXT NOT NULL, device_id TEXT NOT NULL,
  source_work TEXT NOT NULL, native_request_id TEXT NOT NULL, invocation_id TEXT NOT NULL UNIQUE,
  source_topic TEXT NOT NULL, target_topic TEXT NOT NULL, result_json TEXT,
  issued_at INTEGER NOT NULL
 )`);
}
function binding(shared,actor,topic,topicSelector,agentSelectors=[]){
 if(topic.owner_type!=='agent')throw fail('SHARED_SESSION_SINGLE_REQUIRED');
 let bindings=shared.db.prepare(`SELECT t.local_id AS topicId,a.local_id AS agentId
 FROM shared_local_bindings t JOIN shared_local_bindings a
   ON a.space_id=t.space_id AND a.source_id=t.source_id AND a.local_id=t.local_parent
 WHERE t.space_id=? AND t.source_id=? AND t.object_id=? AND t.kind='topic' AND t.hidden=0
 AND a.kind='agent' AND a.object_id=? AND a.hidden=0`).all(topic.space_id,actor.sourceId,topic.id,topic.parent_id);
 if(!bindings.length)throw fail('TOPIC_SPONSOR_BINDING_REQUIRED',403);
 if(topicSelector&&![topic.id,topic.topic_id].includes(topicSelector))bindings=bindings.filter(b=>b.topicId===topicSelector);
 for(const selector of agentSelectors){
  if(bindings.some(b=>b.agentId===selector))bindings=bindings.filter(b=>b.agentId===selector);
 }
 if(bindings.length!==1)throw fail('TOPIC_SPONSOR_BINDING_AMBIGUOUS');
 return bindings[0];
}
function resolve(shared,{actor,admissionId,spaceId},args,{redeeming=false}={}){
 if(shared.readOnly||shared.configurationOnly)throw fail('SHARED_READ_ONLY');
 if(actor?.kind!=='desktop')throw fail('SHARED_DEVICE_REQUIRED',403);
 if(typeof args.topic_id!=='string'||!args.topic_id.trim()||typeof args.message!=='string'||!args.message.trim()||
    args.message.length>12000||Buffer.byteLength(stable(args))>500*1024)throw fail('INVALID_TOPIC_SPONSOR_MESSAGE',400);
 if(args.mode!==undefined||![undefined,false,'false'].includes(args.flowlock))throw fail('INVALID_TOPIC_SPONSOR_OPERATION',400);
 const source=shared.admission(actor,spaceId,admissionId);
 if(source.principal!==actor.principal||!(source.state==='dispatched'||redeeming&&source.state==='review_required'))throw fail('TOPIC_SPONSOR_SOURCE_REQUIRED',403);
 const result=resolveDelivery(shared,actor,shared.topic(actor,source.space_id,source.topic_id,'execute'),
  JSON.parse(source.config_json).owner.config.name,args);
 return {source,...result};
}
function resolveDelivery(shared,actor,sourceTopic,sourceName,args){
 if(shared.readOnly||shared.configurationOnly)throw fail('SHARED_READ_ONLY');
 if(actor?.kind!=='desktop')throw fail('SHARED_DEVICE_REQUIRED',403);
 if(typeof args.topic_id!=='string'||!args.topic_id.trim()||typeof args.message!=='string'||!args.message.trim()||
    args.message.length>12000||Buffer.byteLength(stable(args))>500*1024)throw fail('INVALID_TOPIC_SPONSOR_MESSAGE',400);
 if(args.mode!==undefined||![undefined,false,'false'].includes(args.flowlock))throw fail('INVALID_TOPIC_SPONSOR_OPERATION',400);
 const candidates=shared.db.prepare(`SELECT DISTINCT o.id FROM shared_objects o
 LEFT JOIN shared_local_bindings b ON b.object_id=o.id AND b.space_id=o.space_id AND b.source_id=? AND b.kind='topic'
 WHERE o.space_id=? AND o.kind='topic' AND o.deleted=0 AND
 (o.id=? OR o.topic_id=? OR (b.local_id=? AND b.hidden=0))`)
 .all(actor.sourceId,sourceTopic.space_id,args.topic_id??null,args.topic_id??null,args.topic_id??null);
 if(!candidates.length)throw fail('TOPIC_SPONSOR_TARGET_NOT_BOUND',404);
 if(candidates.length!==1)throw fail('TOPIC_SPONSOR_TARGET_AMBIGUOUS');
 const target=shared.topic(actor,sourceTopic.space_id,candidates[0].id,'execute');
 if(target.id===sourceTopic.id)throw fail('TOPIC_SPONSOR_SELF_TARGET');
 const sourceBinding=binding(shared,actor,sourceTopic,args.source_topic_id,[args.sender_id]),targetBinding=binding(shared,actor,target,args.topic_id,[args.target_agent,args.maid]);
 const targetName=shared.object(shared.row(sourceTopic.space_id,target.parent_id)).config.name;
 if(args.source_topic_id!==undefined&&![sourceTopic.id,sourceTopic.topic_id,sourceBinding.topicId].includes(args.source_topic_id) ||
    args.sender_id!==undefined&&![sourceTopic.parent_id,sourceTopic.owner_id,sourceBinding.agentId].includes(args.sender_id) ||
    args.sender_name!==undefined&&args.sender_name!==sourceName)throw fail('TOPIC_SPONSOR_SOURCE_CHANGED',403);
 const targetNames=[target.parent_id,target.owner_id,targetName,targetBinding.agentId];
 if([args.target_agent,args.maid].some(v=>v!==undefined&&!targetNames.includes(v)))throw fail('TOPIC_SPONSOR_TARGET_CHANGED',403);
 return {target,sourceTopic,sourceName,sourceBinding,targetBinding};
}
function bindRecipient(toolHost, authority) {
 const send = authority.routeHash && toolHost?.bindDistributedTool?.('TopicSponsor', authority.routeHash);
 if (typeof send !== 'function') throw fail('TOPIC_SPONSOR_RECIPIENT_UNAVAILABLE');
 return send;
}
function grant(shared,authority,resolved,invocation,args){
 const {actor,admissionId}=authority,{source,target,sourceTopic}=resolved;
 const ledger=shared.db.prepare("SELECT 1 FROM mobile_native_invocations WHERE invocation_id=? AND execution_id=? AND native_request_id=? AND plugin_name='TopicSponsor' AND state='started'")
 .get(invocation.invocationId,admissionId,invocation.nativeRequestId);
 if(!ledger)throw fail('TOPIC_SPONSOR_INVOCATION_REQUIRED',403);
 const operationId='sponsor_'+invocation.invocationId.replaceAll('-',''),proof=randomUUID(),now=Date.now();
 shared.db.prepare(`INSERT INTO shared_topic_sponsor_grants
  (operation_id,proof_hash,args_hash,space_id,source_id,device_id,source_work,native_request_id,invocation_id,source_topic,target_topic,issued_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(operationId,sha256(proof),sha256(stable(args)),source.space_id,actor.sourceId,actor.deviceId,source.id,invocation.nativeRequestId,invocation.invocationId,sourceTopic.id,target.id,now);
 return {operationId,proof,sourceSharedId:sourceTopic.id,targetSharedId:target.id};
}
function committed(shared,operationId){
 const row=shared.db.prepare('SELECT result_json FROM shared_topic_sponsor_grants WHERE operation_id=?').get(operationId);
 return row?.result_json?JSON.parse(row.result_json):null;
}
function ticketFor(shared,actor,{operationId,proof,args}){
 if(actor?.kind!=='desktop'||typeof operationId!=='string'||!/^sponsor_[a-f0-9]{32}$/.test(operationId)||typeof proof!=='string'||proof.length!==36)throw fail('TOPIC_SPONSOR_AUTHORITY_REQUIRED',403);
 const ticket=shared.db.prepare('SELECT * FROM shared_topic_sponsor_grants WHERE operation_id=?').get(operationId);
 if(!ticket||ticket.device_id!==actor.deviceId||ticket.source_id!==actor.sourceId||!timingSafeEqual(Buffer.from(ticket.proof_hash),Buffer.from(sha256(proof))))throw fail('TOPIC_SPONSOR_AUTHORITY_REQUIRED',403);
 shared.authorize(actor,ticket.space_id,'execute');
 if(ticket.args_hash!==sha256(stable(args??null)))throw fail('REQUEST_ID_REUSED');
 return ticket;
}
async function accept(shared,actor,body){
 const before=ticketFor(shared,actor,body);
 if(!before.result_json){
  if(shared.readOnly||!shared.native||shared.native.closed)throw fail('SHARED_READ_ONLY');
  const verified=resolve(shared,{actor,admissionId:before.source_work,spaceId:before.space_id},body.args,{redeeming:true});
  if(verified.sourceTopic.id!==before.source_topic||verified.target.id!==before.target_topic)throw fail('TOPIC_SPONSOR_TARGET_CHANGED');
  const configs=shared.native.engine.configs,target=configs.topics.find(t=>t.key===before.target_topic&&t.sharedSpaceId===before.space_id);
  if(!target)throw fail('SHARED_CONFIG_PENDING');
  await require('../mobile/sharedConfiguration').prepareSharedConfiguration(configs,target,{desktopContext:true});
 }
 const {operationId,args}=body;
 const result=shared.atomic(()=>{
  const ticket=ticketFor(shared,actor,body);
  const sourceTopic=shared.topic(actor,ticket.space_id,ticket.source_topic,'execute'),target=shared.topic(actor,ticket.space_id,ticket.target_topic,'execute');
  if(sourceTopic.id!==ticket.source_topic||target.id!==ticket.target_topic)throw fail('TOPIC_SPONSOR_TARGET_CHANGED');
  const sourceBinding=binding(shared,actor,sourceTopic,args.source_topic_id,[args.sender_id]),targetBinding=binding(shared,actor,target,args.topic_id,[args.target_agent,args.maid]);
  if(ticket.result_json)return {...JSON.parse(ticket.result_json),replayed:true};
  const verified=resolve(shared,{actor,admissionId:ticket.source_work,spaceId:ticket.space_id},args,{redeeming:true});
  if(verified.sourceTopic.id!==sourceTopic.id||verified.target.id!==target.id)throw fail('TOPIC_SPONSOR_TARGET_CHANGED');
  const ledger=shared.db.prepare("SELECT 1 FROM mobile_native_invocations WHERE invocation_id=? AND execution_id=? AND native_request_id=? AND plugin_name='TopicSponsor' AND state='started'")
   .get(ticket.invocation_id,ticket.source_work,ticket.native_request_id);
  if(!ledger)throw fail('TOPIC_SPONSOR_INVOCATION_REQUIRED',403);
  const name=verified.sourceName;
  const quote=formatTopicRiverQuote(args.river_context);
  const prefix=`[${name}的发言]`;
  const messageText=quote?args.message.trimEnd():args.message;
  const content=[messageText.startsWith(prefix)?messageText:`${prefix}:\n${messageText}`,quote,args.source_topic_id&&`[该发言发送自${args.source_topic_id}话题]`].filter(Boolean).join('\n\n');
  const message={id:'msg_'+operationId,role:'assistant',name,agentId:sourceTopic.owner_id,timestamp:ticket.issued_at,content,isThinking:false,finishReason:'completed'};
  const config=shared.freeze(target);
  const sent=require('./sharedSession').send(shared,actor,{sharedSpaceId:ticket.space_id,sharedId:target.id,requestId:operationId,expectedHead:shared.head(target),configHash:config.hash,message},dispatchKey);
  const receipt={...sent,operationId,sourceSharedId:sourceTopic.id,targetSharedId:target.id,seq:sent.userSeq,topic_id:targetBinding.topicId,target_id:targetBinding.agentId,target_type:'agent',message_id:message.id,sender:name,sender_id:sourceBinding.agentId};
  shared.db.prepare('UPDATE shared_topic_sponsor_grants SET result_json=? WHERE operation_id=?').run(JSON.stringify(receipt),operationId);
  return receipt;
 });
 if(!result.replayed)require('./sharedSession').notify(shared.native.engine,result);
 return result;
}
module.exports={CAPABILITY,ENVELOPE,dispatchKey,schema,resolve,resolveDelivery,bindRecipient,grant,committed,accept};

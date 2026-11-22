'use strict';
const CAP='shared-inline-receipts-v1';
const enabled=req=>String(req.headers?.['x-nativesync-capabilities']||'').split(',').includes(CAP);
// Optional projection data accompanies the original durable receipt. It never
// advances an unrelated journal cursor or grants execution/config authority.
function envelope(shared,actor,name,body,result){
 if(actor.kind!=='desktop'||!['admit','complete'].includes(name))return result;
 const admission=name==='admit'?result:result.request;if(!admission||admission.groupHandoff)return result;
 try{shared.authorize(actor,admission.sharedSpaceId,'config');}catch(error){if(error.status===403)return result;throw error;}
 const {config}=shared.requestConfig(actor,{sharedSpaceId:admission.sharedSpaceId,admissionId:admission.id});
 if(config.owner.kind!=='agent'||admission.turn?.kind&&admission.turn.kind!=='message')return result;
 const seq=name==='admit'?admission.userSeq:admission.replySeq;if(!Number.isSafeInteger(seq)||seq<1)return result;
 let page;
 try{page=shared.history(actor,{sharedSpaceId:admission.sharedSpaceId,sharedId:admission.sharedId,after:seq-1,limit:1});}
 catch(error){if(error.code==='SHARED_OBJECT_NOT_FOUND'&&error.status===404||error.code==='SHARED_TOPIC_MERGED'&&error.status===409)return result;throw error;}
 const event=page.events.find(e=>e.seq===seq);if(!event||event.message?.attachments?.length||Buffer.byteLength(JSON.stringify(event))>512*1024)return result;
 return {...result,inline:{capability:CAP,...(name==='admit'?{config}:{}),event}};
}
module.exports={CAP,enabled,envelope};

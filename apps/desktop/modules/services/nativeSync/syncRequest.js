'use strict';
const { fail } = require('./protocol');

function syncHeaders(connection){
    if(connection.scopeMode==='source')return {'X-NativeSync-Source':connection.sourceId,'X-NativeSync-Device':connection.deviceId,'X-NativeSync-Space':connection.spaceId,...(require('./sourceScope').scopeHash(connection.sourceScope)?{'X-NativeSync-Scope':require('./sourceScope').scopeHash(connection.sourceScope)}:{})};
    return connection.topics?.length?{'X-NativeSync-Topics':Buffer.from(JSON.stringify(connection.topics.map(t=>[t.itemType||'agent',t.itemId,t.topicId]))).toString('base64url')}:{};
}
function createSyncRequest(connection,timeoutMs=8000) {
    const {url,token}=connection;let referencesSupported=false,sourceDataV2Support=null;
    const send=async(route,{body,signal,sharedSessionHistory=false}={})=>{
        const serialized=body?JSON.stringify(body):undefined,size=serialized?Buffer.byteLength(serialized):0;
        const metadata=require('./metadata'),fields=body?.message?metadata.fieldsFrom(body.message):null,references=body?.message&&(body.metadata?.fields?.desktopReferences?.length||body.message._nativeSyncMetadata?.fields?.desktopReferences?.length||fields.desktopReferences?.length);
        const extended=body?.message&&(size>4*1024*1024||metadata.requiresSourceDataV2(body.message,body.metadata));
        if(connection.scopeMode==='source'&&/\/(?:source\/)?push$/.test(route)&&size>16*1024*1024)throw Object.assign(fail('BODY_TOO_LARGE'),{status:413});
        const metadataBytes=extended?Math.max(...[fields,body.message._nativeSyncMetadata?.fields,body.metadata?.fields].filter(Boolean).map(f=>Buffer.byteLength(require('./protocol').stable(f)))):0;
        if((references&&!referencesSupported)||(extended&&(!sourceDataV2Support||sourceDataV2Support.maxOperationBytes<size||sourceDataV2Support.maxMetadataBytes<metadataBytes))){
            if(connection.scopeMode!=='source')throw fail(extended?'SOURCE_DATA_SOURCE_REQUIRED':'DESKTOP_REFERENCE_SOURCE_REQUIRED');
            const info=await send('/api/v1/sync/source/info?'+new URLSearchParams({sourceId:connection.sourceId,deviceId:connection.deviceId}));
            if(info.sourceId!==connection.sourceId||info.deviceId!==connection.deviceId||info.spaceId!==connection.spaceId)throw fail('SOURCE_BINDING_CHANGED');
            if(references&&info.desktopReferences!==true)throw fail('DESKTOP_REFERENCE_SERVER_UPGRADE_REQUIRED');
            if(extended&&(info.sourceDataV2!==true||!Number.isSafeInteger(info.maxOperationBytes)||info.maxOperationBytes<size||!Number.isSafeInteger(info.maxMetadataBytes)||info.maxMetadataBytes<metadataBytes))throw fail('SOURCE_DATA_SERVER_UPGRADE_REQUIRED');
            referencesSupported=info.desktopReferences===true;
            sourceDataV2Support=info.sourceDataV2===true&&Number.isSafeInteger(info.maxOperationBytes)&&Number.isSafeInteger(info.maxMetadataBytes)?{maxOperationBytes:info.maxOperationBytes,maxMetadataBytes:info.maxMetadataBytes}:null;
        }
        route=require('./connection').sourceRoute(connection,route);
        const bulk=connection.scopeMode==='source'&&(/\/source\/(push|pull)(?:\?|$)/.test(route)||/\/source\/baselines(?:\/|$)/.test(route)||Boolean(connection.sharedSpaceId)&&/\/shared\/(?:baselines|baseline|pull)(?:\?|$)/.test(route));
        const deadline=body&&/^\/api\/plugins\/NativeSync\/(?:source\/)?core\/.+\/compact$/.test(route)?Math.max(timeoutMs,600000):bulk?Math.max(timeoutMs,60000):route.startsWith('/api/v1/sync/shared/wait?')?Math.max(timeoutMs,40000):timeoutMs;
        let response,value;const responseDeadline=Date.now()+deadline;
        try {
            response=await fetch(url+route,{method:body?'POST':'GET',headers:{...syncHeaders(connection),Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-NativeSync-Protocol':'2','X-NativeSync-Capabilities':'attachments-v1,message-intents-v1,desktop-references-v1,source-data-v2'+(connection.sharedSpaceId?',shared-space-v1,shared-merge-v1,shared-attachments-v1,shared-context-v1,shared-steering-v1,shared-controlled-text-v1,shared-controlled-tools-v1,group-member-handoff-v1,group-member-handoff-v2,shared-controlled-tool-pair-v1,shared-controlled-aa-v1,shared-model-save-v1,shared-inline-receipts-v1,shared-native-inline-v1,shared-session-v1,shared-events-v1,shared-topic-sponsor-v1':'')+(sharedSessionHistory?',shared-session-history-v1':'')},body:serialized,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(deadline)]):AbortSignal.timeout(deadline)});
        } catch { throw fail('NETWORK_UNAVAILABLE'); }
        try { const {readResponseText}=await import('../../chat/boundedResponse.mjs');value=JSON.parse(await readResponseText(response,{maxBytes:response.ok?32*1024*1024:64*1024,deadline:response.ok?responseDeadline:Math.min(responseDeadline,Date.now()+15000)})); } catch(error) { if(response.ok&&error?.name!=='SyntaxError')throw fail('NETWORK_UNAVAILABLE'); }
        if(!response.ok)throw Object.assign(fail(/^[A-Z][A-Z0-9_]{0,79}$/.test(value?.error?.code||'')?value.error.code:(response.status===413?'BODY_TOO_LARGE':'SYNC_HTTP_ERROR')),{status:response.status});
        if(!value)throw fail('CORRUPT_HTTP_RESPONSE');
        return value;
    };
    return send;
}

module.exports = { createSyncRequest, syncHeaders };

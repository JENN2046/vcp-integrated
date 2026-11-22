'use strict';
// R4 wire contract on a host-owned HTTP server. Authentication and listening
// belong to VCPToolBox; the plugin opens no second server or authentication lane.
const { SyncError } = require('./centralStore');
const {requireReferenceReader,supported,needsReferences,SOURCE_DATA_CAPABILITY}=require('./capabilities');
function createSyncHttpService(store) {
    let closing = false, quiescing = false, active = 0, drain;
    const eventStreams = new Set(), waits = new Set();
    const closeEvents = () => { for (const stream of eventStreams) stream.close(); eventStreams.clear(); for (const controller of waits) controller.abort(); };
    const drained = new Promise(resolve => { drain = resolve; });
    const send = (res, code, body) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
    };
    async function handle(req, res) {
        if (closing) return send(res, 503, { error: { code: 'SYNC_SERVICE_STOPPED', message: 'Native sync service is stopping' } });
        if(quiescing&&req.method!=='GET')return send(res,503,{error:{code:'HOST_DRAINING'}});
        active++;
        try {
            const url = new URL(req.url, 'http://localhost');
            if (url.pathname === '/shared/watch') {
                if (quiescing) throw Object.assign(Error('HOST_DRAINING'),{code:'HOST_DRAINING',status:503});
                if (req.method !== 'GET') throw Object.assign(Error('METHOD_NOT_ALLOWED'),{code:'METHOD_NOT_ALLOWED',status:405});
                let stream;
                stream=require('./sharedHttp').openSharedWatch(store,req,res,url,()=>eventStreams.delete(stream));
                if(!res.writableEnded&&!res.destroyed)eventStreams.add(stream);
                return;
            }
            if (url.pathname === '/shared/session-events') {
                if (quiescing) throw Object.assign(Error('HOST_DRAINING'),{code:'HOST_DRAINING',status:503});
                if (req.method !== 'GET') throw Object.assign(Error('METHOD_NOT_ALLOWED'),{code:'METHOD_NOT_ALLOWED',status:405});
                const query=Object.fromEntries(url.searchParams);
                if(url.searchParams.size!==Object.keys(query).length)throw Object.assign(Error('INVALID_SHARED_EVENT_REQUEST'),{code:'INVALID_SHARED_EVENT_REQUEST',status:400});
                const resolveActor=()=>store.shared.desktop({sourceId:req.headers['x-nativesync-source'],deviceId:req.headers['x-nativesync-device'],spaceId:req.headers['x-nativesync-space'],scopeHash:req.headers['x-nativesync-scope']},req.headers['x-nativesync-capabilities']);
                let stream;stream=require('./sharedEventHttp').openSharedEventStream({shared:store.shared,req,res,resolveActor,query,onClose:()=>eventStreams.delete(stream)});
                if(!res.writableEnded&&!res.destroyed)eventStreams.add(stream);
                return;
            }
            if(url.pathname==='/shared/wait'&&req.method==='GET'){
                if(quiescing)throw Object.assign(Error('HOST_DRAINING'),{code:'HOST_DRAINING',status:503});
                const controller=new AbortController(),abort=()=>controller.abort();
                waits.add(controller);res.once('close',abort);
                try {
                    const result=await require('./sharedHttp').sharedRequest(store,req,url,undefined,controller.signal);
                    if(!res.destroyed)return send(res,200,result);
                    return;
                } finally {res.off('close',abort);waits.delete(controller)}
            }
            if(url.pathname.startsWith('/shared/'))return send(res,200,await require('./sharedHttp').sharedRequest(store,req,url));
            if(['/source/push','/source/pull','/source/status'].includes(url.pathname)){
                if(!req.headers?.['x-nativesync-source'])throw new SyncError('SOURCE_BINDING_REQUIRED','Full-source binding required',403);
                require('./sourceHttp').scopeRequest(store,req);
                url.pathname=url.pathname.slice('/source'.length);
            }else if(url.pathname.startsWith('/source/')){const result=await require('./sourceHttp').sourceRequest(store,req,url);requireReferenceReader(result,req.headers['x-nativesync-capabilities']);store.onSourceChange?.();return send(res,200,result);}
            require('./sourceHttp').scopeRequest(store,req);
            if (req.method === 'GET' && url.pathname === '/pull') {
                const result=store.pull(Number(url.searchParams.get('after_seq') ?? 0), Number(url.searchParams.get('limit') ?? 100), req.nativeSyncTopics);
                requireReferenceReader(result,req.headers['x-nativesync-capabilities']);
                if(req.headers['x-nativesync-protocol']!=='2'&&result.events.some(e=>e.message?._nativeSyncMetadata))throw new SyncError('METADATA_PROTOCOL_UPGRADE_REQUIRED','NativeSync metadata protocol 2 required',409);
                if(!String(req.headers['x-nativesync-capabilities']||'').split(',').includes('message-intents-v1')&&result.events.some(e=>e.message?._nativeSyncMetadata?.fields.continuity))throw new SyncError('MESSAGE_INTENT_PROTOCOL_UPGRADE_REQUIRED','Native message intent capability required',409);
                if(!String(req.headers['x-nativesync-capabilities']||'').split(',').includes('attachments-v1')&&result.events.some(e=>e.message?._nativeSyncMetadata?.fields.attachmentData?.some(a=>a.contentHash||a.frameHashes?.length)))throw new SyncError('ATTACHMENT_PROTOCOL_UPGRADE_REQUIRED','Attachment identity/frame capability required',409);
                return send(res,200,result);
            }
            if (req.method === 'GET' && url.pathname === '/status') return send(res, 200, require('./sourceHttp').metrics(store,req.nativeSyncTopics));
            if (req.method === 'POST' && url.pathname === '/push') {
                // Express may already have consumed JSON before plugin routes.
                let op = req.body;
                const maxBody=req.nativeSyncSourceBinding?16*1024*1024:1024*1024;
                if (op === undefined) {
                    let raw = '';
                    for await (const chunk of req) {
                        raw += chunk;
                        if (Buffer.byteLength(raw) > maxBody) throw new SyncError('BODY_TOO_LARGE', 'Sync operation exceeds bounded maximum', 413);
                    }
                    try { op = JSON.parse(raw); } catch { throw new SyncError('INVALID_OPERATION','Invalid JSON request'); }
                } else if (Buffer.byteLength(JSON.stringify(op)) > maxBody) throw new SyncError('BODY_TOO_LARGE', 'Sync operation exceeds bounded maximum', 413);
                store.sourceCatalog?.authorizePush(req.nativeSyncSourceBinding,op);
                if(req.nativeSyncTopics!==undefined&&!req.nativeSyncTopics.includes(JSON.stringify([op?.ownerType,op?.ownerId,op?.topicId])))throw new SyncError('TOPIC_NOT_ALLOWED','Operation is outside the selected source',403);
                if(req.nativeSyncSourceBinding&&op?.deviceId!==req.nativeSyncSourceBinding.deviceId)throw new SyncError('SOURCE_DEVICE_MISMATCH','Operation device changed',403);
                if(Buffer.byteLength(JSON.stringify(op))>4*1024*1024||require('./metadata').requiresSourceDataV2(op?.message,op?.metadata)){
                    if(!req.nativeSyncSourceBinding)throw new SyncError('SOURCE_DATA_SOURCE_REQUIRED','Extended source data requires Source mode',409);
                    if(!supported(req.headers['x-nativesync-capabilities'],SOURCE_DATA_CAPABILITY))throw new SyncError('SOURCE_DATA_CLIENT_UPGRADE_REQUIRED','Source data v2 support required',409);
                }
                if((needsReferences(op?.message)||op?.metadata?.fields?.desktopReferences?.length||require('./metadata').fieldsFrom(op?.message||{}).desktopReferences?.length)&&!supported(req.headers['x-nativesync-capabilities']))throw new SyncError('DESKTOP_REFERENCE_CLIENT_UPGRADE_REQUIRED','Desktop reference support required',409);
                return send(res, 200, store.apply(op,{metadataPublisher:req.nativeSyncMetadataPublisher??(req.nativeSyncTopics===undefined),attachmentPrincipal:req.nativeSyncDeviceId?'desktop:'+req.nativeSyncDeviceId:'host-bearer'}));
            }
            return send(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown route' } });
        } catch (error) {
            if(res.destroyed)return;
            if(res.headersSent){if(!res.writableEnded)res.end();return;}
            // Request validation has explicit statuses. An unclassified server
            // exception must neither blame the client nor expose row contents.
            if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500)
                return send(res,error.status,{error:{code:error.code||'BAD_REQUEST',message:error.message}});
            const corrupt = error.code === 'SYNC_STORAGE_CORRUPT' || ['ERR_SQLITE_CORRUPT','ERR_SQLITE_NOTADB'].includes(error.code) || [11,26].includes(error.errcode & 255);
            const status = Number.isInteger(error.status) && error.status >= 500 && error.status <= 599 ? error.status : 500;
            const code = corrupt ? 'SYNC_STORAGE_CORRUPT' : status === 503 && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code||'') ? error.code : 'SYNC_INTERNAL_ERROR';
            return send(res,status,{error:{code,message:corrupt?'Stored sync data failed integrity validation':'Sync service failed'}});
        } finally { active--; if (closing && active === 0) drain(); }
    }
    return { handle, beginDrain(){quiescing=true;closeEvents();}, snapshot(){return {accepting:!quiescing,active,eventStreams:eventStreams.size};}, async close() { closing = true;closeEvents(); if (active > 0) await drained; store.close(); } };
}
module.exports = { createSyncHttpService };

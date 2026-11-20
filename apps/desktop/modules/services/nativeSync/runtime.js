'use strict';
const authorityControl=require('./historyAuthority');
const path = require('node:path');
const fs = require('node:fs/promises');
const { NativeSyncAdapter } = require('./adapter');
const { fail } = require('./protocol');
const { attachLocalRecovery } = require('./localAttachment');
const { registerNativeSyncQueries } = require('./queries');
const queueOwners = new WeakMap(), rootOwners = new Map();
function reserveOwner(queue, root) {
    const key=process.platform==='win32'?path.resolve(root).toLowerCase():path.resolve(root);
    if ((queue && queueOwners.has(queue)) || rootOwners.has(key) || (queue?.syncPolicy && !queue.syncPolicy.isRecoveryFence)) throw fail('SYNC_ALREADY_ATTACHED');
    const owner={};rootOwners.set(key,owner);if(queue)queueOwners.set(queue,owner);
    return ()=>{if(rootOwners.get(key)===owner)rootOwners.delete(key);if(queue&&queueOwners.get(queue)===owner)queueOwners.delete(queue);};
}

const { createSyncRequest, syncHeaders } = require('./syncRequest');

function createSyncDownload(connection){
    return (async route=>{
        route=require('./connection').sourceRoute(connection,route);
        let response;try{response=await fetch(connection.url+route,{headers:{...syncHeaders(connection),Authorization:`Bearer ${connection.token}`,'X-NativeSync-Protocol':'2','X-NativeSync-Capabilities':'attachments-v1,message-intents-v1'+(connection.sharedSpaceId?',shared-space-v1,shared-merge-v1,shared-attachments-v1,shared-context-v1,shared-steering-v1,shared-controlled-text-v1,shared-model-save-v1,shared-inline-receipts-v1,shared-native-inline-v1,shared-session-v1,shared-events-v1':'')},redirect:'error',signal:AbortSignal.timeout(30000)});}catch{throw fail('NETWORK_UNAVAILABLE');}
        if(!response.ok){let code;try{code=(await response.json()).error?.code;}catch{}throw Object.assign(fail(/^ATTACHMENT_[A-Z_]+$/.test(code||'')?code:'ATTACHMENT_DOWNLOAD_FAILED'), {status:response.status});}
        try {const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>20*1024*1024)throw fail('ATTACHMENT_FILE_TOO_LARGE');chunks.push(chunk);}return Buffer.concat(chunks);}
        catch(error){if(error.code==='ATTACHMENT_FILE_TOO_LARGE')throw error;throw fail('NETWORK_UNAVAILABLE');}
    });
}
async function createNativeSyncRuntime({ queue, appDataRoot, args = [], isolated = false, notify, notifyExecutionStatus, intervalMs = 250, executionIntervalMs = 5000, readSettings, readAgentConfig, readGroupConfig, readTavernRules, readEffectiveTavernRules, readExecutionPolicy, thumbnail, request, requestBinary, requestEvents, storeAttachment, ipcMain, getMainWindow, sourceFault, agentConfigEvents, sharedHost, historyAuthority = authorityControl.authorityForQueue(queue), localHistoryAuthority, waitForHistoryAuthority, isStopping = () => false }) {
    const poc = args.includes('--native-sync-poc');
    if (poc && !isolated) throw fail('ISOLATED_APP_DATA_REQUIRED');
    if (!poc && !appDataRoot) return null;
    const option = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
    if (poc) {
        let endpoint;
        try { endpoint = new URL(option('native-sync-url')); } catch { throw fail('ISOLATED_LOOPBACK_REQUIRED'); }
        if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') throw fail('ISOLATED_LOOPBACK_REQUIRED');
    }
    const releaseOwner=reserveOwner(queue,appDataRoot);
    let local,adapter,queries,sourceSync,sourceListener,sourcePublisher,configurationTimer,configurationRunning;
    try {
    const statePath = path.join(appDataRoot, '.native-sync', 'state.json');
    if (localHistoryAuthority?.error) throw localHistoryAuthority.error;
    const recoverLocal = () => localHistoryAuthority?.localRecovery || attachLocalRecovery({queue,statePath});
    if(sharedHost)queue.nativeSyncSharedHost=sharedHost;
    let connection;try{connection=poc?null:await require('./connection').readConnection({appDataRoot,readSettings});}catch(error){local=await recoverLocal();throw error;}
    if(connection?.sharedSpaceId){
        let shared;
        try{
            await waitForHistoryAuthority?.();
            shared=await require('./sharedRuntime').SharedRuntime.open({queue,appDataRoot,connection,sharedHost,historyAuthority,isStopping,send:request||createSyncRequest(connection),openEvents:requestEvents||(!request?require('./sharedSessionClient').createSharedEventRequest(connection):null),notify,notifyExecutionStatus,intervalMs,agentConfigEvents,download:requestBinary||createSyncDownload(connection),storeAttachment});
            if(ipcMain&&!isStopping())queries=registerNativeSyncQueries({ipcMain,getMainWindow,queue,getRuntime:()=>shared});
            const close=shared.close.bind(shared);shared.close=async()=>{await close();await queries?.close();releaseOwner();};return shared;
        }catch(error){
            if(error.code==='APPLICATION_SHUTTING_DOWN')throw error;
            queue.configureSync(require('./sharedRuntime').startupFence(connection.sharedSpaceId,()=>error.code||'SHARED_STARTUP_FAILED'));
            if(!ipcMain)throw error;
            const degraded={adapter:null,startupError:error.code||'SHARED_STARTUP_FAILED',async getExecutionStatus(){return {enabled:false,readOnly:true,degraded:this.startupError};},async getNativeTaskResult(){throw fail('SHARED_EXECUTION_NOT_READY');},async close(){await shared?.close();await queries?.close();releaseOwner();}};
            if(!isStopping())queries=registerNativeSyncQueries({ipcMain,getMainWindow,queue,getRuntime:()=>degraded});return degraded;
        }
    }
    local = await recoverLocal();
    if (!poc && !connection) {
        if (!local.exists && !ipcMain) { releaseOwner(); return null; }
        local.setError('SYNC_CONNECTION_REQUIRED');
        let closing;
        const dormant={
            adapter:null,
            async getExecutionStatus(){return {enabled:false};},
            async getNativeTaskResult(){throw fail('NATIVE_TASK_RESULT_UNAVAILABLE');},
            close(){return closing ||= (async()=>{await queries?.close();releaseOwner();})();},
        };
        if(ipcMain&&!isStopping())queries=registerNativeSyncQueries({ipcMain,getMainWindow,queue,getRuntime:()=>dormant});
        return dormant;
    }
    await waitForHistoryAuthority?.();
    let existingState = local.exists, prepared = !connection;
    const send = request || createSyncRequest(connection || {});
    const full=connection?.scopeMode==='source';
    let source;
    if(full){connection.previousSelectedTopics=!local.state?.source?local.state?.topics:undefined;source=await require('./sourceSync').SourceSync.verify(connection,local.state,send,historyAuthority);connection.topics=local.state?.topics.map(t=>({...t}))||[];}
    let publicationError = null,bootstrap;
    const publishConfiguration = async () => {
        if(full&&connection.executionMode==='all-supported')return;
        if (!connection?.publishExecutionConfigs || (full&&!connection.executionTopics.length)) return;
        try {
            await require('./executionConfigs').publishExecutionConfigs({topics:full?connection.executionTopics:connection.topics,readAgentConfig,readGroupConfig,readTavernRules,readEffectiveTavernRules,readExecutionPolicy,send});
            publicationError = null;
        } catch (error) { publicationError = error.code || 'CONFIG_PUBLICATION_FAILED'; }
    };
    const prepare = async () => {
        if (connection&&!full) {
            bootstrap=(await require('./initialImport').initialImport({ queue, appDataRoot, connection, request: (route, body) => send(route, { body }) })).bootstrap;
            if (connection.publishCatalog) {
                const metadata = await require('./catalog').catalog({ appDataRoot, topics: connection.topics, readAgentConfig, readGroupConfig, thumbnail });
                await send('/api/plugins/NativeSync/mobile/catalog', { body: metadata });
            }
        }
        // A private configuration failure cannot disable history catch-up. The
        // host still refuses new execution without a verified snapshot; this
        // catch only isolates publication from the existing history transport.
        await publishConfiguration();
        prepared = true;
    };
    // Existing shared histories attach Queue policy locally before network work.
    // First attachment still requires the approved online comparison.
    if (!existingState) await prepare();
    adapter = await authorityControl.withAuthority(historyAuthority, full ? 'source-binding' : 'selected-binding', () => NativeSyncAdapter.open({ queue, statePath,bootstrap,historyAuthority, ...(full?{source,sourceAdoptionVerified:!local.state?.source,sourceTransitionVerified:Boolean(local.state?.source&&source.scopeTransition?.localStateHash)}:{}), ...(connection || { url: option('native-sync-url'), deviceId: option('native-sync-device'), topics: JSON.parse(option('native-sync-topics') || '[]'), token: 'isolated-poc-token' }), ...((connection || request) ? { request: send } : {}), notify }));
    if(full){sourceSync=await new (require('./sourceSync').SourceSync)({adapter,connection,appDataRoot,readAgentConfig,readGroupConfig,send,fault:sourceFault}).open();
        sourceListener=()=>{sourceSync.dirty=true;};agentConfigEvents?.on?.('agent-config-updated',sourceListener);
        await sourceSync.discover();
        if(connection.executionMode==='all-supported'){
            sourcePublisher=new (require('./sourceExecutionPublication').SourceExecutionPublication)({send,getTopics:()=>connection.topics,getDirectory:()=>sourceSync.directory,readAgentConfig,readGroupConfig,readTavernRules,readEffectiveTavernRules,readExecutionPolicy});
            adapter.sourceExecutionPublication=()=>sourcePublisher.diagnostics();
        }
    }
    const download=requestBinary||createSyncDownload(connection);
    const attachments=connection?.syncAttachments?new (require('./attachments').DesktopAttachments)({queue,appDataRoot,connection,send,download,storeAttachment,onMaterialized:(d,result)=>{adapter.notificationPending.set(adapter.topicKey(d),{agentId:d.itemId,ownerId:d.itemId,ownerType:d.itemType,topicId:d.topicId,revision:result?.revision,source:'native-sync'});adapter.retryNotifications();}}):null;
    if (attachments) adapter.attachmentRecovery = attachments;
    const { NativeExecutionStatus, localDelivery } = require('./executionStatus');
    const withLocal = result => ({ ...result, local: localDelivery(adapter, { itemType: result.topic.ownerType, itemId: result.topic.ownerId, topicId: result.topic.topicId }) });
    const executionStatus = connection ? await NativeExecutionStatus.open({
        connection:full?{...connection,topics:adapter.topics}:connection, file: path.join(appDataRoot, '.native-sync', 'execution-status.json'), request: send,
        notify: result => notifyExecutionStatus?.(withLocal(result)),
    }) : null;
    let runtime;
    if(ipcMain&&!isStopping())queries=registerNativeSyncQueries({ipcMain,getMainWindow,queue,getRuntime:()=>runtime});
    // Read-only execution discovery has its own timer/promise. Slow or failed
    // status reads must never hold the History catch-up loop or Queue policy.
    let stopped = false, running = null, executionRunning = null, lastConfigCheck = Date.now();
    const executionTimer = executionStatus ? setInterval(() => {
        if (stopped || executionRunning) return;
        executionRunning = executionStatus.refreshAll().catch(() => {}).finally(() => { executionRunning = null; });
    }, executionIntervalMs) : null;
    executionTimer?.unref?.();
    configurationTimer=sourcePublisher?setInterval(()=>{
        if(stopped||configurationRunning)return;
        configurationRunning=sourcePublisher.tick().finally(()=>{configurationRunning=null;});
    },250):null;
    configurationTimer?.unref?.();
    async function checkAttachmentWork() {
        if (!attachments?.work.shouldRun()) return;
        try {
            await attachments.work.run(connection.topics);
            adapter.attachmentError=null;
        } catch(error) {
            adapter.attachmentError=error.code||'ATTACHMENT_SYNC_FAILED';
        }
        adapter.attachmentSkipped=attachments.skipped;
        adapter.attachmentSkippedDetails=attachments.skippedDetails;
    }
    const timer = setInterval(() => {
        if (stopped || running) return;
        running = (async () => {
            if (!prepared) await prepare();
            if(sourceSync){await sourceSync.tick();executionStatus?.addTopics(adapter.topics);}
            if(connection?.publishExecutionConfigs && Date.now()-lastConfigCheck>=5000){await publishConfiguration();lastConfigCheck=Date.now();}
            adapter.configurationError=sourcePublisher?(sourcePublisher.error||(sourcePublisher.errors.size?'SOURCE_CONFIGURATION_INCOMPLETE':null)):publicationError;
            // Stage local bytes before publishing references. Any newly applied
            // remote references can then be restored from this same round.
            await checkAttachmentWork();
            await adapter.synchronize();
            adapter.lastTransportError=null;
            await checkAttachmentWork();
            if(sourceSync)await sourceSync.report();
        })().catch(error => {
            adapter.degraded = error.code || 'SYNC_FAILED';
            adapter.lastTransportError={code:adapter.degraded,status:error.status??null};
        }).finally(() => { running = null; });
    }, intervalMs);
    timer.unref?.();
    let closing;
    runtime = {
        adapter,
        async getExecutionStatus(d, { refresh = true } = {}) {
            if (stopped) throw fail('SYNC_BRIDGE_CLOSED');
            if (!executionStatus) return { enabled: false };
            return withLocal(refresh ? await executionStatus.refresh(d) : executionStatus.read(d));
        },
        async getExecutionPage(d,options={}){if(stopped||!executionStatus)throw fail('SYNC_BRIDGE_CLOSED');return executionStatus.page(d,options);},
        async getNativeTaskResult(d, executionId, nativeTaskId) {
            if (stopped) throw fail('SYNC_BRIDGE_CLOSED');
            if (!executionStatus) throw fail('NATIVE_TASK_RESULT_UNAVAILABLE');
            return executionStatus.result(d, executionId, nativeTaskId);
        },
        close() {
            if(closing)return closing;
            stopped=true;clearInterval(timer);clearInterval(executionTimer);clearInterval(configurationTimer);
            closing=(async()=>{
                await queries?.close();
                await running;await executionRunning;await configurationRunning;
                // Host quit admission already stops new native requests. Keep the
                // capture observer until admitted local Queue work has settled.
                await Promise.allSettled([...(queue?.queues?.values() || [])]);
                if(sourceListener)agentConfigEvents?.off?.('agent-config-updated',sourceListener);await executionStatus?.close();await adapter.close();releaseOwner();
            })();
            return closing;
        },
    };
    return runtime;
    } catch(error) {
        clearInterval(configurationTimer);await configurationRunning;
        if(sourceListener)agentConfigEvents?.off?.('agent-config-updated',sourceListener);
        local?.setError(error.code || 'SYNC_STARTUP_FAILED');
        await queries?.close();
        if(adapter){adapter.startupError=error.code || 'SYNC_STARTUP_FAILED';await adapter.close();}
        // The real host must reach native startup when a known local binding
        // can remain fenced. Standalone callers retain their rejection contract.
        // An unreadable/unattested state never reaches this fallback.
        if(ipcMain && local && !['SYNC_ALREADY_ATTACHED','APPLICATION_SHUTTING_DOWN'].includes(error.code)) {
            let closing;
            const degraded={
                adapter:null, startupError:error.code || 'SYNC_STARTUP_FAILED',
                async getExecutionStatus(){return {enabled:false,degraded:this.startupError};},
                async getNativeTaskResult(){throw fail('NATIVE_TASK_RESULT_UNAVAILABLE');},
                close(){return closing ||= (async()=>{await queries?.close();releaseOwner();})();},
            };
            try {if(!isStopping())queries=registerNativeSyncQueries({ipcMain,getMainWindow,queue,getRuntime:()=>degraded});}
            catch(registrationError){releaseOwner();throw registrationError;}
            return degraded;
        }
        releaseOwner();
        throw error;
    }
}
module.exports = { createNativeSyncRuntime,createSyncRequest,syncHeaders, ...require('./historyAuthority') };

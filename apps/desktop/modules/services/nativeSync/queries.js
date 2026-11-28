'use strict';
const owners = new WeakMap();
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { fail } = require('./protocol');

// Main-frame identity is checked at invocation, including after window recreation.
// Device/server grants do not authorize a different local renderer to act.
function mainWindowSender(getMainWindow, projectRoot=path.resolve(__dirname,'../../..')) {
    const target = pathToFileURL(path.join(projectRoot, 'main.html')).href;
    return event => {
        try {
            const window = getMainWindow?.();
            return Boolean(window && !window.isDestroyed() && window.webContents
                && event?.sender === window.webContents
                && event.senderFrame && event.senderFrame === window.webContents.mainFrame
                && typeof event.senderFrame.url === 'string'
                && event.senderFrame.url.split(/[?#]/)[0] === target);
        } catch { return false; }
    };
}

// Fixed status queries and explicit Core send admission. The Bridge owns registration and cleanup.
function registerNativeSyncQueries({ipcMain,getRuntime,getMainWindow,projectRoot=path.resolve(__dirname,'../../..')}) {
    const trusted = mainWindowSender(getMainWindow, projectRoot);
    if (owners.has(ipcMain)) throw Object.assign(Error('SYNC_ALREADY_ATTACHED'),{code:'SYNC_ALREADY_ATTACHED'});
    const owner = {}, registered = [], pending = new Set();
    let stopped = false, closing;
    owners.set(ipcMain,owner);
    const register = (name, action, fallback) => {
        ipcMain.handle(name, (...args) => {
            if (stopped) return Promise.resolve({success:false,error:'SYNC_BRIDGE_CLOSED'});
            const operation = Promise.resolve().then(()=>{
                if (!trusted(args[0])) return {success:false,error:'NATIVE_SYNC_MAIN_WINDOW_REQUIRED'};
                const mutation = ['native-sync:core-compact', 'native-sync:core-flowlock', 'native-sync:task-stop',
                    'native-sync:session-cancel', 'native-sync:prepare-send', 'native-sync:steer', 'native-sync:abandon-send'].includes(name);
                return mutation ? require('../quitAdmission.cjs').run(() => action(...args)) : action(...args);
            }).catch(error=>({success:false,error:error.code || fallback}));
            pending.add(operation); operation.finally(()=>pending.delete(operation));
            return operation;
        });
        registered.push(name);
    };
    try {
        register('native-sync:session-cancel',async(_event,payload)=>{const runtime=getRuntime();if(!runtime?.cancelNativeSession)throw Object.assign(Error(),{code:'SHARED_SESSION_CONTROL_UNAVAILABLE'});return runtime.cancelNativeSession(payload);},'SHARED_CANCEL_FAILED');
        register('native-sync:directory-context',async(_event,scope)=>{const runtime=getRuntime();return runtime?.nativeDeletionContext?runtime.nativeDeletionContext(scope):{success:true,kind:'local'};},'NATIVE_DIRECTORY_UNAVAILABLE');
        register('native-sync:abandon-send',async (_event,payload)=>{const runtime=getRuntime();if(!runtime?.abandonSharedSend)throw Object.assign(Error(),{code:'SHARED_SEND_UNAVAILABLE'});return runtime.abandonSharedSend(payload);},'SHARED_ABANDON_FAILED');
        register('native-sync:steer',async(_event,payload)=>{const runtime=getRuntime();if(!runtime?.submitSharedSteering)throw Object.assign(Error(),{code:'SHARED_STEERING_UNAVAILABLE'});return runtime.submitSharedSteering(payload);},'SHARED_STEERING_FAILED');
        register('native-sync:prepare-send',async (_event,payload)=>{const runtime=getRuntime();if(!runtime?.prepareSharedSend)return {handled:false};return runtime.prepareSharedSend(payload);},'SHARED_SEND_UNAVAILABLE');
        register('native-sync:executions',async (_event,itemId,itemType,topicId,refresh=true)=>{
            if(refresh&&typeof refresh==='object'&&!Array.isArray(refresh)){
                const runtime=getRuntime();if(!runtime?.getExecutionPage)throw Object.assign(Error(),{code:'EXECUTION_PAGINATION_UNAVAILABLE'});
                return {success:true,...await runtime.getExecutionPage({itemId,itemType,topicId},refresh)};
            }
            if (typeof refresh !== 'boolean') throw Object.assign(Error('INVALID_EXECUTION_QUERY'),{code:'INVALID_EXECUTION_QUERY'});
            const runtime=getRuntime();
            if (!runtime) return {success:true,enabled:false};
            return {success:true,...await runtime.getExecutionStatus({itemId,itemType,topicId},{refresh})};
        },'EXECUTION_STATUS_UNAVAILABLE');
        register('native-sync:core-compact', async (_event, { descriptor, action, settings, requestId }) => {
            const client = getRuntime()?.coreSingle;
            if (!client?.owns(descriptor)) throw fail('CORE_COMPACTION_UNAVAILABLE');
            return action === 'cancel' ? client.cancelCompact(descriptor) : client.compact(descriptor, settings, requestId);
        }, 'CORE_COMPACTION_UNAVAILABLE');
        register('native-sync:core-flowlock', async (_event, { descriptor, action, options }) => {
            const client = getRuntime()?.coreSingle;
            if (!client?.owns(descriptor)) throw fail('CORE_FLOWLOCK_UNAVAILABLE');
            return client.setFlowlock(descriptor, action, options);
        }, 'CORE_FLOWLOCK_UNAVAILABLE');
        register('native-sync:task-stop', async (_event, payload) => {
            const runtime = getRuntime();
            if (!runtime?.stopNativeTask) throw fail('NATIVE_TASK_STOP_UNAVAILABLE');
            return runtime.stopNativeTask(payload);
        }, 'NATIVE_TASK_STOP_FAILED');
        register('native-sync:task-result',async (_event,itemId,itemType,topicId,executionId,nativeTaskId)=>{
            if ([executionId,nativeTaskId].some(v=>typeof v!=='string'||!v||v.length>512||/[\x00-\x1f]/.test(v))) throw Object.assign(Error('INVALID_NATIVE_TASK_QUERY'),{code:'INVALID_NATIVE_TASK_QUERY'});
            const runtime=getRuntime();
            if (!runtime) throw Object.assign(Error('NATIVE_TASK_RESULT_UNAVAILABLE'),{code:'NATIVE_TASK_RESULT_UNAVAILABLE'});
            return {success:true,...await runtime.getNativeTaskResult({itemId,itemType,topicId},executionId,nativeTaskId)};
        },'NATIVE_TASK_RESULT_UNAVAILABLE');
    } catch (error) {
        for (const name of registered) ipcMain.removeHandler(name);
        if (owners.get(ipcMain) === owner) owners.delete(ipcMain);
        throw error;
    }
    return {
        close() {
            if (closing) return closing;
            stopped=true;
            closing=(async()=>{
                await Promise.allSettled([...pending]);
                if (owners.get(ipcMain) === owner) {
                    for (const name of registered) ipcMain.removeHandler(name);
                    owners.delete(ipcMain);
                }
            })();
            return closing;
        },
    };
}
module.exports = { registerNativeSyncQueries, mainWindowSender };

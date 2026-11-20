'use strict';
const path = require('node:path');
const fs = require('node:fs');

// Rust CDS/MobileSync and the JS Queue do not share a process lock. Do not
// pretend that two independent history writers are serialized. Keep MobileSync
// read-capable, but refuse its writes to NativeSync-owned physical histories.
function createSyncWriterBoundary(queue) {
    const normalize = p => process.platform === 'win32' ? p.toLowerCase() : p;
    const topics = () => queue?.syncPolicy?.topics || [];
    const authority = () => require('./historyAuthority').authorityForQueue(queue);
    const controlled = () => authority()?.descriptor;
    const denied = code => Object.assign(new Error(code), {code,retryable:false,status:409});
    return {
        active: () => Boolean(controlled()?.protectAll || controlled()?.protectedScopes?.length || controlled()?.protectedTopics?.length || controlled()?.protectedOwners?.length) || queue?.syncPolicy?.fullSource === true || queue?.syncPolicy?.blocksAllWrites === true || topics().length > 0,
        assertWrite(target) {
            if (!queue || target.ownerType === 'user') return;
            const host = authority(), scope = controlled();
            if (host) {
                if (host.blocked) throw denied('HISTORY_ADMISSION_UNKNOWN');
                const {ownerType,ownerId,topicId} = target;
                queue.getHistoryPath(ownerId, topicId || '_owner_scope');
                if (scope.protectAll || scope.protectedOwners.some(t => t.ownerType === ownerType && t.ownerId === ownerId) ||
                    scope.protectedTopics.some(t => t.ownerType === ownerType && t.ownerId === ownerId && (topicId == null || t.topicId === topicId)) ||
                    scope.protectedScopes.some(t => (!t.ownerType || t.ownerType === ownerType) && (!t.ownerIds || t.ownerIds.includes(ownerId)) && (topicId == null || !t.topicIds || t.topicIds.includes(topicId)))) throw denied('SYNC_WRITER_EXCLUDED');
            }
            if ((queue.syncPolicy?.fullSource === true || queue.syncPolicy?.blocksAllWrites === true)) throw Object.assign(new Error('History recovery scope is not yet verified.'), {code:'SYNC_WRITER_EXCLUDED',retryable:false,status:409});
            if (topics().length) {
                const owner = path.resolve(queue.userDataDir, target.ownerId);
                const paths = target.topicId == null ? [owner] : [owner, path.join(owner, 'topics'), path.join(owner, 'topics', target.topicId), queue.getHistoryPath(target.ownerId, target.topicId)];
                for (const file of paths) {
                    try { if (fs.lstatSync(file).isSymbolicLink()) throw Object.assign(new Error('MobileSync path alias is excluded while NativeSync is active.'), {code:'SYNC_WRITER_EXCLUDED',retryable:false,status:409}); }
                    catch (e) { if (e.code !== 'ENOENT') throw e; }
                }
            }
            const root = normalize(path.resolve(queue.userDataDir, target.ownerId));
            const file = target.topicId == null ? null : normalize(queue.getHistoryPath(target.ownerId, target.topicId));
            const protectedPath = topics().some(t => file
                ? normalize(queue.getHistoryPath(t.itemId, t.topicId)) === file
                : normalize(path.resolve(queue.userDataDir, t.itemId)) === root);
            if (protectedPath) throw Object.assign(new Error('NativeSync owns this history. MobileSync is read-only for this topic/owner; disable NativeSync for it and restart before changing writers.'), {
                code: 'SYNC_WRITER_EXCLUDED', retryable: false, status: 409
            });
        }
    };
}
// Only native successful-delete handlers receive this capability. Legacy
// MobileSync callers still use assertWrite and cannot bypass static exclusion.
async function beginNativeDirectoryDeletion(queue,target){
    if(queue?.syncPolicy?.fullSource===true&&typeof queue.syncPolicy.beginDirectoryDeletion==='function')return queue.syncPolicy.beginDirectoryDeletion(target);
    createSyncWriterBoundary(queue).assertWrite(target);
    return {commit:async()=>{}};
}
module.exports = { createSyncWriterBoundary,beginNativeDirectoryDeletion };

'use strict';
const { invoke, on } = require('../../preloads/core/define');
module.exports = {
    handlers: ['modules/nativeSyncDesktopRuntime/profileStatus.js', 'modules/services/nativeSync/queries.js'],
    roles: ['chat'],
    api: {
        getNativeSyncDesktopStatus: invoke('native-sync:desktop-status'),
        onNativeSyncShowProfileStatus: on('native-sync:show-profile-status'),
        cancelSharedSession: invoke('native-sync:session-cancel', 'payload'),
        getNativeDeletionContext: invoke('native-sync:directory-context', 'scope'),
        getNativeExecutionStatus: invoke('native-sync:executions', 'itemId', 'itemType', 'topicId', 'refresh'),
        getNativeTaskResult: invoke('native-sync:task-result', 'itemId', 'itemType', 'topicId', 'executionId', 'nativeTaskId'),
        coreCompact: invoke('native-sync:core-compact', 'payload'),
        coreFlowlock: invoke('native-sync:core-flowlock', 'payload'),
        stopNativeTask: invoke('native-sync:task-stop', 'payload'),
        onNativeExecutionStatusChanged: on('native-sync:executions-changed'),
        onSharedDirectoryChanged:on('native-sync:directory-changed'),
        submitSharedSteering: invoke('native-sync:steer', 'payload'),
        prepareSharedSend: invoke('native-sync:prepare-send', 'payload'),
        abandonSharedSend: invoke('native-sync:abandon-send', 'payload'),
    },
};

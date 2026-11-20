'use strict';
const { invoke } = require('../../preloads/core/define');
module.exports = {
    handlers: ['modules/nativeSyncSettings/index.js'],
    roles: ['chat'],
    api: {
        retryMissingAttachments: invoke('native-sync-setup:retry-missing-attachments'),
        nativeSyncSetupOverview: invoke('native-sync-setup:overview', 'mode'),
        nativeSyncSetupPreview: invoke('native-sync-setup:preview', 'selection'),
        nativeSyncSetupSave: invoke('native-sync-setup:save', 'confirmation'),
    },
};

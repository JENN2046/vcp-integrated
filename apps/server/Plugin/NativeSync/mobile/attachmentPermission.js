'use strict';

// Attachment status is a read-only POST. Upload creation/chunks/finalization
// require the same shared execute permission as submitting a message.
// A read-only pairing must never be allowed to allocate shared upload storage.
function assertAttachmentOperation({method,path,topic,session,shared}) {
    if (method === 'GET' || (method === 'POST' && path === '/status') || !topic?.sharedSpaceId) return;
    if (!shared) throw Object.assign(new Error('SHARED_SPACE_UNAVAILABLE'), {code:'SHARED_SPACE_UNAVAILABLE',status:409});
    shared.mobile(session, topic.sharedSpaceId, 'execute');
    if (shared.readOnly) throw Object.assign(new Error('SHARED_READ_ONLY'), {code:'SHARED_READ_ONLY',status:403});
}

module.exports = {assertAttachmentOperation};

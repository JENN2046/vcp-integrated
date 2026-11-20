'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { HistoryAuthority } = require('../modules/services/historyAuthority');
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture(deriveProtection = async () => ({})) {
    const events = [], queue = { ownerDirectories: {}, drainForAuthority: async () => {}, isOperationActive: () => false, settledNativeDeletions: () => [] };
    const lifecycle = { isReady: true, prepareHistoryAdmission: async d => { assert.equal(d.protectAll, true); events.push('protect-all'); }, activateHistoryAdmission: async () => events.push('activate') };
    return { events, lifecycle, authority: new HistoryAuthority({ queue, lifecycle, deriveProtection }) };
}
test('close waits for an in-flight refresh and its final all-writer fence cannot be overwritten', async () => {
    const entered = deferred(), hold = deferred(), x = fixture(async () => { entered.resolve(); await hold.promise; return {}; });
    const refresh = x.authority.refresh(); await entered.promise;
    let closed = false; const closing = x.authority.close().then(() => { closed = true; });
    await Promise.resolve(); await Promise.resolve(); assert.equal(closed, false);
    hold.resolve(); await refresh; await closing;
    assert.deepEqual(x.events, ['protect-all', 'activate', 'protect-all']);
    assert.throws(() => x.authority.assertNativeAdmission(), { code: 'HISTORY_AUTHORITY_PENDING' });
    await assert.rejects(x.authority.refresh(), { code: 'HISTORY_AUTHORITY_PENDING' });
});
test('close preserves already accepted scope work while rejecting new and not-yet-started changes', async () => {
    const x = fixture(), entered = deferred(), hold = deferred();
    const accepted = x.authority.withChange(async () => { entered.resolve(); await hold.promise; x.authority.assertNativeAdmission(); return x.authority.withChange(async () => 'accepted'); });
    await entered.promise;
    const queued = x.authority.refresh(); const rejected = assert.rejects(queued, { code: 'HISTORY_AUTHORITY_PENDING' });
    const closing = x.authority.close();
    const late = x.authority.refresh(); const lateRejected = assert.rejects(late, { code: 'HISTORY_AUTHORITY_PENDING' });
    hold.resolve(); assert.equal(await accepted, 'accepted'); await rejected; await lateRejected; await closing;
    assert.equal(x.events.at(-1), 'protect-all');
});
test('failed close keeps admission closed and can retry its final fence', async () => {
    const x = fixture(); let fail = true;
    x.lifecycle.prepareHistoryAdmission = async () => { if (fail) throw Error('synthetic fence failure'); x.events.push('closed'); };
    await assert.rejects(x.authority.close(), /synthetic fence failure/);
    assert.throws(() => x.authority.assertNativeAdmission(), { code: 'HISTORY_AUTHORITY_PENDING' });
    await assert.rejects(x.authority.refresh(), { code: 'HISTORY_AUTHORITY_PENDING' });
    fail = false; await x.authority.close(); assert.deepEqual(x.events, ['closed']);
});

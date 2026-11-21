'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

function load(file) {
    if (!file) throw Error('Usage: node tests/mobile-physical/check-receipts.cjs BASELINE_STATUS CANDIDATE_STATUS');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}
const baseline = load(process.argv[2]);
const candidate = load(process.argv[3]);
function lookupResponse(snapshot, lookup, accepts) {
    return snapshot.requests.find(row => row.route === lookup.route && row.method === 'GET' &&
        Math.abs(row.at - lookup.at) < 50 && accepts(row.matchedExecutions));
}
function rejected(snapshot) {
    const submissions = snapshot.requests.filter(row => row.method === 'POST' && row.route.endsWith('/messages'));
    const rejection = submissions.find(row => row.status === 409 && row.code === 'DESKTOP_CONTEXT_REQUIRED');
    assert.ok(rejection);
    assert.equal(rejection.attachments.length, 1);
    const lookup = snapshot.exactLookups.find(row => row.requestId === rejection.requestId);
    assert.ok(lookup);
    const receipt = lookupResponse(snapshot, lookup, rows => rows?.length === 0);
    assert.equal(receipt?.status, 200);
    assert.deepEqual(receipt.matchedExecutions, []);
    return { rejection, submissions };
}
const baselineRejection = rejected(baseline).rejection;
for (const field of ['work', 'journal', 'links', 'provider', 'tools']) assert.deepEqual(baseline[field], []);
const { rejection, submissions } = rejected(candidate);
const attachment = submissions.find(row => row.text === 'PHYSICAL_ATTACHMENT');
const lost = submissions.find(row => row.text === 'PHYSICAL_LOST_ACK');
assert.equal(submissions.length, 3);
assert.equal(attachment?.status, 202);
assert.deepEqual(attachment.attachments, rejection.attachments);
assert.notEqual(attachment.requestId, rejection.requestId);
assert.equal(lost?.status, 202);
assert.equal(lost.dropped, true);
assert.equal(lost.requestId, candidate.lostRequestId);
assert.equal(candidate.work.length, 2);
for (const row of [attachment, lost]) {
    const work = candidate.work.find(work => work.request_id === row.requestId);
    assert.equal(work?.state, 'completed');
    assert.equal(work.id, row.workId);
    assert.equal(work.attempts, 1);
    assert.equal(candidate.journal.filter(entry => entry.msg_id === work.user_message_id && entry.action === 'upsert').length, 1);
    assert.equal(candidate.journal.filter(entry => entry.msg_id === work.reply_message_id && entry.action === 'upsert').length, 1);
    const provider = candidate.provider.filter(call => call.marker === row.text);
    assert.deepEqual(provider.map(call => call.phase), ['tool-request', 'tool-result']);
    assert.ok(provider.every(call => call.id === work.id));
    assert.equal(provider[1].toolResultSeen, true);
    if (row === attachment) assert.equal(provider[0].attachmentSeen, true);
}
assert.equal(candidate.provider.length, 4);
assert.deepEqual(candidate.tools.map(row => row.marker), ['ORDINARY_TOOL_APPROVE', 'ORDINARY_TOOL_DENY']);
assert.equal(candidate.links.length, 1);
assert.equal(candidate.links[0].hash, candidate.attachmentFixture.sha256);
assert.equal(candidate.links[0].msg_id, candidate.work.find(row => row.request_id === attachment.requestId).user_message_id);
assert.ok(candidate.requests.some(row => row.method === 'GET' && row.status === 200 &&
    row.route.endsWith('/attachments/messages/' + candidate.links[0].msg_id + '/' + candidate.links[0].attachment_id)));
const attempts = candidate.exactLookups.filter(row => row.requestId === lost.requestId);
assert.ok(attempts.some(row => row.held));
const restored = attempts.find(row => !row.held);
assert.ok(restored);
const matched = lookupResponse(candidate, restored, rows => rows?.some(row => row.requestId === lost.requestId));
assert.equal(matched?.status, 200);
assert.deepEqual(matched.matchedExecutions.map(({ id, requestId }) => ({ id, requestId })),
    [{ id: lost.workId, requestId: lost.requestId }]);
console.log(JSON.stringify({
    baselineRejectedRequest: baselineRejection.requestId, candidateRejectedRequest: rejection.requestId,
    attachmentWork: attachment.workId, attachmentSha256: candidate.attachmentFixture.sha256,
    lostReceiptWork: lost.workId, lostReceiptRequest: lost.requestId,
    providerRequests: candidate.provider.length, toolInvocations: candidate.tools.length,
}, null, 2));

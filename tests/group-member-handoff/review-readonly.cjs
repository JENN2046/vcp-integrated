'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

module.exports = async function reviewReadOnly({ service, capture, original, cert }) {
    const sharedSpaceId = 'sharedAB';
    const workId = original.id;
    const ca = readFileSync(cert);
    const headers = {
        origin: service.origin,
        'content-type': 'application/json',
        'x-nativesync-capabilities': 'shared-space-v1,group-member-handoff-v1',
    };
    function request(route, { body, credentials, stream = false } = {}) {
        return new Promise((resolve, reject) => {
            const req = https.request(new URL(route, service.origin), {
                ca, method: body ? 'POST' : 'GET', headers: { ...headers, ...credentials },
            }, res => {
                let buffer = '';
                res.setEncoding('utf8');
                res.on('error', reject);
                res.on('data', chunk => {
                    buffer += chunk;
                    if (!stream || res.statusCode !== 200) return;
                    const frameEnd = buffer.indexOf('\n\n');
                    if (frameEnd === -1) return;
                    try {
                        const frame = buffer.slice(0, frameEnd);
                        const payload = JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6));
                        resolve({ status: res.statusCode, payload });
                    } catch (error) {
                        reject(error);
                    } finally {
                        res.destroy();
                    }
                });
                res.on('end', () => {
                    try {
                        resolve({ status: res.statusCode, payload: JSON.parse(buffer), cookie: res.headers['set-cookie']?.[0]?.split(';')[0] });
                    } catch (error) {
                        reject(error);
                    }
                });
            });
            const deadline = setTimeout(() => req.destroy(Error('Read-only fixture request timed out: ' + route)), 5000);
            req.once('close', () => clearTimeout(deadline));
            req.once('error', reject);
            req.end(body && JSON.stringify(body));
        });
    }
    const grant = await request('/api/plugins/NativeSync/mobile/pairing', {
        body: { scopeMode: 'shared', sharedSpaceId, permissions: ['read'] },
        credentials: { authorization: 'Bearer synthetic-only' },
    });
    assert.equal(grant.status, 200);
    assert.ok(grant.payload.pairingCode);
    const paired = await request('/mobile/api/pair', { body: { code: grant.payload.pairingCode } });
    assert.equal(paired.status, 200);
    assert.ok(paired.cookie);
    const credentials = { cookie: paired.cookie };
    const session = await request('/mobile/api/session', { credentials });
    assert.equal(session.status, 200);
    const permissions = session.payload.sharedPermissions;
    assert.deepEqual(permissions, ['shared:sharedAB:read']);

    const db = new DatabaseSync(path.join(service.data, 'central.sqlite'), { readOnly: true });
    try {
        const { topic_id: sharedId } = db.prepare('SELECT topic_id FROM shared_admissions WHERE id=? AND space_id=?').get(workId, sharedSpaceId);
        const receiptCount = db.prepare('SELECT COUNT(*) AS count FROM shared_receipts WHERE op_id LIKE ?');
        const readState = async () => {
            const query = new URLSearchParams({ sharedSpaceId, sharedId, executionId: workId });
            const { status, payload } = await request('/mobile/api/shared/session-events?' + query, { credentials, stream: true });
            assert.equal(status, 200);
            assert.equal(payload.type, 'snapshot');
            assert.equal(payload.executionId, workId);
            assert.equal(payload.request.requestId, original.request_id);
            assert.equal(payload.request.state, 'review_required');
            assert.equal(payload.request.groupHandoff.state, 'review_required');
            return {
                route: '/mobile/api/shared/session-events', status, workId: payload.executionId,
                requestId: payload.request.requestId, state: payload.request.state,
                groupHandoff: payload.request.groupHandoff, epoch: payload.epoch, seq: payload.seq,
            };
        };
        const observedBefore = await readState();
        const before = capture();
        const receiptsBefore = receiptCount.get('fixture-readonly-%').count;
        assert.equal(before.admission.id, workId);
        assert.equal(before.admission.state, 'review_required');
        assert.equal(before.native[1].state, 'unknown');
        const denied = [];
        for (const action of ['abandon', 'group-continue', 'group-handoff']) {
            const route = '/mobile/api/shared/' + action;
            const opId = 'fixture-readonly-' + action;
            const body = action === 'abandon'
                ? { sharedSpaceId, admissionId: workId, opId, confirm: true }
                : { sharedSpaceId, workId, opId, expectedExecutor: before.handoff.executor,
                    expectedExecutorVersion: before.handoff.executor_version };
            const response = await request(route, { body, credentials });
            assert.equal(response.status, 403, route);
            assert.equal(response.payload.error.code, 'SHARED_PERMISSION_REQUIRED', route);
            assert.deepEqual(capture(), before, route);
            assert.equal(receiptCount.get('fixture-readonly-%').count, receiptsBefore, route);
            denied.push({ route, status: response.status, code: response.payload.error.code });
        }
        const observedAfter = await readState();
        assert.deepEqual(observedAfter, observedBefore);
        return { permissions, observedBefore, denied, observedAfter, durableStateUnchanged: true, operationReceiptsAdded: 0 };
    } finally {
        db.close();
    }
};

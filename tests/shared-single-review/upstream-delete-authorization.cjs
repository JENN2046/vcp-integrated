'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { setTimeout: pause } = require('node:timers/promises');
const { start } = require('../integration/service.cjs');

async function until(read, label) {
    const deadline = Date.now() + 20000;
    do {
        const result = await read();
        if (result) return result;
        await pause(40);
    } while (Date.now() < deadline);
    throw Error(label);
}

async function scenario(legacy, acceptedLegacyDeletion = false) {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-upstream-delete-'));
    const key = path.join(out, 'key.pem');
    const cert = path.join(out, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=isolated-upstream-delete', '-addext', 'subjectAltName=IP:127.0.0.1',
        '-keyout', key, '-out', cert], { stdio: 'ignore' });
    const options = {
        candidate: path.resolve(__dirname, '../..'), cert, key,
        waitUntil: until, trace() {},
        groupRelay: {
            respond(body, _row, response) {
                assert.equal(body.stream, true);
                response.writeHead(502, { 'content-type': 'application/json' })
                    .end(JSON.stringify({ error: { message: 'SYNTHETIC_UPSTREAM_502' } }));
                return true;
            },
        },
        toolHandoff: { agentConfig: { streamOutput: true }, observeRequest: () => false, dropResponse: () => false },
    };
    const legacyRevision = 'b5648e96d883';
    let service, db, spaceId;
    async function launch(run, extra) {
        service = await start({ ...options, out: run, ...extra });
        db = new DatabaseSync(path.join(service.data, 'central.sqlite'), { readOnly: true });
        spaceId ??= JSON.parse(fs.readFileSync(path.join(run, 'seed/desktopA/.native-sync/connection.json'))).spaceId;
    }
    async function close() {
        db?.close();
        db = null;
        await service?.close();
        service = null;
    }
    async function http(route, body, device = 'A') {
        const result = await fetch(service.wsOrigin + '/api/v1/sync/shared/' + route, {
            method: body ? 'POST' : 'GET',
            headers: {
                authorization: 'Bearer synthetic-only',
                'content-type': 'application/json',
                'x-nativesync-space': spaceId,
                'x-nativesync-protocol': '2',
                'x-nativesync-device': 'device' + device,
                'x-nativesync-source': 'source' + device,
                'x-nativesync-capabilities': 'shared-space-v1,shared-context-v1,shared-session-v1',
            },
            body: body && JSON.stringify(body),
        });
        return { status: result.status, value: await result.json() };
    }
    async function request(route, body, status = 200, code, device) {
        const response = await http(route, body, device);
        assert.equal(response.status, status, JSON.stringify(response.value));
        if (code) assert.equal(response.value.error.code, code);
        return response.value;
    }

    try {
        const initial = path.join(out, 'initial');
        fs.mkdirSync(initial);
        await launch(initial, legacy ? { serverRevision: legacyRevision } : {});
        const scope = { sharedSpaceId: 'sharedAB', sharedId: service.topics.preSubmit.id };
        const context = await request('context?' + new URLSearchParams(scope));
        const inputId = 'upstream-delete-original-input';
        const submit = {
            ...scope, requestId: 'upstream-delete-original-request', expectedHead: context.head, configHash: context.hash,
            message: { id: inputId, role: 'user', content: 'Synthetic failed input', timestamp: 1 },
        };
        const { workId } = await request('session-send', submit);
        function snapshot() {
            return {
                work: db.prepare('SELECT * FROM mobile_executions WHERE id=?').get(workId),
                admission: db.prepare('SELECT * FROM shared_admissions WHERE id=?').get(workId),
                native: db.prepare('SELECT * FROM shared_native_requests WHERE admission_id=? ORDER BY ordinal').all(workId),
                journal: db.prepare('SELECT seq,msg_id,action,hash FROM journal WHERE topic_id=? ORDER BY seq').all(scope.sharedId).map(row => ({ ...row })),
                providerCalls: service.calls.length,
            };
        }
        const before = await until(() => {
            const state = snapshot();
            return (legacy ? state.work.state === 'publishing' : state.work.state === 'review_required') &&
                state.native[0]?.state === 'unknown' && state;
        }, 'wait for durable HTTP 502 result');
        assert.equal(before.providerCalls, 1);
        assert.equal(before.work.attempts, 1);
        assert.equal(before.work.reply_message_id, null);
        assert.equal(before.work.native_final_operation, null);
        assert.equal(before.admission.native_terminal, 0);
        assert.equal(before.admission.reply_seq, null);
        assert.equal(before.journal.length, 1);
        assert.equal(before.journal[0].msg_id, inputId);
        if (legacy) {
            assert.ok(before.work.pending_operation);
            assert.equal(before.work.error_code, null);
            assert.equal(before.work.terminal_state, 'completed');
        } else {
            assert.equal(before.work.pending_operation, null);
            assert.equal(before.work.error_code, 'EXECUTION_INTERRUPTED_REVIEW_REQUIRED');
        }

        const { seq: baseSeq, hash: baseHash } = before.journal[0];
        const operation = { msgId: inputId, deviceId: 'desktop:deviceA', opId: 'delete-original', action: 'delete',
            baseHash, baseSeq, message: null };
        const { baseSeq: _baseSeq, ...unversioned } = operation;
        const mutate = (value, ...expectation) => request('message', { ...scope, operation: value }, ...expectation);
        await mutate(operation, 409, 'SHARED_TOPIC_BUSY');
        assert.deepEqual(snapshot(), before);
        await request('abandon', { sharedSpaceId: scope.sharedSpaceId, admissionId: workId, opId: 'close-original', confirm: true });
        let settled = snapshot();
        assert.equal(settled.admission.state, 'abandoned');
        assert.equal(settled.work.state, 'cancelled');
        assert.equal(settled.work.review_resolved, 1);
        assert.equal(settled.work.pending_operation, before.work.pending_operation);
        assert.deepEqual(settled.native, before.native);
        assert.deepEqual(settled.journal, before.journal);
        let legacyReceipt;
        if (legacy) {
            if (acceptedLegacyDeletion) {
                legacyReceipt = await mutate(unversioned);
                assert.equal(legacyReceipt.deleted, true);
                settled = snapshot();
                assert.equal(settled.journal.length, 2);
            }
            const original = path.join(service.data, 'central.sqlite');
            await close();
            const upgrade = path.join(out, 'upgrade');
            fs.mkdirSync(upgrade);
            await launch(upgrade, { restoreSyntheticState: ({ data }) => fs.copyFileSync(original, path.join(data, 'central.sqlite')) });
            assert.deepEqual(snapshot(), { ...settled, providerCalls: 0 });
            settled = snapshot();
        }

        if (legacyReceipt) {
            assert.deepEqual(await mutate(unversioned), { ...legacyReceipt, replayed: true });
            await mutate({ ...unversioned, baseHash: 'f'.repeat(64) }, 409, 'IDEMPOTENCY_KEY_REUSED');
            await mutate({ ...unversioned, opId: 'new-unversioned' }, 400, 'INVALID_SHARED_MESSAGE_MUTATION');
            await mutate({ ...unversioned, deviceId: 'desktop:deviceB' }, 403, 'SHARED_REQUEST_OWNER_REQUIRED', 'B');
            assert.deepEqual(snapshot(), settled);
            console.log('PASS upgrade retains the exact prior unversioned delete receipt and rejects new writes');
        }
        if (!legacyReceipt) {
            await mutate({ ...operation, deviceId: 'desktop:deviceB' }, 403, 'SHARED_REQUEST_OWNER_REQUIRED', 'B');
            await mutate({ ...unversioned, deviceId: 'desktop:deviceB' }, 403, 'SHARED_REQUEST_OWNER_REQUIRED', 'B');
            await mutate(unversioned, 400, 'INVALID_SHARED_MESSAGE_MUTATION');
            await mutate({ ...operation, baseSeq: baseSeq + 1 }, 409, 'MESSAGE_CONFLICT');
            await mutate({ ...operation, baseHash: 'f'.repeat(64) }, 409, 'MESSAGE_CONFLICT');
            assert.deepEqual(snapshot(), settled);

            const receipt = await mutate(operation);
            assert.equal(receipt.deleted, true);
            assert.equal(receipt.replayed, false);
            assert.equal(receipt.seq, baseSeq + 1);
            assert.deepEqual(await mutate(operation), { ...receipt, replayed: true });
            await mutate({ ...operation, baseSeq: baseSeq + 1 }, 409, 'IDEMPOTENCY_KEY_REUSED');
            const repeated = await request('session-send', submit);
            assert.equal(repeated.replayed, true);
            assert.equal(repeated.workId, workId);
            assert.deepEqual(snapshot(), {
                ...settled, journal: [...settled.journal, { seq: receipt.seq, msg_id: inputId, action: 'delete', hash: receipt.hash }],
            });
            console.log('PASS ' + (legacy ? legacyRevision + ' closeout upgraded to candidate' : 'candidate closeout') +
                ' preserves Work, admission, native request, and one versioned tombstone on replay');
        }
    } catch (error) {
        console.error('Isolated evidence directory ' + out);
        throw error;
    } finally {
        await close();
    }
    fs.rmSync(out, { recursive: true, force: true });
}

(async () => {
    await scenario(false);
    await scenario(true);
    await scenario(true, true);
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

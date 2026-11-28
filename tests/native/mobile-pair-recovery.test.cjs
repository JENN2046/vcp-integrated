'use strict';

const assert = require('node:assert/strict');
const { createHash, randomBytes, webcrypto } = require('node:crypto');
const test = require('node:test');
const { coreFixture, localProvider, host } = require('./fixtures/coreSingleHarness.cjs');

const algorithm = { name: 'ECDSA', namedCurve: 'P-256' };

async function deviceKey(origin) {
    const { privateKey, publicKey } = await webcrypto.subtle.generateKey(algorithm, false, ['sign', 'verify']);
    const recoveryPublicKey = Buffer.from(await webcrypto.subtle.exportKey('raw', publicKey)).toString('base64url');
    return {
        recoveryPublicKey,
        async proof(challenge, signedOrigin = origin) {
            const payload = new TextEncoder().encode(JSON.stringify(['vcp-mobile-pair-recovery-v1', signedOrigin, challenge]));
            const bytes = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, payload);
            return { recoveryPublicKey, challenge, signature: Buffer.from(bytes).toString('base64url') };
        }
    };
}

async function fixture(t) {
    const provider = await localProvider(t);
    const f = await coreFixture(t, host(provider).chat);
    const { key } = await f.define({});
    const preMigrationToken = randomBytes(32).toString('base64url');
    f.core.store.db.prepare('INSERT INTO mobile_sessions(hash,id,expires,scopes) VALUES(?,?,?,?)')
        .run(createHash('sha256').update(preMigrationToken).digest('hex'), 'legacy-session', Date.now() + 60_000, '["shared:personal:read"]');
    return {
        origin: f.endpoint, key, preMigrationCookie: '__Secure-vcp_mobile=' + preMigrationToken,
        get db() { return f.core.store.db; },
        createCode() { return f.core.remote.sessions.createCode(['shared:personal:read']).pairingCode; },
        restart: f.restart,
        async call(route, { body, cookie, requestOrigin = f.endpoint } = {}) {
            const response = await f.request('/mobile/api' + route, { body, headers: { origin: requestOrigin, ...(cookie && { cookie }) } });
            const value = await response.json();
            const setCookie = response.headers.get('set-cookie');
            return { status: response.status, value, setCookie, cookie: setCookie?.split(';')[0] };
        }
    };
}

test('WebCrypto proof restores the original scoped session once after missing cookie', async t => {
    const f = await fixture(t);
    const device = await deviceKey(f.origin);
    const paired = await f.call('/pair', { body: { code: f.createCode(), recoveryPublicKey: device.recoveryPublicKey } });
    assert.deepEqual(paired.value, { authenticated: true, recoveryEnrolled: true });
    assert.equal((await f.call('/session')).status, 401);
    assert.equal((await f.call('/selection', { body: { key: f.key }, cookie: paired.cookie })).status, 200);

    const session = () => f.db.prepare('SELECT id,expires,scopes,last_topic_key FROM mobile_sessions WHERE recovery_public_key=?').get(device.recoveryPublicKey);
    const { expires: originalExpiry, ...original } = session();
    const first = await f.call('/session', { cookie: paired.cookie });
    const challengeOptions = { body: { recoveryPublicKey: device.recoveryPublicKey } };
    const challenge = (await f.call('/pair/challenge', challengeOptions)).value.challenge;
    assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await f.call('/pair/challenge', challengeOptions)).value.challenge, challenge);

    assert.equal((await f.call('/pair/recover', { body: await device.proof(challenge, 'https://other.invalid') })).status, 401);
    assert.equal((await f.call('/pair/recover', { body: { ...await (await deviceKey(f.origin)).proof(challenge), recoveryPublicKey: device.recoveryPublicKey } })).status, 401);
    assert.equal((await f.call('/pair/challenge', { ...challengeOptions, requestOrigin: 'https://other.invalid' })).value.error.code, 'ORIGIN_REJECTED');
    await f.restart();

    const body = await device.proof(challenge);
    const other = await f.call('/pair', { body: { code: f.createCode() } });
    assert.equal((await f.call('/pair/challenge', { ...challengeOptions, cookie: other.cookie })).status, 409);
    assert.equal((await f.call('/pair/recover', { body, cookie: other.cookie })).status, 409);

    const attempts = await Promise.all([f.call('/pair/recover', { body }), f.call('/pair/recover', { body })]);
    assert.deepEqual(attempts.map(result => result.status).sort(), [200, 401]);
    const recovered = attempts.find(result => result.status === 200);
    assert.equal(attempts.find(result => result.status === 401).setCookie, null);
    assert.deepEqual(recovered.value, { authenticated: true });
    assert.match(recovered.setCookie, /; Path=\/mobile; HttpOnly; Secure; SameSite=Strict; Max-Age=\d+$/);
    assert.notEqual(recovered.cookie, paired.cookie);
    const { expires: recoveredExpiry, ...bound } = session();
    assert.deepEqual(bound, original);
    assert.ok(recoveredExpiry >= originalExpiry);
    assert.deepEqual((await f.call('/session', { cookie: recovered.cookie })).value, first.value);
    assert.equal((await f.call('/session', { cookie: paired.cookie })).status, 401);

    const next = (await f.call('/pair/challenge', challengeOptions)).value.challenge;
    assert.notEqual(next, challenge);
    assert.equal((await f.call('/pair/recover', { body })).status, 401);
    assert.equal((await f.call('/connection/disconnect', { body: {}, cookie: recovered.cookie })).status, 200);
    assert.equal((await f.call('/pair/recover', { body: await device.proof(next) })).status, 401);
    assert.equal((await f.call('/pair/challenge', challengeOptions)).status, 401);
});

test('enrollment rejects malformed and duplicate keys and expires challenges and authority', async t => {
    const f = await fixture(t);
    const device = await deviceKey(f.origin);
    assert.equal((await f.call('/session', { cookie: f.preMigrationCookie })).status, 200);
    const code = f.createCode();
    const pair = recoveryPublicKey => f.call('/pair', { body: { code, recoveryPublicKey } });
    const invalidPoint = Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString('base64url');
    assert.equal((await pair(invalidPoint)).value.error.code, 'INVALID_PAIR_RECOVERY_KEY');
    const enrolled = await pair(device.recoveryPublicKey);
    assert.equal(enrolled.status, 200);

    const unusedCode = f.createCode();
    const duplicate = await f.call('/pair', { body: { code: unusedCode, recoveryPublicKey: device.recoveryPublicKey } });
    assert.equal(duplicate.value.error.code, 'PAIR_RECOVERY_KEY_ALREADY_BOUND');
    const legacy = await f.call('/pair', { body: { code: unusedCode } });
    assert.deepEqual(legacy.value, { authenticated: true });
    assert.ok(legacy.cookie);

    const challengeRequest = { body: { recoveryPublicKey: device.recoveryPublicKey } };
    const getChallenge = async () => (await f.call('/pair/challenge', challengeRequest)).value.challenge;
    const challenge = await getChallenge();
    f.db.exec('UPDATE mobile_sessions SET recovery_challenge_expires=0 WHERE recovery_public_key IS NOT NULL');
    assert.equal((await f.call('/pair/recover', { body: await device.proof(challenge) })).status, 401);
    const fresh = await getChallenge();
    assert.notEqual(fresh, challenge);
    f.db.exec('UPDATE mobile_sessions SET expires=0 WHERE recovery_public_key IS NOT NULL');
    assert.equal((await f.call('/session', { cookie: enrolled.cookie })).status, 401);
    const renewal = await f.call('/pair/recover', { body: await device.proof(fresh) });
    assert.equal(renewal.status, 200);
    assert.equal((await f.call('/session', { cookie: renewal.cookie })).status, 200);
    assert.equal((await f.call('/pair/recover', { body: await device.proof(fresh) })).status, 401);
});

test('a new pairing rotates the existing recovery key and outstanding proof', async t => {
    const f = await fixture(t);
    const device = await deviceKey(f.origin);
    const paired = await f.call('/pair', { body: { code: f.createCode(), recoveryPublicKey: device.recoveryPublicKey } });
    const challengeOptions = { body: { recoveryPublicKey: device.recoveryPublicKey } };
    const challenge = (await f.call('/pair/challenge', challengeOptions)).value.challenge;
    const fresh = await f.call('/pair', { body: { code: f.createCode() }, cookie: paired.cookie });
    assert.equal(fresh.status, 200);
    assert.equal((await f.call('/session', { cookie: fresh.cookie })).status, 200);
    assert.equal((await f.call('/session', { cookie: paired.cookie })).status, 200);
    assert.equal((await f.call('/pair/challenge', challengeOptions)).status, 401);
    assert.equal((await f.call('/pair/recover', { body: await device.proof(challenge) })).status, 401);
});

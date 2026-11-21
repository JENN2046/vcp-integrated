'use strict';

const assert = require('node:assert/strict');
const { createHash, randomBytes, webcrypto } = require('node:crypto');
const path = require('node:path');
const test = require('node:test');

const serverRoot = process.env.VCP_TEST_SERVER || path.resolve(__dirname, '../../apps/server');
const express = require(serverRoot + '/node_modules/express');
const { CentralStore } = require(serverRoot + '/Plugin/NativeSync/sync/centralStore');
const { MobilePortal } = require(serverRoot + '/Plugin/NativeSync/mobile/portal');

const origin = 'https://synthetic-mobile.invalid';
const algorithm = { name: 'ECDSA', namedCurve: 'P-256' };

async function deviceKey() {
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
    const store = new CentralStore(':memory:');
    const opts = {
        store,
        config: {
            NativeMobileOrigin: origin, NativeMobileBackendUrl: origin,
            NativeMobileKeyExchangeEnabled: true, NativeMobileSessionHours: 1,
            NativeMobileTopics: JSON.stringify([{ key: 'test', ownerType: 'agent', ownerId: 'test', topicId: 'test' }])
        },
        agentManager: { isAgent: () => false }
    };
    // Model a session row written before the additive recovery migration.
    store.db.exec("CREATE TABLE mobile_sessions(hash TEXT PRIMARY KEY,id TEXT NOT NULL UNIQUE,expires INTEGER NOT NULL,scopes TEXT NOT NULL)");
    const preMigrationToken = randomBytes(32).toString('base64url');
    store.db.prepare('INSERT INTO mobile_sessions(hash,id,expires,scopes) VALUES(?,?,?,?)')
        .run(createHash('sha256').update(preMigrationToken).digest('hex'), 'legacy-session', Date.now() + 60_000, '["test"]');
    let portal = new MobilePortal(opts);
    const app = express();
    app.set('trust proxy', 'loopback');
    app.use('/mobile', (req, res, next) => portal.router(req, res, next));
    const server = app.listen(0, '127.0.0.1');
    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await portal.close();
        store.db.close();
    });
    await new Promise(resolve => server.once('listening', resolve));
    const url = 'http://127.0.0.1:' + server.address().port + '/mobile/api';

    async function call(route, { body, cookie, requestOrigin = origin } = {}) {
        const response = await fetch(url + route, {
            method: body ? 'POST' : 'GET',
            headers: { 'x-forwarded-proto': 'https', 'content-type': 'application/json', origin: requestOrigin, ...(cookie ? { cookie } : {}) },
            body: body && JSON.stringify(body)
        });
        const value = await response.json();
        const setCookie = response.headers.get('set-cookie');
        return { status: response.status, value, setCookie, cookie: setCookie?.split(';')[0] };
    }
    return {
        call, db: store.db, preMigrationCookie: '__Secure-vcp_mobile=' + preMigrationToken,
        createCode() { return portal.createPairing().pairingCode; },
        async restart() {
            await portal.close();
            portal = new MobilePortal(opts);
        },
        allowFixtureReauthentication() { portal.connection.verifyKey = key => key === 'synthetic-only'; }
    };
}

test('WebCrypto proof restores the original scoped session once after missing cookie', async t => {
    const f = await fixture(t);
    const device = await deviceKey();
    const paired = await f.call('/pair', { body: { code: f.createCode(), recoveryPublicKey: device.recoveryPublicKey } });
    assert.deepEqual(paired.value, { authenticated: true, recoveryEnrolled: true });
    assert.equal((await f.call('/session')).status, 401);
    assert.equal((await f.call('/selection', { body: { key: 'test' }, cookie: paired.cookie })).status, 200);

    const session = () => f.db.prepare('SELECT id,expires,scopes,last_topic_key FROM mobile_sessions WHERE recovery_public_key=?').get(device.recoveryPublicKey);
    const original = session();
    const first = await f.call('/session', { cookie: paired.cookie });
    const challengeOptions = { body: { recoveryPublicKey: device.recoveryPublicKey } };
    const challenge = (await f.call('/pair/challenge', challengeOptions)).value.challenge;
    assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await f.call('/pair/challenge', challengeOptions)).value.challenge, challenge);

    assert.equal((await f.call('/pair/recover', { body: await device.proof(challenge, 'https://other.invalid') })).status, 401);
    assert.equal((await f.call('/pair/recover', { body: { ...await (await deviceKey()).proof(challenge), recoveryPublicKey: device.recoveryPublicKey } })).status, 401);
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
    assert.deepEqual(session(), original);
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
    const device = await deviceKey();
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
    assert.equal((await f.call('/pair/recover', { body: await device.proof(fresh) })).status, 401);
    assert.equal((await f.call('/pair/challenge', challengeRequest)).status, 401);
});

test('reauthentication removes the existing recovery key and outstanding proof', async t => {
    const f = await fixture(t);
    const device = await deviceKey();
    const paired = await f.call('/pair', { body: { code: f.createCode(), recoveryPublicKey: device.recoveryPublicKey } });
    const challengeOptions = { body: { recoveryPublicKey: device.recoveryPublicKey } };
    const challenge = (await f.call('/pair/challenge', challengeOptions)).value.challenge;
    f.allowFixtureReauthentication();
    const authenticated = await f.call('/connection/authenticate', { body: { serverUrl: origin, apiKey: 'synthetic-only' }, cookie: paired.cookie });
    assert.equal(authenticated.status, 200);
    assert.equal((await f.call('/session', { cookie: authenticated.cookie })).status, 200);
    assert.equal((await f.call('/pair/challenge', challengeOptions)).status, 401);
    assert.equal((await f.call('/pair/recover', { body: await device.proof(challenge) })).status, 401);
});

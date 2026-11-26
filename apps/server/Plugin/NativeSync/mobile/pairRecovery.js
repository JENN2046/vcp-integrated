'use strict';

const { createPublicKey, randomBytes, verify } = require('node:crypto');
const error = (code, status = 400) => Object.assign(Error(code), { code, status });

const challengeLifetimeMs = 60_000;
const proofContext = 'vcp-mobile-pair-recovery-v1';

function canonicalBytes(value, size) {
    if (typeof value !== 'string' || value.length !== Math.ceil(size * 8 / 6) || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
    const bytes = Buffer.from(value, 'base64url');
    return bytes.length === size && bytes.toString('base64url') === value ? bytes : null;
}

function recoveryPublicKey(value) {
    const bytes = canonicalBytes(value, 65);
    if (!bytes || bytes[0] !== 4) return null;
    try {
        return createPublicKey({
            format: 'jwk',
            key: {
                kty: 'EC', crv: 'P-256',
                x: bytes.subarray(1, 33).toString('base64url'),
                y: bytes.subarray(33).toString('base64url')
            }
        });
    } catch {
        return null;
    }
}

const pairRequired = () => error('PAIR_REQUIRED', 401);

class PairRecovery {
    constructor(db, origin, renewSeconds = 0) {
        this.db = db;
        this.origin = origin;
        this.renewSeconds = renewSeconds;
        this.trustedDevice = Number(renewSeconds > 0);
        const columns = db.prepare('PRAGMA table_info(mobile_sessions)').all();
        for (const [name, type] of [
            ['recovery_public_key', 'TEXT'],
            ['recovery_challenge', 'TEXT'],
            ['recovery_challenge_expires', 'INTEGER']
        ]) {
            if (!columns.some(column => column.name === name)) {
                db.exec(`ALTER TABLE mobile_sessions ADD COLUMN ${name} ${type}`);
            }
        }
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS mobile_sessions_recovery_key ON mobile_sessions(recovery_public_key) WHERE recovery_public_key IS NOT NULL');
    }

    hasKey(key) {
        return Boolean(this.db.prepare('SELECT 1 FROM mobile_sessions WHERE recovery_public_key=?').get(key));
    }

    clear(sessionId) {
        this.db.prepare(`UPDATE mobile_sessions
            SET recovery_public_key=NULL, recovery_challenge=NULL, recovery_challenge_expires=NULL
            WHERE id=? AND recovery_public_key IS NOT NULL`).run(sessionId);
    }

    challenge(body) {
        const key = body?.recoveryPublicKey;
        if (!canonicalBytes(key, 65)) throw pairRequired();
        const now = Date.now();
        // A request using only the public key can reuse a live challenge but
        // cannot invalidate one that another caller is already signing.
        // The remote Core can recover an expired Cookie using the enrolled
        // device proof. Legacy callers keep the original session deadline.
        const read = this.db.prepare(`SELECT expires, recovery_challenge, recovery_challenge_expires FROM mobile_sessions
            WHERE recovery_public_key=? AND (expires>? OR ?=1)`);
        const current = read.get(key, now, this.trustedDevice);
        if (!current) throw pairRequired();
        if (current.recovery_challenge_expires > now) return current.recovery_challenge;

        const proofExpires = now + challengeLifetimeMs;
        const row = this.db.prepare(`UPDATE mobile_sessions
            SET recovery_challenge=?, recovery_challenge_expires=?
            WHERE recovery_public_key=? AND (expires>? OR ?=1) AND coalesce(recovery_challenge_expires, 0)<=?
            RETURNING recovery_challenge`).get(randomBytes(32).toString('base64url'),
                this.trustedDevice ? proofExpires : Math.min(current.expires, proofExpires), key, now, this.trustedDevice, now);
        const challenge = row?.recovery_challenge ?? read.get(key, now, this.trustedDevice)?.recovery_challenge;
        if (!challenge) throw pairRequired();
        return challenge;
    }

    recover(body, cookieHash) {
        const { recoveryPublicKey: key, challenge, signature } = body ?? {};
        const proof = canonicalBytes(signature, 64);
        if (!proof || !canonicalBytes(challenge, 32) || !canonicalBytes(key, 65)) throw pairRequired();
        const startedAt = Date.now();
        const row = this.db.prepare(`SELECT id FROM mobile_sessions
            WHERE recovery_public_key=? AND recovery_challenge=? AND (expires>? OR ?=1) AND recovery_challenge_expires>?`)
            .get(key, challenge, startedAt, this.trustedDevice, startedAt);
        if (!row) throw pairRequired();
        const publicKey = recoveryPublicKey(key);
        const message = Buffer.from(JSON.stringify([proofContext, this.origin, challenge]));
        if (!publicKey || !verify('sha256', message, { key: publicKey, dsaEncoding: 'ieee-p1363' }, proof)) throw pairRequired();
        const now = Date.now();
        const recovered = this.db.prepare(`UPDATE mobile_sessions
            SET hash=?, expires=CASE WHEN ?=1 THEN ? ELSE expires END,
                recovery_challenge=NULL, recovery_challenge_expires=NULL
            WHERE id=? AND recovery_public_key=? AND recovery_challenge=? AND (expires>? OR ?=1) AND recovery_challenge_expires>?
            RETURNING expires`).get(cookieHash, this.trustedDevice, now + this.renewSeconds * 1000,
                row.id, key, challenge, now, this.trustedDevice, now);
        if (!recovered) throw pairRequired();
        return recovered.expires;
    }
}

module.exports = { PairRecovery, recoveryPublicKey };

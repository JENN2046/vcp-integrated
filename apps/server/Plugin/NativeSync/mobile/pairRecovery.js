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
    constructor(db, origin) {
        this.db = db;
        this.origin = origin;
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
        const read = this.db.prepare(`SELECT recovery_challenge, recovery_challenge_expires FROM mobile_sessions
            WHERE recovery_public_key=? AND expires>?`);
        const current = read.get(key, now);
        if (!current) throw pairRequired();
        if (current.recovery_challenge_expires > now) return current.recovery_challenge;

        const row = this.db.prepare(`UPDATE mobile_sessions
            SET recovery_challenge=?, recovery_challenge_expires=min(expires, ?)
            WHERE recovery_public_key=? AND expires>? AND coalesce(recovery_challenge_expires, 0)<=?
            RETURNING recovery_challenge`).get(randomBytes(32).toString('base64url'), now + challengeLifetimeMs, key, now, now);
        const challenge = row?.recovery_challenge ?? read.get(key, now)?.recovery_challenge;
        if (!challenge) throw pairRequired();
        return challenge;
    }

    recover(body, cookieHash) {
        const { recoveryPublicKey: key, challenge, signature } = body ?? {};
        const proof = canonicalBytes(signature, 64);
        if (!proof || !canonicalBytes(challenge, 32) || !canonicalBytes(key, 65)) throw pairRequired();
        const startedAt = Date.now();
        const row = this.db.prepare(`SELECT id FROM mobile_sessions
            WHERE recovery_public_key=? AND recovery_challenge=? AND expires>? AND recovery_challenge_expires>?`)
            .get(key, challenge, startedAt, startedAt);
        if (!row) throw pairRequired();
        const publicKey = recoveryPublicKey(key);
        const message = Buffer.from(JSON.stringify([proofContext, this.origin, challenge]));
        if (!publicKey || !verify('sha256', message, { key: publicKey, dsaEncoding: 'ieee-p1363' }, proof)) throw pairRequired();
        const now = Date.now();
        const recovered = this.db.prepare(`UPDATE mobile_sessions
            SET hash=?, recovery_challenge=NULL, recovery_challenge_expires=NULL
            WHERE id=? AND recovery_public_key=? AND recovery_challenge=? AND expires>? AND recovery_challenge_expires>?
            RETURNING expires`).get(cookieHash, row.id, key, challenge, now, now);
        if (!recovered) throw pairRequired();
        return recovered.expires;
    }
}

module.exports = { PairRecovery, recoveryPublicKey };

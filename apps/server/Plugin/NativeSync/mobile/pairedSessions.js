'use strict';

const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { PairRecovery, recoveryPublicKey } = require('./pairRecovery');
const error = (code, status = 400) => Object.assign(Error(code), { code, status });
const digest = value => createHash('sha256').update(value).digest('hex');
const cookieName = '__Secure-vcp_mobile';
const mobileCookies = req => String(req.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith(cookieName + '='));
const protectedHttps = req => Boolean(req.socket?.encrypted) || (req.secure === true && ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket?.remoteAddress));

class PairedSessions {
    constructor(db, origin, hours = 8) {
        this.db = db;
        this.origin = origin;
        this.sessionSeconds = Math.floor(hours * 3600);
        this.db.exec(`CREATE TABLE IF NOT EXISTS mobile_pairings(hash TEXT PRIMARY KEY,expires INTEGER NOT NULL,scopes TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS mobile_sessions(hash TEXT PRIMARY KEY,id TEXT NOT NULL UNIQUE,expires INTEGER NOT NULL,scopes TEXT NOT NULL);`);
        if(!this.db.prepare('PRAGMA table_info(mobile_sessions)').all().some(c=>c.name==='last_topic_key'))this.db.exec('ALTER TABLE mobile_sessions ADD COLUMN last_topic_key TEXT');
        this.pairRecovery = new PairRecovery(this.db, this.origin);
    }

    createCode(scopes) {
        const pairingCode = randomBytes(24).toString('base64url');
        const expiresAt = Date.now() + 180000;
        this.db.prepare('INSERT INTO mobile_pairings(hash,expires,scopes) VALUES(?,?,?)')
            .run(digest(pairingCode), expiresAt, JSON.stringify(scopes));
        return { pairingCode, expiresAt };
    }

    sessionForToken(token) {
        if (!/^[a-zA-Z0-9_-]{43}$/.test(token || '')) return null;
        const row = this.db.prepare('SELECT id,expires,scopes,last_topic_key FROM mobile_sessions WHERE hash=?').get(digest(token));
        return row && row.expires>Date.now() ? row : null;
    }

    currentSession(req) {
        const values=mobileCookies(req);if(values.length!==1)return null;
        return this.sessionForToken(values[0].slice(cookieName.length+1));
    }
    requireMissingSession(req) {
        if (mobileCookies(req).length > 1 || this.currentSession(req)) throw error('MOBILE_SESSION_ALREADY_AUTHENTICATED', 409);
    }
    setSessionCookie(res, token, maxAge = this.sessionSeconds) {
        res.setHeader('Set-Cookie',`${cookieName}=${token}; Path=/mobile; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`);
    }
    pair(req,res) {
        const { token, enrolled } = this.redeem(req.body, this.currentSession(req), 'mobile');
        this.setSessionCookie(res, token);
        res.json({ authenticated: true, ...(enrolled && { recoveryEnrolled: true }) });
    }

    redeem(body, previous, kind) {
        const code=body?.code;
        if(typeof code!=='string'||!/^[a-zA-Z0-9_-]{32}$/.test(code))throw error('INVALID_PAIRING',401);
        const hash=digest(code),now=Date.now();const grant=this.db.prepare('SELECT * FROM mobile_pairings WHERE hash=?').get(hash);
        if(!grant||grant.used||grant.expires<=now)throw error('INVALID_PAIRING',401);
        const desktop = JSON.parse(grant.scopes).includes('desktop');
        if (desktop !== (kind === 'desktop')) throw error('INVALID_PAIRING', 401);
        const key = body.recoveryPublicKey;
        if (desktop && key !== undefined) throw error('INVALID_PAIR_RECOVERY_KEY', 400);
        if (key !== undefined && !recoveryPublicKey(key)) throw error('INVALID_PAIR_RECOVERY_KEY', 400);
        const token=randomBytes(32).toString('base64url'),id=randomUUID();
        this.db.exec('BEGIN IMMEDIATE');
        try {
            if(!this.db.prepare('UPDATE mobile_pairings SET used=1 WHERE hash=? AND used=0 AND expires>?').run(hash,now).changes)throw error('INVALID_PAIRING',401);
            if (key !== undefined && this.pairRecovery.hasKey(key)) throw error('PAIR_RECOVERY_KEY_ALREADY_BOUND', 409);
            if (previous) this.pairRecovery.clear(previous.id);
            const scopes = this.db.prepare('SELECT scopes FROM mobile_pairings WHERE hash=?').get(hash).scopes;
            this.db.prepare('INSERT INTO mobile_sessions(hash,id,expires,scopes,recovery_public_key) VALUES(?,?,?,?,?)').run(digest(token),id,now+this.sessionSeconds*1000,scopes,key ?? null);
            this.db.exec('COMMIT');
        } catch(e){this.db.exec('ROLLBACK');throw e;}
        return { token, id, enrolled: key !== undefined };
    }

    challenge(req) {
        this.requireMissingSession(req);
        return { challenge: this.pairRecovery.challenge(req.body) };
    }

    recover(req, res) {
        this.requireMissingSession(req);
        const token = randomBytes(32).toString('base64url');
        const expires = this.pairRecovery.recover(req.body, digest(token));
        this.setSessionCookie(res, token, Math.max(1, Math.ceil((expires - Date.now()) / 1000)));
        res.json({ authenticated: true });
    }

    disconnect(req, res, session) {
        this.db.prepare('DELETE FROM mobile_sessions WHERE id=?').run(session.id);
        this.setSessionCookie(res, '', 0);
        res.json({ authenticated: false });
    }
}

module.exports = { PairedSessions, cookieName, protectedHttps, digest };

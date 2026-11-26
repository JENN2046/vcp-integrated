'use strict';

const express = require('express');
const path = require('node:path');
const { PairedSessions, protectedHttps } = require('../Plugin/NativeSync/mobile/pairedSessions');
const { entryId, sessionMarker } = require('../Plugin/NativeSync/mobile/submissionRecovery');
const { failure } = require('./store');

function remoteOrigin(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== value) throw failure('CORE_REMOTE_HTTPS_ORIGIN_REQUIRED');
    return url;
}

class RemoteAccess {
    constructor(core, { origin, hours }) {
        this.core = core;
        this.url = remoteOrigin(origin);
        this.db = core.store.db;
        this.sessions = new PairedSessions(this.db, origin, hours);
    }

    actor(row, kind, workspace, permission) {
        if (!row || row.expires <= Date.now()) throw failure('PAIR_REQUIRED', 401);
        const scopes = JSON.parse(row.scopes);
        if (workspace !== this.core.workspace || scopes.includes('desktop') !== (kind === 'desktop') ||
            !scopes.includes('shared:' + workspace + ':' + permission)) throw failure('CORE_WORKSPACE_FORBIDDEN', 403);
        return { kind, principal: kind + ':' + row.id, sourceId: row.id, deviceId: row.id };
    }

    live(principal, permission) {
        const [kind, id] = principal.split(':');
        if (!['desktop', 'mobile'].includes(kind) || !id) throw failure('WORK_AUTHORITY_REVOKED', 403);
        const row = this.db.prepare('SELECT id,expires,scopes FROM mobile_sessions WHERE id=?').get(id);
        return this.actor(row, kind, this.core.workspace, permission);
    }

    recovery(session) {
        return { version: 1, entryId: entryId(this.url.origin, this.url.origin), sessionMarker: sessionMarker(session.id) };
    }

    requireSubmissionContext(req) {
        const entries = [req.get('x-nativesync-entry-id'), req.get('x-nativesync-session-marker')];
        const session = this.sessions.currentSession(req);
        if (!session) throw failure('PAIR_REQUIRED', 401);
        const expected = this.recovery(session);
        if (entries[0] !== expected.entryId || entries[1] !== expected.sessionMarker) {
            throw failure('SUBMISSION_CONTEXT_CHANGED');
        }
    }

    router(kind) {
        const router = express.Router();
        const mobile = kind === 'mobile';
        const find = mobile ? req => this.sessions.currentSession(req) :
            req => this.sessions.sessionForToken(/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get('authorization') || '')?.[1]);
        const workspace = this.core.workspace;
        const authorize = (req, space, permission) => this.actor(find(req), kind, space, permission);
        const server = { serverUrl: this.url.origin, credentialExchangeAllowed: false, mode: 'core' };
        router.use((req, res, next) => {
            // The only proxy trusted for this surface is the colocated TLS terminator.
            if (!protectedHttps(req) || (!req.socket.encrypted && req.get('x-forwarded-proto') !== 'https') ||
                req.get('host') !== this.url.host) return next(failure('HTTPS_REQUIRED', 403));
            if (req.get('origin') && req.get('origin') !== this.url.origin ||
                mobile && !['GET', 'HEAD'].includes(req.method) && req.get('origin') !== this.url.origin) {
                return next(failure('ORIGIN_REJECTED', 403));
            }
            this.core.checkStorage(req);
            res.set({
                'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
                'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
            });
            next();
        });
        const exchange = express.json({ limit: '4kb', strict: true });
        const service = mobile ? '/api/core' : '/';
        const core = express.Router();
        core.use((req, _res, next) => {
            authorize(req, workspace, 'read');
            next();
        }, express.json({ limit: mobile ? '128kb' : '16mb', strict: true }), this.core.router(authorize));
        if (!mobile) {
            router.post('/pair', exchange, (req, res) => {
                if (this.core.runner.draining) throw failure('HOST_DRAINING', 503);
                const { token, id } = this.sessions.redeem(req.body, null, kind);
                res.json({ token, deviceId: id, workspace });
            });
            router.get('/session', (req, res) => {
                const actor = authorize(req, workspace, 'read');
                const scopes = JSON.parse(find(req).scopes);
                res.json({ deviceId: actor.deviceId, workspace, permissions: scopes.filter(scope => scope.startsWith('shared:' + workspace + ':')).map(scope => scope.split(':').at(-1)) });
            });
            router.use(service, core);
        } else {
            router.get('/api/connection', (_req, res) => res.json(server));
            router.post('/api/pair', exchange, (req, res) => {
                if (this.core.runner.draining) throw failure('HOST_DRAINING', 503);
                this.sessions.pair(req, res);
            });
            router.post('/api/pair/challenge', exchange, (req, res) => res.json(this.sessions.challenge(req)));
            router.post('/api/pair/recover', exchange, (req, res) => this.sessions.recover(req, res));
            router.use(service, core);
            router.get('/api/session', (req, res) => {
                const actor = authorize(req, workspace, 'read');
                const session = find(req);
                const permissions = JSON.parse(session.scopes);
                const directory = this.core.local.mobileDirectory(actor, permissions.includes('shared:' + workspace + ':execute'), this.core.historyDeleted);
                res.json({ authenticated: true, storageId: this.core.store.storageId, server, recovery: this.recovery(session), selectedTopic: session.last_topic_key,
                    ...directory, directory: { paged: false }, sharedFeatures: [], sharedPermissions: [] });
            });
            router.post('/api/selection', exchange, (req, res) => {
                const actor = authorize(req, workspace, 'read');
                const topic = this.core.topic(actor, workspace, req.body?.key, 'read');
                this.db.prepare('UPDATE mobile_sessions SET last_topic_key=? WHERE id=?').run(topic.key, actor.deviceId);
                res.json({ selectedTopic: topic.key });
            });
            router.post('/api/connection/disconnect', (req, res) => {
                authorize(req, workspace, 'read');
                this.sessions.disconnect(req, res, find(req));
            });
            router.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND' } }));
            router.use(express.static(path.join(__dirname, '../Plugin/NativeSync/mobile-dist'), {
                index: 'index.html', dotfiles: 'deny', maxAge: 0
            }));
        }
        router.use((error, _req, res, next) => {
            if (res.headersSent) return next(error);
            res.status(error.status || 503).json({ error: { code: error.code || 'CORE_REQUEST_FAILED' } });
        });
        return router;
    }
}

module.exports = { RemoteAccess, remoteOrigin };

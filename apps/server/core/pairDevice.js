'use strict';

// Deployment operator entry point. Only the server account can open the Core database.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { PairedSessions } = require('../Plugin/NativeSync/mobile/pairedSessions');
const { remoteOrigin } = require('./remoteAccess');

function administer(env, [command, value, setting]) {
    const directory = env.VCP_CORE_DATA_DIR;
    const origin = remoteOrigin(env.VCP_CORE_REMOTE_ORIGIN).origin;
    if (!directory || !path.isAbsolute(directory)) throw Error('CORE_DATA_DIRECTORY_REQUIRED');
    const file = path.join(directory, 'core.sqlite');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1) throw Error('CORE_DATA_FILE_ALIAS');
    const db = new DatabaseSync(file);
    try {
        db.exec('PRAGMA busy_timeout=5000');
        const entries = Object.fromEntries(db.prepare('SELECT key,value FROM core_metadata').all().map(row => [row.key, row.value]));
        if (entries.authority !== 'local' || !entries.local_workspace || entries.remote_origin !== origin) {
            throw Error('CORE_REMOTE_AUTHORITY_NOT_INITIALIZED');
        }
        if (command === 'list' && value === undefined) return db.prepare('SELECT id,expires,scopes FROM mobile_sessions WHERE expires>? OR recovery_public_key IS NOT NULL ORDER BY expires').all(Date.now());
        if (command === 'revoke' && /^[0-9a-f-]{36}$/.test(value || '')) {
            return { revoked: Boolean(db.prepare('DELETE FROM mobile_sessions WHERE id=?').run(value).changes) };
        }
        if (command === 'agent-create' && /^[0-9a-f-]{36}$/.test(value || '') && ['on', 'off'].includes(setting)) {
            const prefix = 'shared:' + entries.local_workspace + ':';
            const grant = prefix + 'create-agent';
            const row = db.prepare('SELECT scopes FROM mobile_sessions WHERE id=?').get(value);
            const scopes = row ? JSON.parse(row.scopes) : [];
            if (scopes.includes('desktop') || !['read', 'execute'].every(scope => scopes.includes(prefix + scope))) {
                throw Error('CORE_MOBILE_EXECUTION_DEVICE_REQUIRED');
            }
            // Match the previous scopes so a concurrent revoke cannot recreate a session.
            const next = scopes.filter(scope => scope !== grant);
            if (setting === 'on') next.push(grant);
            if (!db.prepare('UPDATE mobile_sessions SET scopes=? WHERE id=? AND scopes=?')
                .run(JSON.stringify(next), value, row.scopes).changes) throw Error('CORE_DEVICE_GRANTS_CHANGED');
            return { deviceId: value, createAgent: setting === 'on' };
        }
        const grants = {
            desktop: ['read', 'execute', 'config'], 'desktop-reader': ['read', 'execute'],
            mobile: ['read', 'execute'], 'mobile-reader': ['read']
        };
        if (command !== 'pair' || !Object.hasOwn(grants, value) || setting !== undefined) throw Error('Use pair desktop|desktop-reader|mobile|mobile-reader, list, revoke DEVICE_ID, or agent-create DEVICE_ID on|off');
        const scopes = grants[value].map(permission => 'shared:' + entries.local_workspace + ':' + permission);
        if (value.startsWith('desktop')) scopes.push('desktop');
        return new PairedSessions(db, origin).createCode(scopes);
    } finally {
        db.close();
    }
}

if (require.main === module) {
    try { process.stdout.write(JSON.stringify(administer(process.env, process.argv.slice(2))) + '\n'); }
    catch (error) { process.stderr.write((error.code || error.message) + '\n'); process.exitCode = 1; }
}
module.exports = { administer };

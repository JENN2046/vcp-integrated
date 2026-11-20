'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { DatabaseSync } = require('node:sqlite');
const { sharedConfig, sharedIdentity } = require('./contracts.generated.cjs');
const { stable, sha256, fail } = require('./protocol');
const { assertHistoryPath } = require('./sourceDirectory');

function validateConfig(object, space, id = object?.id, known, metadata) {
    sharedIdentity(id);
    if (object?.id !== id || object.sharedSpaceId !== space || !Number.isSafeInteger(object.version) ||
        object.version < 1 || sha256(stable(sharedConfig(object.kind, object.config))) !== object.configHash) {
        throw fail('SHARED_CONFIG_RESPONSE_INVALID');
    }
    if (known) checkVersion(object, known.version, known.hash);
    if (metadata) checkVersion(object, metadata.version, metadata.configHash);
}

function checkVersion(object, version, hash) {
    if (!Number.isSafeInteger(version) || version < 1 || !/^[a-f0-9]{64}$/.test(hash)) throw fail('SHARED_CONFIG_STATE_INVALID');
    if (object.version < version) throw fail('SHARED_CONFIG_VERSION_REWIND');
    if (object.version === version && object.configHash !== hash) throw fail('SHARED_CONFIG_RESPONSE_INVALID');
}

async function openConfigDatabase(root, connection) {
    const dir = path.join(root, '.native-sync', 'shared', connection.sharedSpaceId);
    const file = path.join(dir, 'config-versions.sqlite');
    await assertHistoryPath(root, file);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(file);
    try {
        db.exec('PRAGMA busy_timeout=500; PRAGMA synchronous=FULL');
        return db;
    } catch (error) {
        db.close();
        throw error;
    }
}

// A read can be confirmed without materializing any local config. Store only
// its version and digest; the replica remains the owner of projections and drafts.
async function observeConfigVersions(root, connection, objects) {
    if (!objects.length) return;
    const binding = stable([connection.url, connection.spaceId, connection.sourceId, connection.deviceId, connection.sharedSpaceId]);
    const db = await openConfigDatabase(root, connection);
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS confirmed (
            binding TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL,
            hash TEXT NOT NULL, PRIMARY KEY(binding, id))`);
        const read = db.prepare('SELECT version,hash FROM confirmed WHERE binding=? AND id=?');
        const newer = objects.filter(object => {
            const row = read.get(binding, object.id);
            if (row) checkVersion(object, row.version, row.hash);
            return !row || object.version > row.version;
        });
        if (!newer.length) return;
        db.exec('BEGIN IMMEDIATE');
        const write = db.prepare(`INSERT INTO confirmed VALUES(?,?,?,?)
            ON CONFLICT(binding,id) DO UPDATE SET version=excluded.version, hash=excluded.hash
            WHERE excluded.version > confirmed.version`);
        for (const object of newer) {
            const result = write.run(binding, object.id, object.version, object.configHash);
            if (!result.changes) {
                // A concurrent confirmer won. Compare its revision before returning.
                const row = read.get(binding, object.id);
                checkVersion(object, row.version, row.hash);
            }
        }
        db.exec('COMMIT');
    } finally {
        db.close(); // Also rolls back an unfinished transaction.
    }
}
module.exports = { validateConfig, checkVersion, observeConfigVersions, openConfigDatabase };

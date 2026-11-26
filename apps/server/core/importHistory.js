'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const { CoreStore } = require('./store');
const { identity, stable, sha256 } = require('../Plugin/NativeSync/sync/protocol');
const { projectStoredMessage } = require('../Plugin/NativeSync/sync/centralStore');
const { AttachmentStore, MAX_FILE, detect, hash } = require('../Plugin/NativeSync/mobile/attachments');

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hasTable = (db, name) => db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const tuple = ({ ownerType, ownerId, topicId }) => [ownerType, ownerId, topicId];

function under(root, filename) {
    const resolved = fs.realpathSync(filename);
    const relative = path.relative(root, resolved);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        throw new Error('Migration source file is outside the snapshot root');
    }
    return resolved;
}

function readTombstones(cds, topic) {
    if (!cds) return [];
    const [type, owner, id] = tuple(topic);
    const results = [];
    for (const [table, kind, ids, where] of [
        ['owners', 'owner', [type, owner], 'owner_type=? AND owner_id=?'],
        ['topics', 'topic', [type, owner, id], 'owner_type=? AND owner_id=? AND topic_id=?'],
        ['messages', 'message', [type, owner, id], 'owner_type=? AND owner_id=? AND topic_id=?']
    ]) {
        if (!cds.prepare('PRAGMA table_info(' + table + ')').all().some(column => column.name === 'deleted_at')) continue;
        const entity = kind === 'message' ? 'msg_id' : kind === 'topic' ? 'topic_id' : 'owner_id';
        for (const row of cds.prepare(`SELECT ${entity} AS id, deleted_at FROM ${table} WHERE ${where} AND deleted_at IS NOT NULL ORDER BY ${entity}`).all(...ids)) {
            results.push({ kind, ...row });
        }
    }
    if (hasTable(cds, 'tombstones')) {
        results.push(...cds.prepare(`SELECT entity_type AS kind,entity_id AS id,deleted_at FROM tombstones
            WHERE owner_type=? AND owner_id=? AND ((entity_type='owner' AND topic_id='' AND entity_id=owner_id)
            OR (topic_id=? AND entity_type IN ('topic','message'))) ORDER BY kind,id,deleted_at`).all(type, owner, id));
    }
    return results;
}

function collect(root, central, cds, topic) {
    const snapshot = topic.history && readJson(under(root, path.resolve(root, topic.history)));
    const native = snapshot ? (Array.isArray(snapshot) ? snapshot : snapshot.messages) : [];
    if (!Array.isArray(native)) throw new Error('Invalid native History document');
    const entries = new Map();
    for (const message of native) {
        identity({ ...topic, msgId: message.id });
        if (entries.has(message.id)) throw new Error('Duplicate native message in History');
        entries.set(message.id, { id: message.id, message, deleted: false });
    }
    const beforeNative = new Map();
    let centralTail = [];
    let centralHead = 0;
    if (central) {
        centralHead = central.prepare(`SELECT coalesce(max(seq),0) AS value FROM journal
            WHERE owner_type=? AND owner_id=? AND topic_id=?`).get(...tuple(topic)).value;
        const rows = central.prepare(`SELECT m.*, (SELECT min(j.seq) FROM journal j
            WHERE j.owner_type=m.owner_type AND j.owner_id=m.owner_id AND j.topic_id=m.topic_id AND j.msg_id=m.msg_id) AS first_seq
            FROM messages m WHERE m.owner_type=? AND m.owner_id=? AND m.topic_id=? ORDER BY first_seq,m.last_seq,m.msg_id`).all(...tuple(topic));
        for (const row of rows) {
            const message = projectStoredMessage({ metadata_version: 0, metadata_hash: null, ...row });
            const prior = entries.get(row.msg_id)?.message;
            if (prior) {
                if (centralTail.length) beforeNative.set(row.msg_id, centralTail);
                centralTail = [];
            } else centralTail.push(row.msg_id);
            // The native array supplies order and native-only extensions. A
            // validated central edit supplies the shared message projection.
            entries.set(row.msg_id, { id: row.msg_id, deleted: !!row.deleted,
                message: message ? { ...prior, ...message, attachments: message.attachments ?? [] } : prior,
                nativeMessage: prior, centralSeq: row.last_seq });
        }
    }
    const tombstones = readTombstones(cds, topic);
    for (const tombstone of tombstones) {
        if (tombstone.kind !== 'message') continue;
        const prior = entries.get(tombstone.id);
        entries.set(tombstone.id, { ...prior, id: tombstone.id, deleted: true, deletedAt: tombstone.deleted_at });
    }
    const parentDeleted = tombstones.some(row => row.kind !== 'message');
    const ids = new Set([...native.flatMap(message => [...(beforeNative.get(message.id) || []), message.id]),
        ...centralTail, ...entries.keys()]);
    const ordered = [...ids].map(id => entries.get(id));
    return { topic, centralHead, entries: parentDeleted ? ordered.map(entry => ({ ...entry, deleted: true })) : ordered, tombstones };
}

function attachmentSource(root, topic, entry, attachment) {
    const raw = attachment._fileManagerData || attachment;
    const portableHash = attachment.blobHash || attachment.hash || raw.hash;
    const source = raw.internalPath || attachment.internalPath || attachment.src;
    const archive = topic.attachmentFiles?.[entry.id]?.[attachment.id];
    let file;
    if (archive) file = path.resolve(root, archive);
    else if (/^[a-f0-9]{64}$/.test(portableHash || '')) {
        const candidate = path.join(root, 'attachments', portableHash.slice(0, 2), portableHash);
        if (fs.existsSync(candidate)) file = candidate;
    }
    if (!file && source) file = source.startsWith('file:') ? fileURLToPath(source) : path.resolve(root, source);
    if (!file) throw new Error('Attachment bytes missing from snapshot');
    const checked = under(root, file);
    const frames = (attachment.frameHashes || []).map(digest => {
        if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid attachment frame hash');
        const frame = under(root, path.join(root, 'attachments', digest.slice(0, 2), digest));
        if (hash(readAttachment(frame)) !== digest) throw new Error('Migration attachment frame hash mismatch');
        return { digest, file: frame };
    });
    return { file: checked, digest: hash(readAttachment(checked)), frames };
}

function readAttachment(input) {
    const stat = fs.statSync(input);
    if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('Unsupported migration attachment size');
    return fs.readFileSync(input);
}

function importAttachment(store, topic, entry, attachment, source) {
    const raw = attachment._fileManagerData || attachment;
    const { file } = source;
    const name = attachment.name || raw.originalName || raw.name || path.basename(file);
    const save = (filename, expected, type) => {
        const bytes = readAttachment(filename);
        const digest = hash(bytes);
        if (expected && expected !== digest) throw new Error('Migration attachment hash mismatch');
        const target = store.blobPath(digest);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        if (fs.existsSync(target)) store.readBlob(digest);
        else fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600, flush: true });
        store.db.prepare("INSERT OR IGNORE INTO attachment_blobs VALUES(?,?,?,'ready')").run(digest, bytes.length, type || detect(bytes, name));
        return { digest, bytes };
    };
    const type = attachment.type || raw.mimeType;
    if (attachment.blobHash && attachment.blobHash !== source.digest) throw new Error('Migration attachment hash mismatch');
    const result = save(file, source.digest, type && type !== 'application/octet-stream' ? type : undefined);
    const id = attachment.id || raw.id || 'attachment_' + result.digest;
    const destIdentity = JSON.stringify([topic.ownerType, topic.ownerId, topic.key]);
    store.db.prepare('INSERT INTO attachment_links VALUES(?,?,?,?)').run(destIdentity, entry.id, id, result.digest);
    for (const [index, frame] of source.frames.entries()) {
        const { digest } = frame;
        save(frame.file, digest, 'image/png');
        store.db.prepare('INSERT INTO attachment_frames VALUES(?,?,?,?,?)').run(destIdentity, entry.id, id, index, digest);
    }
    return { id, name, type: store.db.prepare('SELECT type FROM attachment_blobs WHERE hash=?').get(result.digest).type,
        size: result.bytes.length, hash: result.digest, blobHash: result.digest,
        ...(attachment.extractedText !== undefined && { extractedText: attachment.extractedText }),
        ...(attachment.frameHashes?.length && { frameHashes: attachment.frameHashes }) };
}

function importHistory(root, destination) {
    root = fs.realpathSync(root);
    destination = path.join(fs.realpathSync(path.dirname(destination)), path.basename(destination));
    const relative = path.relative(root, destination);
    const reverse = path.relative(destination, root);
    const outside = value => value === '..' || value.startsWith('..' + path.sep) || path.isAbsolute(value);
    if (!outside(relative) || !outside(reverse)) throw new Error('Migration destination must be separate from the source snapshot');
    const manifest = readJson(under(root, path.join(root, 'manifest.json')));
    if (!manifest.workspace || !Array.isArray(manifest.topics) || !manifest.topics.length) throw new Error('Invalid migration manifest');
    const open = file => file && new DatabaseSync(under(root, path.resolve(root, file)), { readOnly: true });
    const central = open(manifest.central);
    let cds, store;
    try {
        cds = open(manifest.cds);
        const plans = manifest.topics.map(topic => {
            identity({ ...topic, msgId: 'migration' });
            if (typeof topic.key !== 'string' || !topic.key) throw new Error('Missing target Core topic ID');
            const plan = collect(root, central, cds, topic);
            for (const entry of plan.entries) {
                if (!entry.deleted) entry.files = (entry.message?.attachments || []).map(ref => attachmentSource(root, topic, entry, ref));
            }
            return plan;
        });
        if (new Set(plans.map(plan => plan.topic.key)).size !== plans.length ||
            new Set(plans.map(plan => JSON.stringify(tuple(plan.topic)))).size !== plans.length) {
            throw new Error('Duplicate conversation in migration manifest');
        }
        const fingerprint = sha256(stable({ workspace: manifest.workspace, plans: plans.map(plan => ({
            ...plan, entries: plan.entries.map(({ files, ...entry }) => ({ ...entry,
                ...(files && { fileDigests: files.map(file => file.digest) }) }))
        })) }));
        const filename = path.join(destination, 'core.sqlite');
        if (fs.existsSync(destination)) {
            if (fs.lstatSync(destination).isSymbolicLink()) throw new Error('Unsafe migration destination');
            const prior = new DatabaseSync(filename, { readOnly: true });
            try {
                const receipt = prior.prepare("SELECT value FROM core_metadata WHERE key='history_import'").get();
                const result = receipt && JSON.parse(receipt.value);
                if (!result || result.fingerprint !== fingerprint) throw new Error('Migration destination already exists with different data');
                return { ...result, repeated: true };
            } finally { prior.close(); }
        }
        // Publish only a complete staged database and its verified attachments.
        const staging = fs.mkdtempSync(destination + '.import-');
        try {
            store = new CoreStore(path.join(staging, 'core.sqlite'));
            const attachments = new AttachmentStore({ store, root: staging, topics: [], extractPdf: () => {} });
            const result = store.transaction(() => {
                store.db.exec(`CREATE TABLE history_import_deletions (
                    conversation_id TEXT NOT NULL REFERENCES conversations(id), kind TEXT NOT NULL,
                    entity_id TEXT NOT NULL, deleted_at INTEGER NOT NULL, PRIMARY KEY(conversation_id,kind,entity_id));
                    CREATE TABLE history_import_topics (conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
                        owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, topic_id TEXT NOT NULL, central_head INTEGER NOT NULL)`);
                let messages = 0, deleted = 0, files = 0;
                for (const { topic, entries, tombstones, centralHead } of plans) {
                    store.ensureConversation({ ...topic, workspace: manifest.workspace });
                    store.db.prepare('INSERT INTO history_import_topics VALUES(?,?,?,?,?)').run(topic.key, ...tuple(topic), centralHead);
                    for (const row of tombstones) {
                        store.db.prepare(`INSERT INTO history_import_deletions VALUES(?,?,?,?)
                            ON CONFLICT DO UPDATE SET deleted_at=min(deleted_at,excluded.deleted_at)`)
                            .run(topic.key, row.kind, row.id, row.deleted_at);
                    }
                    for (const entry of entries) {
                        const { id, role = 'user', content = '', timestamp, name, attachments: refs = [],
                            contextCompaction, ...extension } = entry.message || {};
                        if (!entry.deleted && (!['assistant', 'user'].includes(role) || typeof content !== 'string' || !Number.isSafeInteger(timestamp))) {
                            throw new Error('Unsupported historical message role, content or timestamp');
                        }
                        const portable = entry.deleted ? [] : refs.map((ref, index) => importAttachment(attachments, topic, entry, ref, entry.files[index]));
                        store.insertMessage({ id: entry.id, key: topic.key, role: entry.deleted ? 'user' : role,
                            content: entry.deleted ? '' : content, createdAt: timestamp ?? entry.deletedAt ?? 0,
                            deleted: entry.deleted, senderName: name, attachments: portable, checkpoint: contextCompaction,
                            historyMetadata: { ...extension, originalAttachments: refs, nativeMessage: entry.nativeMessage, centralSeq: entry.centralSeq } });
                        if (entry.deleted) deleted++; else messages++;
                        files += portable.length;
                    }
                }
                const stats = { fingerprint, conversations: plans.length, messages, deleted, attachments: files };
                store.db.prepare("INSERT INTO core_metadata VALUES('history_import',?)").run(JSON.stringify(stats));
                return stats;
            });
            store.db.close();
            store = null;
            fs.renameSync(staging, destination);
            return result;
        } finally {
            store?.db.close();
            fs.rmSync(staging, { recursive: true, force: true });
        }
    } finally {
        cds?.close();
        central?.close();
    }
}

if (require.main === module) {
    if (process.argv.length !== 4) throw new Error('Usage: node importHistory.js SNAPSHOT_ROOT NEW_CORE_DIRECTORY');
    console.log(JSON.stringify(importHistory(process.argv[2], process.argv[3])));
}

module.exports = { importHistory };

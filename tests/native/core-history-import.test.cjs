'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { BOX } = require('./fixtures/sharedSingleHarness.cjs');
const { CoreStore } = require(BOX + '/core/store');
const { CentralStore } = require(BOX + '/Plugin/NativeSync/sync/centralStore');
const { AttachmentStore } = require(BOX + '/Plugin/NativeSync/mobile/attachments');

test('offline migration reconciles native order, central commits and both CDS deletion layouts', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-core-import-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'fixture');
    const target = path.join(root, 'core');
    fs.mkdirSync(source);
    const topic = { ownerType: 'agent', ownerId: 'agentA', topicId: 'topicA', key: 'sharedTopic', history: 'history.json' };
    const second = { ownerType: 'agent', ownerId: 'agentA', topicId: 'topicB', key: 'deletedTopic', history: 'second.json' };
    const msg = (id, content = id, rest = {}) => ({ id, content, role: 'user', timestamp: 100, ...rest });
    const bytes = Buffer.from('附件原始字节\n');
    const manifest = { workspace: 'dev', central: 'central.sqlite', cds: 'cds.sqlite', topics: [topic, second] };
    fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(source, 'history.json'), JSON.stringify([
        msg('original', '原始正文', { timestamp: 200, customExtension: { score: 1 },
            attachments: [{ id: 'file', name: 'note.txt', internalPath: 'note.txt' }] }),
        msg('edited'), msg('central_deleted'), msg('cds_deleted')
    ]));
    fs.writeFileSync(path.join(source, 'second.json'), JSON.stringify([msg('hidden_by_topic')]));
    fs.writeFileSync(path.join(source, 'note.txt'), bytes);
    const central = new CentralStore(path.join(source, manifest.central));
    function apply(id, content, action = 'upsert', baseHash = null) {
        return central.apply({ ...topic, deviceId: 'fixture', opId: action + id, msgId: id, action, baseHash,
            ...(action === 'upsert' && { message: msg(id, content) }) });
    }
    apply('central_prefix', '先于匹配锚点');
    apply('edited', '中央修订');
    const prior = apply('central_deleted', 'removed');
    apply('central_deleted', '', 'delete', prior.hash);
    apply('central_only', '中央独有');
    central.db.close();
    const cds = new DatabaseSync(path.join(source, manifest.cds));
    cds.exec(`CREATE TABLE messages (owner_type,owner_id,topic_id,msg_id,deleted_at);
        CREATE TABLE topics (owner_type,owner_id,topic_id,deleted_at);
        CREATE TABLE tombstones (owner_type,owner_id,topic_id,entity_type,entity_id,deleted_at);
        INSERT INTO topics VALUES('agent','agentA','topicB',1101);
        INSERT INTO messages VALUES('agent','agentA','topicA','cds_deleted',1102);
        INSERT INTO tombstones VALUES('agent','agentA','topicA','message','v1_deleted',1103);`);
    cds.close();

    const command = () => spawnSync(process.execPath, [
        path.join(BOX, 'core/importHistory.js'), source, target
    ], { encoding: 'utf8' });
    const first = command();
    assert.equal(first.status, 0, first.stderr);
    const receipt = JSON.parse(first.stdout);
    assert.deepEqual({ ...receipt, fingerprint: undefined }, {
        fingerprint: undefined, conversations: 2, messages: 4, deleted: 4, attachments: 1
    });
    const again = command();
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(JSON.parse(again.stdout), { ...receipt, repeated: true });

    const store = new CoreStore(path.join(target, 'core.sqlite'));
    t.after(() => store.db.close());
    const messages = store.snapshot(topic.key, Number.MAX_SAFE_INTEGER, 100);
    assert.deepEqual(messages.map(({ id, content, timestamp }) => [id, content, timestamp]), [
        ['original', '原始正文', 200], ['central_prefix', '先于匹配锚点', 100], ['edited', '中央修订', 100], ['central_only', '中央独有', 100]
    ]);
    assert.deepEqual(store.changes(topic.key, 0, 100).filter(e => e.action === 'delete').map(e => e.messageId),
        ['central_deleted', 'cds_deleted', 'v1_deleted']);
    assert.deepEqual(store.snapshot(second.key, Number.MAX_SAFE_INTEGER, 100), []);
    const metadata = store.db.prepare('SELECT history_metadata_json FROM messages WHERE id=?').get('original');
    assert.deepEqual(JSON.parse(metadata.history_metadata_json).customExtension, { score: 1 });
    assert.deepEqual(store.db.prepare('SELECT deleted_at AS date FROM history_import_deletions ORDER BY deleted_at').all().map(r => r.date),
        [1101, 1102, 1103]);
    const attachment = new AttachmentStore({ root: target, topics: [{ ...topic, topicId: topic.key }], extractPdf: () => {},
        store: { db: store.db, readSnapshot: fn => fn(), projectMessage: row => store.message(row),
            findMessage: store.db.prepare('SELECT * FROM messages WHERE ?=\'agent\' AND ?=\'agentA\' AND conversation_id=? AND id=?') } });
    assert.deepEqual(attachment.locate(topic.key, 'original', 'file').bytes, bytes);
    fs.writeFileSync(path.join(source, 'note.txt'), 'changed source');
    const mismatch = command();
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /destination already exists with different data/);
    assert.deepEqual(attachment.locate(topic.key, 'original', 'file').bytes, bytes);
});

test('an imported regular group becomes Core-owned after verifying the isolated central history head', async t => {
    const { backup } = require('node:sqlite');
    const { fixture } = require('./fixtures/sharedSingleHarness.cjs');
    const { localProvider, host, mountCore } = require('./fixtures/coreSingleHarness.cjs');
    const { importHistory } = require(BOX + '/core/importHistory');
    const f = await fixture(t);
    const actor = f.actor('A');
    const owner = f.shared.create(actor, { sharedSpaceId: 'sharedAB', opId: 'migration-group',
        kind: 'group', localId: 'old-group', config: { name: 'Old group', mode: 'sequential', members: [f.owner.id] } }).object;
    const topic = f.shared.create(actor, { sharedSpaceId: 'sharedAB', opId: 'migration-topic',
        kind: 'topic', parentId: owner.id, localId: 'old-topic', localParent: 'old-group', config: { name: 'Old topic' } }).object;
    assert.equal(topic.coreGroup, undefined);
    const old = { id: 'legacy-fixture', role: 'user', content: 'Existing shared history', timestamp: 100 };
    f.store.apply({ ...topic.topic, msgId: old.id, deviceId: 'fixture',
        opId: 'legacy-commit', action: 'upsert', baseHash: null, message: old }, { sharedSpace: 'sharedAB' });
    const source = path.join(f.root, 'isolated-snapshot');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({
        workspace: 'sharedAB', central: 'snapshot.sqlite', topics: [{ ...topic.topic, key: topic.id }]
    }));
    await backup(f.store.db, path.join(source, 'snapshot.sqlite'));
    importHistory(source, f.root + '-core');
    const { chat } = host(await localProvider(t));
    const { core } = await mountCore(f, chat);
    t.after(() => core.close());
    const current = f.shared.get(actor, 'sharedAB', topic.id);
    assert.equal(current.coreGroup, true);
    const desktop = await f.desktop('B');
    const local = desktop.runtime.localFor(topic.id);
    const read = await desktop.runtime.coreSingle.history({ itemType: 'group', itemId: local.localParent, topicId: local.localId });
    assert.equal(read.history[0].id, old.id);
    assert.equal(read.history[0].content, old.content);
    const phone = await f.phone();
    await phone.call('/conversations/' + topic.id + '/messages', { requestId: 'deny-old-group', text: 'blocked' }, 409);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM journal').get().n, 1);
});

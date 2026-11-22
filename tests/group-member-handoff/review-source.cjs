'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const { stable } = require('../../apps/desktop/modules/services/nativeSync/protocol');
const { groupMemberHandoff: evidence } =
    require('../../docs/evidence/group-member-handoff/candidate-handoff-unknown.json');

const defaultSource = '/tmp/vcp-integration-thtI35/ready';
const sourceDigest = '99db7df76016daf3624e66a220ef80891ac84be3bd151d1f3d877dc79bb27c44';
const historyDigest = '18a91b0527e0badaa20ac0b4cc87961d69f3ff69ec0fdfc3f8a847f8592a014d';
const snapshot = evidence.unknown;
const syncDir = '.native-sync';
const sharedDir = path.join(syncDir, 'shared', 'sharedAB');
const projectionFiles = ['registry.json', 'configs.json', 'executions.json', 'local-inputs.json',
    'messages.json', 'config-versions.sqlite'];
const hash = value => createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const rows = statements => statements.map(row => ({ ...row }));

function load(out) {
    const root = fs.realpathSync(process.env.NS_GROUP_REVIEW_SOURCE || defaultSource);
    out = fs.realpathSync(out);
    assert.ok(!out.startsWith(root + path.sep) && out !== root, 'fixture output must be isolated');
    assert.equal(fs.readFileSync(path.join(root, 'seed/L4-SYNTHETIC-ONLY'), 'utf8'),
        'NativeSync L4 synthetic process fixture\n');
    const original = path.join(root, 'data/central.sqlite');
    const assertOriginalUnchanged = () => {
        for (const suffix of ['-wal', '-shm', '-journal']) assert.ok(!fs.existsSync(original + suffix));
        const digest = hash(fs.readFileSync(original));
        assert.equal(digest, sourceDigest, 'original central store SHA-256');
        return digest;
    };
    const sourceSha256 = assertOriginalUnchanged();
    const workId = snapshot.admission.id;
    const db = new DatabaseSync(pathToFileURL(original).href + '?immutable=1', { readOnly: true });
    let groupTopic;
    let identity;
    try {
        const work = db.prepare('SELECT id,request_id,principal,state,dispatched,user_seq,topic_id FROM shared_admissions WHERE id=?').get(workId);
        const { topic_id: topicId, ...admission } = work;
        assert.deepEqual(admission, snapshot.admission);
        const handoff = db.prepare('SELECT executor,executor_version,state,first_reply_seq FROM shared_group_handoffs WHERE work_id=?').get(workId);
        assert.deepEqual({ ...handoff }, snapshot.handoff);
        const native = db.prepare('SELECT id,ordinal,principal,member_id,state FROM shared_native_requests WHERE admission_id=? ORDER BY ordinal').all(workId);
        assert.deepEqual(rows(native), snapshot.native);
        const topic = db.prepare('SELECT id,topic_id AS topicId,parent_id AS groupId FROM shared_objects WHERE kind=? AND id=?').get('topic', topicId);
        const binding = db.prepare('SELECT local_parent AS localGroupId,local_id AS localTopicId FROM shared_local_bindings WHERE source_id=? AND object_id=? AND hidden=0').get('sourceB', topicId);
        assert.ok(topic && binding);
        groupTopic = { ...topic, ...binding, topic: { topicId: topic.topicId } };
        const journal = db.prepare('SELECT seq,msg_id,device_id,action,message_json FROM journal WHERE topic_id=? ORDER BY seq').all(topic.topicId)
            .map(({ message_json, ...row }) => ({ ...row, message: JSON.parse(message_json) }));
        assert.deepEqual(journal, snapshot.journal);
        identity = db.prepare('SELECT source_id AS sourceId, device_id AS deviceId, space_id AS spaceId FROM source_bindings WHERE source_id=?').get('sourceB');
        assert.equal(identity.deviceId, 'deviceB');
        for (const table of ['mobile_pairings', 'mobile_sessions', 'attachment_blobs']) {
            assert.equal(db.prepare('SELECT count(*) AS n FROM ' + table).get().n, 0, table);
        }
    } finally {
        db.close();
    }

    const sourceProfile = path.join(root, 'profile-B');
    const historyFile = path.join('UserData', groupTopic.localGroupId, 'topics', groupTopic.localTopicId, 'history.json');
    const historyBytes = fs.readFileSync(path.join(sourceProfile, historyFile));
    assert.equal(hash(historyBytes), historyDigest, 'original B History SHA-256');
    const history = JSON.parse(historyBytes);
    const cursors = read(path.join(sourceProfile, sharedDir, 'messages.json')).topicCursors;
    assert.equal(cursors[groupTopic.topicId], snapshot.journal.at(-1).seq);
    const loc = read(path.join(sourceProfile, sharedDir, 'registry.json')).locals[groupTopic.id];
    assert.equal(loc.localId, groupTopic.localTopicId);
    assert.equal(loc.localParent, groupTopic.localGroupId);
    const executions = read(path.join(sourceProfile, sharedDir, 'executions.json'));
    assert.ok(executions.requests['group-handoff:' + workId], 'B projection knows original Work');
    assert.deepEqual(history.map(({ id, content, timestamp }) => ({ id, content, timestamp })),
        snapshot.journal.map(({ message: { id, content, timestamp } }) => ({ id, content, timestamp })));

    function ensureDestination(dest) {
        dest = path.resolve(dest);
        assert.ok(dest.startsWith(out + path.sep), 'fixture destination must be under isolated output');
        assert.ok(!fs.existsSync(dest) || fs.realpathSync(dest) === dest);
        assert.equal(fs.realpathSync(path.dirname(dest)), path.dirname(dest));
        return dest;
    }

    function restoreSyntheticState({ data }) {
        data = ensureDestination(data);
        const dest = path.join(data, 'central.sqlite');
        assertOriginalUnchanged();
        fs.copyFileSync(original, dest, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(dest, 0o600);
        assert.equal(hash(fs.readFileSync(dest)), sourceSha256);
        assertOriginalUnchanged();
    }

    function restoreBProfile({ profile, origin }) {
        profile = ensureDestination(profile);
        assert.equal(new URL(origin).hostname, '127.0.0.1');
        if (fs.existsSync(profile)) assert.deepEqual(fs.readdirSync(profile), [], 'fresh B profile required');
        else fs.mkdirSync(profile, { mode: 0o700 });
        const write = (rel, value) => {
            const dest = path.join(profile, rel);
            fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
            fs.writeFileSync(dest, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
        };
        const copy = rel => {
            const source = path.join(sourceProfile, rel);
            assert.ok(fs.lstatSync(source).isFile(), rel);
            assert.equal(fs.realpathSync(source), source, rel);
            const dest = path.join(profile, rel);
            fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
            fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL);
            fs.chmodSync(dest, 0o600);
        };
        const state = read(path.join(sourceProfile, syncDir, 'state.json'));
        assert.deepEqual({ ...identity }, Object.fromEntries(Object.keys(identity).map(key => [key, state.source.binding[key]])));
        state.source.binding.sourceRoot = profile;
        state.source.binding.rootHash = hash(profile);
        write(path.join(syncDir, 'state.json'), state);
        for (const file of projectionFiles) {
            const rel = path.join(sharedDir, file);
            if (['registry.json', 'executions.json', 'local-inputs.json'].includes(file)) {
                const value = read(path.join(sourceProfile, rel));
                value.binding.sourceRoot = profile;
                if (file === 'registry.json') value.legacyHash = hash(stable(state));
                write(rel, value);
            } else {
                copy(rel);
            }
        }
        const groupConfig = path.join('AgentGroups', groupTopic.localGroupId, 'config.json');
        const group = read(path.join(sourceProfile, groupConfig));
        assert.equal(group.name, 'Relay fixture A B');
        copy(groupConfig);
        // Preserve the native catalog the projection already knows, including unrelated synthetic seed agents.
        for (const agentId of fs.readdirSync(path.join(sourceProfile, 'Agents'))) {
            assert.match(agentId, /^ns_[a-f0-9]{24}$/);
            for (const file of ['config.json', 'regex_rules.json']) copy(path.join('Agents', agentId, file));
        }
        copy(historyFile);
        write(path.join(syncDir, 'connection.json'), {
            version: 1, enabled: true, scopeMode: 'source', fullSelectionApproved: true,
            ...identity, sourceRoot: profile, topics: [], executionTopics: [], executionMode: 'all-supported',
            sharedSpaceId: 'sharedAB', sharedJoinOpId: 'bootB', serverUrl: origin,
            credentialSource: 'existing-vcp-settings', publishExecutionConfigs: true, publishCatalog: true,
            syncAttachments: false,
        });
        write('settings.json', {
            ChatDataServiceEnabled: false, vcpServerUrl: origin + '/v1/chat/completions', vcpApiKey: 'synthetic-only',
            userName: '用户', disableAsana: true, enableVcpLog: false, enableDistributedServer: false,
        });
    }
    return {
        groupTopic, workId, nativeRequestIds: snapshot.native.map(row => row.id), handler: evidence.handler,
        sourceSha256, sourcePath: original, assertOriginalUnchanged, restoreSyntheticState, restoreBProfile, historyFile,
    };
}

module.exports = { load };

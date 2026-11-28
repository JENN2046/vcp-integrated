'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { BOX, fixture } = require('./fixtures/sharedSingleHarness.cjs');
const { host, localProvider, mountCore } = require('./fixtures/coreSingleHarness.cjs');
const { createGrantReader, createWorkAuthority } = require(BOX + '/core/nativeCapabilityGrants');
const native = require(BOX + '/modules/requestExecutionContext');
const diary = require(BOX + '/modules/nativeDiaryAuthority');
const DirectDiaryTextProcessor = require(BOX + '/Plugin/RAGDiaryPlugin/DirectDiaryTextProcessor');

async function grants(directory, workspace, agents) {
    const file = path.join(directory, 'native-capability-grants.json');
    const pending = file + '.pending';
    await fs.writeFile(pending, JSON.stringify({ version: 1, workspace, agents }), { mode: 0o600 });
    await fs.rename(pending, file);
}

test('native text diary reads honor identity, roots and live revocation while standalone keeps native behavior', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'core-diary-scope-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await fs.mkdir(path.join(directory, 'Harbor'));
    await fs.mkdir(path.join(directory, 'Other'));
    await fs.writeFile(path.join(directory, 'Harbor/diary.txt'), 'authorized native note');
    await fs.writeFile(path.join(directory, 'Other/hidden.txt'), 'hidden native note');
    await fs.symlink('../Other/hidden.txt', path.join(directory, 'Harbor/linked.txt'));
    await grants(directory, 'workspace', { 'agent-a': { diaries: ['Harbor'] } });
    const read = createGrantReader(directory);
    const create = (id, workspace = 'workspace') => createWorkAuthority(read, workspace, id, () => {});
    const inTurn = (authority, run) => native.runCoreTurn({
        workId: 'diary-work', coreNativeAuthority: authority, signal: new AbortController().signal, fence() {}
    }, run);
    const processor = new DirectDiaryTextProcessor();
    processor.setDailyNoteRootPath(directory);
    const prompt = '{{Harbor日记本}}';
    const authority = create('agent-a');
    await inTurn(authority, async () => {
        const allowed = await processor.processContent(prompt);
        assert.match(allowed, /authorized native note/);
        assert.doesNotMatch(allowed, /hidden native note/);
        assert.equal(await processor.processContent('{{Other日记本}}'), '');
        const oldBlock = '<!-- VCP_RAG_BLOCK_START {"dbName":"Harbor"} -->stale<!-- VCP_RAG_BLOCK_END -->';
        assert.equal(diary.canRefresh(oldBlock), false);
        assert.equal(diary.stripOldBlocks([{ role: 'system', content: oldBlock }])[0].content, '');
        diary.rememberBlock(oldBlock);
        assert.equal(diary.canRefresh(oldBlock), true);
        await grants(directory, 'workspace', {});
        assert.equal(await processor.processContent(prompt), '');
        assert.throws(native.assertDispatch, { code: 'CORE_NATIVE_CAPABILITY_REVOKED' });
    });
    await grants(directory, 'workspace', { 'agent-a': { diaries: ['Harbor'] } });
    assert.equal(await inTurn(create('agent-b'), () => processor.processContent(prompt)), '');
    assert.equal(await inTurn(create('agent-a', 'different-workspace'), () => processor.processContent(prompt)), '');
    assert.match(await processor.processContent('{{Other日记本}}'), /hidden native note/);
});

test('Core memory tools permit an explicitly granted peer and deny fallback after revocation', async t => {
    const f = await fixture(t);
    const provider = await localProvider(t);
    const { chat } = host(provider);
    const peer = f.shared.create(f.actor('A'), { sharedSpaceId: 'sharedAB', opId: 'native-scope-peer-agent',
        kind: 'agent', localId: 'peer-agent', config: { name: 'Peer fixture', model: 'peer-model', systemPrompt: 'Fixture only' } }).object;
    const destination = f.shared.create(f.actor('A'), { sharedSpaceId: 'sharedAB', opId: 'native-scope-peer-topic',
        kind: 'topic', localId: 'peer-topic', localParent: 'peer-agent', parentId: peer.id,
        config: { name: 'Peer archive' } }).object;
    const { core, options } = await mountCore(f, chat);
    t.after(async () => { await core.close(); await fs.rm(options.directory, { recursive: true, force: true }); });
    const actor = f.actor('A');
    const origin = { ...core.topic(actor, 'sharedAB', f.topic.id, 'execute'), actor };
    const target = core.topic(actor, 'sharedAB', destination.id, 'read');
    core.store.ensureConversation(target);
    core.store.insertMessage({ id: 'peer_history', key: target.key, role: 'user', content: 'Peer archive marker' });
    const authority = () => createWorkAuthority(core.readNativeGrants, 'sharedAB', origin.ownerId, () => {});
    const run = (fn) => native.runCoreTurn({ workId: 'peer-read-work',
        coreNativeAuthority: authority(), signal: new AbortController().signal, fence() {} }, fn);
    const args = { maid: 'Peer fixture', command: 'GetTopicContent', topic_id: destination.id };
    await assert.rejects(run(() => core.memoryTool(origin, 'TopicMemo', args)), { code: 'CORE_NATIVE_CAPABILITY_DENIED' });
    await grants(options.directory, 'sharedAB', { [origin.ownerId]: { TopicMemo: [peer.id], DeepMemo: [peer.id] } });
    assert.match(await run(() => core.memoryTool(origin, 'TopicMemo', args)), /Peer archive marker/);
    if (process.env.VCP_CORE_CDS_BINARY) {
        const result = await run(() => core.memoryTool(origin, 'DeepMemo', { agentId: peer.id, keyword: 'Peer archive marker' }));
        assert.match(JSON.stringify(result), /Peer archive marker/);
    }
    await grants(options.directory, 'sharedAB', { [origin.ownerId]: { TopicMemo: [f.owner.id] } });
    await assert.rejects(run(() => core.memoryTool(origin, 'TopicMemo', args)), { code: 'CORE_NATIVE_CAPABILITY_DENIED' });
    await assert.rejects(run(() => core.memoryTool(origin, 'DeepMemo', { agentId: peer.id, keyword: 'marker' })),
        { code: 'CORE_NATIVE_CAPABILITY_DENIED' });
    assert.equal(f.calls(), 0);
});

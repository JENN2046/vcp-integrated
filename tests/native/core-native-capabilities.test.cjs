'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { BOX, coreFixture, host, localProvider } = require('./fixtures/coreSingleHarness.cjs');
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
        assert.throws(native.assertDispatch, { code: 'CORE_NATIVE_CAPABILITY_REVOKED' });
        assert.equal(await processor.processContent(prompt), '');
    });
    await grants(directory, 'workspace', { 'agent-a': { diaries: ['Harbor'] } });
    assert.equal(await inTurn(create('agent-b'), () => processor.processContent(prompt)), '');
    assert.equal(await inTurn(create('agent-a', 'different-workspace'), () => processor.processContent(prompt)), '');
    assert.match(await processor.processContent('{{Other日记本}}'), /hidden native note/);
});

test('Core memory tools permit an explicitly granted peer and deny fallback after revocation', async t => {
    const provider = await localProvider(t);
    const f = await coreFixture(t, host(provider).chat);
    const { core, workspace, directory } = f;
    const source = await f.define({});
    const peer = 'peer-agent';
    const destination = await f.define({ ownerId: peer, topicId: 'peer-topic', name: 'Peer archive',
        config: { name: 'Peer fixture', model: 'peer-model', systemPrompt: 'Fixture only' } });
    const actor = core.local.actor;
    const origin = { ...core.topic(actor, workspace, source.key, 'execute'), actor };
    const target = core.topic(actor, workspace, destination.key, 'read');
    core.store.ensureConversation(target);
    core.store.insertMessage({ id: 'peer_history', key: target.key, role: 'user', content: 'Peer archive marker' });
    const authority = () => createWorkAuthority(core.readNativeGrants, workspace, origin.ownerId, () => {});
    const run = (fn) => native.runCoreTurn({ workId: 'peer-read-work',
        coreNativeAuthority: authority(), signal: new AbortController().signal, fence() {} }, fn);
    const args = { maid: 'Peer fixture', command: 'GetTopicContent', topic_id: destination.key };
    await assert.rejects(run(() => core.memoryTool(origin, 'TopicMemo', args)), { code: 'CORE_NATIVE_CAPABILITY_DENIED' });
    await grants(directory, workspace, { [origin.ownerId]: { TopicMemo: [peer], DeepMemo: [peer] } });
    assert.match(await run(() => core.memoryTool(origin, 'TopicMemo', args)), /Peer archive marker/);
    if (process.env.VCP_CORE_CDS_BINARY) {
        const result = await run(() => core.memoryTool(origin, 'DeepMemo', { agentId: peer, keyword: 'Peer archive marker' }));
        assert.match(JSON.stringify(result), /Peer archive marker/);
    }
    await grants(directory, workspace, { [origin.ownerId]: { TopicMemo: [origin.ownerId] } });
    await assert.rejects(run(() => core.memoryTool(origin, 'TopicMemo', args)), { code: 'CORE_NATIVE_CAPABILITY_DENIED' });
    await assert.rejects(run(() => core.memoryTool(origin, 'DeepMemo', { agentId: peer, keyword: 'marker' })),
        { code: 'CORE_NATIVE_CAPABILITY_DENIED' });
    assert.equal(provider.calls.length, 0);
});


test('Core dependency injection loads RAG without consulting execution bridges', async () => {
    const { createDefaultDependencyBridgeRegistry } = require(BOX + '/modules/pluginBridgeRegistry');
    const registry = createDefaultDependencyBridgeRegistry();
    const manager = { index: 'fixture' };
    const manifest = { name: 'RAGDiaryPlugin' };
    await native.runCoreTurn({ workId: 'dependency-fixture' }, async () => {
        const dependencies = await registry.buildDependencies(manifest, {}, {
            vectorDBManager: manager,
            getMessagePreprocessor() { return null; },
            debugLog() {}
        });
        assert.equal(dependencies.vectorDBManager, manager);
    });
});

test('native resource checks share a snapshot and refresh at the next dispatch', () => {
    let reads = 0;
    let grants = { diaries: ['Harbor'], TopicMemo: ['peer'] };
    const authority = createWorkAuthority(() => { reads++; return grants; }, 'sandbox', 'agent-a', () => {});
    assert.equal(authority.allows('TopicMemo', 'agent-a'), true);
    assert.equal(authority.allows('DeepMemo', 'agent-a'), true);
    assert.equal(reads, 0);
    assert.equal(authority.allows('diaries', 'Harbor'), true);
    assert.equal(authority.allows('TopicMemo', 'peer'), true);
    assert.equal(authority.allows('TopicMemo', 'other'), false);
    assert.equal(reads, 1);
    grants = { diaries: ['Harbor'] };
    assert.throws(() => authority.assertCurrent(), { code: 'CORE_NATIVE_CAPABILITY_REVOKED' });
    assert.equal(reads, 2);
});

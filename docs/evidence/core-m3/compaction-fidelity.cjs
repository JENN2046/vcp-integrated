'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { CHAT, ctx, fixture } = require('../../../tests/native/fixtures/sharedSingleHarness.cjs');
const { host, mountCore, localProvider } = require('../../../tests/native/fixtures/coreSingleHarness.cjs');

test('compare desktop native HTTP and Core compaction on the same isolated model', { timeout: 180000 }, async t => {
    const engine = new URL(process.env.M3_COMPACTION_PROVIDER || 'http://127.0.0.1:19573');
    assert.equal(engine.hostname, '127.0.0.1');
    const scenario = process.env.M3_COMPACTION_CASE || 'en';
    const chinese = scenario.startsWith('zh');
    const f = await fixture(t);
    const provider = await localProvider(t);
    provider.setReply((body, res) => void (async () => {
        const upstream = await fetch(new URL('/v1/chat/completions', engine), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, temperature: 0, seed: 54, max_tokens: chinese ? 420 : 240 })
        });
        res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('Content-Type') });
        for await (const chunk of upstream.body) res.write(chunk);
        res.end();
    })().catch(() => { res.statusCode = 502; res.end(); }));
    const { chat } = host(provider);
    chat.config.apiConnectionTimeoutMs = 30000;
    f.control.nativeResponder = (req, res) => ctx.runNativeHandler(() => chat.handle(req, res));
    const { core } = await mountCore(f, chat);
    t.after(() => core.close());

    const desktop = await f.desktop('A');
    const actor = f.actor('A');
    const topic = core.topic(actor, 'sharedAB', f.topic.id, 'execute');
    const settings = {
        vcpServerUrl: f.url + '/v1/chat/completions',
        enableContextCompaction: true, contextCompactionModel: 'synthetic',
        contextCompactionPrompt: chinese ? '先逐句读取中间的真实历史，再输出四节快照。逐字保留代号、文件路径、提交哈希、报告网址和待审时间。每个值取自历史消息。' : 'Summarize only the supplied fictional chat. Keep all codenames, file paths, commit hashes, URLs and unfinished decisions verbatim. No tools.',
        contextCompactionSendPrompt: chinese ? '根据历史三条讯息，写出项目代号、脚本路径、冻结提交、报告网址及仍待审的部署决定。' : 'Write a compact factual checkpoint with the concrete identifiers and the pending decision.',
        contextCompactionMainPrompt: '{{context_checkpoint}}'
    };
    if (scenario === 'zh-status') settings.contextCompactionSendPrompt += ' 请把部署当前是否已批准和下一步决定分开记录。';
    const facts = ['Azure Kite', 'src/probes/health.js', '9ac5e43', 'https://example.invalid/qa', '14:30'];
    const source = [
        'The project codename is Azure Kite. The validation script is src/probes/health.js.',
        'Confirmed. The frozen commit is 9ac5e43 and the synthetic report is https://example.invalid/qa.',
        'Keep deployment pending until the 14:30 review. Do not mark it approved yet.'
    ];
    const localized = [
        '项目的代号是 Azure Kite。我们要验证的脚本是 src/probes/health.js。',
        '确认冻结的提交是 9ac5e43，人工验收的报告网址是 https://example.invalid/qa。',
        '请保持部署未批准，等 14:30 审查完成再决定是否发布。'
    ];
    const history = (chinese ? localized : source).map((content, i) => ({ id: 'm3-fidelity-' + i, role: i === 1 ? 'assistant' : 'user', content, timestamp: 1700000000000 + i }));
    core.store.transaction(() => {
        core.store.ensureConversation(topic);
        for (const message of history) core.store.insertMessage({ ...message, key: topic.key, createdAt: message.timestamp });
    });
    const nativeDir = pathToFileURL(CHAT + '/modules/chat/');
    const { requestContextCompaction } = await import(new URL('contextCompactionService.js', nativeDir));
    const { prepareCompactionState } = await import(new URL('contextCompactionState.js', nativeDir));
    const { createCheckpointMessage } = await import(new URL('contextCompactionPrompts.js', nativeDir));
    const state = prepareCompactionState(history);
    const response = await requestContextCompaction({ settings, state, requestId: 'm3-native-compaction-fidelity' });
    const nativeCheckpoint = createCheckpointMessage(state, response, settings, { id: 'native_checkpoint' });
    const compacted = await desktop.runtime.coreSingle.compact(desktop.descriptor, settings, 'm3-core-compaction-fidelity');
    const coreCheckpoint = compacted.message;

    assert.equal(provider.calls.length, 2);
    assert.deepEqual(provider.calls[0].messages, provider.calls[1].messages);
    const result = message => {
        const { checkpoint, fidelity } = message.contextCompaction;
        return { checkpoint, fidelity, kept: facts.filter(fact => checkpoint.includes(fact)),
            pendingDecision: /pending|await|等.*审|未批准|未获准|尚未.*批准/i.test(checkpoint) && /14:30/.test(checkpoint) };
    };
    const evidence = {
        model: process.env.M3_COMPACTION_MODEL || 'Qwen2.5-1.5B-Instruct Q4_K_M', case: scenario, engine: 'llama.cpp b12728',
        providerRequests: provider.calls.length, equivalentModelInput: true,
        desktopNative: result(nativeCheckpoint), core: result(coreCheckpoint),
        equalOutput: nativeCheckpoint.contextCompaction.checkpoint === coreCheckpoint.contextCompaction.checkpoint
    };
    console.log('M3_FIDELITY ' + JSON.stringify(evidence));
});

'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const { createServer } = require('node:http');
const { once } = require('node:events');
const path = require('node:path');
const { promisify } = require('node:util');
const base = require('../group-context/input.json');
const { groupRequest } = require('../../apps/server/Plugin/NativeSync/mobile/groupRequest');
const { sharedConfig } = require('../../apps/server/Plugin/NativeSync/sync/contracts.generated.cjs');

const root = path.resolve(__dirname, '../..');
const context = path.join(root, 'tests/group-context');
const execute = promisify(execFile);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const packet = body => [body.model, body.temperature, body.max_tokens, body.stream];

function makeSpec(useUnifiedModel, unifiedModel) {
    const spec = structuredClone(base);
    Object.assign(spec.group, { useUnifiedModel, unifiedModel });
    spec.speakers[0].model = 'synthetic-a';
    Object.assign(spec.speakers[1], { model: 'synthetic-b', temperature: 0.8, maxOutputTokens: 144 });
    return spec;
}

function writeSpec(out, name, spec) {
    const file = path.join(out, name + '.json');
    fs.writeFileSync(file, JSON.stringify(spec), { mode: 0o600 });
    return file;
}

async function runPositive(out, name, spec, models) {
    const { stdout } = await execute(process.execPath, [path.join(context, 'run.cjs'), 'candidate'], {
        env: { ...process.env, NS_GROUP_FIXTURE: writeSpec(out, name, spec) },
        timeout: 150000,
    });
    const evidenceFile = stdout.trim().split('\n').at(-1);
    const evidence = read(evidenceFile);
    const expected = [[models[0], 0.5, 128, true], [models[1], 0.8, 144, true]];
    const handler = evidence.handler.filter(row => row.kind === 'handler');
    const native = handler.filter(row => !row.workId);
    const shared = handler.filter(row => row.workId);
    assert.deepEqual(native.map(row => packet(row.body)), expected);
    assert.deepEqual(shared.map(row => packet(row.body)), expected);
    assert.deepEqual(evidence.provider.map(row => packet(row.body)), [...expected, ...expected]);
    assert.equal(evidence.shared.work.state, 'completed');
    assert.equal(evidence.shared.mobile.sameLedgerAndPackets, true);
    assert.deepEqual(evidence.shared.steps.map(row => row.attempts), [1, 1]);
    const nativeRule = evidence.native.sources.main.find(row => row.file === 'packages/core-rules/group/modelSelection.js');
    const used = evidence.native.coverage.find(row => row.file === nativeRule?.file);
    assert.equal(used?.hitFunctions.find(row => row.name === 'resolveEffectiveModel')?.count, 2);
    const worker = evidence.handler.filter(row => row.kind === 'worker-model');
    assert.deepEqual(worker.map(row => row.result.effectiveModel), models);
    assert.deepEqual(worker.map(row => row.sha256), [nativeRule.sha256, nativeRule.sha256]);
    return {
        packets: { native: native.map(row => packet(row.body)), shared: shared.map(row => packet(row.body)) },
        providerCalls: evidence.provider.length,
        sharedWorkState: evidence.shared.work.state,
        sharedAttempts: evidence.shared.steps.map(row => row.attempts),
        replayPreservedLedgerAndPackets: evidence.shared.mobile.sameLedgerAndPackets,
        nativeRule,
        workerSource: worker[0].source,
    };
}

async function runNegative(out, name, spec, rejectPublished) {
    const sourceAgent = spec.speakers[0];
    let completionRequests = 0;
    const provider = createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/v1/chat/completions') completionRequests++;
        res.writeHead(503).end();
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    try {
        const result = path.join(out, name + '-native.json');
        await execute(process.execPath, [path.join(context, 'native-run.cjs'), writeSpec(out, name, spec),
            'http://127.0.0.1:' + provider.address().port + '/v1/chat/completions', result], { timeout: 100000 });
        const native = read(result);
        assert.equal(native.completionDispatches, 0);
        assert.equal(completionRequests, 0);
        const nativeModelCalls = native.coverage.find(row => row.file === 'packages/core-rules/group/modelSelection.js')
            ?.hitFunctions.find(row => row.name === 'resolveEffectiveModel')?.count;
        assert.equal(nativeModelCalls, 2);
        const topic = { key: 'synthetic-topic' };
        const config = { group: spec.group, agents: spec.speakers };
        await assert.rejects(groupRequest({ topic, config, member: sourceAgent, history: [], requestId: name }), {
            code: 'AGENT_NOT_CONFIGURED',
        });
        assert.throws(rejectPublished, { code: 'INVALID_SHARED_CONFIG' });
        return { nativeErrors: native.errors, nativeModelCalls, completionRequests,
            workerError: 'AGENT_NOT_CONFIGURED', sharedConfigError: 'INVALID_SHARED_CONFIG' };
    } finally {
        await new Promise(resolve => provider.close(resolve));
    }
}

async function main() {
    const runRoot = path.join(root, '.runs', 'group-model');
    fs.mkdirSync(runRoot, { recursive: true });
    const out = fs.mkdtempSync(path.join(runRoot, 'run-'));
    const results = {};
    results.member = await runPositive(out, 'member', makeSpec(false, 'synthetic-unified'), ['synthetic-a', 'synthetic-b']);
    results.unified = await runPositive(out, 'unified', makeSpec(true, 'synthetic-unified'), ['synthetic-unified', 'synthetic-unified']);
    results.padded = await runPositive(out, 'padded', makeSpec(true, ' synthetic-unified '), ['synthetic-unified', 'synthetic-unified']);

    const blankUnified = makeSpec(true, '  ');
    blankUnified.expectedModelError = '已启用群组统一模型，但群组统一模型为空。';
    results.blankUnified = await runNegative(out, 'blank-unified', blankUnified, () => sharedConfig('group', {
        ...blankUnified.group, members: blankUnified.plan,
    }));
    const blankMember = makeSpec(false, 'synthetic-unified');
    blankMember.speakers.forEach(member => { member.model = '  '; });
    blankMember.expectedModelError = '当前成员未配置模型。';
    results.blankMember = await runNegative(out, 'blank-member', blankMember, () => {
        const { id, ...agent } = blankMember.speakers[0];
        return sharedConfig('agent', agent);
    });
    console.log(JSON.stringify(results, null, 2));
}

main().catch(error => {
    console.error(error.stderr || error.stack);
    process.exitCode = 1;
});

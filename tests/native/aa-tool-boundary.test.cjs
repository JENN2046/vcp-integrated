'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const server = process.env.VCP_TEST_SERVER || path.resolve(__dirname, '../../apps/server');
const native = require(server + '/modules/requestExecutionContext');
const { createDelegationContinuity } = require(server + '/Plugin/AgentAssistant/delegationContinuity');
const delegation = { agentName: 'Synthetic AA', prompt: 'Original authorized content.' };
const call = { name: 'AgentAssistant', args: {
    agent_name: delegation.agentName, prompt: delegation.prompt, task_delegation: 'true'
} };

function runRequest(headers, callback) {
    const req = Object.assign(new EventEmitter(), {
        path: '/v1/chat/completions', body: { requestId: 'test-native-request' }, headers
    });
    const res = new EventEmitter();
    return (async () => {
        try { return await native.middleware(req, res, callback); }
        finally { res.emit('close'); }
    })();
}

test('explicit AA permits just one exact top-level delegation dispatch', async t => {
    const accepted = [];
    const actor = { principal: 'desktop:test' };
    t.after(native.setSharedBoundary({
        enter: () => ({
            workId: 'test-aa-work', sponsorAuthority: { actor }, delegation,
            safeTools: new Set(['AgentAssistant']), fence() {}, finish() {},
            bridge: {
                onToolDispatch() {}, onToolSettled() {},
                onTaskAccepted: task => accepted.push(task), onTaskObserved() {}
            }
        }),
        taskRequests: { binding: () => ({}) }
    }));
    await runRequest(undefined, async () => {
        for (const field of ['archery', 'archeryNoReply', 'markHistory', 'river', 'vref']) {
            assert.throws(() => native.assertToolBatch([{ ...call, [field]: true }]),
                { code: 'CONTROLLED_TOOL_FORBIDDEN' });
        }
        for (const args of [
            { prompt: 'Changed' }, { agent_name: 'Different' }, { task_delegation: false },
            { timely_contact: 'later' }, { inject_tools: 'Other' }, { cancel_delegation: 'OtherTask' }
        ]) {
            assert.throws(() => native.assertToolBatch([{ ...call, args: { ...call.args, ...args } }]),
                { code: 'CONTROLLED_TOOL_FORBIDDEN' });
        }
        assert.throws(() => native.assertToolBatch([call, call]), { code: 'CONTROLLED_TOOL_CALL_LIMIT' });
        assert.throws(() => native.assertDelegationDispatch(call.name), { code: 'CONTROLLED_TOOL_FORBIDDEN' });
        assert.throws(() => native.assertDelegationInvocation(call.args), { code: 'CONTROLLED_TOOL_FORBIDDEN' });
        native.assertToolBatch([call]);
        await native.executeControlledToolBatch([call], ({ name, args }) => {
            native.assertDelegationDispatch(name);
            return native.trackToolInvocation({ pluginName: name, recordId: 'tool-record' }, dispatch => dispatch(async () => {
                assert.equal(native.assertDelegationInvocation(args), true);
                const child = { pluginName: name, agentBaseName: 'SYNTHETIC', nativeTaskId: 'aa-delegation-1-12345678' };
                const link = await native.acceptNativeTask(child);
                assert.equal(link.identity.recordId, 'tool-record');
                await assert.rejects(native.acceptNativeTask({ ...child, nativeTaskId: 'aa-delegation-2-12345678' }),
                    { code: 'CONTROLLED_TOOL_FORBIDDEN' });
                return 'accepted';
            }));
        });
    });
    assert.equal(accepted.length, 1);
});

test('registered text-only child cannot invoke another tool or AA directly', async t => {
    t.after(native.setSharedBoundary({
        taskRequests: { enter: () => ({ textOnly: true, fence() {}, finish() {} }) }
    }));
    const release = native.register('test-native-request', {}, null, { kind: 'native-task', admissionId: 'test-aa-work' });
    t.after(release);
    await runRequest(release.headers, () => {
        native.assertToolBatch([]);
        assert.throws(() => native.assertToolBatch([call]), { code: 'CONTROLLED_TEXT_TOOLS_FORBIDDEN' });
        assert.throws(() => native.assertToolsAllowed(call.name, call.args), { code: 'CONTROLLED_TEXT_TOOLS_FORBIDDEN' });
        assert.throws(() => native.assertDelegationInvocation(call.args), { code: 'CONTROLLED_TEXT_TOOLS_FORBIDDEN' });
    });
});

test('native archive verification requires the identity-bound terminal receipt and intact report', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-archive-proof-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const continuity = createDelegationContinuity(root);
    const identity = { pluginName: 'AgentAssistant', agentBaseName: 'SYNTHETIC', nativeTaskId: 'aa-delegation-1-12345678',
        nativeRequestId: 'test-native-request', invocationId: 'test-invocation', recordId: 'test-record' };
    const file = 'file/document/AgentTask/SYNTHETIC_aa-delegation-1-12345678.md';
    const archive = path.join(root, file);
    const report = 'A verified native result.';
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.writeFileSync(archive, `# 委托任务归档报告: ${identity.nativeTaskId}\n\n## 最终执行结果\n\n${report}\n`);

    assert.equal(native.hasNativeTaskProvider('AgentAssistant'), false);
    t.after(native.registerNativeTaskProvider('AgentAssistant', {
        read: () => ({ state: 'running', revision: 0 }),
        readArchive: link => continuity.read(link, { includeResult: true })
    }));
    assert.equal(native.hasNativeTaskProvider('AgentAssistant'), true);
    assert.equal(native.verifyNativeTaskArchive('AgentAssistant', identity), null);
    const terminal = continuity.persist(identity, { nativeStatus: 'Succeed', endTime: Date.now(), archivePath: file, report });
    const verified = native.verifyNativeTaskArchive('AgentAssistant', identity);
    assert.equal(verified.resultContent, report);
    assert.equal(verified.resultHash, terminal.resultHash);
    assert.equal(verified.archiveHash, terminal.archiveHash);
    assert.throws(() => native.verifyNativeTaskArchive('AgentAssistant', { ...identity, invocationId: 'wrong' }),
        { code: 'NATIVE_RESULT_IDENTITY_MISMATCH' });
    fs.appendFileSync(archive, 'tampered');
    assert.throws(() => native.verifyNativeTaskArchive('AgentAssistant', identity),
        { code: 'NATIVE_RESULT_HASH_MISMATCH' });
});

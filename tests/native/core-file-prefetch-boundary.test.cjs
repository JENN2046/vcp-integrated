'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pluginManager = require('../../apps/server/Plugin');
const fileResolver = require('../../apps/server/FileFetcherServer');
const native = require('../../apps/server/modules/requestExecutionContext');

test('Core asks for trusted approval without resolving legacy file references', async t => {
    const plugin = 'FixtureApprovalPreview';
    const placeholder = new URL('file:///synthetic-fixture/not-a-real-file.txt').href;
    const seen = [];
    const restoreResolver = t.mock.method(fileResolver, 'resolveFileUrl', async value => {
        seen.push('legacy resolver');
        return value;
    });
    t.mock.method(pluginManager, 'getPlugin', () => ({ name: plugin, isDistributed: false }));
    let approvalArgs;
    t.mock.method(pluginManager.toolApprovalManager, 'getApprovalDecision', (_name, args) => {
        approvalArgs = args;
        seen.push('approval policy');
        return { requiresTrustedHumanAuthorization: true };
    });
    await assert.rejects(native.runCoreTurn({
        workId: 'synthetic-core-work',
        observe() {},
        fence() {}
    }, () => pluginManager.processToolCall(plugin, { reference: placeholder })),
        { code: 'CORE_TRUSTED_APPROVAL_UNAVAILABLE' });
    assert.equal(approvalArgs.reference, placeholder);
    assert.deepEqual(seen, ['approval policy']);
    assert.equal(restoreResolver.mock.callCount(), 0);
});

test('legacy tool calls still pass through their existing file resolver', async t => {
    const stop = Error('Fixture stopped before plugin execution');
    const placeholder = new URL('file:///synthetic-fixture/not-a-real-file.txt').href;
    const resolver = t.mock.method(fileResolver, 'resolveFileUrl', async value => value);
    t.mock.method(pluginManager, 'getPlugin', () => ({ name: 'FixtureLegacy', isDistributed: false }));
    t.mock.method(pluginManager.toolApprovalManager, 'getApprovalDecision', () => { throw stop; });
    await assert.rejects(pluginManager.processToolCall('FixtureLegacy', { reference: placeholder }), error => error === stop);
    assert.equal(resolver.mock.callCount(), 1);
});

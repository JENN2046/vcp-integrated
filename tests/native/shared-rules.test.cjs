'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const desktop = path.resolve(__dirname,'../../apps/desktop');
const serverRules = path.resolve(__dirname,'../../apps/server/Plugin/NativeSync/nativeRules');
const desktopRequire = createRequire(path.join(desktop,'package.json'));

test('server preparation and desktop preparation preserve the same native tool batch', () => {
    const input = '<<<[VCP_TOOL_BATCH_START:abc]>>>\n<div>synthetic</div>\n<<<[VCP_TOOL_BATCH_END:abc]>>>';
    for (const modules of [path.join(desktop,'modules'),path.join(serverRules,'modules')]) {
        assert.equal(require(path.join(modules,'contextSanitizer')).sanitizeContent(input),input);
        const regions = require(path.join(modules,'renderer/toolResultRegions'));
        assert.equal(regions.collectToolDataRanges(input).length,1);
        assert.equal(regions.collectToolDataRanges(input)[0].end,input.length);
    }
});

test('sandbox browser scripts are byte-identical to the installed shared rules', () => {
    for (const [entry,target] of [['tavern','tavernRulesEngine'], ...['toolBatchRegions','toolResultRegions','markdownCodeDomainScanner'].map(name=>['renderer/'+name,'renderer/'+name])]) {
        assert.deepEqual(fs.readFileSync(path.join(desktop,'modules',target+'.js')),fs.readFileSync(desktopRequire.resolve('@vcp/core-rules/'+entry)));
    }
});

test('group depth follows speaker history and the invitation while preserving timestamped source rows', () => {
    const native = desktopRequire('./Groupmodules/groupContextWindow');
    const worker = require(path.join(serverRules, 'Groupmodules/groupContextWindow'));
    assert.equal(worker.applyGroupContextRules, native.applyGroupContextRules);
    const engine = desktopRequire('@vcp/core-rules/tavern');
    const rules = [{ type: 'context_inject', scope: 'group', enabled: true, role: 'user', depth: 2, content: 'context', wrap: false }];
    const make = (role, text) => ({ role, content: [{ type: 'text', text }] });
    const system = make('system', 'agent'), historySystem = make('system', 'notice');
    const user = make('user', 'input'), reply = { ...make('assistant', 'A reply'), __vcpchatTimestampMeta: { messageId: 'reply-A', role: 'assistant', timestamp: 42 } };
    const invite = make('user', 'B invitation');
    const input = [system, user, historySystem, reply, invite];
    const original = structuredClone(input);
    assert.deepEqual(native.applyGroupContextRules(input, rules, engine), [
        system, historySystem, user, make('user', 'context'), reply, invite,
    ]);
    for (const inactive of [[], [{ ...rules[0], enabled: false }], [{ type: 'user_suffix' }]]) {
        assert.deepEqual(native.applyGroupContextRules(input, inactive, engine), original);
    }
    assert.deepEqual(input, original);
});

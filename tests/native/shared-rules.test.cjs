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

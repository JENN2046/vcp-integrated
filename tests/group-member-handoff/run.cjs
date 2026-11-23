'use strict';

// Extend only the test runner. Native modules load from the actual checkout.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');

const mode = process.argv[2];
assert.ok(['a-partial', 'a-committed', 'b-unknown', 'handoff', 'handoff-unknown', 'handoff-a-partial', 'review-closeout', 'plan-baseline', 'plan'].includes(mode));
process.env.NS_GROUP_HANDOFF_CASE = mode;
const runner = path.resolve(__dirname, '../integration/run.cjs');
let source = fs.readFileSync(runner, 'utf8');
function replace(before, after) {
    assert.equal(source.split(before).length, 2, before);
    source = source.replace(before, after);
}
process.argv = [process.argv[0], runner, 'ready'];
replace("const groupRelay = nativeQueue?.createProvider();",
    "const groupRelay = require('../group-member-handoff/fixture.cjs').create();");
if (mode === 'review-closeout') {
    replace('let service, aa;', `let service, aa;
    const closeoutSource = require('../group-member-handoff/review-source.cjs').load(out);`);
    replace('serverRevision, groupRelay, toolHandoff,',
        'serverRevision, groupRelay, toolHandoff, restoreSyntheticState: closeoutSource.restoreSyntheticState,');
    replace("['A'] : ['A', 'B'];", "['A'] : ['B'];");
    replace("} else await restoreProfile(path.join(out,'seed','desktop'+role),profile,service.origin,role);",
        '} else await closeoutSource.restoreBProfile({ profile, origin: service.origin });');
    replace('if (!approvalRestore && !compaction && !streamInterrupt && !toolHandoff && !desktopStreamClose) {',
        'if (A && !approvalRestore && !compaction && !streamInterrupt && !toolHandoff && !desktopStreamClose) {');
}
replace('serverRevision, groupRelay, toolHandoff,', 'serverRevision, groupRelay, toolHandoff: groupRelay.proxyHooks,');
replace('observedContext: toolHandoff?.observed || compactionFallback?.observe(out) || compaction?.observe(out, crossDeviceCompaction)',
    'handleFixtureRequest: groupRelay.cutBeforeDispatch, observedContext: groupRelay.observed(out)');
replace("(compaction || toolHandoff)?'/v1/chat/completions':'/v1/local-chat/completions'",
    "'/v1/chat/completions'");
replace("if (mode === '--dev' || mode === 'ready') {",
    `if (mode === 'ready') {
        await require('../group-member-handoff/${mode === 'review-closeout' ? 'review-closeout' : mode.startsWith('plan') ? 'plan' : 'scenario'}.cjs')({
            clients, out, result, picture, click, evalJs, waitUntil, sha, service, stop, start, profiles, crash, groupRelay,
            ${mode === 'review-closeout' ? 'cert, closeoutSource,' : ''}
        });
    }
    if (mode === '--dev' || mode === 'ready') {`);
const instrumented = new Module(runner, module);
instrumented.filename = runner;
instrumented.paths = Module._nodeModulePaths(path.dirname(runner));
instrumented._compile(source, runner);

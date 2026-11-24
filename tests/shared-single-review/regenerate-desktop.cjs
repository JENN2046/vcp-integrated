'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// Reuse the sandboxed Electron runner, CDS checks, and disposable ToolBox instance.
const runner = path.resolve(__dirname, '../integration/run.cjs');
let source = fs.readFileSync(runner, 'utf8');
function replace(before, after) {
    assert.equal(source.split(before).length, 2, before);
    source = source.replace(before, after);
}
const local = process.env.NS_REGENERATE_MODE === 'local';
process.argv = [process.argv[0], runner, local ? 'local-only' : 'ready'];
replace('const groupRelay = nativeQueue?.createProvider();',
    "const regenerate = require('../shared-single-review/regenerate-desktop-scenario.cjs');\n    const groupRelay = regenerate.provider;");
replace("['A'] : ['A', 'B'];", "['A'] : ['A'];");
replace('serverRevision, groupRelay, toolHandoff,',
    'serverRevision, groupRelay, toolHandoff: regenerate.hooks,');
replace("((compaction || toolHandoff)?'/v1/chat/completions':'/v1/local-chat/completions')", "'/v1/chat/completions'");
replace("if (mode === '--dev' || mode === 'ready') {",
    `result.desktopRegenerate = await regenerate.scenario({
        A, profiles, service, cert, out, picture, click, evalJs, waitUntil, start, stop,
    });
    if (mode === '--dev' || mode === 'ready') {`);
if (local) replace("} else if (mode !== 'ready') {", "} else if (mode !== 'local-only') {");
const instrumented = new Module(runner, module);
instrumented.filename = runner;
instrumented.paths = Module._nodeModulePaths(path.dirname(runner));
instrumented._compile(source, runner);

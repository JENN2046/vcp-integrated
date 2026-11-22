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
process.argv = [process.argv[0], runner, 'ready'];
replace("const host = path.join(candidate, 'apps/desktop');", "const host = process.env.NS_UPSTREAM_DELETE_DESKTOP || path.join(candidate, 'apps/desktop');");
replace('const serverRevision = requested', "const serverRevision = process.env.NS_UPSTREAM_DELETE_SERVER || (requested");
replace('process.env.NS_BASELINE_SERVER_REVISION : undefined;', 'process.env.NS_BASELINE_SERVER_REVISION : undefined);');
replace('const groupRelay = nativeQueue?.createProvider();',
    "const closeout = require('../shared-single-review/upstream-delete-desktop-scenario.cjs');\n    const groupRelay = closeout.provider;");
replace('serverRevision, groupRelay, toolHandoff,',
    'serverRevision, groupRelay, toolHandoff: closeout.hooks,');
replace("((compaction || toolHandoff)?'/v1/chat/completions':'/v1/local-chat/completions')", "'/v1/chat/completions'");
replace("if (mode === '--dev' || mode === 'ready') {",
    `if (mode === 'ready') result.desktopDelete = await closeout.scenario({
        A, B, start, stop, result, profiles, service, cert, out, picture, click, evalJs, waitUntil,
    });
    if (mode === '--dev' || mode === 'ready') {`);
const instrumented = new Module(runner, module);
instrumented.filename = runner;
instrumented.paths = Module._nodeModulePaths(path.dirname(runner));
instrumented._compile(source, runner);

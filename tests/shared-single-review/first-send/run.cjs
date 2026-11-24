'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// Keep using the existing sandboxed Electron, CDS and ToolBox integration runner.
const mode = process.argv[2] ?? 'fixed';
assert.ok(['fixed', 'baseline', 'rejection'].includes(mode), 'Usage: node run.cjs [fixed|baseline|rejection]');
if (mode === 'baseline') assert.ok(process.env.NS_FIRST_SEND_DESKTOP, 'Baseline requires a built previous Desktop app path');
process.env.NS_FIRST_SEND_MODE = mode;
const candidate = path.resolve(__dirname, '../../..');
const runner = path.join(candidate, 'tests/integration/run.cjs');
let source = fs.readFileSync(runner, 'utf8');
function replace(before, after) {
    assert.equal(source.split(before).length, 2, before);
    source = source.replace(before, after);
}

const scratch = path.join(candidate, '.runs', 'first-send-topic-head');
fs.mkdirSync(scratch, { recursive: true });
process.argv = [process.argv[0], runner, 'ready'];
replace("const host = path.join(candidate, 'apps/desktop');",
    "const host = process.env.NS_FIRST_SEND_DESKTOP || path.join(candidate, 'apps/desktop');");
replace('const serverRevision = requested', "const serverRevision = process.env.NS_FIRST_SEND_SERVER || (requested");
replace('process.env.NS_BASELINE_SERVER_REVISION : undefined;', 'process.env.NS_BASELINE_SERVER_REVISION : undefined);');
replace("path.join(os.tmpdir(), 'vcp-integration-')", JSON.stringify(path.join(scratch, 'run-')));
replace("path.join(here, './electron.cjs')", JSON.stringify(path.join(__dirname, 'electron.cjs')));
replace("require('./service.cjs')).start", `require(${JSON.stringify(path.join(__dirname, 'service.cjs'))})).start`);
replace('...compaction?.settings,...compactionFallback?.settings',
    "lastOpenItemId:service.descriptors[role].preSubmit.itemId,lastOpenItemType:'agent',lastOpenTopicId:service.descriptors[role].preSubmit.topicId,...compaction?.settings,...compactionFallback?.settings");
replace("    if (!approvalRestore && !compaction && !streamInterrupt && !toolHandoff && !desktopStreamClose) {",
    "    if (mode !== 'ready' && !approvalRestore && !compaction && !streamInterrupt && !toolHandoff && !desktopStreamClose) {");
replace("if (mode === '--dev' || mode === 'ready') {",
    `if (mode === 'ready') await require(${JSON.stringify(path.join(__dirname, 'scenario.cjs'))})({
        clients: {A, B}, out, result, service, picture, click, evalJs, waitUntil, start, stop, trace,
    });
    if (mode === '--dev') {`);

const instrumented = new Module(runner, module);
instrumented.filename = runner;
instrumented.paths = Module._nodeModulePaths(path.dirname(runner));
instrumented._compile(source, runner);

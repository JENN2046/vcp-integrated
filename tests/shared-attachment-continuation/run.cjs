'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Module } = require('node:module');
const path = require('node:path');

const runner = require.resolve('../integration/run.cjs');
const mode = 'shared-attachment-continuation';
let source = fs.readFileSync(runner, 'utf8');
function replace(anchor, replacement) {
    assert.equal(source.split(anchor).length, 2, 'Integration fixture anchor: ' + anchor);
    source = source.replace(anchor, replacement);
}

assert.equal(process.argv.length, 2);
process.argv.push(mode);
replace("const requested = process.argv[2] || 'all';",
    "const requested = process.argv[2] || 'all';\nconst attachmentContinuation = require('../shared-attachment-continuation/fixture.cjs');");
replace("'local-stream-interrupt', 'desktop-stream-close'].includes(requested)",
    "'local-stream-interrupt', 'desktop-stream-close', 'shared-attachment-continuation'].includes(requested)");
replace("...(desktopStreamClose ? { NS_DESKTOP_STREAM_CLOSE: '1' } : {}) };",
    "...(desktopStreamClose ? { NS_DESKTOP_STREAM_CLOSE: '1' } : {}),\n" +
    "        ...((role === 'A' || role === 'L') && { NS_ATTACHMENT_FIXTURE_FILE: attachmentContinuation.file(out) }) };");
replace("path.join(here, './electron.cjs')", "require.resolve('../shared-attachment-continuation/electron.cjs')");
replace("compaction?.observe(out, crossDeviceCompaction),",
    "compaction?.observe(out, crossDeviceCompaction) || attachmentContinuation.observe(out),");
replace("ordinaryTools: ordinaryFixture, serverRevision", "ordinaryTools: attachmentContinuation.probeTool, serverRevision");
replace("if (mode === 'idle') {\n                const connectionFile",
    "if (role === 'A') {\n                const connectionFile");
replace("? ['A'] : ['A', 'B'];", "? ['A'] : ['A', 'B', 'L'];");
replace("if (desktopStreamClose || mode==='local-only' && role==='A')", "if (role==='L')");
replace("id:'local-agent',name:'Synthetic local',model:'synthetic',systemPrompt:'Synthetic test',streamOutput:Boolean(desktopStreamClose),...streamInterrupt?.agent,",
    `...read(path.join(profiles.A, 'Agents', service.descriptors.A.preSubmit.itemId, 'config.json')),
                    id:'local-agent',name:'Synthetic local control',`);
replace("&& (mode!=='local-only'||role==='B')", "&& role!=='L'");
replace("((compaction || toolHandoff)?'/v1/chat/completions':'/v1/local-chat/completions')",
    "'/v1/chat/completions'");
replace("if (!approvalRestore && !compaction && !streamInterrupt", "if (false && !approvalRestore && !compaction && !streamInterrupt");
replace(": mode === 'config-only' ? require('./configuration.cjs') : scenario;",
    ": require('../shared-attachment-continuation/scenario.cjs');");

const fixture = new Module(runner, module);
fixture.filename = runner;
fixture.paths = Module._nodeModulePaths(path.dirname(runner));
fixture._compile(source, runner);

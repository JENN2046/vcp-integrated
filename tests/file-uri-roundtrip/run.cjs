'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Module } = require('node:module');
const path = require('node:path');

// Reuse the integration harness's staged ToolBox, synthetic NativeSync seed,
// desktop lifecycle, loopback TLS proxy, and evidence collection.
function load(relative, edits) {
    const filename = require.resolve(relative);
    let source = fs.readFileSync(filename, 'utf8');
    for (const [anchor, replacement] of edits) {
        assert.equal(source.split(anchor).length, 2, 'Integration fixture anchor: ' + anchor);
        source = source.replace(anchor, replacement);
    }
    const fixture = new Module(filename, module);
    fixture.filename = filename;
    fixture.paths = Module._nodeModulePaths(path.dirname(filename));
    fixture._compile(source, filename);
    return fixture.exports;
}

module.exports.service = load('../integration/service.cjs', [
    ["const { spawn, execFileSync } = require('node:child_process');",
        "const { execFileSync } = require('node:child_process');\n" +
        "const uriFixture = require('../file-uri-roundtrip/fixture.cjs');\n" +
        "const { spawnIsolatedToolbox } = require('../file-uri-roundtrip/isolation.cjs');"],
    ["const upstream = http.request({host:",
        "delete upstreamHeaders['x-forwarded-for'];\n" +
        "        const upstream = http.request({localAddress:route === '/v1/chat/completions' ? uriFixture.sourceAddress() : undefined, host:"],
    ["backend = spawn(node, [", "backend = spawnIsolatedToolbox(node, ["],
    ["cwd:box,stdio:['ignore',log,log],env:{",
        "privateCacheDir: uriFixture.privateCacheDir(out), spawnOptions: {cwd:box,stdio:['ignore',log,log],env:{"],
    ["\n            }\n        });\n        fs.closeSync(log);", "\n            }}\n        });\n        fs.closeSync(log);"],
]);

const desktop = path.resolve(__dirname, '../../apps/desktop');
const distribution = path.join(desktop, 'VCPDistributedServer');
const pluginRoot = path.join(distribution, 'Plugin');
const activeConfigs = [
    path.join(desktop, '.env'),
    path.join(desktop, 'AppData/generated_lists/config.env'),
    path.join(distribution, 'config.env'),
    ...fs.readdirSync(pluginRoot, {withFileTypes:true}).filter(entry => entry.isDirectory())
        .map(entry => path.join(pluginRoot, entry.name, 'config.env')),
];
for (const config of activeConfigs) {
    assert.equal(fs.lstatSync(config, {throwIfNoEntry:false}), undefined,
        'Use a clean checkout without active desktop or plugin configuration');
}

const testCase = process.argv[2];
assert.ok(['tool', 'inline', 'filename'].includes(testCase), 'Usage: node tests/file-uri-roundtrip/run.cjs tool|inline|filename');
assert.equal(process.argv.length, 3);
process.env.NS_FILE_URI_CASE = testCase;
process.argv[2] = 'file-uri-roundtrip';
load('../integration/run.cjs', [
    ["const requested = process.argv[2] || 'all';",
        "const requested = process.argv[2] || 'all';\nconst uriRoundtrip = require('../file-uri-roundtrip/fixture.cjs');"],
    ["'local-stream-interrupt', 'desktop-stream-close'].includes(requested)",
        "'local-stream-interrupt', 'desktop-stream-close', 'file-uri-roundtrip'].includes(requested)"],
    ["...(desktopStreamClose ? { NS_DESKTOP_STREAM_CLOSE: '1' } : {}) };",
        "NS_ATTACHMENT_FIXTURE_FILE: uriRoundtrip.file(out), NS_URI_DISTRIBUTED_A: '1', NS_URI_SOURCE_IP: uriRoundtrip.sourceAddress() };"],
    ["path.join(here, './electron.cjs')", "require.resolve('../file-uri-roundtrip/endpoint-electron.cjs')"],
    ["desktopStreamClose || require('./service.cjs')", "require('../file-uri-roundtrip/run.cjs').service"],
    ["compaction?.observe(out, crossDeviceCompaction),", "uriRoundtrip.observe(out),"],
    ["ordinaryTools: ordinaryFixture, serverRevision", "ordinaryTools: uriRoundtrip.tool, serverRevision"],
    ["if (mode === 'idle') {\n                const connectionFile", "{\n                const connectionFile"],
    ["? ['A'] : ['A', 'B'];", "? ['A'] : ['A'];"],
    ["((compaction || toolHandoff)?'/v1/chat/completions':'/v1/local-chat/completions')", "'/v1/chat/completions'"],
    ["enableDistributedServer:false,vcpLogUrl:service.wsOrigin", "enableDistributedServer:true,vcpLogUrl:service.wsOrigin"],
    ["if (!approvalRestore && !compaction && !streamInterrupt", "if (false && !approvalRestore && !compaction && !streamInterrupt"],
    [": mode === 'config-only' ? require('./configuration.cjs') : scenario;",
        ": require('../file-uri-roundtrip/scenario.cjs');"],
]);

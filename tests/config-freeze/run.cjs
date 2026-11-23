'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { Module } = require('node:module');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const revision = 'f67c546c8a425ef2b31c198b329a3461c5111e7a';
const git = args => execFileSync('git', args, { cwd:root, encoding:'utf8' }).trim();
const editor = 'apps/desktop/modules/nativeSyncSettings/sharedEditor.js';
const candidate = process.argv[2] === '--candidate';
assert.ok(process.argv.length === (candidate ? 3 : 2), 'Usage: node tests/config-freeze/run.cjs [--candidate]');
const checkoutRevision = git(['rev-parse', 'HEAD']);
if (candidate) git(['merge-base', '--is-ancestor', revision, checkoutRevision]);
else assert.equal(checkoutRevision, revision);
const archivedBaseline = process.env.NS_FREEZE_BASELINE_DIST;
assert.ok(!archivedBaseline || !candidate && path.isAbsolute(archivedBaseline));
const projectChanges = git(['diff', revision, '--name-only', '--', 'apps', 'packages']);
assert.ok((candidate ? [editor] : archivedBaseline ? ['', editor] : ['']).includes(projectChanges),
    'Expected only the shared editor to differ from the fixed baseline in candidate mode');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const baselineBundleSha256 = 'ab00bcfbf1387c31dfcfaa39d98a2cb3dedf6fa46c9fe93c59cb0741169a2973';
if (archivedBaseline) {
    const assets = path.join(archivedBaseline, 'assets');
    const entries = fs.readdirSync(assets).filter(name => /^index-.+\.js$/.test(name));
    assert.equal(entries.length, 1);
    assert.equal(sha256(fs.readFileSync(path.join(assets, entries[0]))), baselineBundleSha256);
}
module.exports.provenance = {
    revision, checkoutRevision, candidate, editor, archivedBaseline:Boolean(archivedBaseline), baselineBundleSha256,
    editorBaseSha256:sha256(execFileSync('git', ['show', revision + ':' + editor], {cwd:root})),
    editorWorkingSha256:sha256(fs.readFileSync(path.join(root, editor))),
    editorDiffSha256:projectChanges ? sha256(execFileSync('git', ['diff', revision, '--', editor], {cwd:root})) : null,
};
process.argv[2] = 'mobile-config-freeze';

// Load the existing integration fixture with targeted test-only options.
function load(relative, replacements) {
    const filename = require.resolve(relative);
    let source = fs.readFileSync(filename, 'utf8');
    for (const [anchor, replacement] of replacements) {
        assert.equal(source.split(anchor).length, 2, anchor);
        source = source.replace(anchor, replacement);
    }
    const fixture = new Module(filename, module);
    fixture.filename = filename;
    fixture.paths = Module._nodeModulePaths(path.dirname(filename));
    fixture._compile(source, filename);
    return fixture.exports;
}

module.exports.service = load('../integration/service.cjs', [
    ["NativeMobileStartDelayMs:'0'", "NativeMobileStartDelayMs:'10000'"],
    ["agentConfig: toolHandoff?.agentConfig", "agentConfig: observedContext.agentConfig"],
]);

load('../integration/run.cjs', [
    ["const requested = process.argv[2] || 'all';",
        "const requested = process.argv[2] || 'all';\nconst freeze = require('../config-freeze/fixture.cjs');"],
    ["'local-stream-interrupt', 'desktop-stream-close'].includes(requested)",
        "'local-stream-interrupt', 'desktop-stream-close', 'mobile-config-freeze'].includes(requested)"],
    ["desktopStreamClose || require('./service.cjs')", "require('../config-freeze/run.cjs').service"],
    ["compaction?.observe(out, crossDeviceCompaction),",
        "freeze.observe(out), mobileBuild:process.env.NS_FREEZE_BASELINE_DIST,"],
    ["if (!approvalRestore && !compaction && !streamInterrupt", "if (false && !approvalRestore && !compaction && !streamInterrupt"],
    [": mode === 'config-only' ? require('./configuration.cjs') : scenario;",
        ": require('../config-freeze/scenario.cjs');"],
]);

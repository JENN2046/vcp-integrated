'use strict';
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const here = __dirname;
const repo = path.resolve(process.env.AA_ACCEPTANCE_CHECKOUT || path.join(here, '../..'));
process.chdir(repo);
const [mode = 'candidate', order = 'parent'] = process.argv.slice(2);
if (!['baseline','candidate','crash','sse','archive-mismatch'].includes(mode) || !['parent','child'].includes(order)) {
    throw Error('Usage: node tests/aa-handoff/run.cjs [baseline|candidate|crash|sse|archive-mismatch] [parent|child]');
}
if (['crash','sse','archive-mismatch'].includes(mode) && order !== 'parent') throw Error('Fault and SSE probes use parent-first order');
if (mode === 'baseline' && require('node:child_process').execFileSync('git',['rev-parse','--short=12','HEAD'],{cwd:repo,encoding:'utf8'}).trim() !== 'c9008bde429d') {
    throw Error('AA_ACCEPTANCE_CHECKOUT must point to a built, isolated c9008bde429d checkout');
}
process.env.AA_ACCEPTANCE_CANDIDATE = mode === 'baseline' ? '0' : '1';
process.env.AA_ACCEPTANCE_ORDER = order;
process.env.AA_ACCEPTANCE_TAMPER_ARCHIVE = mode === 'archive-mismatch' ? '1' : '0';
process.env.AA_ACCEPTANCE_SSE = mode === 'sse' ? '1' : '0';
process.env.AA_ACCEPTANCE_CRASH = mode === 'crash' ? '1' : '0';
const runner = path.join(repo, 'tests/integration/run.cjs');
const aa = path.join(repo, 'tests/aa-delegation/fixture.cjs');
// Preserve the frozen checkout. Extend only the attested fixture modules in memory.
function load(file, edit) {
    const mod = new Module(file, module);
    mod.filename = file;
    mod.paths = Module._nodeModulePaths(path.dirname(file));
    Module._cache[file] = mod;
    mod._compile(edit(fs.readFileSync(file, 'utf8')), file);
    mod.loaded = true;
}
function replace(source, from, to) {
    if (!source.includes(from)) throw Error('Missing fixture anchor ' + from);
    return source.replace(from, to);
}
if (process.env.AA_ACCEPTANCE_CANDIDATE === '1' && process.env.AA_ACCEPTANCE_ORDER === 'child') {
    const fixturePreload = path.join(here, 'parent-fence-preload.cjs');
    load(path.join(repo, 'tests/integration/service.cjs'), source => replace(
        source, "...(observedContext ? ['--require',observedContext.preload] : []),'server.js']",
        "'--require'," + JSON.stringify(fixturePreload) + ",...(observedContext ? ['--require',observedContext.preload] : []),'server.js']"
    ));
}
load(aa, source => {
    source = replace(source, ".findLast(Boolean);", ".findLast(Boolean) || ((body.model === 'synthetic-summary' || body.messages.some(message => JSON.stringify(message.content).includes(childReport))) && (process.env.AA_ACCEPTANCE_ORDER === 'child' ? markers.complete : markers.desktop));");
    source = replace(source, "row.role = body.model === childModel ? 'child' : 'parent';", "row.role = body.model === 'synthetic-summary' ? 'summary' : body.model === childModel ? 'child' : 'parent';");
    source = replace(source, "row.round = row.role === 'child' ? ++gate.childRounds : ++gate.parentRounds;", "row.round = row.role === 'summary' ? 1 : row.role === 'child' ? ++gate.childRounds : ++gate.parentRounds;");
    source = replace(source, 'async reply(body, row, res) {', `async reply(body, row, res) {
            if (row.role === 'summary') {
                row.summaryReportCount = JSON.stringify(body.messages).split(childReport).length - 1;
                row.summaryHasTypedReceipt = JSON.stringify(body.messages).includes('AgentAssistantReport');
                return writeCompletion(body, res, ${JSON.stringify('<context_checkpoint>\nFixture checkpoint for original AA Work. AA_DELEGATION_CHILD_REPORT\n</context_checkpoint>')});
            }
`);
    source = replace(source, 'waitForChildDispatch: () =>', 'marker: row.marker, waitForChildDispatch: () =>');
    return replace(source, 'if (placeholders.length) {', `
            if (row.round > 1 && body.messages.some(m => JSON.stringify(m.content).includes(childReport))) {
                row.resumedReportMarkerCount = JSON.stringify(body.messages).split(childReport).length - 1;
                row.resumedWithCommittedCheckpoint = JSON.stringify(body.messages).includes('Fixture checkpoint for original AA Work.');
                return writeCompletion(body, res, 'AA_DELEGATION_B_FINAL_' + row.marker);
            }
            if (row.round > 1 && !placeholders.length) {
                row.resumedReportMarkerCount = 0;
                return writeCompletion(body, res, 'AA_DELEGATION_B_FINAL_' + row.marker);
            }
            if (placeholders.length) {`);
});
const options = require('./options.cjs');
const scenario = path.join(repo, 'tests/aa-desktop/scenario.cjs');
Module._cache[scenario] = { exports: options.run };
process.argv = [process.argv[0], runner, 'aa-desktop'];
load(runner, source => {
    source = replace(source, 'trace, mode: \'pre-only\'});', 'trace, mode: \'pre-only\', ...require(' + JSON.stringify(__filename.replace(/run\.cjs$/, 'options.cjs')) + ').options});');
    source = replace(source, 'approvalRestore || aaDesktop || nativeQueue', 'approvalRestore || nativeQueue');
    source = replace(source, 'if (!approvalRestore && !compaction && !streamInterrupt && !toolHandoff && !desktopStreamClose) {', 'if (!aaDesktop && !approvalRestore && !compaction && !streamInterrupt && !toolHandoff && !desktopStreamClose) {');
    source = replace(source, '(compaction || toolHandoff)?', '(aaDesktop || compaction || toolHandoff)?');
    if (process.env.AA_ACCEPTANCE_CANDIDATE === '1') source = replace(source, '...compaction?.settings,...toolHandoffFixture?.settings,', "...compaction?.settings,...toolHandoffFixture?.settings,enableContextCompaction:true,contextCompactionModel:'synthetic-summary',");
    return source;
});

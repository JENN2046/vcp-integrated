'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const [runPath, markerPath, cdsBinary] = process.argv.slice(2);
if (!runPath || !markerPath || !cdsBinary) throw Error('Usage: node validate-reader-pin.cjs RUN_DIR B-PIN.JSON WINDOWS_CDS_EXE');
const run = fs.realpathSync(runPath);
const runId = path.basename(run);
assert.match(runId, /^run-[A-Za-z0-9]+$/);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const ready = read(path.join(run, 'ready.json'));
const status = read(path.join(run, 'status.json'));
const markerBytes = fs.readFileSync(markerPath);
const marker = JSON.parse(markerBytes.toString().replace(/^\uFEFF/, ''));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const { pinned, followup, observer } = marker;

assert.equal(marker.version, 1);
assert.equal(marker.runId, runId);
assert.equal(marker.appropriateUser, true);
assert.equal(observer.platform, 'win32');
assert.equal(observer.arch, 'x64');
assert.equal(observer.cds.sha256, digest(fs.readFileSync(cdsBinary)), 'Windows must load the staged CDS executable');
assert.ok(Number.isSafeInteger(observer.cds.pid) && observer.cds.pid > 0);
assert.equal(status.work.length, 0, 'the server already has a Work');
assert.equal(status.providerCalls, 0, 'a provider call already exists');
assert.equal(status.journal.length, status.seedCount, 'only the seed history may exist before pin approval');

const draft = 'Windows B held draft while shared reply streams.';
for (const sample of [pinned, followup]) {
    assert.equal(sample.topicId, ready.windowsDescriptor.topicId, 'marker is from a different isolated Windows topic');
    assert.match(sample.messageId, /^hardware-seed-\d\d$/);
    assert.equal(sample.selection.anchorId, sample.messageId);
    assert.equal(sample.selection.focusId, sample.messageId);
    assert.equal(sample.selection.collapsed, false);
    assert.ok(Number.isSafeInteger(sample.selection.anchorOffset) && Number.isSafeInteger(sample.selection.focusOffset));
    assert.notEqual(sample.selection.anchorOffset, sample.selection.focusOffset);
    assert.equal(sample.selection.length, Math.abs(sample.selection.focusOffset - sample.selection.anchorOffset));
    assert.match(sample.selection.hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(sample.composer, { length: draft.length, hash: digest(draft) });
    assert.ok(sample.connected.originalBubble && sample.connected.originalBody && sample.connected.originalAnchor && sample.connected.originalFocus);
    assert.match(sample.reading.viewportAnchorId, /^hardware-seed-\d\d$/);
    assert.ok(Number.isFinite(sample.reading.anchorTop));
    assert.ok(sample.reading.scrollTop > 64 && sample.reading.maxScrollTop - sample.reading.scrollTop > 64,
        'Windows anchor is too close to a scroll boundary');
    assert.ok(sample.layout.composerWithinWindow);
}
assert.deepEqual(pinned.selection, followup.selection);
assert.equal(pinned.reading.viewportAnchorId, followup.reading.viewportAnchorId);
assert.ok(Math.abs(pinned.reading.anchorTop - followup.reading.anchorTop) <= 2);
for (const kind of ['pointerdown', 'pointerup']) {
    assert.ok(pinned.pointerEvents.some(event => event.kind === kind && event.trusted && event.pointerType === 'mouse' && event.messageId === pinned.messageId));
}

const pass = { pass: true, version: 1, runId, topicId: pinned.topicId, sharedTopicId: ready.sharedTopicId,
    providerCallsAtPin: status.providerCalls, journalRowsAtPin: status.journal.length,
    sourceMarkerSha256: digest(markerBytes), validatedAt: new Date().toISOString(), observer,
    selection: pinned.selection, anchor: pinned.reading, composer: pinned.composer };
const output = path.join(run, 'windows-pin-pass.json');
assert.equal(fs.existsSync(output), false, 'gate already opened for this run');
const temporary = output + '.tmp-' + process.pid;
const fd = fs.openSync(temporary, 'wx', 0o600);
try {
    fs.writeFileSync(fd, JSON.stringify(pass, null, 2) + '\n');
    fs.fsyncSync(fd);
} finally {
    fs.closeSync(fd);
}
fs.renameSync(temporary, output);
console.log(JSON.stringify(pass));

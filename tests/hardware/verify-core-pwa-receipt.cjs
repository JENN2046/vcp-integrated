// Verify the preserved raw fixture results against a tested commit and a review head.
'use strict';
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const [run, tested, head = 'HEAD'] = process.argv.slice(2);
if (!run || !tested) throw Error('Usage: node tests/hardware/verify-core-pwa-receipt.cjs RUN TESTED_COMMIT [REVIEW_HEAD]');
const root = path.resolve(__dirname, '../..');
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 8 * 1024 * 1024 });
const read = name => JSON.parse(fs.readFileSync(path.join(run, name), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const verifyFile = ({ file, sha256 }) => assert.equal(hash(git('show', testedCommit + ':' + file)), sha256, file);
const testedCommit = git('rev-parse', '--verify', tested + '^{commit}').toString().trim();
const reviewCommit = git('rev-parse', '--verify', head + '^{commit}').toString().trim();
const evidence = read('evidence.json');
const proof = read('pwa-proof.json');
assert.deepEqual(evidence.failures, []);
assert.deepEqual(evidence.checkout.atStart, evidence.checkout.atEnd);
assert.equal(evidence.checkout.atStart.commit, testedCommit);
assert.deepEqual(evidence.checkout.atStart.inputChanges, []);
for (const input of ['apps', 'packages', 'scripts', 'tests']) {
    const tree = git('rev-parse', testedCommit + ':' + input).toString().trim();
    assert.equal(evidence.checkout.atStart.inputTrees[input], tree, input);
    assert.equal(git('rev-parse', reviewCommit + ':' + input).toString().trim(), tree, input);
}
assert.deepEqual(evidence.backendSources, read('backend-loaded.json'));
assert(evidence.backendSources.length > 0);
evidence.backendSources.forEach(verifyFile);
assert.deepEqual(evidence.desktopLoads.map(row => row.role), ['A','B','B']);
for (const load of evidence.desktopLoads) {
    assert(load.preloadArtifact.matchedDebuggerSource);
    for (const row of [...load.main, ...load.renderer]) verifyFile(row);
}
assert(evidence.core.physicalAndroid && evidence.core.browserPwa && evidence.core.rendererReloadReadback);
assert(evidence.core.definitionTombstoneAndReplay && evidence.core.historyAndAttachmentUnchangedAfterRestart);
assert.equal(proof.mode, 'browser-phone');
assert.equal(proof.final.length, 2);
assert.equal(proof.ongoing.length, 2);
assert.equal(proof.loadedAssets.length, 2);
assert.deepEqual(proof.loadedAssets[0], proof.loadedAssets[1]);
for (const ext of ['js', 'css']) assert(proof.loadedAssets[0].some(asset => asset.path.endsWith('.' + ext) && /^[a-f0-9]{64}$/.test(asset.sha256)));
const ids = proof.final.map(client => client.messages.map(message => message.id));
assert.equal(new Set(ids[0]).size, 6);
assert.equal(evidence.core.formalMessages, 6);
assert.equal(evidence.provider.length, 3);
assert.deepEqual(ids[0], ids[1]);
assert.deepEqual(proof.final[0].works, proof.final[1].works);
assert.equal(new Set(proof.final[0].works.map(work => work.id)).size, 3);
assert(proof.final[0].works.every(work => work.status === 'completed'));
const work = read('desktop-exited.json').workId;
for (const observer of proof.ongoing) assert(observer.works.some(row => row.id === work && row.status === 'running'));
const rawHashes = Object.fromEntries(['evidence.json','pwa-proof.json','backend-loaded.json'].map(file => [file, hash(fs.readFileSync(path.join(run, file)))]));
console.log(JSON.stringify({testedCommit, reviewCommit, inputTrees:evidence.checkout.atStart.inputTrees, loadedBackendFiles:evidence.backendSources.length,
    electronLoads:evidence.desktopLoads.length, pwaAssets:proof.loadedAssets[0], workObservedRunning:work, rawHashes}, null, 2));

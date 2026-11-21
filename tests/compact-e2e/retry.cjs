'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./fixture.cjs');

module.exports = async ({
    A, result, service, history, journal, intents, compactIpc, compacted, committed, checkpoint,
    manualCompact, picture, waitUntil, profiles, sha,
}) => {
    const summaryCalls = () => service.calls.filter(row => row.model === fixture.summaryModel);
    const central = () => service.requests.filter(row => row.route.includes('/shared/compact-'));
    const replies = action => compactIpc(A).filter(row => row.data.channel.endsWith('compact-' + action));
    const localFile = path.join(profiles.A, '.native-sync/shared/sharedAB/executions.json');
    const localIntent = () => JSON.parse(fs.readFileSync(localFile, 'utf8')).compactions?.[committed.id];
    const journalIds = () => journal().map(({seq,msg_id,action,hash}) => ({seq,msg_id,action,hash}));
    const observed = result.compactionRetry = { checkpointId:checkpoint.id, intentId:committed.id };
    const race = await waitUntil(() => A.events.find(row => row.event === 'compaction-history-inode-race'),
        'A strict History read raced one inode replacement');
    assert.equal(race.data.intentId, committed.id);
    assert.equal(race.data.checkpointId, checkpoint.id);
    assert.notEqual(race.data.beforeIno, race.data.afterIno);
    assert.equal(race.data.links, 1);
    observed.race = race.data;
    const failed = await waitUntil(() => replies('commit')[0], 'A gets its first commit IPC result');
    assert.deepEqual([failed.data.success, failed.data.error], [false,'HISTORY_IDENTITY_CHANGED']);
    const diagnostic = await waitUntil(() => A.command('dismiss-compaction-diagnostic'),
        'A sees and dismisses the compaction failure diagnostic');
    const cut = central().find(row => row.route.endsWith('/compact-commit') && row.body.id === committed.id);
    assert.equal(cut.status, 200);
    assert.equal(cut.response.seq, committed.committed_seq);
    assert.deepEqual(history(), compacted);
    assert.equal(summaryCalls().length, 1);
    const journalBeforeRetry = journalIds();
    observed.beforeRetry = { result:failed.data, diagnostic, journal:journalBeforeRetry,
        physicalIds:history().map(row => row.id), localIntent:localIntent(), summaryCalls:summaryCalls().length,
        central:structuredClone(central()) };
    await picture(A, 'A-central-committed-local-confirmation-failed');
    await manualCompact();
    const second = await waitUntil(() => replies('prepare')[1], 'A receives the result of retrying from the same message menu');
    observed.afterRetry = { result:second.data, localIntent:localIntent() };
    if (!second.data.recovered && second.data.success) {
        // Baseline: record what the successful *new* prepare actually did.
        const duplicate = await waitUntil(() => replies('commit')[1], 'baseline retry reaches a second commit');
        observed.afterRetry.duplicateCommit = duplicate.data;
    }
    Object.assign(observed.afterRetry, { journal:journalIds(), physicalIds:history().map(row => row.id),
        summaryCalls:summaryCalls().length, central:structuredClone(central()) });
    const loaded = await A.command('loaded-sources', {
        main:[
            'apps/desktop/modules/services/historyMutationQueue.js',
            'apps/desktop/modules/services/nativeSync/sharedRuntime.js',
            'apps/desktop/modules/services/nativeSync/sharedQueue.js',
        ],
        renderer:['apps/desktop/modules/chat/contextCompactionService.js'],
    });
    assert.equal(loaded.main.length, 3);
    assert.equal(loaded.renderer.length, 1);
    for (const source of [...loaded.main, ...loaded.renderer]) assert.equal(source.sha256, sha(path.join(result.candidate, source.file)));
    observed.loaded = loaded;
    assert.equal(second.data.recovered, true, 'retry must recover the original publication');
    assert.equal(second.data.intentId, committed.id);
    assert.equal(second.data.checkpointId, checkpoint.id);
    assert.deepEqual(journalIds(), journalBeforeRetry, 'retry must not append another checkpoint');
    assert.deepEqual(history(), compacted);
    assert.equal(intents().length, 1);
    assert.equal(observed.beforeRetry.localIntent.awaitingConfirmation, true);
    assert.equal(localIntent().phase, 'completed');
    assert.equal(localIntent().awaitingConfirmation, false);
    assert.equal(summaryCalls().length, 1);
    assert.equal(central().filter(row => row.route.endsWith('/compact-prepare')).length, 1);
    assert.equal(central().filter(row => row.route.endsWith('/compact-cancel')).length, 0);
    assert.ok(central().filter(row => row.route.endsWith('/compact-commit')).every(row =>
        row.body.id === cut.body.id && row.bodySha256 === cut.bodySha256 &&
        row.status === cut.status && row.response.seq === cut.response.seq));
};

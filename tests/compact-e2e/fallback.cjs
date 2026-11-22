'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { envelopeFor } = require('../../apps/server/Plugin/NativeSync/sync/metadata');

const fallbackModel = 'synthetic-summary-fallback';
const partial = 'SYNTHETIC PARTIAL SUMMARY MUST NEVER PERSIST';
const goodMarker = 'SYNTHETIC OLDER VALID CHECKPOINT';
const badMarker = '[UPSTREAM_ERROR] 上游API返回状态码 404，错误信息: SYNTHETIC HISTORICAL PROVIDER ERROR';
const intervening = 'SYNTHETIC TURN BETWEEN CHECKPOINTS';
const historyRows = [
    checkpointRow('fallback-history-good', goodMarker, 1700000000003),
    { id:'fallback-history-between', role:'assistant', content:intervening, timestamp:1700000000004 },
    checkpointRow('fallback-history-bad', badMarker, 1700000000005),
];
function checkpointRow(id, checkpoint, timestamp) {
    return { id, role:'user', content:checkpoint, timestamp,
        contextCompaction:{kind:'vchat-context-checkpoint', version:1, checkpoint} };
}


function create(mode, fixture) {
    const fault = mode.slice('compact-fallback-'.length);
    const failureStatus = Number(fault);
    const isSummary = row => [fixture.summaryModel, fallbackModel].includes(row.model);
    const summaries = service => service.calls.filter(isSummary);
    const publication = service => service.requests.filter(row => /\/compact-(?:prepare|commit|cancel)$/.test(row.route));

    function observe(out) {
        const existing = fixture.observe(out);
        return {
            ...existing,
            seedCount:existing.seedCount + (fault === 'history' ? historyRows.length : 0),
            seed(f, source, ...rest) {
                existing.seed(f, source, ...rest);
                if (fault !== 'history') return;
                for (const message of historyRows) f.store.apply({
                    ...source.topic, msgId:message.id, deviceId:f.actor('C').principal,
                    opId:message.id, baseHash:null, action:'upsert', message,
                    ...(message.contextCompaction && {metadata:envelopeFor(message, 1)}),
                }, {sharedSpace:'sharedAB', metadataPublisher:true});
            },
            observeCompaction: true,
            summaryModels:[fixture.summaryModel, fallbackModel],
            async respond(body, row, res) {
                if (body.model === fixture.summaryModel && failureStatus) {
                    Object.assign(row, { model:body.model, messages:body.messages, fixtureStatus:failureStatus });
                    res.writeHead(failureStatus, {'content-type':'application/json'});
                    res.end(JSON.stringify({error:{message:'synthetic upstream rejection'}}));
                    return true;
                }
                if (body.model === fixture.summaryModel && fault === 'unknown') {
                    Object.assign(row, { model:body.model, messages:body.messages, fixtureFault:'stream-cut' });
                    res.writeHead(200, {'content-type':'text/event-stream'});
                    const delta = {choices:[{index:0,delta:{content:partial},finish_reason:null}]};
                    res.write('data: ' + JSON.stringify(delta) + '\n\n', () => setTimeout(() => res.destroy(), 100));
                    return true;
                }
                if (body.model === fallbackModel) {
                    return existing.respond(body, row, res, fallbackModel);
                }
                return existing.respond(body, row, res);
            },
        };
    }

    async function verifyAttempt({ A, result, service, intents, journal, history, originalJournal, prior,
        compactIpc, waitUntil, evalJs, picture, sha }) {
        const loaded = await A.command('loaded-sources', {
            main:['apps/desktop/modules/services/nativeSync/sharedRuntime.js'],
            renderer:['apps/desktop/modules/chat/contextCompactionService.js','apps/desktop/modules/chat/contextCompactionStream.js'],
        });
        assert.equal(loaded.main.length, 1);
        assert.equal(loaded.renderer.length, 2);
        for (const source of [...loaded.main, ...loaded.renderer]) {
            assert.equal(source.sha256, sha(path.join(result.candidate, source.file)));
        }

        const first = await waitUntil(() => summaries(service)[0], 'the primary summary request reaches the Provider');
        const disposition = await waitUntil(() => compactIpc(A).find(row =>
            /compact-(commit|cancel)$/.test(row.data.channel)), 'the renderer settles the shared attempt');
        const calls = summaries(service);
        const snapshot = {
            fault, loaded, disposition:disposition.data, calls,
            summaryTransport:service.requests.filter(row => row.summaryTransport),
            compactIpc:compactIpc(A), publication:publication(service),
            intentRows:intents().map(({id, state, work_id, message_id, committed_seq}) => ({id, state, work_id, message_id, committed_seq})),
            journalPreserved:JSON.stringify(journal()) === JSON.stringify(originalJournal),
            historyPreserved:JSON.stringify(history()) === JSON.stringify(prior),
            displayed:await evalJs(A, "document.querySelectorAll('.vcp-context-checkpoint').length"),
        };
        result.compactionFallback = snapshot;
        assert.equal(first.model, fixture.summaryModel);
        assert.equal(snapshot.summaryTransport.length, calls.length);
        assert.equal(snapshot.summaryTransport[0].requestId, first.id);

        if (fault === '404') {
            assert.equal(first.fixtureStatus, 404);
            assert.deepEqual(calls.map(row => row.model), [fixture.summaryModel, fallbackModel]);
            assert.notEqual(calls[0].id, calls[1].id);
            assert.deepEqual(calls[0].messages, calls[1].messages);
            assert.equal(disposition.data.channel, 'native-sync:compact-commit');
            assert.deepEqual(snapshot.publication.map(row => row.route.split('/').at(-1)), ['compact-prepare', 'compact-commit']);
            assert.deepEqual(snapshot.intentRows.map(row => row.state), ['committed']);
            assert.equal(snapshot.publication[0].response.id, snapshot.publication[1].body.id);
            assert.equal(snapshot.publication[1].body.message.contextCompaction.checkpoint, fixture.checkpoint);
            assert.equal(snapshot.summaryTransport[0].upstreamStatus, '404');
            assert.equal(snapshot.summaryTransport[1].upstreamStatus, undefined);
            return false;
        }

        assert.equal(calls.length, 1, 'the failure cannot start another summary');
        if (failureStatus) assert.equal(first.fixtureStatus, failureStatus);
        else assert.equal(first.fixtureFault, 'stream-cut');
        assert.equal(disposition.data.channel, 'native-sync:compact-cancel');
        assert.equal(snapshot.historyPreserved, true);
        assert.equal(snapshot.journalPreserved, true);
        assert.equal(snapshot.displayed, 0);
        assert.equal(snapshot.intentRows.length, 1);
        assert.equal(snapshot.intentRows[0].state, 'cancelled');
        assert.equal(snapshot.summaryTransport[0].upstreamStatus, failureStatus ? String(failureStatus) : undefined);
        await picture(A, 'rejected-with-original-history');
        return true;
    }

    async function verifyHistory({ A, result, service, journal, history, originalJournal, prior,
        send, start, stop, select, evalJs, out, intents, works, picture, sha }) {
        await stop('A');
        const reopened = await start('A-reopened', 'A');
        await select(reopened);
        assert.deepEqual(history(), prior, 'open must retain the exact stored records');
        const visible = await evalJs(reopened, "Array.from(document.querySelectorAll('.vcp-context-checkpoint')).map(node => node.closest('[data-message-id]')?.dataset.messageId)");
        const final = await send(reopened, fixture.tail, 1);
        await picture(reopened, 'history-and-next-send');
        const handlerRows = fs.readFileSync(fixture.capturePath(out), 'utf8').trim().split('\n').map(JSON.parse);
        const selector = handlerRows.find(row => row.kind === 'checkpoint-selection' &&
            JSON.stringify(row.beforeIds) === JSON.stringify(prior.map(message => message.id)));
        const handler = handlerRows.find(row => row.kind === 'handler-input');
        const provider = service.calls.find(row => JSON.stringify(row.messages).includes(fixture.tail));
        const latestWork = works().at(-1);
        const loaded = await reopened.command('loaded-sources', {
            main:[], renderer:['apps/desktop/modules/chat/historyWindow/index.mjs'],
        });
        assert.equal(loaded.renderer[0]?.sha256, sha(path.join(result.candidate, loaded.renderer[0].file)));
        result.compactionFallback = { fault, visible, loaded, selector, handler, provider, work:latestWork,
            preservedHistoryIds:final.slice(0, prior.length).map(row => row.id),
            preservedJournal:JSON.stringify(journal().slice(0, originalJournal.length)) === JSON.stringify(originalJournal) };
        assert.deepEqual(final.slice(0, prior.length), prior);
        assert.equal(result.compactionFallback.preservedJournal, true);
        assert.equal(intents().length, 0);
        assert.equal(summaries(service).length, 0);
        assert.equal(latestWork.state, 'completed');
        assert.equal(latestWork.attempts, 1);
        assert.equal(latestWork.request_dispatched, 1);
        assert.equal(handler.workId, latestWork.id);
        assert.deepEqual(selector.afterIds, prior.slice(2).filter(row => row.id !== historyRows[2].id).map(row => row.id));
        for (const request of [handler, provider]) {
            const content = JSON.stringify(request.messages);
            assert.equal(content.split(goodMarker).length - 1, 1);
            assert.ok(content.includes(intervening));
            assert.ok(content.includes(fixture.tail));
            assert.ok(!content.includes(badMarker));
            assert.ok(!content.includes(fixture.priorRows[0].content));
        }
    }

    return { fault, observe, verifyAttempt, verifyHistory, historyRows:fault === 'history' ? historyRows : [], settings:{contextCompactionFallbackModel:fallbackModel} };
}

module.exports = { create };

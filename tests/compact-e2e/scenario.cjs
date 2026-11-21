'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { execFileSync } = require('node:child_process');
const fixture = require('./fixture.cjs');

const quote = JSON.stringify;
const text = row => Array.isArray(row.content)
    ? row.content.filter(part => part.type === 'text').map(part => part.text).join('')
    : row.content;
const checkpointMessage = row => row.contextCompaction?.kind === 'vchat-context-checkpoint';
const checkpointText = row => text(row)?.includes('COMPACT_DESKTOP_CHECKPOINT');

module.exports = async ({ clients: { A, B }, out, result, service, picture, click, evalJs, waitUntil, start, stop, profiles, sha }) => {
    const db = new DatabaseSync(path.join(service.data, 'central.sqlite'), { readOnly:true });
    const descriptor = service.descriptors.A.preSubmit;
    const topicId = service.topics.preSubmit.id;
    const historyPath = path.join(profiles.A, 'UserData', descriptor.itemId, 'topics', descriptor.topicId, 'history.json');
    const history = () => JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    const journal = () => db.prepare('SELECT * FROM journal WHERE topic_id=? ORDER BY seq').all(topicId);
    const intents = () => db.prepare('SELECT * FROM shared_compaction_intents WHERE topic_id=?').all(topicId);
    const works = () => db.prepare('SELECT id, request_id, state, attempts, request_dispatched, user_message_id, reply_message_id FROM mobile_executions WHERE topic_key=? ORDER BY rowid').all(topicId);
    const transcript = client => evalJs(client, "document.querySelector('#chatMessages').innerText");
    const compactIpc = client => client.events.filter(({event,data}) => event === 'ipc-result' && data.channel?.startsWith('native-sync:compact-'));

    async function select(client, target = descriptor) {
        if (!await evalJs(client, "document.querySelector('#tabContentAgents').classList.contains('active')")) {
            await click(client, '.sidebar-tab-button[data-tab="agents"]');
        }
        await click(client, '#agentList > li .agent-name', 'Synthetic shared');
        await waitUntil(async () => (await evalJs(client, 'window.VCPStateChannels.get("conversation.current").get()')).topicId === target.topicId,
            'shared topic selected');
        await waitUntil(async () => {
            try {
                return (await evalJs(client, `window.chatAPI.getNativeDeletionContext(${quote(target)})`))?.kind === 'shared';
            } catch (error) {
                if (!error.message.includes("No handler registered for 'native-sync:directory-context'")) throw error;
                return false;
            }
        }, 'shared ownership');
    }

    async function send(client, content, count) {
        await evalJs(client, `(() => {
            const input = document.querySelector('#messageInput');
            input.focus();
            input.value = ${quote(content)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await click(client, '#sendMessageBtn');
        await waitUntil(() => works().length === count && works().at(-1)?.state === 'completed', 'native Work completed');
        const saved = await waitUntil(() => {
            const rows = history();
            return rows.at(-2)?.content === content && text(rows.at(-1))?.includes(fixture.reply) && rows;
        }, 'desktop History persisted native reply');
        assert.deepEqual(saved.slice(-2).map(row => row.id), [works().at(-1).user_message_id, works().at(-1).reply_message_id]);
        await waitUntil(async () => (await transcript(client)).includes(content) && (await transcript(client)).includes(fixture.reply), 'next terminal rendered');
        return saved;
    }

    try {
        if (B) {
            const other = service.descriptors.B.preSubmit;
            await select(B, other);
            await waitUntil(async () => (await transcript(B)).includes(fixture.edited), 'B sees edited shared History before going offline');
            assert.equal(await evalJs(B, 'document.querySelectorAll(".vcp-context-checkpoint").length'), 0);
            assert.notEqual(result.A.profileDigest, result.B.profileDigest);
            await picture(B, 'B-before-A-compaction');
            await stop('B');
        }
        await select(A);
        const controlled = result.controlledTurns;
        const [editedTurn, deletedTurn] = controlled;
        const priorIds = [...fixture.priorRows.map(row => row.id), editedTurn.userId, editedTurn.requestId, deletedTurn.userId];
        const prior = await waitUntil(() => JSON.stringify(history().map(row => row.id)) === JSON.stringify(priorIds) && history(),
            'physical History received controlled edits and tombstone');
        assert.deepEqual(prior.map(text), [
            ...fixture.priorRows.map(text), fixture.inputs[0], fixture.edited, fixture.inputs[1],
        ]);
        const originalJournal = journal();
        assert.deepEqual(originalJournal.map(row => [row.msg_id, row.action]), [
            ...fixture.priorRows.map(row => [row.id, 'upsert']),
            [editedTurn.userId, 'upsert'], [editedTurn.requestId, 'upsert'], [editedTurn.requestId, 'upsert'],
            [deletedTurn.userId, 'upsert'], [deletedTurn.requestId, 'upsert'], [deletedTurn.requestId, 'delete'],
        ]);
        assert.deepEqual(intents(), []);
        const callsBefore = service.calls.length;
        assert.equal(callsBefore, 2);
        assert.ok(service.calls.every(row => row.fixtureControlled));
        await waitUntil(async () => (await transcript(A)).includes(fixture.edited), 'visible edit in shared History');
        async function manualCompact(screenshot) {
            const point = await evalJs(A, `(() => {
                const row = document.querySelector('[data-message-id="${editedTurn.requestId}"]');
                row.scrollIntoView({block:'center',behavior:'instant'});
                const rect = row.getBoundingClientRect();
                return {x:Math.round(rect.left + rect.width / 2), y:Math.round(rect.top + rect.height / 2)};
            })()`);
            await A.command('mouse-right', point);
            if (screenshot) await picture(A, screenshot);
            await click(A, '.context-menu-item', '压缩前文');
        }
        await manualCompact('manual-menu');
        const committed = await waitUntil(() => intents().find(row => row.state === 'committed'), 'durable checkpoint commit');
        const compacted = await waitUntil(() => history().find(checkpointMessage) && history(), 'physical checkpoint projection');
        const checkpoint = compacted.find(checkpointMessage);
        assert.deepEqual(compacted.filter(row => row.id !== checkpoint.id), prior);
        if (B) assert.ok(prior.at(-1).timestamp > checkpoint.timestamp, 'fixture clock skew exceeds A checkpoint timestamp');
        else assert.equal(compacted.at(-1).id, checkpoint.id);
        assert.equal(checkpoint.id, committed.message_id);
        assert.equal(checkpoint.contextCompaction.checkpoint, fixture.checkpoint);
        assert.deepEqual(journal().slice(0, -1), originalJournal);
        assert.equal(journal().at(-1).msg_id, checkpoint.id);
        assert.equal(journal().at(-1).seq, committed.committed_seq);
        const source = JSON.parse(committed.proof_json);
        assert.deepEqual(source.canonical.map(row => row.id), prior.map(row => row.id));
        assert.deepEqual(source.native.map(row => row.hash), controlled.map(row => row.proofHash));
        const proofLinks = db.prepare('SELECT request_id, proof_hash, journal_seq FROM shared_compaction_native_links WHERE checkpoint_id=?')
            .all(checkpoint.id);
        assert.equal(proofLinks.length, controlled.length);
        for (const turn of controlled) {
            const link = proofLinks.find(row => row.request_id === turn.requestId);
            assert.equal(link.proof_hash, turn.proofHash);
            assert.equal(link.journal_seq, committed.committed_seq);
        }
        assert.equal(service.calls.length, callsBefore + 1);
        const summaryCall = service.calls[callsBefore];
        assert.equal(summaryCall.model, fixture.summaryModel);
        assert.ok(!summaryCall.messages.some(row => fixture.replies.some(marker => text(row)?.includes(marker))));
        assert.deepEqual(summaryCall.messages.slice(1, -1).map(row => [row.role,text(row)]), prior.map(row => [row.role,text(row)]));
        if (result.mode === 'compact-history-identity') {
            const retry = require('./retry.cjs');
            await retry({ A, result, service, history, journal, intents, compactIpc, compacted, committed, checkpoint,
                manualCompact, picture, waitUntil, profiles, sha });
        } else {
            await waitUntil(() => compactIpc(A).some(row => row.data.channel.endsWith('compact-commit') && row.data.success), 'commit IPC receipt');
        }
        await waitUntil(() => evalJs(A, 'document.querySelector(".vcp-context-checkpoint")?.checkVisibility()'), 'checkpoint card');
        await picture(A, 'checkpoint-committed');
        await stop('A');
        if (B) {
            result.compaction = { checkpoint, checkpointSeq:committed.committed_seq, source, proofLinks,
                summaryCall, compactIpc:compactIpc(A) };
            await require('./cross-device.cjs')({
                out,result,service,picture,click,evalJs,waitUntil,start,stop,profiles,sha,select,db,
                works,journal,intents,prior,compacted,originalJournal,checkpoint,
            });
            return;
        }
        const reopened = await start('A-reopened', 'A');
        await select(reopened);
        assert.equal(result.A.profileDigest, result['A-reopened'].profileDigest);
        assert.deepEqual(history(), compacted);
        await waitUntil(() => evalJs(reopened, 'document.querySelector(".vcp-context-checkpoint")?.checkVisibility()'), 'checkpoint card after reopening');
        await picture(reopened, 'checkpoint-reopened');
        const first = await send(reopened, fixture.tail, 1);
        const final = await send(reopened, fixture.next, 2);
        assert.deepEqual(first.slice(0, compacted.length), compacted);
        assert.deepEqual(final.slice(0, first.length), first);
        assert.deepEqual(final.filter(checkpointMessage).map(row => row.id), [checkpoint.id]);
        assert.deepEqual(journal().slice(0, originalJournal.length), originalJournal);
        assert.deepEqual(journal().slice(originalJournal.length).map(row => row.msg_id), final.slice(prior.length).map(row => row.id));
        assert.equal(intents().length, 1);
        const handler = fs.readFileSync(fixture.capturePath(out), 'utf8').trim().split('\n').map(JSON.parse);
        const modelHandler = handler.filter(row => row.kind === 'handler-input');
        const selectors = handler.filter(row => row.kind === 'checkpoint-selection');
        assert.equal(modelHandler.length, 2);
        assert.equal(service.calls.length, callsBefore + 3);
        const requestViews = [first, final].map((saved, index) => {
            const work = works()[index];
            const native = modelHandler[index];
            const provider = service.calls[callsBefore + index + 1];
            const selector = selectors.find(row => row.beforeIds.at(-1) === work.user_message_id);
            const tail = saved.slice(prior.length + 1, -1);
            assert.deepEqual(selector.afterIds, [checkpoint.id, ...tail.map(row => row.id)]);
            assert.equal(native.workId, work.id);
            assert.equal(work.attempts, 1);
            assert.equal(work.request_dispatched, 1);
            for (const rows of [native.messages, provider.messages]) {
                assert.equal(rows.filter(checkpointText).length, 1);
                const cut = rows.findIndex(checkpointText);
                assert.equal(cut, 1);
                assert.equal(rows[0].role, 'system');
                assert.deepEqual(rows.slice(cut + 1).map(row => [row.role, text(row)]), tail.map(row => [row.role, text(row)]));
                assert.ok(!rows.some(row => [...prior.map(text), ...fixture.replies].some(marker => text(row)?.includes(marker))));
            }
            const sends = service.requests.filter(row => row.route.endsWith('/session-send') && row.body?.requestId === work.request_id);
            assert.equal(sends.length, 1);
            assert.equal(sends[0].response.workId, work.id);
            assert.ok(sends[0].status >= 200 && sends[0].status < 300);
            return { work, receipt:{status:sends[0].status,workId:sends[0].response.workId}, selection:selector,
                handler:{route:native.route,workId:native.workId,messages:native.messages}, provider };
        });
        const loaded = await reopened.command('loaded-sources', {
            main:['apps/desktop/modules/services/nativeSync/queries.js','apps/desktop/modules/services/nativeSync/sharedRuntime.js'],
            renderer:['apps/desktop/modules/renderer/messageContextMenu.js','apps/desktop/modules/chat/contextCompactionService.js'],
        });
        assert.equal(loaded.main.length, 2);
        assert.equal(loaded.renderer.length, 2);
        for (const source of [...loaded.main, ...loaded.renderer]) assert.equal(source.sha256, sha(path.join(result.candidate, source.file)));
        await picture(reopened, 'next-send-complete');
        result.compaction = {
            revision:execFileSync('git', ['rev-parse','HEAD'], {cwd:result.candidate,encoding:'utf8'}).trim(),
            loaded, profileReused:true, compactIpc:compactIpc(A), checkpoint, checkpointSeq:committed.committed_seq, source, proofLinks,
            journalPrefixPreserved:true, historyPrefixPreserved:true,
            journal:journal().map(({seq,msg_id,action,hash}) => ({seq,msg_id,action,hash})),
            history:final.map(({id,role,content}) => ({id,role,content})), summaryCall, requestViews,
        };
    } finally {
        db.close();
    }
};

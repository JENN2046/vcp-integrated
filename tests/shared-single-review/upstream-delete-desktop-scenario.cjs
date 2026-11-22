'use strict';

const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const firstInput = 'SYNTHETIC_502_ORIGINAL_INPUT';
const secondInput = 'SYNTHETIC_502_NEXT_INPUT';
const failureText = 'SYNTHETIC_UPSTREAM_502';
const finalText = 'SYNTHETIC_502_NEXT_FINAL';

const closeout = require('./upstream-closeout-desktop-scenario.cjs');
const {provider} = closeout;
const hooks = {
    ...closeout.hooks,
    observeRequest: (method, route) => method === 'POST' && /\/shared\/(abandon|message)$/.test(route),
};

async function scenario({ A, B, start, stop, result, profiles, service, cert, out, picture, click, evalJs, waitUntil }) {
    const baseline = process.env.NS_UPSTREAM_DELETE_BASELINE === '1';
    const db = new DatabaseSync(path.join(service.data, 'central.sqlite'), { readOnly:true });
    const tools = new DatabaseSync(path.join(out, 'runtime-box/config/tool-call-records.sqlite3'), {readOnly:true});
    const topic = service.topics.preSubmit.id;
    const historyFile = role => {
        const {itemId, topicId} = service.descriptors[role].preSubmit;
        return path.join(profiles[role], 'UserData', itemId, 'topics', topicId, 'history.json');
    };
    const ledgers = {
        toolCalls: tools.prepare('SELECT COUNT(*) AS count FROM tool_call_records'),
        work: db.prepare('SELECT id,request_id,state,attempts,error_code,user_message_id,reply_message_id,pending_operation,native_final_operation,review_resolved FROM mobile_executions WHERE topic_key=? ORDER BY rowid'),
        admissions: db.prepare('SELECT id,principal,state,dispatched,native_terminal,user_seq,reply_seq FROM shared_admissions WHERE topic_id=? ORDER BY rowid'),
        native: db.prepare('SELECT id,state FROM shared_native_requests WHERE admission_id=? ORDER BY ordinal'),
        journal: db.prepare('SELECT seq,msg_id,action,message_json FROM journal WHERE topic_id=? ORDER BY seq'),
    };
    function snapshot() {
        const work = ledgers.work.all(topic);
        return {
            work, toolCalls: ledgers.toolCalls.get().count, admissions: ledgers.admissions.all(topic),
            native: work.map(({id}) => ledgers.native.all(id).map(row => ({...row}))),
            journal: ledgers.journal.all(topic).map(({message_json,...row}) => ({...row,message:JSON.parse(message_json ?? 'null')})),
            history: JSON.parse(fs.readFileSync(historyFile('A'), 'utf8')),
            mirror: JSON.parse(fs.readFileSync(historyFile('B'), 'utf8')),
            messages: db.prepare('SELECT msg_id,deleted,last_seq FROM messages WHERE topic_id=? ORDER BY last_seq').all(topic).map(row => ({...row})),
            provider: service.calls.map(({id,input,stream,httpStatus}) => ({id,input,stream,httpStatus})),
        };
    }
    const selection = "window.VCPStateChannels.get('conversation.current').get()";
    const messages = () => evalJs(A, "document.querySelector('#chatMessages').innerText");
    const send = '#sendMessageBtn';
    async function submit(text) {
        await evalJs(A, `(() => {const input = document.querySelector('#messageInput');
            input.focus(); input.value = ${JSON.stringify(text)};
            input.dispatchEvent(new Event('input', {bubbles:true}));})()`);
        await click(A, send + ':not(:disabled)');
    }
    const evidence = {baseline};
    async function select(client, role) {
        const {itemId, topicId} = service.descriptors[role].preSubmit;
        const read = script => evalJs(client, script);
        if (!await read("document.querySelector('#tabContentAgents').classList.contains('active')")) {
            await click(client, '.sidebar-tab-button[data-tab="agents"]');
        }
        await click(client, '#agentList > li .agent-name', 'Synthetic shared');
        await waitUntil(async () => (await read(selection))?.itemId === itemId, role + ' shared item selected');
        await click(client, '.sidebar-tab-button[data-tab="topics"]');
        if ((await read(selection))?.topicId !== topicId) {
            await click(client, '#topicList [data-topic-id=' + JSON.stringify(topicId) + '] .topic-title-display');
        }
        await waitUntil(async () => (await read(selection))?.topicId === topicId, role + ' shared topic selected');
    }
    try {
        const sources = evidence.loaded = await A.command('loaded-sources', {
            main: ['apps/desktop/modules/services/nativeSync/sharedExecution.js'],
            renderer: [
                'apps/desktop/modules/messageRenderer.js',
                'apps/desktop/modules/renderer/messageContextMenu.js',
                'apps/desktop/modules/chat/chatHistoryMutationAuthority.js',
            ],
        });
        assert.deepEqual([sources.main.length,sources.renderer.length], [1,3]);
        const host = process.env.NS_UPSTREAM_DELETE_DESKTOP || path.resolve(__dirname, '../../apps/desktop');
        for (const {file,sha256} of [...sources.main,...sources.renderer]) {
            assert.equal(sha256, createHash('sha256').update(fs.readFileSync(path.join(host, '../../', file))).digest('hex'), file);
        }
        delete sources.url;
        await select(A, 'A');
        await select(B, 'B');
        assert.deepEqual(snapshot(), {work:[],toolCalls:0,admissions:[],native:[],journal:[],history:[],mirror:[],messages:[],provider:[]});
        await submit(firstInput);
        const before = evidence.before = await waitUntil(() => {
            const state = snapshot();
            return state.work[0]?.state === 'review_required' && state.admissions[0]?.state === 'review_required' &&
                state.history.length === 1 && state.mirror.length === 1 && state;
        }, 'original persisted work after Provider HTTP 502');
        const original = before.work[0];
        const workId = original.id;
        assert.equal(original.attempts, 1);
        assert.equal(before.admissions[0].id, workId);
        assert.equal(before.admissions[0].dispatched, 1);
        assert.equal(before.admissions[0].native_terminal, 0);
        assert.equal(before.admissions[0].reply_seq, null);
        assert.equal(original.reply_message_id, null);
        assert.deepEqual(before.native, [[{id:workId,state:'unknown'}]]);
        assert.deepEqual(before.provider, [{id:workId,input:firstInput,stream:true,httpStatus:502}]);
        assert.deepEqual(before.journal.map(row => [row.msg_id,row.message?.content]), [[original.user_message_id, firstInput]]);
        assert.equal(original.pending_operation, null);
        assert.equal(original.native_final_operation, null);
        assert.deepEqual(before.history.map(row => [row.id,row.content]), [[original.user_message_id, firstInput]]);
        assert.doesNotMatch(await messages(), /SYNTHETIC_UPSTREAM_502/);

        const selector = '#chatMessages .message-item[data-message-id=' + JSON.stringify(original.user_message_id) + ']';
        const visible = client => evalJs(client, `Boolean(document.querySelector(${JSON.stringify(selector)})?.checkVisibility())`);
        const errors = () => A.events.filter(event => event.event === 'renderer-console' &&
            /history mutation failed/i.test(event.data?.message));
        async function confirmDelete(label) {
            const hit = () => evalJs(A, `(() => {
                const item = document.querySelector(${JSON.stringify(selector)});
                if (!item?.checkVisibility()) return false;
                item.scrollIntoView({block:"center", behavior:"instant"});
                const rect = item.getBoundingClientRect();
                const x = Math.round(rect.left + rect.width / 2);
                const y = Math.round(rect.top + rect.height / 2);
                return item.contains(document.elementFromPoint(x,y)) && {x,y};
            })()`);
            await waitUntil(async () => {
                const menu = () => evalJs(A, "Boolean(document.querySelector('#chatContextMenu')?.checkVisibility())");
                if (await menu()) return true;
                const point = await hit();
                if (!point) return false;
                await A.command('mouse-right', point);
                return menu();
            }, 'native message menu opened by right click', 5000);
            await click(A, '#chatContextMenu .context-menu-item', '删除消息');
            await picture(A, label + '-confirmation');
            await click(A, '#confirm-dialog-overlay .confirm-dialog-confirm', '删除');
        }
        await waitUntil(() => visible(B), 'original 502 user row visible to second desktop');
        const initialErrors = errors().length;
        await confirmDelete('A-pending');
        evidence.pendingError = await waitUntil(() => errors()[initialErrors]?.data.message, 'pending deletion refusal', 8000);
        evidence.pendingVisible = { A: await visible(A), B: await visible(B) };
        await picture(A, 'A-pending-after-delete');
        assert.deepEqual(snapshot(), before);
        if (baseline) {
            assert.match(evidence.pendingError, /EXPLICIT_DELETE_REQUIRED/);
            assert.equal(evidence.pendingVisible.A, false);
            assert.equal(evidence.pendingVisible.B, true);
            await stop('A');
            A = await start('A-baseline-reopened', 'A');
            await select(A, 'A');
            await waitUntil(() => visible(A), 'baseline user row returns after restart');
        } else {
            assert.match(evidence.pendingError, /SHARED_TOPIC_BUSY/);
            assert.deepEqual(evidence.pendingVisible, {A:true,B:true});
            evidence.pendingWire = service.requests.find(row => row.route.endsWith('/shared/message'));
            assert.equal(evidence.pendingWire.response.error.code, 'SHARED_TOPIC_BUSY');
            assert.match(await evalJs(A, 'document.body.innerText'), /话题仍有未结清的请求，处理后再删除/);
        }

        const panel = '.native-sync-execution-status';
        const workRow = panel + ' [data-work-id=' + JSON.stringify(workId) + ']';
        const checkbox = workRow + ' input[type=checkbox]';
        const abandon = workRow + ' button';
        await waitUntil(() => evalJs(A, `document.querySelector(${JSON.stringify(panel)})?.checkVisibility()`), 'native execution status panel');
        if (!await evalJs(A, `document.querySelector(${JSON.stringify(panel)}).open`)) await click(A, panel + ' summary');
        evidence.reviewUi = await waitUntil(async () => {
            const status = await evalJs(A, `document.querySelector(${JSON.stringify(workRow)})?.innerText`);
            return status?.includes('需要核对') && status;
        }, 'original Work shows review status');
        assert.equal(await evalJs(A, `document.querySelector(${JSON.stringify(abandon)})?.disabled`), true);
        await picture(A, 'A-original-review-required');
        await click(A, checkbox);
        await click(A, abandon + ':not(:disabled)', '确认放弃并解除暂停');
        const settled = evidence.settled = await waitUntil(() => {
            const state = snapshot();
            return state.admissions[0]?.state === 'abandoned' && state;
        }, 'native abandon persisted for the original Work');
        const closeout = service.requests.find(row => row.route.endsWith('/shared/abandon'));
        assert.equal(closeout.device, 'deviceA');
        assert.equal(closeout.body.admissionId, workId);
        assert.equal(closeout.body.confirm, true);
        assert.equal(settled.work[0].state, 'cancelled');
        assert.equal(settled.work[0].review_resolved, 1);
        assert.equal(settled.work[0].attempts, 1);
        evidence.confirmation = {device:closeout.device, body:closeout.body};
        assert.deepEqual(settled.provider, before.provider);
        assert.deepEqual(settled.journal, before.journal);
        assert.deepEqual(settled.history, before.history);
        assert.deepEqual(settled.native, before.native);
        await waitUntil(() => evalJs(A, `!document.querySelector(${JSON.stringify(checkbox)})?.checkVisibility()`), 'original closeout control hidden');
        await picture(A, 'A-original-closed');

        const settledErrors = errors().length;
        await confirmDelete('A-settled');
        if (baseline) {
            evidence.settledError = await waitUntil(() => errors()[settledErrors]?.data.message, 'baseline settled deletion refusal', 8000);
            assert.match(evidence.settledError, /EXPLICIT_DELETE_REQUIRED/);
            assert.deepEqual(snapshot(), settled);
            assert.equal(await visible(A), false);
            assert.equal(await visible(B), true);
            await picture(A, 'A-settled-after-delete');
            await stop('A-baseline-reopened');
            A = await start('A-reopened', 'A');
            await select(A, 'A');
            await waitUntil(() => visible(A), 'original row restored from durable History');
            await picture(A, 'A-reopened');
            return evidence;
        }
        const deleted = evidence.deleted = await waitUntil(() => {
            const state = snapshot();
            return state.journal.at(-1)?.action === 'delete' && state.history.length === 0 &&
                state.mirror.length === 0 && state;
        }, 'tombstone and removal from both physical Histories');
        assert.deepEqual(deleted.journal.slice(0,-1), settled.journal);
        const tombstone = deleted.journal.at(-1);
        evidence.deleteWire = service.requests.filter(row => row.route.endsWith('/shared/message')).at(-1);
        assert.equal(evidence.deleteWire.device, 'deviceA');
        assert.equal(evidence.deleteWire.status, 200);
        assert.equal(evidence.deleteWire.body.operation.msgId, original.user_message_id);
        assert.equal(evidence.deleteWire.response.seq, tombstone.seq);
        assert.equal(tombstone.msg_id, original.user_message_id);
        assert.deepEqual(deleted.messages, [{msg_id:original.user_message_id,deleted:1,last_seq:tombstone.seq}]);
        for (const ledger of ['work','admissions','native','provider','toolCalls']) assert.deepEqual(deleted[ledger], settled[ledger]);
        await waitUntil(async () => !await visible(A) && !await visible(B), 'both renderers remove the tombstoned row');
        await picture(B, 'B-deleted');
        await stop('A');
        A = await start('A-reopened', 'A');
        assert.equal(result.A.profileDigest, result['A-reopened'].profileDigest);
        await select(A, 'A');
        assert.equal(await visible(A), false);
        assert.deepEqual(snapshot(), deleted);
        await picture(A, 'A-reopened');

        await submit(secondInput);
        const next = evidence.next = await waitUntil(() => {
            const state = snapshot();
            return state.work[1]?.state === 'completed' && state.admissions[1]?.state === 'completed' &&
                state.history.at(-1)?.content === finalText && state.mirror.at(-1)?.content === finalText && state;
        }, 'new Work completes and writes native History in the same topic');
        await waitUntil(async () => (await messages()).includes(finalText), 'successful new assistant response rendered');
        const newWork = next.work[1];
        assert.notEqual(newWork.id, workId);
        assert.equal(newWork.attempts, 1);
        assert.deepEqual(next.work[0], settled.work[0]);
        assert.deepEqual(next.admissions[0], settled.admissions[0]);
        assert.deepEqual(next.native[0], before.native[0]);
        assert.deepEqual(next.native[1], [{id:newWork.id,state:'model_terminal'}]);
        assert.deepEqual(next.journal.map(row => [row.msg_id,row.message?.content]), [
            [original.user_message_id,firstInput],[original.user_message_id, next.journal[1].message?.content],
            [newWork.user_message_id,secondInput],[newWork.reply_message_id,finalText],
        ]);
        assert.deepEqual(next.mirror.map(({id,content}) => [id,content]), next.history.map(({id,content}) => [id,content]));
        assert.deepEqual(next.history.map(row => [row.id,row.content]), next.journal.slice(2).map(row => [row.msg_id,row.message?.content]));
        assert.deepEqual(next.provider, [...before.provider,{id:newWork.id,input:secondInput,stream:true,httpStatus:200}]);
        await picture(A, 'A-next-native-round-completed');

        const originalPost = service.requests.find(row => row.route.endsWith('/shared/session-send') &&
            row.body?.message?.id === original.user_message_id);
        assert.equal(originalPost.body.requestId, original.request_id);
        const {spaceId} = JSON.parse(fs.readFileSync(path.join(profiles.A,'.native-sync/connection.json')));
        const replay = evidence.replay = await replayOriginal({ service, cert, originalPost, spaceId });
        assert.equal(replay.status, 200);
        assert.equal(replay.body.workId, workId);
        assert.equal(replay.body.replayed, true);
        assert.equal(replay.body.state, 'abandoned');
        assert.equal(replay.body.execution.state, 'cancelled');
        assert.equal(replay.body.execution.reviewResolved, true);
        assert.deepEqual(snapshot(), next);
        return evidence;
    } finally {
        fs.writeFileSync(path.join(out,'desktop-delete.json'), JSON.stringify(evidence,null,2) + '\n');
        tools.close();
        db.close();
    }
}

function replayOriginal({ service, cert, originalPost, spaceId }) {
    const body = JSON.stringify(originalPost.body);
    return new Promise((resolve,reject) => {
        const req = https.request(service.origin + originalPost.route, {
            method:'POST', ca:fs.readFileSync(cert), headers:{
                authorization:'Bearer synthetic-only', 'content-type':'application/json', 'content-length':Buffer.byteLength(body),
                'x-nativesync-space':spaceId, 'x-nativesync-protocol':'2', 'x-nativesync-device':'deviceA',
                'x-nativesync-source':'sourceA', 'x-nativesync-capabilities':originalPost.capabilities,
            },
        }, async response => {
            try {
                const chunks = [];
                for await (const chunk of response) chunks.push(chunk);
                resolve({status:response.statusCode, body:JSON.parse(Buffer.concat(chunks))});
            } catch (error) { reject(error); }
        });
        req.on('error', reject);
        req.end(body);
    });
}

module.exports = {provider,hooks,scenario};

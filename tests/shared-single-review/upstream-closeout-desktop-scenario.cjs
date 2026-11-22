'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const firstInput = 'SYNTHETIC_502_ORIGINAL_INPUT';
const secondInput = 'SYNTHETIC_502_NEXT_INPUT';
const failureText = 'SYNTHETIC_UPSTREAM_502';
const finalText = 'SYNTHETIC_502_NEXT_FINAL';

const provider = {
    respond(body, row, response) {
        const content = body.messages.findLast(message => message.role === 'user')?.content;
        const input = Array.isArray(content)
            ? content.filter(part => part.type === 'text').map(part => part.text).join('') : content;
        assert.equal(body.stream, true);
        assert.ok([firstInput, secondInput].includes(input), JSON.stringify(input));
        row.input = input;
        row.httpStatus = input === firstInput ? 502 : 200;
        if (input === firstInput) {
            response.writeHead(502, {'content-type':'application/json'})
                .end(JSON.stringify({error:{message:failureText}}));
        } else {
            response.writeHead(200, {'content-type':'text/event-stream'});
            const chunk = (delta, finish_reason) => 'data: ' + JSON.stringify({
                id: 'synthetic-success', model:'synthetic', choices:[{index:0, delta, finish_reason}],
            }) + '\n\n';
            response.write(chunk({role:'assistant',content:finalText}, null));
            response.end(chunk({}, 'stop') + 'data: [DONE]\n\n');
        }
        return true;
    },
};
const hooks = {
    agentConfig:{streamOutput:true},
    dropResponse: () => false,
    observeRequest: (method, route) => method === 'POST' && route.endsWith('/shared/abandon'),
};

async function scenario({ A, profiles, service, cert, out, picture, click, evalJs, waitUntil }) {
    const baseline = Boolean(process.env.NS_UPSTREAM_CLOSEOUT_BASELINE);
    const db = new DatabaseSync(path.join(service.data, 'central.sqlite'), { readOnly:true });
    const topic = service.topics.preSubmit.id;
    const { itemId, topicId } = service.descriptors.A.preSubmit;
    const historyFile = path.join(profiles.A,'UserData',itemId,'topics',topicId,'history.json');
    const ledgers = {
        work: db.prepare('SELECT id,request_id,state,attempts,error_code,user_message_id,reply_message_id,pending_operation,native_final_operation,review_resolved FROM mobile_executions WHERE topic_key=? ORDER BY rowid'),
        admissions: db.prepare('SELECT id,principal,state,dispatched,native_terminal,user_seq,reply_seq FROM shared_admissions WHERE topic_id=? ORDER BY rowid'),
        native: db.prepare('SELECT id,state FROM shared_native_requests WHERE admission_id=? ORDER BY ordinal'),
        journal: db.prepare('SELECT seq,msg_id,action,message_json FROM journal WHERE topic_id=? ORDER BY seq'),
    };
    function snapshot() {
        const work = ledgers.work.all(topic);
        return {
            work, admissions: ledgers.admissions.all(topic),
            native: work.map(({id}) => ledgers.native.all(id).map(row => ({...row}))),
            journal: ledgers.journal.all(topic).map(({message_json,...row}) => ({...row,message:JSON.parse(message_json)})),
            history: JSON.parse(fs.readFileSync(historyFile, 'utf8')),
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
    const evidence = {};
    try {
        if (!await evalJs(A, "document.querySelector('#tabContentAgents').classList.contains('active')")) {
            await click(A, '.sidebar-tab-button[data-tab="agents"]');
        }
        await click(A, '#agentList > li .agent-name', 'Synthetic shared');
        await waitUntil(async () => (await evalJs(A, selection))?.itemId === itemId, 'original native sidebar item selected');
        await click(A, '.sidebar-tab-button[data-tab="topics"]');
        if ((await evalJs(A, selection))?.topicId !== topicId) {
            await click(A, '#topicList [data-topic-id=' + JSON.stringify(topicId) + '] .topic-title-display');
        }
        await waitUntil(async () => (await evalJs(A, selection))?.topicId === topicId, 'original native topic selected');
        assert.deepEqual(snapshot(), {work:[],admissions:[],native:[],journal:[],history:[],provider:[]});
        await submit(firstInput);
        const before = evidence.before = await waitUntil(() => {
            const state = snapshot();
            if (baseline) return state.work[0]?.state === 'publishing' && state.work[0].pending_operation && state;
            return state.work[0]?.state === 'review_required' && state.admissions[0]?.state === 'review_required' &&
                state.history.length === 1 && state;
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
        assert.deepEqual(before.journal.map(row => [row.msg_id,row.message.content]), [[original.user_message_id, firstInput]]);
        if (baseline) {
            assert.match(JSON.parse(original.pending_operation).message.content, /502.*SYNTHETIC_UPSTREAM_502/);
            await waitUntil(async () => (await messages()).includes(failureText), 'baseline displays upstream error as an assistant response');
            evidence.stillPublishing = snapshot();
            assert.deepEqual(evidence.stillPublishing.work, before.work);
            assert.ok(evidence.stillPublishing.history.every(row => row.role === 'user'));
            await picture(A, 'A-baseline-publishing');
            return evidence;
        }
        assert.equal(original.pending_operation, null);
        assert.equal(original.native_final_operation, null);
        assert.deepEqual(before.history.map(row => [row.id,row.content]), [[original.user_message_id, firstInput]]);
        assert.doesNotMatch(await messages(), /SYNTHETIC_UPSTREAM_502/);

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

        await submit(secondInput);
        const next = evidence.next = await waitUntil(() => {
            const state = snapshot();
            return state.work[1]?.state === 'completed' && state.admissions[1]?.state === 'completed' &&
                state.history.at(-1)?.content === finalText && state;
        }, 'new Work completes and writes native History in the same topic');
        await waitUntil(async () => (await messages()).includes(finalText), 'successful new assistant response rendered');
        const newWork = next.work[1];
        assert.notEqual(newWork.id, workId);
        assert.equal(newWork.attempts, 1);
        assert.deepEqual(next.work[0], settled.work[0]);
        assert.deepEqual(next.admissions[0], settled.admissions[0]);
        assert.deepEqual(next.native[0], before.native[0]);
        assert.deepEqual(next.native[1], [{id:newWork.id,state:'model_terminal'}]);
        assert.deepEqual(next.journal.map(row => [row.msg_id,row.message.content]), [
            [original.user_message_id,firstInput],[newWork.user_message_id,secondInput],[newWork.reply_message_id,finalText],
        ]);
        assert.deepEqual(next.history.map(row => [row.id,row.content]), next.journal.map(row => [row.msg_id,row.message.content]));
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
        fs.writeFileSync(path.join(out,'desktop-closeout.json'), JSON.stringify(evidence,null,2) + '\n');
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

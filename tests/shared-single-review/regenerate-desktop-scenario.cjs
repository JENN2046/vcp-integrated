'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const firstInput = 'SYNTHETIC_REGENERATE_ORIGINAL_INPUT';
const laterInput = 'SYNTHETIC_REGENERATE_LATER_INPUT';
const originalText = 'SYNTHETIC_REGENERATE_ORIGINAL_REPLY';
const laterText = 'SYNTHETIC_REGENERATE_LATER_REPLY';
const regeneratedText = 'SYNTHETIC_REGENERATE_NEW_REPLY';
const failureText = 'SYNTHETIC_REGENERATE_FAILED_PARTIAL';
const mode = process.env.NS_REGENERATE_MODE || 'sse';
assert.ok(['sse', 'json', 'local'].includes(mode));
let originalCalls = 0;
let releaseReply;
const replyGate = new Promise(resolve => { releaseReply = resolve; });

const provider = {
    async respond(body, row, response) {
        const content = body.messages.findLast(message => message.role === 'user')?.content;
        const input = Array.isArray(content)
            ? content.filter(part => part.type === 'text').map(part => part.text).join('') : content;
        assert.equal(Boolean(body.stream), mode === 'sse');
        assert.ok([firstInput, laterInput].includes(input), JSON.stringify(input));
        row.input = input;
        row.context = body.messages.filter(message => ['user', 'assistant'].includes(message.role))
            .map(({role, content}) => ({role, content}));
        if (input === firstInput) originalCalls += 1;
        const failure = originalCalls >= 3 && input === firstInput;
        const text = input === laterInput ? laterText : originalCalls === 1 ? originalText : regeneratedText;
        if (failure && mode !== 'sse') {
            row.httpStatus = 502;
            response.writeHead(502, {'content-type':'application/json'})
                .end(JSON.stringify({error:{message:failureText}}));
            return true;
        }
        row.httpStatus = 200;
        if (!body.stream) {
            if (text === regeneratedText && mode !== 'local') await replyGate;
            response.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify({
                id: 'synthetic-regenerate', model:'synthetic',
                choices:[{index:0,message:{role:'assistant',content:text},finish_reason:'stop'}],
            }));
            return true;
        }
        response.writeHead(200, {'content-type':'text/event-stream'});
        const chunk = (delta, finish_reason) => 'data: ' + JSON.stringify({
            id: 'synthetic-regenerate', model:'synthetic', choices:[{index:0, delta, finish_reason}],
        }) + '\n\n';
        response.write(chunk({role:'assistant',content:failure ? failureText : text}, null));
        if (failure) {
            response.end();
            return true;
        }
        if (text === regeneratedText) await replyGate;
        response.end(chunk({}, 'stop') + 'data: [DONE]\n\n');
        return true;
    },
};
const hooks = {
    agentConfig:{streamOutput:mode === 'sse'},
    dropResponse: () => false,
    observeRequest: (method, route) => method === 'POST' && /\/shared\/(message|regenerate|session-regenerate)$/.test(route),
};

async function scenario({ A, profiles, service, cert, out, picture, click, evalJs, waitUntil, start, stop }) {
    const baseline = process.env.NS_REGENERATE_BASELINE === '1';
    const db = new DatabaseSync(path.join(service.data, 'central.sqlite'), { readOnly:true });
    const topic = service.topics.preSubmit.id;
    const { itemId, topicId } = mode === 'local'
        ? { itemId:'local-agent', topicId:'local-topic' } : service.descriptors.A.preSubmit;
    const historyFile = path.join(profiles.A,'UserData',itemId,'topics',topicId,'history.json');
    const ledgers = {
        work: db.prepare('SELECT id,request_id,state,attempts,error_code,user_message_id,reply_message_id,pending_operation,native_final_operation,review_resolved FROM mobile_executions WHERE topic_key=? ORDER BY rowid'),
        admissions: db.prepare('SELECT id,state,dispatched,native_terminal,user_seq,reply_seq FROM shared_admissions WHERE topic_id=? ORDER BY rowid'),
        native: db.prepare('SELECT id,state FROM shared_native_requests WHERE admission_id=? ORDER BY ordinal'),
        journal: db.prepare('SELECT seq,msg_id,action,message_json FROM journal WHERE topic_id=? ORDER BY seq'),
    };
    function snapshot() {
        const admissions = ledgers.admissions.all(topic);
        return {
            work: ledgers.work.all(topic), admissions,
            native: admissions.map(({id}) => ledgers.native.all(id).map(row => ({...row}))),
            journal: ledgers.journal.all(topic).map(({message_json,...row}) => ({...row,message:JSON.parse(message_json)})),
            history: JSON.parse(fs.readFileSync(historyFile, 'utf8')),
            provider: service.calls.map(({id,input,stream,httpStatus,context}) => ({id,input,stream,httpStatus,context})),
            requests: service.requests.map(({route,status,body,response,capabilities}) => ({route,status,body,response,capabilities})),
        };
    }
    const selection = "window.VCPStateChannels.get('conversation.current').get()";
    const messages = () => evalJs(A, "document.querySelector('#chatMessages').innerText");
    async function submit(text) {
        await evalJs(A, `(() => {const input = document.querySelector('#messageInput');
            input.focus(); input.value = ${JSON.stringify(text)};
            input.dispatchEvent(new Event('input', {bubbles:true}));})()`);
        await click(A, '#sendMessageBtn:not(:disabled)');
    }
    async function openMenu(id) {
        const selector = '#chatMessages .message-item[data-message-id=' + JSON.stringify(id) + '] .md-content';
        const hit = () => evalJs(A, `(() => {
            const item = document.querySelector(${JSON.stringify(selector)});
            if (!item?.checkVisibility()) return false;
            item.scrollIntoView({block:"center", behavior:"instant"});
            const rect = item.getBoundingClientRect();
            const x = Math.round(rect.left + rect.width / 2);
            const y = Math.round(rect.top + rect.height / 2);
            return item.contains(document.elementFromPoint(x,y)) && {x,y};
        })()`);
        const visible = () => evalJs(A, "Boolean(document.querySelector('#chatContextMenu .regenerate-text')?.checkVisibility())");
        await waitUntil(async () => {
            if (await visible()) return true;
            const point = await hit();
            if (!point) return false;
            await A.command('mouse-right', point);
            return visible();
        }, 'native regenerate menu item', 8000);
    }
    const menu = '#chatContextMenu .regenerate-text';
    const evidence = { baseline, mode, rendererErrors: [] };
    async function selectTopic() {
        if (!await evalJs(A, "document.querySelector('#tabContentAgents').classList.contains('active')")) {
            await click(A, '.sidebar-tab-button[data-tab="agents"]');
        }
        await click(A, '#agentList > li .agent-name', mode === 'local' ? 'Synthetic local' : 'Synthetic shared');
        await waitUntil(async () => (await evalJs(A, selection))?.itemId === itemId, 'synthetic native sidebar item selected');
        await click(A, '.sidebar-tab-button[data-tab="topics"]');
        if ((await evalJs(A, selection))?.topicId !== topicId) {
            await click(A, '#topicList [data-topic-id=' + JSON.stringify(topicId) + '] .topic-title-display');
        }
        await waitUntil(async () => (await evalJs(A, selection))?.topicId === topicId, 'original native topic selected');
    }
    try {
        await selectTopic();
        await submit(firstInput);
        const originalSaved = await waitUntil(() => {
            const state = snapshot();
            return state.history.some(row => row.content === originalText) && state;
        }, 'original terminal reply');
        if (mode === 'local') {
            evidence.before = originalSaved;
            await openMenu(originalSaved.history.find(row => row.content === originalText).id);
            await click(A, menu, '重新回复');
            evidence.localUi = await waitUntil(async () => {
                const text = await messages();
                return text.includes(regeneratedText) && text;
            }, 'ordinary local regenerate menu still opens a native reply');
            const after = evidence.after = await waitUntil(() => {
                const state = snapshot();
                return state.history.some(row => row.content === regeneratedText) && state;
            }, 'local regenerate persists in the original History');
            assert.deepEqual(after.history.map(row => row.content), [firstInput, regeneratedText]);
            assert.equal(after.provider.length, 2);
            assert.equal(after.provider[1].input, firstInput);
            assert.equal(after.admissions.length, 0);
            assert.deepEqual(after.journal, []);
            await picture(A, 'A-local-regenerate');
            return evidence;
        }
        await submit(laterInput);
        const before = evidence.before = await waitUntil(() => {
            const state = snapshot();
            return state.history.some(row => row.content === laterText) && state;
        }, 'later terminal reply');
        // Reopen the terminal History to exercise the persistent reply after the live stream has ended.
        await stop('A');
        A = await start('A-reopened', 'A');
        await selectTopic();
        await waitUntil(async () => (await messages()).includes(laterText), 'both saved replies displayed after reopening');
        const original = before.history.find(row => row.content === originalText);
        assert.equal(before.provider.length, 2);
        assert.equal(before.history.length, 4);
        await openMenu(original.id);
        await picture(A, 'A-regenerate-menu');
        await click(A, menu, '重新回复');
        if (baseline) {
            evidence.error = await waitUntil(() => fs.readFileSync(path.join(out, 'A-reopened.log'), 'utf8')
                .match(/VCP请求错误 \(catch block\): Error: SHARED_NATIVE_ADMISSION_REQUIRED[^\n]*\n[^\n]*contracts\.generated\.cjs[^\n]*\n[^\n]*sharedExecution\.js[^\n]*/)?.[0],
                'user-reported native admission error', 10000);
            evidence.uiAfter = await waitUntil(async () => {
                const text = await messages();
                return text.includes(firstInput) && !text.includes(originalText) && text;
            }, 'baseline drops the targeted and later bubbles from view', 10000);
            evidence.after = snapshot();
            assert.deepEqual(evidence.after.journal, before.journal);
            assert.deepEqual(evidence.after.provider, before.provider);
            assert.deepEqual(evidence.after.history, before.history);
            assert.deepEqual(evidence.after.admissions, before.admissions);
            assert.doesNotMatch(evidence.uiAfter, new RegExp(originalText + '|' + laterInput + '|' + laterText));
            await picture(A, 'A-baseline-regenerate-error');
            return evidence;
        }
        const pending = evidence.pending = await waitUntil(() => {
            const state = snapshot();
            return state.provider.length === 3 && state;
        }, 'regeneration uses one admitted Provider call');
        assert.equal(pending.admissions.length, 3);
        assert.notEqual(pending.provider[2].id, before.provider[0].id);
        assert.equal(pending.provider[2].input, firstInput);
        assert.equal(pending.provider[2].stream, mode === 'sse');
        assert.doesNotMatch(JSON.stringify(pending.provider[2].context), new RegExp([originalText, laterInput, laterText].join('|')));
        assert.deepEqual(pending.history, before.history);
        assert.deepEqual(pending.journal, before.journal);
        assert.match(await messages(), new RegExp(originalText));
        await openMenu(original.id);
        await click(A, menu, '重新回复');
        evidence.duplicateUi = await waitUntil(async () => {
            const text = await evalJs(A, 'document.body.innerText');
            return text.match(/此话题的回复正在重新生成/)?.[0];
        }, 'duplicate click refused while the same topic is regenerating');
        assert.equal(snapshot().provider.length, 3);
        await picture(A, 'A-candidate-preserved-during-regenerate');
        releaseReply();

        const completed = evidence.completed = await waitUntil(() => {
            const state = snapshot();
            return state.history.some(row => row.content === regeneratedText) && state;
        }, 'replacement projected after Provider terminal');
        assert.equal(completed.history.length, 4);
        assert.deepEqual(completed.history.map(row => row.id), before.history.map(row => row.id));
        assert.deepEqual(completed.history.filter(row => row.id !== original.id), before.history.filter(row => row.id !== original.id));
        assert.equal(completed.history[1].content, regeneratedText);
        assert.deepEqual(completed.journal.slice(0, -1), before.journal);
        assert.deepEqual(completed.journal.slice(-1).map(({msg_id,action,message}) => [msg_id,action,message.content]),
            [[original.id,'upsert',regeneratedText]]);
        assert.equal(completed.provider.length, 3);
        assert.equal(completed.admissions.length, 3);
        assert.equal(completed.admissions[2].state, 'completed');
        const regenerationAdmissions = completed.requests.filter(row => row.route.endsWith('/shared/admit') && row.body?.kind === 'regenerate');
        assert.equal(regenerationAdmissions.length, 1);
        assert.equal(regenerationAdmissions[0].body.targetId, original.id);
        assert.equal(regenerationAdmissions[0].body.targetSeq, before.journal[1].seq);
        assert.match(regenerationAdmissions[0].body.targetHash, /^[a-f0-9]{64}$/);
        await waitUntil(async () => (await messages()).includes(regeneratedText), 'updated assistant bubble displayed');
        assert.match(await messages(), new RegExp(laterText));
        assert.doesNotMatch(await messages(), new RegExp(originalText));
        await picture(A, 'A-candidate-regenerate-completed');

        const completion = completed.requests.find(row => row.route.endsWith('/shared/complete')
            && row.body.admissionId === completed.admissions[2].id);
        assert.equal(completion.status, 200);
        assert.equal(completion.response.receipt.seq, completed.journal.at(-1).seq);
        const {spaceId} = JSON.parse(fs.readFileSync(path.join(profiles.A, '.native-sync/connection.json')));
        const replay = evidence.replay = await replayRequest(service.origin, cert, spaceId, completion);
        assert.equal(replay.status, 200);
        assert.equal(replay.body.replayed, true);
        assert.equal(replay.body.request.id, completed.admissions[2].id);
        assert.equal(replay.body.receipt.seq, completion.response.receipt.seq);
        const {requests: _replayRequests, ...afterReplay} = snapshot();
        const {requests: _originalRequests, ...beforeReplay} = completed;
        assert.deepEqual(afterReplay, beforeReplay);

        await openMenu(original.id);
        await click(A, menu, '重新回复');
        const failed = evidence.failed = await waitUntil(() => {
            const state = snapshot();
            return state.provider.length === 4 && state.admissions[3]?.state === 'review_required' && state;
        }, 'failed regeneration preserved for review');
        assert.equal(failed.provider[3].httpStatus, mode === 'sse' ? 200 : 502);
        assert.equal(failed.provider[3].input, firstInput);
        assert.equal(failed.admissions[3].native_terminal, 0);
        assert.equal(failed.admissions[3].reply_seq, null);
        assert.deepEqual(failed.native[3], [{id:failed.provider[3].id,state:'unknown'}]);
        assert.deepEqual(failed.history, completed.history);
        assert.deepEqual(failed.journal, completed.journal);
        assert.match(await messages(), new RegExp(regeneratedText));
        assert.match(await messages(), new RegExp(laterText));
        assert.doesNotMatch(await messages(), new RegExp(failureText));
        evidence.failureUi = await waitUntil(async () => {
            const text = await evalJs(A, 'document.body.innerText');
            return text.match(/结果需要核对[^\n]*/)?.[0];
        }, 'failed regenerate shown in the desktop UI');
        await picture(A, 'A-candidate-failed-preserved');
        return evidence;
    } finally {
        releaseReply();
        evidence.rendererErrors = A.events.filter(event => event.event === 'renderer-console').map(event => event.data.message);
        evidence.final = snapshot();
        fs.writeFileSync(path.join(out,'desktop-regenerate.json'), JSON.stringify(evidence,null,2) + '\n');
        db.close();
    }
}

function replayRequest(origin, cert, spaceId, request) {
    const payload = JSON.stringify(request.body);
    return new Promise((resolve, reject) => {
        const req = https.request(origin + request.route, {
            method:'POST', ca:fs.readFileSync(cert), headers:{
                authorization:'Bearer synthetic-only', 'content-type':'application/json', 'content-length':Buffer.byteLength(payload),
                'x-nativesync-space':spaceId, 'x-nativesync-protocol':'2',
                'x-nativesync-device':'deviceA', 'x-nativesync-source':'sourceA', 'x-nativesync-capabilities':request.capabilities,
            },
        }, async response => {
            try {
                const chunks = [];
                for await (const chunk of response) chunks.push(chunk);
                resolve({status:response.statusCode, body:JSON.parse(Buffer.concat(chunks))});
            } catch (error) { reject(error); }
        });
        req.on('error', reject);
        req.end(payload);
    });
}

module.exports = {provider,hooks,scenario};

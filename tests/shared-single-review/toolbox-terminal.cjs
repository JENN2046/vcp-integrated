'use strict';

// Kill the real ToolBox process at named ordinary shared worker durability boundaries.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function instrument() {
    const Module = require('node:module');
    const load = Module._load;
    const marker = process.env.NS_AUDIT_TERMINAL_MARKER;
    const mode = process.env.NS_AUDIT_TERMINAL_CUT;
    const wrapped = new WeakSet();
    const stream = process.env.NS_AUDIT_TERMINAL_STREAM === '1';
    function cut(requestId, content, terminal) {
        const loaded = {};
        for (const file of ['modules/chatCompletionHandler.js', stream ? 'modules/handlers/streamHandler.js' : 'modules/handlers/nonStreamHandler.js', 'Plugin/NativeSync/mobile/nativeResponse.js',
            'modules/requestExecutionContext.js', 'Plugin/NativeSync/mobile/execution.js', 'Plugin/NativeSync/mobile/sharedSingle.js',
            ...(process.env.NS_AUDIT_TERMINAL_ENTRY === 'desktop-session-send' ? ['Plugin/NativeSync/sync/sharedSession.js'] : []),
            'Plugin/NativeSync/sync/sharedNative.js', 'Plugin/NativeSync/sync/sharedSpace.js']) {
            const absolute = path.join(process.cwd(), file);
            assert.ok(require.cache[absolute]?.loaded, file);
            loaded['apps/server/'+file] = createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
        }
        fs.writeFileSync(marker, JSON.stringify({ requestId, ...terminal, loaded, contentHash: createHash('sha256').update(content).digest('hex') }), { flag: 'wx' });
        process.kill(process.pid, 'SIGKILL');
    }
    Module._load = function (name, parent, ...rest) {
        const api = load.call(this, name, parent, ...rest);
        if (fs.existsSync(marker) || !api || typeof api !== 'object' || wrapped.has(api)) return api;
        if (mode === 'dispatch-only' && api.finalReplyPublisher) {
            wrapped.add(api);
            const assertDispatch = api.assertDispatch;
            api.assertDispatch = (...args) => {
                const dispatched = assertDispatch(...args);
                const workId = api.currentWork();
                if (workId) cut(workId, '', {dispatchedWithoutProviderResponse:true});
                return dispatched;
            };
        } else if (['before-final-seal','after-final-seal'].includes(mode) && api.finalReplyPublisher) {
            wrapped.add(api);
            const publisher = api.finalReplyPublisher;
            api.finalReplyPublisher = () => {
                const publish = publisher();
                if (!publish) return publish;
                const observed = value => {
                    if (mode === 'after-final-seal') publish(value);
                    cut(api.currentWork(), value.content, {handlerFinishReason:value.finishReason});
                };
                return Object.assign(observed, publish);
            };
        } else if (['before-intent', 'corrupt-final'].includes(mode) && name === './nativeResponse' && parent?.filename.endsWith('/mobile/execution.js')) {
            wrapped.add(api);
            const nativeResponse = api.nativeResponse;
            api.nativeResponse = async function (args) {
                const received = await nativeResponse(args);
                assert.equal(received.finishReason, 'stop');
                cut(args.body.requestId, received.content, {handlerFinishReason:received.finishReason});
                return received;
            };
        } else if (mode === 'after-intent' && api.ConversationExecution?.prototype.completeIntent) {
            wrapped.add(api);
            const complete = api.ConversationExecution.prototype.completeIntent;
            api.ConversationExecution.prototype.completeIntent = function (row) {
                if (row.kind === 'shared_session' && row.state === 'publishing' && row.pending_operation) {
                    const op = JSON.parse(row.pending_operation);
                    cut(row.id, op.message.content, {intentTerminalState:row.terminal_state});
                }
                return complete.call(this, row);
            };
        }
        return api;
    };
}

async function run(mode, stream, entry = 'desktop-session-send') {
    const { execFileSync } = require('node:child_process');
    const { DatabaseSync } = require('node:sqlite');
    const https = require('node:https');
    const { setTimeout: pause } = require('node:timers/promises');
    const { start } = require('../integration/service.cjs');
    const counter = require('../ordinary-tools/fixture.cjs');
    const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ordinary-terminal-'));
    const key = path.join(out, 'key.pem'), cert = path.join(out, 'cert.pem'), marker = path.join(out, 'cut.json');
    execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=isolated-review',
        '-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',cert],{stdio:'ignore'});
    async function until(read, label, ms = 15000) {
        const end = Date.now() + ms;
        do { const value = await read(); if (value) return value; await pause(40); } while (Date.now() < end);
        throw Error(label);
    }
    let db, service;
    try {
        const ordinaryTools = stream ? {
            ...counter,
            reply(body, row, previousCalls) {
                assert.equal(body.stream, true);
                row.streamContent = counter.reply({...body, stream: false}, row, previousCalls);
            },
        } : counter;
        const groupRelay = stream ? {
            respond(_body, row, response) {
                response.writeHead(200, {'content-type':'text/event-stream'});
                for (const delta of [
                    {delta:{role:'assistant', content:row.streamContent}, finish_reason:null},
                    {delta:{}, finish_reason:'stop'},
                ]) response.write('data: '+JSON.stringify({id:'fixture-stream',object:'chat.completion.chunk',
                    created:1,model:'synthetic',choices:[{index:0,...delta}]})+'\n\n');
                response.end('data: [DONE]\n\n');
                return true;
            },
        } : undefined;
        service = await start({out, cert, key, candidate:path.resolve(__dirname, '../..'), ordinaryTools, groupRelay, waitUntil:until, trace() {},
            toolHandoff:{agentConfig:{streamOutput:stream},observeRequest:()=>false,dropResponse:()=>false,
                env:{NODE_OPTIONS:'--require='+__filename, NS_AUDIT_TERMINAL_MARKER:marker, NS_AUDIT_TERMINAL_CUT:mode, NS_AUDIT_TERMINAL_STREAM:stream?'1':'0', NS_AUDIT_TERMINAL_ENTRY:entry}}});
        db = new DatabaseSync(path.join(service.data, 'central.sqlite'), {readOnly:true});
        const scope = {sharedSpaceId:'sharedAB', sharedId:service.topics.preSubmit.id};
        const {spaceId} = JSON.parse(fs.readFileSync(path.join(out, 'seed/desktopA/.native-sync/connection.json')));
        async function api(route, body) {
            const response = await fetch(service.wsOrigin + '/api/v1/sync/shared/' + route, {method:body?'POST':'GET',
                headers:{authorization:'Bearer synthetic-only','content-type':'application/json','x-nativesync-space':spaceId,
                    'x-nativesync-protocol':'2','x-nativesync-device':'deviceA','x-nativesync-source':'sourceA',
                    'x-nativesync-capabilities':'shared-space-v1,shared-context-v1,shared-session-v1'},body:body && JSON.stringify(body)});
            const value = await response.json();
            assert.equal(response.status,200,JSON.stringify(value));
            return value;
        }
        const context = await api('context?'+new URLSearchParams(scope));
        const requestId = 'ordinary-review-'+entry+'-'+mode+(stream?'-sse':'-json');
        const body = {...scope,requestId,expectedHead:context.head,configHash:context.hash,
            message:{id:requestId,role:'user',content:'ORDINARY_TOOL_LOCAL',timestamp:1}};
        let mobileCookie;
        const mobile = entry === 'mobile-messages';
        function httpsPost(route, value, headers, status) {
            return new Promise((resolve, reject) => {
                const request = https.request(service.origin + route, {
                    method: 'POST', ca: fs.readFileSync(cert),
                    headers: {origin:service.origin, 'content-type':'application/json', ...headers},
                }, async response => {
                    try {
                        const chunks = [];
                        for await (const chunk of response) chunks.push(chunk);
                        const data = JSON.parse(Buffer.concat(chunks));
                        assert.equal(response.statusCode, status, route+' '+JSON.stringify(data));
                        resolve({headers:response.headers, data});
                    } catch (error) { reject(error); }
                });
                request.on('error', reject);
                request.setTimeout(4500, () => request.destroy(Error('Timed out requesting '+route)));
                request.end(JSON.stringify(value));
            });
        }
        if (mobile) {
            const {data:{pairingCode}} = await httpsPost('/api/plugins/NativeSync/mobile/pairing',
                {scopeMode:'shared', sharedSpaceId:'sharedAB', permissions:['read','execute']},
                {authorization:'Bearer synthetic-only'}, 200);
            const paired = await httpsPost('/mobile/api/pair', {code:pairingCode}, {}, 200);
            mobileCookie = paired.headers['set-cookie'][0].split(';')[0];
        }
        const send = async () => {
            if (!mobile) return api('session-send', body);
            const {data} = await httpsPost('/mobile/api/conversations/'+scope.sharedId+'/messages',
                {requestId, text:body.message.content},
                {cookie:mobileCookie, 'x-nativesync-capabilities':'shared-space-v1'}, 202);
            return {workId:data.id, replayed:data.replayed};
        };
        const {workId} = await send();
        function state() {
            const work = db.prepare('SELECT kind, state, attempts, user_message_id, reply_message_id, pending_operation IS NOT NULL AS replyIntent, native_final_operation IS NOT NULL AS nativeFinal FROM mobile_executions WHERE id=?').get(workId);
            const admission = db.prepare('SELECT state,dispatched,native_terminal,reply_seq FROM shared_admissions WHERE id=?').get(workId);
            const native = db.prepare('SELECT id,state FROM shared_native_requests WHERE admission_id=?').all(workId);
            const invocations = db.prepare('SELECT invocation_id,native_request_id,record_id,state FROM mobile_native_invocations WHERE execution_id=?').all(workId);
            const finalOperation = db.prepare('SELECT native_final_operation AS operation FROM mobile_executions WHERE id=?').get(workId).operation;
            const nativeFinalHash = finalOperation && createHash('sha256').update(finalOperation).digest('hex');
            const workCount = db.prepare('SELECT count(*) AS n FROM mobile_executions WHERE request_id=?').get(requestId).n;
            const userMessageCount = db.prepare('SELECT count(*) AS n FROM journal WHERE msg_id=?').get(work.user_message_id).n;
            const finalRows = db.prepare('SELECT seq,msg_id,action,message_json FROM journal WHERE msg_id=? ORDER BY seq').all('reply_'+workId)
                .map(row=>({seq:row.seq,id:row.msg_id,action:row.action,contentHash:createHash('sha256').update(JSON.parse(row.message_json).content).digest('hex')}));
            return {work,workCount,userMessageCount,nativeFinalHash,admission,native,invocations,finalRows,counter:counter.counts(out).length,providerPhases:service.calls.map(c=>c.ordinaryPhase),providerStreams:service.calls.map(c=>c.stream)};
        }
        await until(()=>fs.existsSync(marker),'worker did not hit the selected cut');
        const cut = JSON.parse(fs.readFileSync(marker));
        assert.equal(cut.requestId,workId);
        const before = state();
        if (mode === 'corrupt-final') {
            const writable = new DatabaseSync(path.join(service.data, 'central.sqlite'));
            try {
                const sealed = writable.prepare('SELECT native_final_operation AS evidence FROM mobile_executions WHERE id=?').get(workId);
                const tampered = JSON.parse(sealed.evidence);
                tampered.operation.message.content = 'Tampered synthetic terminal response';
                writable.prepare('UPDATE mobile_executions SET native_final_operation=? WHERE id=?').run(JSON.stringify(tampered), workId);
            } finally {
                writable.close();
            }
        }
        await service.restartAfterCrash();
        const unsealed = ['dispatch-only','before-final-seal'].includes(mode);
        const expected = unsealed || mode === 'corrupt-final' ? 'review_required' : 'completed';
        await until(()=>state().work.state===expected,'work did not recover');
        const ack = await send();
        assert.equal(ack.workId,workId); assert.equal(ack.replayed,true);
        const after = state();
        assert.equal(before.work.replyIntent, mode==='after-intent'?1:0);
        assert.equal(before.work.nativeFinal, unsealed?0:1);
        assert.equal(before.native[0].state, unsealed?'dispatched':'model_terminal');
        assert.equal(before.admission.native_terminal, unsealed?0:1);
        const dispatchOnly = mode === 'dispatch-only';
        for (const snapshot of [before, after]) {
            assert.equal(snapshot.work.kind, mobile ? null : 'shared_session');
            assert.equal(snapshot.workCount, 1);
            assert.equal(snapshot.userMessageCount, 1);
            assert.equal(snapshot.work.attempts, before.work.attempts);
            assert.deepEqual(snapshot.providerStreams, dispatchOnly ? [] : [stream, stream]);
            assert.deepEqual(snapshot.providerPhases, dispatchOnly ? [] : ['tool-request','continuation']);
            assert.equal(snapshot.counter, dispatchOnly ? 0 : 1);
            assert.equal(snapshot.invocations.length, dispatchOnly ? 0 : 1);
        }
        assert.deepEqual(before.invocations, after.invocations);
        if (!dispatchOnly) {
            assert.equal(after.invocations[0].state, 'returned');
            assert.equal(after.invocations[0].native_request_id, workId);
            assert.ok(after.invocations[0].invocation_id);
            assert.ok(after.invocations[0].record_id);
        }
        assert.equal(before.finalRows.length,0);
        assert.equal(after.finalRows.length, expected==='completed'?1:0);
        if(after.finalRows.length)assert.equal(after.finalRows[0].contentHash,cut.contentHash);
        await service.restartWithUpgrade(async () => {});
        const second = await send();
        assert.equal(second.workId, workId);
        assert.equal(second.replayed, true);
        const afterSecondRestart = state();
        assert.deepEqual(afterSecondRestart, after);
        return {entry,mode,transport:stream?'sse':'json',requestId,workId,cut,before,after,afterSecondRestart,replayed:ack.replayed};
    } catch (error) {
        const log = path.join(out, 'backend.log');
        if (fs.existsSync(log)) console.error(fs.readFileSync(log, 'utf8').split('\n').slice(-28).join('\n'));
        throw error;
    } finally {
        db?.close();
        await service?.close();
        fs.rmSync(out,{recursive:true,force:true});
    }
}

if(process.env.NS_AUDIT_TERMINAL_MARKER) instrument();
else if(require.main===module) (async()=>{
    const result={base:require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{cwd:__dirname,encoding:'utf8'}).trim(),
        node:process.version,cases:[]};
    for (const mode of ['before-final-seal','after-final-seal']) {
        for (const stream of [false, true]) result.cases.push(await run(mode, stream, 'mobile-messages'));
    }
    for (const mode of ['dispatch-only','before-final-seal','after-final-seal','before-intent','after-intent','corrupt-final']) {
        for (const stream of [false, true]) result.cases.push(await run(mode, stream));
    }
    if(process.env.TOOLBOX_REVIEW_EVIDENCE)fs.writeFileSync(process.env.TOOLBOX_REVIEW_EVIDENCE,JSON.stringify(result,null,2)+'\n');
    console.log('Verified ordinary ToolBox final recovery across '+result.cases.length+' cases.');
})().catch(error=>{console.error(error);process.exitCode=1;});

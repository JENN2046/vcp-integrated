'use strict';

// Compare the two sides of the ordinary shared worker's existing reply-intent write.
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
    function cut(requestId, content, terminal) {
        const loaded = {};
        for (const file of ['modules/chatCompletionHandler.js', 'modules/handlers/nonStreamHandler.js', 'Plugin/NativeSync/mobile/nativeResponse.js',
            'Plugin/NativeSync/mobile/execution.js', 'Plugin/NativeSync/sync/sharedSession.js', 'Plugin/NativeSync/sync/sharedNative.js']) {
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
        if (mode === 'before-intent' && name === './nativeResponse' && parent?.filename.endsWith('/mobile/execution.js')) {
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

async function run(mode) {
    const { execFileSync } = require('node:child_process');
    const { DatabaseSync } = require('node:sqlite');
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
        service = await start({out, cert, key, candidate:path.resolve(__dirname, '../..'), ordinaryTools:counter, waitUntil:until, trace() {},
            toolHandoff:{observeRequest:()=>false,dropResponse:()=>false,
                env:{NODE_OPTIONS:'--require='+__filename, NS_AUDIT_TERMINAL_MARKER:marker, NS_AUDIT_TERMINAL_CUT:mode}}});
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
        const requestId = 'ordinary-review-'+mode;
        const body = {...scope,requestId,expectedHead:context.head,configHash:context.hash,
            message:{id:requestId,role:'user',content:'ORDINARY_TOOL_LOCAL',timestamp:1}};
        const {workId} = await api('session-send',body);
        function state() {
            const work = db.prepare('SELECT state, attempts, user_message_id, reply_message_id, pending_operation IS NOT NULL AS replyIntent FROM mobile_executions WHERE id=?').get(workId);
            const admission = db.prepare('SELECT state,dispatched,native_terminal,reply_seq FROM shared_admissions WHERE id=?').get(workId);
            const native = db.prepare('SELECT id,state FROM shared_native_requests WHERE admission_id=?').all(workId);
            const invocations = db.prepare('SELECT invocation_id,native_request_id,record_id,state FROM mobile_native_invocations WHERE execution_id=?').all(workId);
            const finalRows = db.prepare('SELECT seq,msg_id,action,message_json FROM journal WHERE msg_id=? ORDER BY seq').all('reply_'+workId)
                .map(row=>({seq:row.seq,id:row.msg_id,action:row.action,contentHash:createHash('sha256').update(JSON.parse(row.message_json).content).digest('hex')}));
            return {work,admission,native,invocations,finalRows,counter:counter.counts(out).length,providerPhases:service.calls.map(c=>c.ordinaryPhase)};
        }
        await until(()=>fs.existsSync(marker),'worker did not hit the selected cut');
        const cut = JSON.parse(fs.readFileSync(marker));
        assert.equal(cut.requestId,workId);
        const before = state();
        await service.restartAfterCrash();
        const expected = mode==='before-intent'?'review_required':'completed';
        await until(()=>state().work.state===expected,'work did not recover');
        const ack = await api('session-send',body);
        assert.equal(ack.workId,workId); assert.equal(ack.replayed,true);
        const after = state();
        assert.equal(before.work.replyIntent,mode==='before-intent'?0:1);
        assert.equal(before.native[0].state,'model_terminal');
        assert.equal(before.admission.native_terminal,1);
        assert.deepEqual(before.invocations,after.invocations);
        assert.equal(after.invocations.length,1); assert.equal(after.invocations[0].state,'returned');
        assert.equal(before.counter,1); assert.equal(after.counter,1);
        assert.deepEqual(before.providerPhases,['tool-request','continuation']); assert.deepEqual(before.providerPhases,after.providerPhases);
        assert.equal(before.finalRows.length,0);
        assert.equal(after.finalRows.length,mode==='before-intent'?0:1);
        if(after.finalRows.length)assert.equal(after.finalRows[0].contentHash,cut.contentHash);
        return {mode,requestId,workId,cut,before,after,replayed:ack.replayed};
    } finally {
        db?.close();
        await service?.close();
        fs.rmSync(out,{recursive:true,force:true});
    }
}

if(process.env.NS_AUDIT_TERMINAL_MARKER) instrument();
else if(require.main===module) (async()=>{
    const result={base:require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{cwd:__dirname,encoding:'utf8'}).trim(),
        node:process.version,cases:[await run('before-intent'),await run('after-intent')]};
    if(process.env.TOOLBOX_REVIEW_EVIDENCE)fs.writeFileSync(process.env.TOOLBOX_REVIEW_EVIDENCE,JSON.stringify(result,null,2)+'\n');
    console.log('Verified ordinary ToolBox restart on both sides of the reply intent.');
})().catch(error=>{console.error(error);process.exitCode=1;});

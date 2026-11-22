'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const failure = 'SYNTHETIC_UPSTREAM_502';

if (process.env.NS_UPSTREAM_ERROR_WIRE) {
    const { ServerResponse } = require('node:http');
    const write = ServerResponse.prototype.write;
    ServerResponse.prototype.write = function (chunk, ...rest) {
        const upstreamStatus = this.getHeader('x-vcp-upstream-status');
        if (upstreamStatus) {
            fs.appendFileSync(process.env.NS_UPSTREAM_ERROR_WIRE, JSON.stringify({
                status: this.statusCode, upstreamStatus: Number(upstreamStatus),
                contentType: this.getHeader('content-type'), chunk: String(chunk),
            })+'\n');
        }
        return write.call(this, chunk, ...rest);
    };
} else if (require.main === module) {
    run().catch(error => { console.error(error); process.exitCode = 1; });
}

async function run() {
    const { execFileSync } = require('node:child_process');
    const { DatabaseSync } = require('node:sqlite');
    const { setTimeout: pause } = require('node:timers/promises');
    const { start } = require('../integration/service.cjs');
    const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ns-ordinary-upstream-'));
    console.log('Evidence directory '+out);
    const cert = path.join(out, 'cert.pem');
    const key = path.join(out, 'key.pem');
    const wire = path.join(out, 'wire.jsonl');
    execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=isolated-upstream-error',
        '-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',cert], {stdio:'ignore'});

    async function until(read, label, ms = 15000) {
        const deadline = Date.now()+ms;
        do {
            const value = await read();
            if (value) return value;
            await pause(40);
        } while (Date.now()<deadline);
        throw Error(label);
    }

    let service, db;
    try {
        service = await start({
            out, cert, key, candidate: path.resolve(__dirname, '../..'), waitUntil: until, trace() {},
            serverRevision: process.env.NS_UPSTREAM_ERROR_SERVER_REVISION,
            groupRelay: {
                respond(body, _row, response) {
                    assert.equal(body.stream, true);
                    response.writeHead(502, {'content-type':'application/json'}).end(JSON.stringify({error:{message:failure}}));
                    return true;
                },
            },
            toolHandoff: {
                agentConfig: {streamOutput:true}, observeRequest:()=>false, dropResponse:()=>false,
                env: {NODE_OPTIONS:'--require='+__filename, NS_UPSTREAM_ERROR_WIRE:wire},
            },
        });
        db = new DatabaseSync(path.join(service.data, 'central.sqlite'), {readOnly:true});
        const scope = {sharedSpaceId:'sharedAB', sharedId:service.topics.preSubmit.id};
        const {spaceId} = JSON.parse(fs.readFileSync(path.join(out, 'seed/desktopA/.native-sync/connection.json')));
        const requestId = 'upstream-error-stream-shared-session';
        async function api(route, body) {
            const response = await fetch(service.wsOrigin+'/api/v1/sync/shared/'+route, {
                method: body ? 'POST' : 'GET',
                headers: {authorization:'Bearer synthetic-only', 'content-type':'application/json',
                    'x-nativesync-space':spaceId, 'x-nativesync-protocol':'2', 'x-nativesync-device':'deviceA',
                    'x-nativesync-source':'sourceA', 'x-nativesync-capabilities':'shared-space-v1,shared-context-v1,shared-session-v1'},
                body: body && JSON.stringify(body),
            });
            const value = await response.json();
            assert.equal(response.status, 200, JSON.stringify(value));
            return value;
        }
        const {head, hash} = await api('context?'+new URLSearchParams(scope));
        const body = {...scope, requestId, expectedHead:head, configHash:hash,
            message:{id:requestId, role:'user', content:'Synthetic ordinary shared request', timestamp:1}};
        const {workId} = await api('session-send', body);
        function snapshot() {
            const work = db.prepare('SELECT kind,state,attempts,error_code,user_message_id,reply_message_id,pending_operation,native_final_operation FROM mobile_executions WHERE id=?').get(workId);
            const admission = db.prepare('SELECT state,dispatched,native_terminal,reply_seq FROM shared_admissions WHERE id=?').get(workId);
            const native = db.prepare('SELECT state FROM shared_native_requests WHERE admission_id=?').all(workId);
            const history = db.prepare('SELECT msg_id AS id,action FROM journal WHERE topic_id=? ORDER BY seq').all(scope.sharedId).map(row=>({...row}));
            return {work, admission, native, history, providerStreams:service.calls.map(row=>row.stream)};
        }
        await until(() => {
            const {work, admission} = snapshot();
            return ['review_required','completed','failed','cancelled'].includes(admission.state) &&
                ['publishing','review_required','completed','failed','cancelled'].includes(work.state);
        }, 'shared execution did not settle after upstream failure');
        const first = snapshot();
        const ack = await api('session-send', body);
        const afterReplay = snapshot();
        const wireFrames = fs.readFileSync(wire, 'utf8').trim().split('\n').map(line=>JSON.parse(line));
        fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify({first, afterReplay, wireFrames, replayed:ack.replayed}, null, 2)+'\n');
        const frame = wireFrames.find(row => row.chunk.includes(failure));
        assert.equal(frame?.status, 200);
        assert.equal(frame.upstreamStatus, 502);
        assert.match(frame.contentType, /^text\/event-stream/);
        const [choice] = JSON.parse(frame.chunk.replace(/^data:\s*/, '')).choices;
        assert.equal(choice.finish_reason, 'stop');
        assert.match(choice.delta.content, /SYNTHETIC_UPSTREAM_502/);
        assert.equal(first.work.kind, 'shared_session');
        assert.equal(first.work.attempts, 1);
        assert.equal(first.admission.dispatched, 1);
        assert.equal(first.admission.native_terminal, 0);
        assert.deepEqual(first.native.map(row=>row.state), ['unknown']);
        assert.equal(first.admission.reply_seq, null);
        assert.equal(first.work.reply_message_id, null);
        assert.deepEqual(first.history, [{id:requestId, action:'upsert'}]);
        assert.equal(ack.workId, workId);
        assert.equal(ack.replayed, true);
        assert.deepEqual(afterReplay, first);
        assert.deepEqual(first.providerStreams, [true]);
        assert.equal(first.work.pending_operation, null, 'must not persist upstream SSE error as a reply intent');
        assert.equal(first.work.native_final_operation, null);
        assert.equal(first.work.state, 'review_required');
        assert.equal(first.admission.state, 'review_required');
    } finally {
        db?.close();
        await service?.close();
    }
}

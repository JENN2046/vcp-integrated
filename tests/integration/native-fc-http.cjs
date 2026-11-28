'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { start } = require('./service.cjs');

async function main() {
    const candidate = path.resolve(__dirname, '../..');
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'native-fc-http-'));
    const cert = path.join(out, 'cert.pem');
    const key = path.join(out, 'key.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=Isolated FC', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert], {stdio:'ignore'});
    const name = 'client_add';
    const tools = [{ type:'function', function:{ name, parameters:{ type:'object', properties:{ a:{type:'integer'}, b:{type:'integer'} } } } }];
    const call = {id:'call_add', type:'function', function:{name, arguments:'{"a":2,"b":3}'}};
    let malformed = false;
    const provider = http.createServer(async (req, res) => {
        try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const request = JSON.parse(Buffer.concat(chunks));
            assert.deepEqual(request.tools, tools);
            if (malformed) {
                const choice = {index:0, finish_reason:'stop', native_finish_reason:'MALFORMED_FUNCTION_CALL'};
                if (request.stream) {
                    res.writeHead(200, {'Content-Type':'text/event-stream'});
                    res.end('data: '+JSON.stringify({error:{message:'rejected fixture call'}, choices:[{...choice,delta:{}}]})+'\n\ndata: [DONE]\n\n');
                } else {
                    res.writeHead(200, {'Content-Type':'application/json'});
                    res.end(JSON.stringify({choices:[{...choice,message:{role:'assistant',content:'unfinished',tool_calls:[call]}}]}));
                }
                return;
            }
            const result = request.messages.findLast(row => row.role === 'tool');
            if (result) {
                assert.equal(result.tool_call_id, call.id);
                assert.equal(result.content, '5');
            }
            const message = result ? {role:'assistant', content:'received 5'} : {role:'assistant', content:null, tool_calls:[call]};
            const finish_reason = result ? 'stop' : 'tool_calls';
            if (!request.stream) return res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify({choices:[{index:0,message,finish_reason}]}));
            const delta = result ? message : {role:'assistant', tool_calls:[{index:0,...call}]};
            res.writeHead(200, {'Content-Type':'text/event-stream'});
            res.write('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
            res.end('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason}]})+'\n\ndata: [DONE]\n\n');
        } catch (error) { res.writeHead(500).end(error.message); }
    });
    await new Promise(resolve => provider.listen(0,'127.0.0.1',resolve));
    let service;
    let passed = false;
    try {
        const waitUntil = async (fn,label,ms) => {
            const until = Date.now()+ms;
            while (Date.now()<until) { const result=await fn(); if (result) return result; await delay(40); }
            throw Error(label);
        };
        service = await start({candidate,out,cert,key,mode:'core-local',enforceBudget:true,trace() {},waitUntil,
            coreRemote:{model:'synthetic',provider:'http://127.0.0.1:'+provider.address().port}});
        for (const stream of [false,true]) {
            const messages = [{role:'user',content:'add the fixture operands'}];
            for (const round of [1,2]) {
                const response = await fetch(service.wsOrigin+'/v1/chat/completions', {
                    method:'POST', headers:{authorization:'Bearer synthetic-only','content-type':'application/json'},
                    body:JSON.stringify({model:'synthetic',tools,messages,stream}),signal:AbortSignal.timeout(20000)
                });
                const wire = await response.text();
                assert.equal(response.status,200,wire);
                let message;
                const finish = round === 1 ? 'tool_calls' : 'stop';
                if (stream) {
                    const data = wire.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim());
                    assert.equal(data.pop(),'[DONE]',wire);
                    const choices = data.flatMap(line=>JSON.parse(line).choices);
                    const terminals = choices.map(choice=>choice.finish_reason).filter(Boolean);
                    assert.deepEqual(terminals,[finish]);
                    const deltas=choices.map(choice=>choice.delta);
                    message = {role:'assistant',content:deltas.map(delta=>delta.content||'').join(''),
                        tool_calls:deltas.flatMap(delta=>delta.tool_calls||[]).map(({index,...item})=>item)};
                } else {
                    const choice = JSON.parse(wire).choices[0];
                    assert.equal(choice.finish_reason,finish);
                    message = choice.message;
                }
                if (round===1) {
                    assert.deepEqual(message.tool_calls,[call]);
                    const {a,b}=JSON.parse(message.tool_calls[0].function.arguments);
                    messages.push(message,{role:'tool',tool_call_id:call.id,content:String(a+b)});
                } else assert.match(message.content,/received 5/);
            }
        }
        for (const stream of [false,true]) {
            const response = await fetch(service.wsOrigin+'/v1/chat/completions', {
                method:'POST', headers:{authorization:'Bearer synthetic-only','content-type':'application/json'},
                body:JSON.stringify({model:'synthetic', stream, contextTokenLimit:64, messages:[
                    {role:'user',content:'budget input '.repeat(512)}
                ]}), signal:AbortSignal.timeout(20000)
            });
            const wire = await response.text();
            if (stream) {
                assert.equal(response.status,200);
                const frames = wire.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim());
                assert.equal(frames.length,2);
                assert.equal(frames[1],'[DONE]');
                const terminal = JSON.parse(frames[0]);
                assert.equal(terminal.vcp_incomplete,true);
                assert.equal(terminal.vcp_context_budget.stage,'outbound');
            } else {
                assert.equal(response.status,400,wire);
                const failure = JSON.parse(wire);
                assert.equal(failure.error.code,'context_length_exceeded');
                assert.equal(failure.vcp_context_budget.limit,64);
            }
        }
        assert.equal(service.calls.length,4);
        malformed = true;
        for (const stream of [false,true]) {
            const response = await fetch(service.wsOrigin+'/v1/chat/completions', {
                method:'POST', headers:{authorization:'Bearer synthetic-only','content-type':'application/json'},
                body:JSON.stringify({model:'synthetic',tools,stream,messages:[{role:'user',content:'malformed fixture'}]}),
                signal:AbortSignal.timeout(20000)
            });
            const wire = await response.text();
            assert.equal(response.status,200,wire);
            assert.doesNotMatch(wire,/client_add/);
            if (stream) {
                assert.match(wire,/STREAM_INCOMPLETE/);
                assert.equal((wire.match(/data: \[DONE\]/g)||[]).length,1);
            } else {
                const message = JSON.parse(wire).choices[0].message;
                assert.equal(message.tool_calls,undefined);
                assert.match(message.content,/UPSTREAM_INCOMPLETE/);
            }
        }
        assert.equal(service.calls.length,6, 'malformed replies did not dispatch a continuation');
        passed = true;
        console.log('PASS actual ToolBox HTTP, client-owned FC and followup in both formats, one SSE DONE per response');
    } finally {
        if (service) await service.close();
        provider.closeAllConnections();
        await new Promise(resolve=>provider.close(resolve));
        await fs.rm(key,{force:true});
        if (passed) await fs.rm(out,{recursive:true,force:true});
        else console.error('Failed fixture retained at',out);
    }
}
main().catch(error=>{console.error(error);process.exitCode=1;});

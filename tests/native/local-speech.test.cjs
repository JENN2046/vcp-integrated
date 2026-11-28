'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const BOX = process.env.VCP_TEST_SERVER || path.resolve(__dirname,'../../apps/server');
const express = require(BOX + '/node_modules/express');
const WebSocket = require(BOX + '/node_modules/ws');
const { RemoteAccess } = require(BOX + '/core/remoteAccess');
const { CoreStore } = require(BOX + '/core/store');
const { localSpeechConfig } = require(BOX + '/modules/speech/localSpeech');

test('local speech requires HTTPS, same origin, and a paired device; supports cancel and disconnect', { timeout:10000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(),'local-speech-'));
    t.after(() => fs.rmSync(root,{recursive:true,force:true}));
    const cert = path.join(root,'cert.pem'), key = path.join(root,'key.pem');
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,
        '-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
    const ca=fs.readFileSync(cert), worker=path.join(root,'test-interpreter');
    fs.writeFileSync(worker,'#!'+process.execPath+'\n'+
        "console.log(JSON.stringify({ready:true}));\n"+
        "process.stdin.on('data',()=>console.log(JSON.stringify({text:'局部',final:false})));\n"+
        "process.stdin.on('end',()=>console.log(JSON.stringify({text:'最后',final:true})));\n",{mode:0o700});
    assert.equal(localSpeechConfig({}),null);
    const speech=localSpeechConfig({VCP_CORE_LOCAL_SPEECH:'1',VCP_CORE_LOCAL_SPEECH_PYTHON:worker,VCP_CORE_LOCAL_SPEECH_MODEL:root});
    assert.ok(speech);
    const app=express(), server=https.createServer({key:fs.readFileSync(key),cert:ca},app);
    server.listen(0,'127.0.0.1');
    await once(server,'listening');
    const origin='https://127.0.0.1:'+server.address().port;
    const store=new CoreStore(path.join(root,'core.sqlite'));
    const core={store,workspace:'personal',runner:{draining:false},checkStorage(){},router:()=>express.Router()};
    const remote=new RemoteAccess(core,{origin,hours:1,speech});
    const disabled=new RemoteAccess(core,{origin,hours:1});
    app.use('/mobile',remote.router('mobile'));
    let speechAccess=disabled;
    const upgrade=(req,socket,head)=>{
        if(!speechAccess.upgradeSpeech(req,socket,head)) socket.destroy();
    };
    server.on('upgrade',upgrade);
    const insecure=http.createServer();
    insecure.on('upgrade',upgrade);
    insecure.listen(0,'127.0.0.1');
    await once(insecure,'listening');
    const sockets=new Set();
    t.after(async()=>{
        for (const socket of sockets) socket.terminate();
        remote.speech.close();
        server.closeAllConnections();
        await new Promise(resolve=>server.close(resolve));
        await new Promise(resolve=>insecure.close(resolve));
        store.db.close();
    });
    function request(route,data,cookie) {
        return new Promise((resolve,reject)=>{
            const payload=data && JSON.stringify(data);
            const req=https.request(origin+'/mobile/api/'+route,{ca,method:payload?'POST':'GET',
                headers:{Origin:origin,...(cookie&&{Cookie:cookie}),...(payload&&{'Content-Type':'application/json'})}},res=>{
                res.resume();
                res.on('end',()=>resolve(res));
            });
            req.on('error',reject);
            req.end(payload);
        });
    }
    async function pair() {
        const code=remote.sessions.createCode(['shared:personal:read']).pairingCode;
        const response=await request('pair',{code});
        assert.equal(response.statusCode,200);
        return response.headers['set-cookie'][0].split(';')[0];
    }
    function connect(cookie, source=origin, endpoint=origin.replace('https:','wss:')) {
        const ws=new WebSocket(endpoint+'/mobile/api/voice',{ca,origin:source,
            headers:{Host:new URL(origin).host,...(cookie&&{Cookie:cookie})}});
        sockets.add(ws);
        ws.on('error',()=>{});
        ws.once('close',()=>sockets.delete(ws));
        return ws;
    }
    async function denied(cookie, code, source, endpoint) {
        const ws=connect(cookie,source,endpoint);
        const [req,response]=await once(ws,'unexpected-response');
        assert.equal(response.statusCode,code);
        response.resume();
        req.destroy();
    }
    async function start(cookie) {
        const ws=connect(cookie);
        const [ready]=await once(ws,'message');
        assert.deepEqual(JSON.parse(ready),{ready:true});
        return ws;
    }
    await denied(null,404);
    speechAccess=remote;
    await denied(null,401);
    const cookie=await pair();
    await denied(cookie,403,'https://foreign.invalid');
    await denied(cookie,403,origin,'ws://127.0.0.1:'+insecure.address().port);
    const active=await start(cookie);
    await denied(cookie,429);
    const partial=once(active,'message');
    active.send(Buffer.alloc(3200));
    assert.deepEqual(JSON.parse((await partial)[0]),{text:'局部',final:false});
    const final=once(active,'message'), normalClose=once(active,'close');
    active.send('finish');
    assert.deepEqual(JSON.parse((await final)[0]),{text:'最后',final:true});
    assert.equal((await normalClose)[0],1000);
    const second=await pair(), cancelled=await start(second);
    const cancelledClose=once(cancelled,'close');
    cancelled.close();
    await cancelledClose;
    const third=await pair(), interrupted=await start(third);
    const revoked=once(interrupted,'message'), interruptedClose=once(interrupted,'close');
    assert.equal((await request('connection/disconnect',{},third)).statusCode,200);
    assert.deepEqual(JSON.parse((await revoked)[0]),{error:'VOICE_PAIR_REQUIRED'});
    await interruptedClose;
    await denied(third,401);
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSyncRequest } = require(path.resolve(__dirname,'../../apps/desktop/modules/services/nativeSync/syncRequest.js'));

async function main() {
    const ready = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const url = new URL(ready.origin);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(process.env.NODE_EXTRA_CA_CERTS, ready.cert);
    const fixture = JSON.parse(fs.readFileSync(path.join(ready.profileSeed,'.native-sync/connection.json'),'utf8'));
    const send = createSyncRequest({ ...fixture,url:ready.origin,token:'synthetic-only' });
    const scope = { sharedSpaceId:'sharedAB',sharedId:ready.topic.id };
    const attemptPath = path.join(ready.out,'shared-attempt.json');
    const receiptPath = path.join(ready.out,'shared-receipt.json');
    const route = '/api/v1/sync/shared/session-send';
    if (process.argv[3] === '--replay') {
        const body = JSON.parse(fs.readFileSync(attemptPath,'utf8'));
        const original = JSON.parse(fs.readFileSync(receiptPath,'utf8'));
        const lookup = await send('/api/v1/sync/shared/request?' + new URLSearchParams({
            sharedSpaceId:scope.sharedSpaceId,requestId:body.requestId,
        }));
        assert.equal(lookup.request?.id,original.workId);
        assert.equal(lookup.request?.state,'completed');
        const result = await send(route,{body});
        assert.equal(result.workId,original.workId);
        assert.equal(result.replayed,true);
        const replay = { requestId:body.requestId, workId:result.workId, replayed:result.replayed, state:result.state };
        fs.writeFileSync(path.join(ready.out,'shared-replay.json'),JSON.stringify(replay)+'\n',{mode:0o600,flag:'wx'});
        console.log(JSON.stringify(replay));
        return;
    }
    const context = await send('/api/v1/sync/shared/context?' + new URLSearchParams(scope));
    const id = 'ctx-current-shared';
    const body = {...scope,requestId:id,expectedHead:context.head,configHash:context.hash,
        message:{id,role:'user',content:ready.sharedInput,timestamp:1700000004000}};
    // The immutable attempt stays on uncertainty. Each fresh run has one user intent.
    fs.writeFileSync(attemptPath, JSON.stringify(body)+'\n',{mode:0o600,flag:'wx'});
    const result = await send(route,{body});
    const receipt = { requestId:id,workId:result.workId,state:result.state };
    assert.ok(receipt.workId);
    fs.writeFileSync(receiptPath,JSON.stringify(receipt)+'\n',{mode:0o600,flag:'wx'});
    console.log(JSON.stringify(receipt));
}
main().catch(error => { console.error(error.code || error.message); process.exitCode=1; });

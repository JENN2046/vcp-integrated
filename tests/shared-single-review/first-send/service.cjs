'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const filename = path.resolve(__dirname, '../../integration/service.cjs');
let source = fs.readFileSync(filename, 'utf8');
function replace(before, after) {
    assert.equal(source.split(before).length, 2, before);
    source = source.replace(before, after);
}

// A different topic contributes to the global baseline watermark before the
// empty target is materialized. Persist its topic cursor through the real pull.
replace('        if (missingCase) require', `        const unrelated = {
            id:'synthetic-unrelated-prior-message', role:'user',
            content:'Synthetic prior message in a different topic.', timestamp:1700000000000,
        };
        f.store.apply({...target.topic, msgId:unrelated.id, deviceId:actor.principal,
            opId:'synthetic-unrelated-first-send-seed', baseHash:null, action:'upsert', message:unrelated}, {sharedSpace:'sharedAB'});
        if (missingCase) require`);
replace(': idleMessages;', ": subject === 'lostAck' ? 1 : idleMessages;");
replace("            if (mode === 'idle') idleDesktops.push(desktop);", `            const mapping = desktop.runtime.execution.mapping(desktop.descriptor);
            await desktop.runtime.syncExecutionTopic(mapping, {minSeq: 0});
            if (mode === 'idle') idleDesktops.push(desktop);`);

// Exercise a known pre-admission refusal and release it after reopening.
if (process.env.NS_FIRST_SEND_MODE === 'rejection') {
    replace('        const relevant = compactionRequest', `        if (req.method === 'GET' && route.endsWith('/shared/context') &&
            url.searchParams.get('sharedId') === source.id && req.headers['x-nativesync-device'] === 'deviceA' &&
            !fs.existsSync(path.join(out, 'allow-first-send-context'))) {
            const code = 'SHARED_CONFIG_CONFLICT';
            requests.push({route, method:req.method, status:409, device:'deviceA', injected:true, code});
            return res.writeHead(409, {'content-type':'application/json'}).end(JSON.stringify({error:{code}}));
        }
        const relevant = compactionRequest`);
}

const instrumented = new Module(filename, module);
instrumented.filename = filename;
instrumented.paths = Module._nodeModulePaths(path.dirname(filename));
instrumented._compile(source, filename);
module.exports = instrumented.exports;

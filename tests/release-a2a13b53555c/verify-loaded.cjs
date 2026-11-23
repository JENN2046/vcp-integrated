'use strict';

const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const candidate = path.resolve(process.argv[2]);
const run = path.resolve(process.argv[3]);
const loaded = filename => JSON.parse(fs.readFileSync(path.join(run,filename)));
const check = row => {
    const hash = createHash('sha256').update(fs.readFileSync(path.join(candidate,row.file))).digest('hex');
    assert.equal(row.sha256,hash,row.file);
    return row.file;
};
const records = {};
const mainCoverage = new Set();
for (const file of fs.readdirSync(run).filter(file => /^linux-\d+-loaded\.json$/.test(file))) {
    const evidence = loaded(file);
    assert.ok(evidence.main.some(row => row.file.endsWith('/Groupmodules/groupchat.js')));
    assert.ok(evidence.main.some(row => row.file.endsWith('/sharedGroupHandoff.js')));
    assert.equal(evidence.renderer.length,2);
    records[file] = [...evidence.main,...evidence.renderer].map(check);
    for (const row of evidence.main) mainCoverage.add(row.file);
}
assert.ok(mainCoverage.has('apps/desktop/modules/services/nativeSync/sharedExecution.js'));
const backend = loaded('backend-loaded.json');
assert.ok(backend.some(row => row.file === 'apps/server/Plugin/NativeSync/mobile/sharedSingle.js'));
assert.ok(backend.some(row => row.file === 'apps/server/modules/handlers/streamHandler.js'));
records.backend = backend.map(check);
if (fs.existsSync(path.join(run,'group-handler.jsonl'))) {
    const group = fs.readFileSync(path.join(run,'group-handler.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(group.length,3);
    records.handoff = group.map(({handoffSource}) => check({...handoffSource,file:'apps/server/' + handoffSource.file}));
}
console.log(JSON.stringify(records,null,2));

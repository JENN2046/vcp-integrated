'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite');
const { Module } = require('node:module');
const { pathToFileURL } = require('node:url');

const [phase, current, prior, scratch, input, report] = process.argv.slice(2);
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// Use the release's compatibility fixture for the original native registration,
// completion and mobile-host lifecycle, without registering its node:test suite.
const helper = path.resolve(current, 'tests/group-member-handoff/compatibility.cjs');
const source = fs.readFileSync(helper, 'utf8');
const boundary = source.indexOf("test('old host opens and settles v1");
assert.ok(boundary > 0);
const fixture = new Module(helper, module);
fixture.filename = helper;
fixture.paths = Module._nodeModulePaths(path.dirname(helper));
fixture._compile(source.slice(0, boundary) + 'module.exports={loadHost,startHost,publish,actor,sourceHeaders};', helper);
const { loadHost, startHost, publish, actor, sourceHeaders } = fixture.exports;
const space = 'sharedAB';
const mode = 'group-member-handoff-v1';
const old = loadHost(path.resolve(prior,'apps/server'));
const next = loadHost(path.resolve(current,'apps/server'));
const restorePoint = path.join(scratch, 'before-v2.sqlite');
const manifest = path.join(scratch,'original-work.json');
const upgraded = path.join(scratch, 'candidate-with-stored-work.sqlite');
const copy = (src, dest) => fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
const write = (file, value) => fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const read = file => JSON.parse(fs.readFileSync(file));
const openImmutable = file => new DatabaseSync(pathToFileURL(file).href+'?immutable=1',{readOnly:true});

function facts(db, w) {
    return {
        work: db.prepare('SELECT id,request_id,state,user_seq,reply_seq,principal,native_terminal FROM shared_admissions WHERE id=?').get(w.id),
        control: db.prepare('SELECT * FROM shared_group_handoffs WHERE work_id=?').get(w.id),
        native: db.prepare('SELECT id,ordinal,member_id,principal,state FROM shared_native_requests WHERE admission_id=? ORDER BY ordinal').all(w.id),
        journal: db.prepare('SELECT seq,msg_id,hash,action,device_id FROM journal WHERE topic_id=? ORDER BY seq').all(w.topic.topicId),
        receipts: db.prepare('SELECT principal,op_id,request_hash,result_json FROM shared_receipts WHERE instr(result_json,?)>0 ORDER BY principal,op_id').all(w.id)
            .map(row=>({opId:row.op_id,principal:row.principal,requestHash:row.request_hash,
                resultHash:createHash('sha256').update(row.result_json).digest('hex')})),
    };
}

async function withHost(host,file,action) {
    const config={NativeSyncFullSources:JSON.stringify(['A','B','C','D'].map(device=>({
        sourceId:'source'+device,deviceId:'device'+device,executionMode:'all-supported'}))),
        NativeSyncSharedSpaces:JSON.stringify([{id:space,sources:['sourceA','sourceB','sourceC']},{id:'foreignSpace',sources:['sourceD']}]),
        NativeSyncDataDir:file+'-files',NativeMobileOrigin:'https://127.0.0.1:18443',NativeMobileConfigSync:true,NativeMobileTopics:'[]'};
    const store=new host.CentralStore(file);
    let close;
    try {
        store.sourceCatalog=new host.SourceCatalog(store,config);
        close=startHost(host,store,config);
        return await action(store);
    } finally {
        try { await close?.(); } finally { store.close(); }
    }
}
async function finish(host, store, w) {
    const post=(route,body)=>host.sharedRequest(store,{method:'POST',headers:sourceHeaders(store,'B',mode),
        body:{sharedSpaceId:space,...body}},new URL('http://fixture.invalid/shared/'+route));
    await post('group-handoff',{workId:w.id,opId:'old-work-handoff',expectedExecutor:'desktop:deviceA',expectedExecutorVersion:0});
    await post('group-continue',{workId:w.id,opId:'old-work-continue',expectedExecutor:'desktop:deviceB',expectedExecutorVersion:1});
    publish(store,'B',mode,w.topic,w.id,w.plan,1);
    const body={admissionId:w.id,opId:'old-work-finish',finish:true};
    assert.equal((await post('complete',body)).request.state,'completed');
    assert.equal((await post('complete',body)).replayed,true);
    return facts(store.db,w);
}
async function main() {
    if(phase==='prepare') {
        const source=path.join(scratch,'old-host.sqlite');
        const initialHash=sha(input);
        copy(input,source);
        const w=await withHost(old,source,async store=>{
            const a=actor(store,'A',mode);
            const plan=store.db.prepare("SELECT id FROM shared_objects WHERE space_id=? AND kind='agent' AND deleted=0 ORDER BY rowid LIMIT 2").all(space).map(v=>v.id);
            assert.equal(plan.length,2);
            const group=store.shared.create(a,{sharedSpaceId:space,opId:'release-stored-group',kind:'group',localId:'r4-old-group',
                config:{name:'Stored legacy relay',mode:'sequential',members:plan}}).object;
            const target=store.shared.create(a,{sharedSpaceId:space,opId:'release-stored-topic',kind:'topic',parentId:group.id,
                localParent:'r4-old-group',localId:'r4-old-topic',config:{name:'Pre-upgrade saved turn'}}).object;
            const scope={sharedSpaceId:space,sharedId:target.id};
            const ctx=store.shared.executionConfig(a,scope);
            const admitted=store.shared.admit(a,{...scope,requestId:'old-work-input',expectedHead:ctx.head,configHash:ctx.hash,
                controlMode:mode,message:{id:'old-work-input',role:'user',content:'Synthetic compatibility input',timestamp:1}});
            assert.deepEqual(admitted.turn.plan,plan);
            const w={id:admitted.id,topic:target.topic,plan};
            const first=publish(store,'A',mode,w.topic,w.id,plan,0);
            assert.equal(first.request.groupHandoff.state,'awaiting_handoff');
            await backup(store.db, restorePoint);
            return w;
        });
        write(manifest,w);
        const checkpoint=openImmutable(restorePoint);
        const before=facts(checkpoint,w);
        const schema=checkpoint.prepare('SELECT version FROM shared_schema ORDER BY version').all().map(x=>x.version);
        checkpoint.close();
        assert.equal(schema.at(-1),3);
        assert.equal(before.journal.length,2);
        copy(restorePoint,upgraded);
        const after=await withHost(next,upgraded,async store=>{
            assert.deepEqual(facts(store.db,w),before);
            return finish(next,store,w);
        });
        assert.deepEqual(after.journal.slice(0,2),before.journal);
        assert.equal(after.journal.length,3);
        assert.deepEqual(after.native.map(v=>v.state),['model_terminal','model_terminal']);
        assert.equal(sha(input), initialHash);
        write(report,{oldRevision:'af17c99e784fd1afd5b127fcf8a467f06ef8423d',targetRevision:'a2a13b53555c55ca79844544d8802d61fc0cf3e0',
            boundary:'Real old and new host modules; synthetic model-terminal events via the native request boundary.',schema,work:w,before,after,
            seedHash:initialHash,backupHash:sha(restorePoint),upgradedHash:sha(upgraded)});
        console.log('READY',upgraded,sha(upgraded));
    } else if(phase==='rollback') {
        const w=read(manifest);
        const priorReport=read(path.join(path.dirname(report),'upgrade.json'));
        assert.equal(sha(restorePoint),priorReport.backupHash);
        const c=openImmutable(input);
        const schema=c.prepare('SELECT version FROM shared_schema ORDER BY version').all().map(x=>x.version);
        const readFacts=facts(c,w); c.close();
        assert.equal(schema.at(-1),4);
        assert.deepEqual(JSON.parse(JSON.stringify(readFacts)),priorReport.after);
        const currentHash=sha(input);
        const rejected=path.join(scratch,'legacy-reject.sqlite');
        copy(input,rejected);
        await assert.rejects(withHost(old,rejected,()=>assert.fail('legacy host opened schema 4')),{code:'SHARED_SCHEMA_UPGRADE_REQUIRED'});
        const refused=openImmutable(rejected);
        assert.deepEqual(facts(refused,w),readFacts);
        refused.close();
        const restored=path.join(scratch,'legacy-restored.sqlite');
        copy(restorePoint,restored);
        const recovered=await withHost(old,restored,async store=>{
            const uponOpen=facts(store.db,w);
            assert.deepEqual(JSON.parse(JSON.stringify(uponOpen)),priorReport.before);
            return {uponOpen,after:await finish(old,store,w)};
        });
        assert.deepEqual(recovered.after.journal.map(v=>[v.msg_id,v.hash]),readFacts.journal.map(v=>[v.msg_id,v.hash]));
        assert.equal(sha(restorePoint),priorReport.backupHash);
        assert.equal(sha(input),currentHash);
        write(report,{schema4:schema,schema4BackupSha256:currentHash,rejected:'SHARED_SCHEMA_UPGRADE_REQUIRED',backupHash:sha(restorePoint),restored:recovered,productionCopyUntouched:true});
    } else throw Error('prepare or rollback required');
}
main().catch(e=>{console.error(e);process.exitCode=1});

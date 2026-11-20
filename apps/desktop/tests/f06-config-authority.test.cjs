'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Manager = require('../modules/utils/agentConfigManager');
const {HistoryMutationQueue} = require('../modules/services/historyMutationQueue');
async function fixture(t, config = {name:'synthetic',topics:[{id:'live'}],_historyDeletedTopics:['gone']}) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'f06-authority-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const agents=path.join(root,'Agents'),file=path.join(agents,'owner','config.json');await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(config));
 return {root,file,manager:new Manager(agents),queue:new HistoryMutationQueue({userDataDir:path.join(root,'UserData')})};
}
test('direct saves preserve native topic tombstones even if an old settings DTO omits them',async t=>{
 const x=await fixture(t);await x.manager.writeAgentConfig('owner',{name:'changed',topics:[{id:'live'}]});
 assert.deepEqual(JSON.parse(await fs.readFile(x.file))._historyDeletedTopics,['gone']);
 await assert.rejects(x.manager.writeAgentConfig('owner',{name:'old',topics:[{id:'gone'}]}),/HISTORY_TOPIC_DELETED/);
 assert.deepEqual(JSON.parse(await fs.readFile(x.file)).topics,[{id:'live'}]);
});
test('queued mutations cannot erase native deletion facts or reactivate an old identity',async t=>{
 const x=await fixture(t);const updated=await x.manager.updateAgentConfig('owner',()=>({name:'current',topics:[{id:'live'}]}));
 assert.deepEqual(updated.config._historyDeletedTopics,['gone']);
 await assert.rejects(x.manager.updateAgentConfig('owner',()=>({topics:[{id:'gone'}]})),/HISTORY_TOPIC_DELETED/);
});
test('a durable owner tombstone survives old full saves and blocks a new process queue',async t=>{
 const x=await fixture(t,{id:'owner',topics:[],_historyDeleting:true});
 await assert.rejects(x.manager.writeAgentConfig('owner',{name:'old',topics:[{id:'live'}]}),/HISTORY_OWNER_DELETED/);
 await x.manager.writeAgentConfig('owner',{topics:[],_historyDeleting:false});
 assert.equal(JSON.parse(await fs.readFile(x.file))._historyDeleting,true);
 await assert.rejects(x.queue.write({itemId:'owner',topicId:'live'},[]),/HISTORY_OWNER_UNVERIFIED/);
});
test('a corrupt primary is never replaced by cached or backup authority through an updater',async t=>{
 const x=await fixture(t);await x.manager.readAgentConfig('owner');const bad=Buffer.from('{ broken primary');await fs.writeFile(x.file,bad);await fs.writeFile(x.file+'.backup',JSON.stringify({name:'old',topics:[{id:'gone'}]}));
 await assert.rejects(x.manager.updateAgentConfig('owner',c=>({...c,name:'should fail'})));
 assert.deepEqual(await fs.readFile(x.file),bad);
});
test('a missing primary with a recovery backup cannot be recreated by a direct stale save',async t=>{
 const x=await fixture(t);const old=await fs.readFile(x.file);await fs.writeFile(x.file+'.backup',old);await fs.unlink(x.file);
 await assert.rejects(x.manager.writeAgentConfig('owner',{name:'old',topics:[{id:'gone'}]}),/HISTORY_CONFIG_RECOVERY_REQUIRED/);
 await assert.rejects(fs.stat(x.file),{code:'ENOENT'});assert.deepEqual(await fs.readFile(x.file+'.backup'),old);
});
test('new configuration identities remain writable without manufacturing old deletion permissions',async t=>{
 const x=await fixture(t);await x.manager.writeAgentConfig('new',{name:'new',topics:[{id:'fresh'}]});
 const d={itemId:'new',topicId:'fresh'};const made=await x.queue.initializeIfMissing(d);assert.equal(made.status,'created');await x.queue.mutate(d,h=>[...h,{id:'m',role:'user',content:'synthetic'}]);assert.equal((await x.queue.read(d)).length,1);
});

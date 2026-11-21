'use strict';

const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const test = require('node:test');
const { fixture, wait, BOX, ctx } = require('./fixtures/sharedSingleHarness.cjs');

async function groupFixture(t) {
 const f = await fixture(t);
 const create = input => f.shared.create(f.actor('A'), {sharedSpaceId:'sharedAB', ...input}).object;
 const second = create({opId:'second',kind:'agent',localId:'second',
  config:{name:'Second',model:'synthetic',systemPrompt:'Second prompt',streamOutput:false}});
 const members = [f.owner.id, second.id];
 const group = create({opId:'group',kind:'group',localId:'group',
  config:{name:'Settlement group',mode:'sequential',members,sequentialSpeakerOrder:members}});
 const topic = create({opId:'group-topic',kind:'topic',parentId:group.id,localId:'group-topic',
  localParent:'group',config:{name:'Settlement topic'}});
 const phone = await f.phone();
 const route = '/conversations/'+topic.id+'/messages';
 return {f,topic,phone,route};
}

async function playedGroup(t) {
 const {f,topic,phone,route} = await groupFixture(t);
 const input = {requestId:'legacy-ordinary-group',text:'Synthetic group submission'};
 const {id} = await phone.call(route,input,202);
 const engine = f.portal.engine;
 const {db} = engine;
 db.prepare('UPDATE mobile_executions SET not_before=0 WHERE id=?').run(id);
 engine.setEndpoint({url:f.url+'/v1/chat/completions',key:'synthetic-only'});
 const speakers = () => db.prepare('SELECT * FROM mobile_execution_steps WHERE job_id=? AND step_index>=0 ORDER BY step_index').all(id);
 await wait(()=>speakers().length===2 && speakers().every(row=>row.state==='completed') && !engine.active.has(id),
  'both original speaker replies are committed');
 const speaker = speakers().at(-1);
 const admission = () => db.prepare('SELECT * FROM shared_admissions WHERE id=?').get(id);
 assert.equal(admission().state,'completed');
 assert.equal(admission().native_terminal,1);
 assert.equal(f.calls(),2);

 const markLegacy = shape => {
  if(shape==='plan') {
   db.prepare("UPDATE mobile_executions SET state='review_required',error_code='GROUP_PLAN_REVIEW_REQUIRED' WHERE id=?").run(id);
  } else {
   db.prepare("UPDATE mobile_executions SET state='blocked_config',error_code='SHARED_NATIVE_TERMINAL_REQUIRED' WHERE id=?").run(id);
   db.prepare("UPDATE shared_admissions SET state='review_required',native_terminal=0 WHERE id=?").run(id);
   // The late-settlement legacy failure happened before the finish receipt committed.
   db.prepare('DELETE FROM shared_receipts WHERE principal=? AND op_id=?')
    .run(admission().principal,'mobile-group-finish_'+id);
  }
 };
 const durable = () => ({
  journal: db.prepare('SELECT * FROM journal WHERE topic_id=? ORDER BY seq').all(topic.id),
  messages: db.prepare('SELECT * FROM messages WHERE topic_id=? ORDER BY msg_id').all(topic.id),
  steps: db.prepare('SELECT * FROM mobile_execution_steps WHERE job_id=? ORDER BY step_index').all(id),
  requests: db.prepare('SELECT * FROM shared_native_requests WHERE admission_id=? ORDER BY ordinal').all(id),
  finish: db.prepare('SELECT * FROM shared_receipts WHERE principal=? AND op_id=?')
   .get(admission().principal,'mobile-group-finish_'+id),
  child: db.prepare('SELECT * FROM shared_native_child_requests WHERE work_id=? ORDER BY id').all(id),
  tasks: db.prepare('SELECT * FROM mobile_native_tasks WHERE execution_id=? ORDER BY native_task_id').all(id),
  tools: db.prepare('SELECT * FROM mobile_native_invocations WHERE execution_id=? ORDER BY invocation_id').all(id),
 });
 const recover = async () => {
  await f.reopenBackend();
  f.shared.native.checkTerminal(id);
  await new Promise(resolve=>setImmediate(resolve));
 };
 return {f,db,id,topic,phone,route,input,admission,speaker,markLegacy,durable,recover};
}

function seedChild({db,id,speaker}, state) {
 const child = 'synthetic-child';
 db.prepare(`INSERT INTO mobile_native_invocations
  (invocation_id,execution_id,step_id,native_request_id,plugin_name,state,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?)`)
  .run('synthetic-aa-invocation',id,speaker.id,speaker.id,'AgentAssistant','returned',1,1);
 db.prepare(`INSERT INTO mobile_native_tasks
  (plugin_name,native_task_id,execution_id,step_id,native_request_id,invocation_id,agent_base_name,state,observed_at,native_status,revision,result_ref,result_hash)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run('AgentAssistant','synthetic-task',id,speaker.id,speaker.id,'synthetic-aa-invocation','Synthetic','completed',1,'Succeed',1,'synthetic-test-archive','a'.repeat(64));
 db.prepare('INSERT INTO shared_native_child_requests VALUES (?,?,?,?,?,?,?,?)')
  .run(child,id,'AgentAssistant','synthetic-task','0'.repeat(64),'synthetic',0,state);
 db.prepare(`INSERT INTO mobile_execution_steps
  (id,job_id,step_index,agent_id,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
  .run(child,id,-1,'Synthetic','pending',1,1);
 return child;
}

const removeReply = ({db,topic,speaker}) => {
 db.prepare('DELETE FROM messages WHERE topic_id=? AND msg_id=?').run(topic.id,speaker.reply_message_id);
};

const cases = [
 ['unknown child request','terminal',fx=>seedChild(fx,'unknown')],
 ['started invocation after child terminal','terminal',fx=>{
  const {db,id} = fx;
  const child = seedChild(fx,'model_terminal');
  db.prepare(`INSERT INTO mobile_native_invocations
   (invocation_id,execution_id,step_id,native_request_id,plugin_name,state,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?)`).run('synthetic-child-invocation',id,child,child,'SyntheticTool','started',1,1);
 }],
 ['missing original reply','terminal',removeReply],
 ['missing Journal row despite a History projection','plan',({db,topic,speaker})=>{
  db.prepare('DELETE FROM journal WHERE topic_id=? AND msg_id=?').run(topic.id,speaker.reply_message_id);
 }],
 ['unverified AA terminal projection','plan',fx=>{
  seedChild(fx,'model_terminal');
  fx.db.prepare('UPDATE mobile_native_tasks SET result_hash=NULL WHERE execution_id=?').run(fx.id);
 }],
 ['missing original reply despite a finish receipt','plan',removeReply],
 ['explicit execution review','terminal',({db,id})=>{
  db.prepare("UPDATE mobile_executions SET state='review_required',error_code='EXECUTION_INTERRUPTED_REVIEW_REQUIRED' WHERE id=?").run(id);
 }],
 ['frozen plan mismatch','plan',({db,id,admission})=>{
  const turn = JSON.parse(admission().user_op).sharedTurn;
  db.prepare('UPDATE mobile_executions SET group_plan=? WHERE id=?').run(JSON.stringify(turn.plan.reverse()),id);
 }],
];

for (const [reason,shape,contradict] of cases) {
 test('ordinary group recovery holds '+reason,async t=>{
  const fx = await playedGroup(t);
  const {f,id,topic,phone,route,input,admission,markLegacy,durable,recover} = fx;
  markLegacy(shape);
  contradict(fx);
  const before = durable();
  const admissionBefore = admission();
  const {attempts} = f.portal.engine.get(id);
  await recover();
  const job = f.portal.engine.get(id);
  assert.ok(['review_required','blocked_config'].includes(job.state),job.state);
  assert.equal(job.review_resolved,0);
  assert.equal(job.attempts,attempts);
  assert.equal(admission().state,admissionBefore.state);
  assert.equal(admission().native_terminal,admissionBefore.native_terminal);
  assert.equal(admission().reply_seq,admissionBefore.reply_seq);
  await phone.call(route,{requestId:'blocked-next-group',text:'successor'},409);
  assert.equal((await phone.call(route,input,202)).id,id);
  assert.equal(f.shared.active(topic.id)?.id,shape==='plan'?undefined:id);
  assert.deepEqual(durable(),before);
  assert.equal(f.calls(),2);
 });
}

test('ordinary group recovery preserves owner abandonment and a successor admission',async t=>{
 const {f,id,topic,phone,route,admission,markLegacy,durable,recover} = await playedGroup(t);
 markLegacy('terminal');
 const resolution = await phone.call('/executions/'+id+'/resolve',{action:'acknowledge_and_abandon_remaining'});
 assert.equal(resolution.state,'cancelled');
 assert.equal(resolution.reviewResolved,true);
 const next = await phone.call(route,{requestId:'next-after-owner-ack',text:'successor'},202);
 assert.notEqual(next.id,id);
 const before = durable();
 await recover();
 const job = f.portal.engine.get(id);
 assert.equal(job.state,'cancelled');
 assert.equal(job.review_resolved,1);
 assert.equal(admission().state,'abandoned');
 assert.equal(f.shared.active(topic.id)?.id,next.id);
 assert.equal(f.portal.engine.get(next.id).state,'queued');
 assert.deepEqual(durable(),before);
 assert.equal(f.calls(),2);
});


test('last speaker reply settles after its live delegated child tool returns',async t=>{
 const {f,topic,phone,route} = await groupFixture(t);
 const hash = require(BOX+'/Plugin/NativeSync/sync/protocol').sha256;
 const childId = 'ordinary-last-speaker-child-'+randomUUID();
 const taskId = 'ordinary-last-speaker-aa';
 const completion = content => ({choices:[{message:{role:'assistant',content},finish_reason:'stop'}]});
 let delegated, parentResponse, finishChildTool;
 const toolGate = new Promise(resolve=>{finishChildTool=resolve;});
 t.after(finishChildTool);
 t.after(ctx.registerNativeTaskProvider('AgentAssistant',identity=>({...identity,state:'running',revision:0})));
 f.control.nativeResponder = async (req,res) => {
  if(req.body.requestId===childId){
   await ctx.runToolInvocation({pluginName:'SyntheticTool'},()=>toolGate);
   res.json(completion('CHILD_REPLY_AFTER_TOOL'));
   return;
  }
  if(f.calls()===1){
   res.json(completion('FIRST_SPEAKER_REPLY'));
   return;
  }
  await ctx.runToolInvocation({pluginName:'AgentAssistant'},async()=>{
   delegated=await ctx.acceptNativeTask({pluginName:'AgentAssistant',nativeTaskId:taskId,agentBaseName:'Synthetic'});
   await delegated.observe({state:'running',revision:0});
  });
  parentResponse=res;
 };
 const {id} = await phone.call(route,{requestId:'last-speaker-with-child-tool',text:'Synthetic group submission'},202);
 const engine = f.portal.engine;
 const {db} = engine;
 const job = () => engine.get(id);
 const journal = () => db.prepare('SELECT seq,msg_id FROM journal WHERE topic_id=? ORDER BY seq').all(topic.id);
 const steps = () => db.prepare('SELECT * FROM mobile_execution_steps WHERE job_id=? AND step_index>=0 ORDER BY step_index').all(id);
 db.prepare('UPDATE mobile_executions SET not_before=0 WHERE id=?').run(id);
 engine.setEndpoint({url:f.url+'/v1/chat/completions',key:'synthetic-only'});
 await wait(()=>parentResponse,'last speaker delegated AA');
 const wire = {model:'synthetic',stream:false,requestId:childId,messages:[{role:'user',content:'synthetic child'}]};
 const registration = delegated.requests.register(wire);
 t.after(registration);
 const response = fetch(f.url+'/v1/chat/completions',{method:'POST',
  headers:{...registration.headers,'content-type':'application/json'},body:JSON.stringify(wire),
  signal:AbortSignal.timeout(5000)});
 response.catch(()=>{});
 const childTool = () => db.prepare('SELECT state FROM mobile_native_invocations WHERE execution_id=? AND native_request_id=?').get(id,childId);
 try {
  await wait(()=>childTool()?.state==='started','delegated child is running its tool');
  parentResponse.json(completion('LAST_SPEAKER_REPLY_BEFORE_CHILD_TOOL_RETURN'));
  await wait(()=>!engine.active.has(id),'last speaker has returned');
  assert.equal(job().state,'recovering');
  const lastSpeaker=steps().at(-1);
  assert.equal(lastSpeaker.state,'publishing');
  const pendingReply=JSON.parse(lastSpeaker.pending_operation).message;
  assert.equal(pendingReply.content,'LAST_SPEAKER_REPLY_BEFORE_CHILD_TOOL_RETURN');
  assert.equal(journal().length,2);
  f.shared.native.checkTerminal(id);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(job().state,'recovering');
  assert.equal(childTool().state,'started');
  assert.equal(f.shared.active(topic.id)?.state,'dispatched');
  await phone.call(route,{requestId:'next-during-child-tool',text:'successor'},409);

  finishChildTool();
  const finished = await response;
  assert.equal(finished.status,200);
  await finished.json();
  assert.equal(childTool().state,'returned');
  assert.equal(job().state,'recovering');
  assert.equal(f.shared.active(topic.id)?.native_terminal,0);
  delegated.requests.confirmFinal(childId);
  await delegated.observe({schemaVersion:1,state:'completed',nativeStatus:'Succeed',revision:1,controlRevision:0,
   resultRef:'synthetic archive',resultHash:hash('synthetic child result'),summary:'synthetic child result',endTime:1});
  await wait(()=>job().state==='completed','original group finishes after delegated tool receipt');
  assert.deepEqual(steps().map(row=>[row.state,row.attempts]),[['completed',1],['completed',1]]);
  const committed=journal();
  assert.equal(committed.length,3);
  assert.equal(committed.at(-1).msg_id,pendingReply.id);
  f.shared.native.checkTerminal(id);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(journal(),committed);
  const [reply] = f.store.readProjected(()=>db.prepare('SELECT * FROM messages WHERE topic_id=? AND msg_id=?')
   .all(topic.id,pendingReply.id));
  assert.equal(reply.message.content,pendingReply.content);
  assert.equal(db.prepare('SELECT state FROM shared_native_child_requests WHERE id=?').get(childId).state,'model_terminal');
  assert.equal(f.shared.active(topic.id),undefined);
  assert.equal(f.calls(),3);
 } finally {
  finishChildTool();
  await response.catch(()=>{});
 }
});

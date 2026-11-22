// Explicit controls around the existing NativeSync Work and native send path.
// This view never converts an accepted ordinary request or dispatches on refresh.
export function createControlledWorkView({container,api,execute,refresh}){
 const doc=container.ownerDocument,panel=doc.createElement('details'),heading=doc.createElement('summary'),description=doc.createElement('p'),input=doc.createElement('textarea'),status=doc.createElement('p'),actions=doc.createElement('div');
 panel.className='native-sync-controlled-work';panel.hidden=true;heading.textContent='跨端任务';description.textContent='工具任务在工具回执确认后暂停。请在本端压缩前文，再到另一端接管并继续。';input.placeholder='新的任务或对此任务的补充文本';input.setAttribute('aria-label','受控任务文本');input.style.cssText='width:100%;box-sizing:border-box;min-height:60px';status.setAttribute('role','status');
 const delegate=doc.createElement('input');
 delegate.placeholder='委托 Agent 名称';delegate.setAttribute('aria-label','委托 Agent 名称');
 const make=(label,action)=>{const button=doc.createElement('button');button.type='button';button.textContent=label;button.addEventListener('click',()=>run(action));actions.append(button);return button;};
 let value=null,scope=null,busy=false,closed=false,epoch=0,polling=false,creation=null;
 const groupStages={
  submission_unconfirmed:'原提交结果待核对',
  first_member:'等待第一位成员的回复确认',
  awaiting_handoff:'第一位成员回复已确认，可以关闭此设备并在另一设备接管',
  awaiting_continue:'已接管，等待本端继续',
  continuing:'正在处理第二位成员的回复',
  completed:'两位成员的回复均已保存',
  review_required:'原回复结果待核对',
  abandoned:'接力已结束',
 };
 const group=()=>scope?.ownerType==='group';
 const groupWork=()=>value?.groupHandoff;
 const stages={awaiting_native_task:'父请求已结算，等待原委托报告',unstarted:'待开始',applying:'待开始或继续',applied:'本轮执行中',attachments_pending:'等待补充就绪',waiting_safe_boundary:'等待安全边界',ready:'可继续',blocked:'原任务需要核对',compacting:'正在整理上下文',awaiting_compaction:'工具回执已确认，等待执行端压缩前文',awaiting_handoff:'检查点已发布，等待另一设备接管'};
 const timer=setInterval(async()=>{if(closed||panel.hidden||!panel.open||polling||busy)return;polling=true;try{await refresh();}finally{polling=false;}},1500);
 const descriptor=()=>({itemType:scope.ownerType,itemId:scope.ownerId,topicId:scope.topicId});
 const work=()=>value?.executions?.find(job=>['text-only-v1','safe-tools-v1','agent-assistant-v1'].includes(job.controlMode)&&!['completed','cancelled','abandoned'].some(state=>job.phase===state||job.state===state));
 const key=s=>JSON.stringify([s?.ownerType,s?.ownerId,s?.topicId]);
 const errorText={SHARED_GROUP_HANDOFF_UNSUPPORTED:'两成员接力需要共享顺序群聊，并且只能使用纯文本。',SHARED_GROUP_RESULT_UNCONFIRMED:'原回复结果待核对。请先查看任务状态。',SHARED_GROUP_HANDOFF_STATE_CHANGED:'执行归属已变化，请核对最新任务。',CONTROLLED_MODE_IMMUTABLE:'当前话题已有请求，等待原请求结清后再提交。',WORK_SAFE_BOUNDARY_PENDING:'原请求尚未到安全边界，不能接管或继续。',WORK_HANDOFF_STATE_CHANGED:'执行归属已变化，请核对最新任务。',CONTROLLED_TEXT_PORTABLE_REQUIRED:'此会话含附件或本机资源，不能作为受控纯文本任务。',CONTROLLED_TEXT_TOOLS_FORBIDDEN:'受控纯文本模式已阻止工具执行。',SHARED_TOPIC_BUSY:'此话题仍有原请求，不能将它转换为受控任务。',WORK_EXECUTOR_HANDOFF_REQUIRED:'请先显式接管到本端。',STEERING_REVISION_CHANGED:'补充版本已变化，请核对后继续。'};
 async function run(action){if(closed||busy||!scope||panel.hidden)return;busy=true;const turn=epoch;buttons();try{const frozen={descriptor:descriptor(),work:work(),text:input.value,agentName:delegate.value.trim(),epoch:turn,current:()=>!closed&&turn===epoch&&!panel.hidden};const result=await action(frozen);if(result?.success===false)throw Object.assign(Error(result.error),{code:result.error});if(turn===epoch){status.textContent='操作已确认；任务归属和结果以最新记录为准。';await refresh();}}catch(error){if(turn===epoch){if(group())await refresh();if(turn===epoch)status.textContent=errorText[error.code]||`尚未完成：${error.code||error.message}，原任务和输入保持。`;}}finally{busy=false;buttons();}}
 async function createTask(frozen,mode){
  const text=frozen.text.trim();
  if(!text)throw Error('请输入任务文本');
  const agentName=mode==='agent-assistant-v1'?frozen.agentName:'';
  if(mode==='agent-assistant-v1'&&!agentName)throw Error('请输入委托 Agent 名称');
  if(!creation||creation.mode!==mode||creation.message.content!==text||creation.agentName!==agentName){
   creation={mode,agentName,message:{id:'controlled_'+crypto.randomUUID().replaceAll('-',''),role:'user',content:text,timestamp:Date.now(),attachments:[]}};
  }
  const result=group()
   ? await api.groupMemberHandoff({descriptor:frozen.descriptor,action:'start',message:creation.message})
   : await api.prepareSharedSend({descriptor:frozen.descriptor,controlMode:mode,...(agentName&&{delegation:{agentName}}),message:creation.message});
  if(result?.success!==false&&frozen.current()){creation=null;if(input.value===frozen.text)input.value='';}
  return result;
 }
 const create=make('新建受控任务',frozen=>createTask(frozen,'text-only-v1'));
 const toolTask=make('新建工具任务',frozen=>createTask(frozen,'safe-tools-v1'));
 const aaTask=make('新建 AA 委托',frozen=>createTask(frozen,'agent-assistant-v1'));
 const supplement=make('补充到此任务',async frozen=>{const current=frozen.work,text=frozen.text.trim();if(!current||!text)throw Error('请选择受控任务并填写补充文本');const result=await api.submitSharedSteering({descriptor:frozen.descriptor,observedWorkId:current.id,message:{id:'control_input_'+crypto.randomUUID().replaceAll('-',''),role:'user',content:text,timestamp:Date.now(),attachments:[]}});if(result?.success!==false&&frozen.current()&&input.value===frozen.text)input.value='';return result;});
 const groupStart=make('开始两成员接力',frozen=>createTask(frozen,'group-member-handoff-v1'));
 const groupRecover=make('恢复原接力',async frozen=>{
  const result=await api.groupMemberHandoff({descriptor:frozen.descriptor,action:'start',workId:groupWork()?.id});
  if(result?.success===true&&frozen.current()&&input.value===frozen.text){input.value='';creation=null;}
  return result;
 });
 const groupAction=(frozen,action)=>{
  const current=groupWork();
  return api.groupMemberHandoff({descriptor:frozen.descriptor,action,workId:current.id,
   expectedExecutor:current.executor,expectedExecutorVersion:current.executorVersion});
 };
 const handoff=make('接管到本端',frozen=>group()?groupAction(frozen,'handoff'):api.handoffSharedWork({descriptor:frozen.descriptor,workId:frozen.work.id}));
 const proceed=make('本端继续执行',async frozen=>{if(group())return groupAction(frozen,'continue');const current=frozen.work,prepared=await api.prepareSharedContinuation({descriptor:frozen.descriptor,workId:current.id,expectedRevision:current.steering?.revision});if(prepared?.success===false)return prepared;if(!frozen.current())throw Object.assign(Error('CONTROLLED_TOPIC_CHANGED'),{code:'CONTROLLED_TOPIC_CHANGED'});return execute({descriptor:frozen.descriptor,prepared});});
 const check=make('核对任务',()=>refresh());panel.append(heading,description,delegate,input,actions,status);container.before(panel);
 function buttons(){
 if(group()){
  const current=groupWork(),blocked=busy||panel.hidden||value?.connection!=='online';
  const active=Boolean(current&&!['completed','abandoned'].includes(current.state));
  for(const button of [create,toolTask,aaTask,supplement,delegate])button.hidden=true;
  groupStart.hidden=input.hidden=active;
  groupStart.disabled=blocked||active;
  groupRecover.hidden=!current?.canRetryFirst;groupRecover.disabled=blocked||groupRecover.hidden;
  handoff.disabled=blocked||!current?.canHandoff;
  proceed.disabled=blocked||!current?.canContinue;
  check.disabled=busy||panel.hidden;
  return;
 }
 groupStart.hidden=groupRecover.hidden=true;input.hidden=false;
 const current=work(),blocked=busy||panel.hidden;for(const button of [create,toolTask,aaTask,supplement,handoff,proceed,check])button.disabled=blocked;create.hidden=value?.controlledToolsAvailable===true||value?.controlledTextAvailable!==true;
 aaTask.hidden=!value?.controlledAAAvailable;delegate.hidden=aaTask.hidden||Boolean(current);
 toolTask.hidden=!value?.controlledToolsAvailable;
 create.disabled=toolTask.disabled=aaTask.disabled=blocked||Boolean(current);
 supplement.hidden=current?.controlMode!=='text-only-v1';supplement.disabled=blocked||!current;handoff.disabled=blocked||!current||!current.canHandoff||(['safe-tools-v1','agent-assistant-v1'].includes(current.controlMode)&&current.steering?.applicationState!=='awaiting_handoff');proceed.disabled=blocked||!current||current.canHandoff||!['ready','applying'].includes(current.steering?.applicationState);}
 return {update(next,selected){if(key(scope)!==key(selected)){scope=selected;creation=null;input.value='';delegate.value='';status.textContent='';epoch++;}const allowed=next?.enabled===true&&next?.readOnly===false&&key(next.topic)===key(scope)
  &&(group()?next.groupHandoffAvailable===true&&typeof api.groupMemberHandoff==='function'
   :scope?.ownerType==='agent'&&(next?.controlledAAAvailable===true||next?.controlledToolsAvailable===true||next?.executions?.some(job=>job.controlMode==='text-only-v1'&&next?.controlledTextAvailable===true)));if(!panel.hidden&&!allowed)epoch++;value=allowed?next:null;panel.hidden=!allowed;
 if(group()){
  const current=groupWork();
  description.textContent='按群聊顺序发言。第一位成员回复确认后，可在另一设备接管，再继续第二位成员。';
  const state=current?.state==='continuing'&&current.canContinue?'已确认继续操作，等待本端开始第二位成员':groupStages[current?.state];
  status.textContent=current?`${state||'正在核对原接力'}${current.executor?' · 执行端：'+(current.owned?'本端':'另一设备'):''}`:allowed?'当前没有进行中的接力。':'';
  if(current&&!current.fresh)status.textContent+=' · 最近已知';
  buttons();return;
 }
 const current=work();description.textContent=current?.controlMode==='agent-assistant-v1'||(!current&&value?.controlledAAAvailable&&!value?.controlledToolsAvailable)?'一次委托一个 Agent。父请求和原报告均确认后，另一设备可接管、压缩前文并继续。':'工具任务在工具回执确认后暂停。请在本端压缩前文，再到另一端接管并继续。';status.textContent=current?`${current.state==='review_required'||current.phase==='review_required'?stages.blocked:stages[current.steering?.applicationState]||'正在核对原任务'} · 执行端：${current.canHandoff?'另一设备':'本端'}`:allowed?'当前没有进行中的跨端任务。':'';buttons();},dispose(){closed=true;epoch++;clearInterval(timer);panel.remove();}};
}

<script setup>
import MobileIcon from './MobileIcon.vue';
import VoiceOrb from './VoiceOrb.vue';
import VoiceStage from './VoiceStage.vue';
import {changedInputText} from './keyboardOrb.js';
import {createVoiceDictation} from './voiceDictation.js';
import {localSpeechRecognition} from './localSpeech.js';
import {readVoiceDraft,writeVoiceDraft} from './voiceDraftStorage.js';
import AgentAvatar from './AgentAvatar.vue';
import DesktopRelayStatus from './DesktopRelayStatus.vue';
import SharedAttachmentImage from './SharedAttachmentImage.vue';
import InlineAgentRun from './InlineAgentRun.vue';
import ModelBrandMark from './ModelBrandMark.vue';
import {ref,shallowReactive,computed,watch,onMounted,onUnmounted,nextTick} from 'vue';
import TextPages from './TextPages.vue';
import SharedConfigEditor from './SharedConfigEditor.vue';
import SharedDirectoryView from './SharedDirectoryView.vue';
import {sharedHidden} from '../../desktop/modules/nativeSyncSettings/sharedDirectory.js';
import {createExecutionPager} from './executionPages.js';
import {readDirectoryPages,readHistoryBaseline,applyHistoryDelta,directorySources} from './directoryHistory.js';
import {createAttachmentStatusPager} from './attachmentStatus.js';
import {createHistoryCache,historyCacheKey} from './historyCache.js';
import {filterChatModels} from './contracts.generated.js';
import {consumePairingLink} from './pairingLink.js';
import {createPairRecovery} from './pairRecovery.js';
import {uploadAttachment} from './attachmentUpload.js';
import {readAttachment,saveAttachment} from './attachmentRead.js';
import {createSubmissionRecovery,rejectedDraftFiles,restoreRejectedDraft,validSessionRecovery,SUBMISSION_STORAGE_KEY} from './submissionRecovery.js';
import {projectNativeWork,verifyNativeResult,nativeTaskLabels,toolLabels,resultHash} from './nativeTasks.js';
import {createSharedSessionObservers,sharedSessionPreviews} from './sharedSessions.js';
import {consumeSharedEvents} from '../../desktop/modules/services/nativeSync/sharedEventClient.mjs';
const attachmentPager=createAttachmentStatusPager(),historyCache=createHistoryCache();
const executionPager=createExecutionPager(),jobsInfo=ref(null),jobsError=ref('');
const attachmentStates=ref({}),reviewChecks=ref({}),invitedAgent=ref('');
const conversationPanel=ref(''), topicToggle=ref(null), workToggle=ref(null);
const viewportHeight=ref(null), shell=ref(null), composer=ref(null);
const browserOnline=ref(navigator.onLine), coreFeed=ref('');
const themeModes=['system','light','dark'];
const theme=ref('system');
try{const stored=localStorage.getItem('vcp.mobile.theme');if(themeModes.includes(stored))theme.value=stored;}catch{}
const prefersDark=window.matchMedia('(prefers-color-scheme: dark)');
function syncTheme(){
 const dark=theme.value==='dark'||(theme.value==='system'&&prefersDark.matches);
 document.documentElement.dataset.theme=dark?'dark':'light';
 document.querySelector('meta[name="theme-color"]')?.setAttribute('content',dark?'#20211f':'#fcfbf8');
}
function applyTheme(mode){
 theme.value=mode;
 try{localStorage.setItem('vcp.mobile.theme',mode);}catch{}
 syncTheme();
}
syncTheme();
function fitViewport(){
 const vv=window.visualViewport;
 viewportHeight.value=vv&&vv.scale===1?Math.round(vv.height):null;
}
function resizeComposer(){
 const area=composer.value;
 if(!area)return;
 area.style.height='0px';
 area.style.height=area.scrollHeight+'px';
}
watch(composer,resizeComposer,{flush:'post'});
const navigationVisible=computed(()=>conversationPanel.value==='topics' || !selected.value && conversationPanel.value!=='work');
function togglePanel(name){
 if(conversationPanel.value===name){closePanel();return;}
 conversationPanel.value=name;
 nextTick(()=>shell.value?.querySelector(name==='topics'?'#topics-heading':'#work-heading')?.focus());
}
function closePanel(){
 const toggle=conversationPanel.value==='topics'?topicToggle.value:workToggle.value;
 conversationPanel.value='';
 nextTick(()=>toggle?.focus());
}
const attachmentPreview=ref(null),attachmentDialog=ref(null);let attachmentReadRequest=0,attachmentReadController=null;
const attachmentTextPreviewLimit=256*1024;
// Persist composer intent by paired identity and topic. Selected local files
// stay in the page; verified rejections use the existing recovery store.
const drafts=new Map(),composerDraft=ref({text:'',files:[],revision:0});let composerScope='';
const steeringStoragePrefix='vcp.mobile.steering.v1:', steeringStorageError=ref('');
const dismissedSteeringPrefix='vcp.mobile.steering-dismissed.v1:';
const confirmedSteeringKey=(scope,requestId)=>'vcp.mobile.steering-confirmed.v1:'+scope+':'+requestId;
const steeringRecordCorrupt=ref(false), steeringRemovalPrompt=ref(false);
const text=computed({get:()=>composerDraft.value.text,set:value=>{composerDraft.value.text=value;composerDraft.value.revision++;saveDraftEdit(composerDraft.value);}});
watch(text,resizeComposer,{flush:'post'});
const pendingFiles=computed({get:()=>composerDraft.value.files,set:value=>{composerDraft.value.files=value;}});
watch(()=>pendingFiles.value.map(item=>item.file),files=>{
 const file=attachmentPreview.value?.localFile;
 if(file&&!files.includes(file))closeAttachment();
});
const nativeResult=ref(null),nativeResultPanel=ref(null);let nativeResultRequest=0;
let incomingPairing=consumePairingLink({location:window.location,history:window.history,secureContext:window.isSecureContext});
let connectionInitialized=false;
const pairingLinkOpen=ref(false), pairError=ref('');
const paired=ref(false),pairCode=ref(''),topics=ref([]),selected=ref(''),agentId=ref(''),messages=ref([]),jobs=ref([]),busy=ref(true),notice=ref('正在连接…'),online=ref(false),history=ref(null);
const historyAtEnd=ref(true);
const composerMenu=ref(false),expandedDraftAttachment=ref(null),filePicker=ref(null),imagePicker=ref(null);
watch([selected,paired,conversationPanel],()=>{
 composerMenu.value=false;expandedDraftAttachment.value=null;
});
function pickComposerAttachment(kind){
 const input=kind==='image'?imagePicker.value:filePicker.value;
 if(!input||input.disabled)return;
 input.click();
 composerMenu.value=false;
}
const nearHistoryEnd=area=>!area||area.scrollHeight-area.scrollTop-area.clientHeight<48;
function trackHistoryEnd(){historyAtEnd.value=nearHistoryEnd(history.value);}
function returnToLatest(){
 const area=history.value;
 if(area)area.scrollTop=area.scrollHeight;
 trackHistoryEnd();
}
// Preserve the reader's position when the keyboard or composer changes height.
watch(history, (area, previous, onCleanup) => {
 if(!area)return;
 let height=area.clientHeight;
 const nearEnd=()=>nearHistoryEnd(area);
 let anchored=nearEnd();
 const onScroll=()=>{if(area.clientHeight===height)anchored=nearEnd();};
 const observer=new ResizeObserver(()=>{
  const nextHeight=area.clientHeight;
  if(nextHeight!==height && anchored)area.scrollTop=area.scrollHeight;
  height=nextHeight;anchored=nearEnd();trackHistoryEnd();
 });
 area.addEventListener('scroll',onScroll,{passive:true});
 observer.observe(area);
 onCleanup(()=>{area.removeEventListener('scroll',onScroll);observer.disconnect();});
});
const sharedSpaces=ref([]),sharedFeatures=ref([]),sharedStreams=ref([]);
const corePreviews=ref([]);
const terminalCoreStates=new Set(['completed','failed','cancelled','review_required','review_released']);
const terminalCoreWorks=shallowReactive(new Map());
function rememberTerminalCoreWork(id,status,replyId){
 if(!terminalCoreStates.has(status))return false;
 const previous=terminalCoreWorks.get(id);
 // A stale snapshot or event cannot undo a confirmed completion or lose its reply ID.
 if(!previous||status==='completed'&&(previous.status!=='completed'||replyId&&replyId!==previous.replyId))
  terminalCoreWorks.set(id,{status,replyId});
 return true;
}

let coreObserver, coreRefreshTimer;
const coreStorageKey = 'vcp.core.storage-id';
const coreStorageHeaders = () => {
 const storageId=localStorage.getItem(coreStorageKey);
 return storageId ? {'X-VCP-Core-Storage-Id':storageId} : {};
};
const corePath = topic => 'core/' + [topic.sharedSpaceId, topic.key].map(encodeURIComponent).join('/');
function stopCoreObservation() {
 coreObserver?.controller.abort();coreObserver=null;corePreviews.value=[];coreFeed.value='';clearTimeout(coreRefreshTimer);
}
function observeCore(topic) {
 if(coreObserver?.key===topic.key)return;
 stopCoreObservation();
 const controller=new AbortController(),entry={key:topic.key,controller,seq:cursor};
 coreObserver=entry;coreFeed.value='connecting';
 const isCurrent=()=>coreObserver===entry&&!controller.signal.aborted;
 const scheduleRefresh=()=>{clearTimeout(coreRefreshTimer);coreRefreshTimer=setTimeout(()=>{if(isCurrent())void refresh();},120);};
 void (async()=>{
  while(isCurrent()) {
   try {
    const response=await fetch('/mobile/api/'+corePath(topic)+'/observe',{
      credentials:'same-origin',redirect:'error',cache:'no-store',signal:controller.signal,
      headers:{'X-NativeSync-Capabilities':'shared-space-v1',...coreStorageHeaders()}
    });
    if(isCurrent() && response.ok && response.headers.get('content-type')?.includes('text/event-stream'))coreFeed.value='live';
    await consumeSharedEvents(response,(data,type)=>{
     if(!isCurrent())return;
     if(type==='change_seq'&&data.seq!==entry.seq){entry.seq=data.seq;scheduleRefresh();}
     if(type==='native_task'){scheduleRefresh();return;}
     if(!data.workId)return;
     if(type==='work_state'){
      scheduleRefresh();
      if(rememberTerminalCoreWork(data.workId,data.status,data.replyId)){
       const quote=composerDraft.value.taskQuote;
       if(quote?.id===data.workId)quote.closed=data.status;
       corePreviews.value=corePreviews.value.filter(work=>work.id!==data.workId);
       return;
      }
     }
     if(terminalCoreWorks.has(data.workId))return;
     const prior=corePreviews.value.find(work=>work.id===data.workId);
     const next={...prior,id:data.workId};
     if(type==='work_preview'){next.text=data.text;next.speakerName=data.speakerName;}
     if(type==='delta')next.text=((next.text||'')+data.text).slice(-256*1024);
     if(type==='approval_requested')next.approval=data.toolName;
     if(type==='approval_settled')delete next.approval;
     if(type==='tool'){next.tool=data.pluginName;next.toolStatus=data.status;}
     if(type==='resident_presentation')next.presentation=data;
     corePreviews.value=[...corePreviews.value.filter(work=>work.id!==data.workId),next];
    },{signal:controller.signal,envelope:true});
   }catch(error){
    if(!isCurrent())break;
    coreFeed.value='paused';
    if(error.code==='SHARED_EVENT_PERMISSION_REQUIRED')break;
    await new Promise(resolve=>setTimeout(resolve,1000));
   }
  }
 })().finally(()=>{if(coreObserver===entry)coreObserver=null;});
}
async function refreshCore(topic, readApi, context, current) {
 const base=corePath(topic);
 let rows=[], before, seq;
 if(historyKey===topic.key && baselineReady){
  const currentRows=new Map(messages.value.map(message=>[message.id,message]));
  seq=cursor;
  for(;;){
   const page=await readApi(base+'/changes?'+new URLSearchParams({after:String(seq)}));
   if(!current())return;
   for(const event of page.changes){
    if(event.message===null)currentRows.delete(event.messageId);
    else if(event.message)currentRows.set(event.messageId,event.message);
   }
   seq=page.next;if(seq>=page.head)break;
  }
  rows=[...currentRows.values()];
 }else do {
  const page=await readApi(base+'/messages?'+new URLSearchParams({limit:'500',...(before&&{before:String(before)})}));
  if(!current())return;
  if(seq!==undefined&&seq!==page.seq)throw Object.assign(Error('会话正在更新，请重试'),{code:'CORE_SNAPSHOT_CHANGED'});
  seq=page.seq;rows.unshift(...page.messages);before=page.hasMore?page.nextBefore:undefined;
 }while(before);
 const {works}=await readApi(base+'/works');
 if(!current())return;
 for(const {id,status,replyId} of works)rememberTerminalCoreWork(id,status,replyId);
 if(corePreviews.value.some(work=>terminalCoreWorks.has(work.id)))
  corePreviews.value=corePreviews.value.filter(work=>!terminalCoreWorks.has(work.id));
 await displayHistory(rows,current);
 if(!current())return;
 cursor=seq;historyKey=topic.key;baselineReady=true;
 attachmentStates.value=Object.fromEntries(rows.flatMap(message=>message.attachments.map(item=>[
  message.id+'/'+item.id,{state:'available',type:item.type}
 ])));
 jobs.value=works.map(work=>({...work,topicKey:topic.key,state:work.status,own:work.owner,core:true}));
 historyContextReady.value=true;online.value=true;historyProgress.value=null;
 topic.messageCount=rows.length;
 observeCore(topic);
 if(context&&loadRecovery()){
  const pending=submissionStore.current({entryId:context.recovery.entryId,topicKey:context.topicKey});
  if(pending){
   const {executions}=await readApi(base+'/receipt?'+new URLSearchParams({requestId:pending.requestId}));
   await reconcileSubmission(pending,executions,context);
  }
  await reconcileSteering(topic,readApi,context);
 }
}

const directoryAgents=ref(null),directoryNotice=ref(''),directoryFetchError=ref(''),sourceProgress=ref([]);
const historyContextReady=ref(false);
const sourceFilter=ref('*'),sourceKey=row=>row?.sourceId||'';
const expandedLongText=ref(new Set()),expandedAttachmentText=ref(new Set()),historyStart=ref(0),historyProgress=ref(null);
const visibleMessages=computed(()=>messages.value.slice(historyStart.value));
const attachmentTextKey=(m,a,index)=>JSON.stringify([selected.value,m.id,a.id,index]);
function toggleAttachmentText(m,a,index,event){if(!event.target.isConnected)return;const next=new Set(expandedAttachmentText.value),key=attachmentTextKey(m,a,index);if(event.target.open)next.add(key);else next.delete(key);expandedAttachmentText.value=next;}
async function showEarlierMessages(){const element=history.value,top=element?.scrollTop||0,height=element?.scrollHeight||0,epoch=generation,key=selected.value;historyStart.value=Math.max(0,historyStart.value-40);await nextTick();if(element&&element===history.value&&epoch===generation&&key===selected.value)element.scrollTop=top+element.scrollHeight-height;}
async function displayHistory(rows,current){
 if(!current())return;
 const element=history.value,stick=nearHistoryEnd(element),anchor=messages.value[historyStart.value]?.id;
 const sorted=rows.sort((a,b)=>(a.ordinal??a.timestamp)-(b.ordinal??b.timestamp)),index=anchor?sorted.findIndex(m=>m.id===anchor):-1;
 historyStart.value=stick?Math.max(0,sorted.length-40):Math.max(0,index);messages.value=sorted;
 await nextTick();if(current()){if(stick)returnToLatest();else trackHistoryEnd();}
}
const longTextKey=m=>JSON.stringify([selected.value,m.id]);
function toggleLongText(m){const next=new Set(expandedLongText.value),key=longTextKey(m);if(next.has(key))next.delete(key);else next.add(key);expandedLongText.value=next;}
const sources=computed(()=>directorySources(directoryAgents.value||[],topics.value));
const sourceMatches=row=>sourceFilter.value==='*'||sourceKey(row)===sourceFilter.value;
const sourceName=row=>sources.value.find(s=>s.key===sourceKey(row))?.label||'选定会话';
let lastDirectory=null;
let directoryPaged=false,directoryRevision='',directoryLoading=false,directoryRequest=0,baselineReady=false,baselineRequestId='';
const settingsOpen=ref(false),serverUrl=ref(''),accessKey=ref(''),server=ref(null),tested=ref(false);
const recoveryContext=ref(null),recoveryRecords=ref([]),recoveryError=ref(''),recoveryDetail=ref(''),acceptedReceipt=ref(null);
const browserOrigin=window.location.origin;
const pairingRecovery=createPairRecovery({origin:browserOrigin,indexedDB:window.indexedDB,crypto:window.crypto,locks:navigator.locks,secureContext:window.isSecureContext});
const pairRecoveryNotice=ref('');
let startupSessionController=null, needsSessionRecovery=false;
const submissionStore=createSubmissionRecovery({origin:browserOrigin,getStorage:()=>window.localStorage});
let timer,refreshing=null,historyKey='',cursor=0,historyRows=new Map(),generation=0,authEpoch=0,submissionNoticeHeld=false,historyBinding='',historyFromCache=false;
let pageSuspended=false,sharedRefreshTimer=null,sharedRefreshPending=false;
const sharedObserver=createSharedSessionObservers({
 openEvents:(query,{signal})=>fetch('/mobile/api/shared/session-events?'+new URLSearchParams(query),{credentials:'same-origin',cache:'no-store',redirect:'error',headers:{'X-NativeSync-Capabilities':'shared-space-v1,shared-events-v1'},signal}),
 onChange:values=>{sharedStreams.value=values;},
 onSettled:(_value,context)=>scheduleSharedRefresh(context),onStatus:(_value,context)=>scheduleSharedRefresh(context),
 onDenied:(error,context)=>{if(!sameSharedView(context))return;if(error.status===401){paired.value=false;invalidateSession();notice.value='设备会话已失效，临时观察已关闭；原提交记录继续保留。';}else{notice.value='当前话题观察权限已变化，正在核对目录。';refreshView().catch(()=>{});}}
});
function sameSharedView(context){return context&&paired.value&&!pageSuspended&&context.topicKey===selected.value&&context.generation===generation&&context.authEpoch===authEpoch&&context.entryId===recoveryContext.value?.entryId&&context.sessionMarker===recoveryContext.value?.sessionMarker;}
function syncSharedObservers(){const topic=topics.value.find(t=>t.key===selected.value);sharedObserver.sync({enabled:paired.value&&!pageSuspended&&['agent','group'].includes(topic?.ownerType||'agent')&&sharedFeatures.value.includes('shared-events-v1'),sharedSpaceId:topic?.sharedSpaceId,topicKey:topic?.key,generation,authEpoch,entryId:recoveryContext.value?.entryId,sessionMarker:recoveryContext.value?.sessionMarker,jobs:jobs.value,committedIds:messages.value.map(m=>m.id)});}
function scheduleSharedRefresh(context){
 if(!sameSharedView(context))return;sharedRefreshPending=true;if(sharedRefreshTimer)return;
 const check=async()=>{sharedRefreshTimer=null;if(!sameSharedView(context)){sharedRefreshPending=false;return;}if(refreshing){sharedRefreshTimer=setTimeout(check,100);return;}sharedRefreshPending=false;await refresh();};
 sharedRefreshTimer=setTimeout(check,50);
}
function clearSharedObservers(){stopCoreObservation();clearTimeout(sharedRefreshTimer);sharedRefreshTimer=null;sharedRefreshPending=false;sharedObserver.reset();}
const visibleSharedStreams=computed(()=>sharedSessionPreviews(sharedStreams.value,messages.value.map(message=>message.id)));
const sharedActivityLabels={started:'原生工具执行中',accepted:'原生任务已接收',settled:'原生工具已返回',observed:'原生任务状态已更新',waiting_approval:'等待原生审批',running:'原生执行中'};
const ownerKey=t=>JSON.stringify([t.ownerType||'agent',t.sharedOwnerId||t.ownerId||t.agentName]);
const labels={accepted:'已受理，等待执行',dispatched:'原生执行中',waiting_approval:'等待原生工具审批',review_required:'执行中断 · 接力已暂停',blocked_config:'上下文或配置不可用 · 接力已暂停',recovering:'正在恢复已保存的结果',interrupted:'已中断 · 不自动重跑',preparing:'正在持久保存',queued:'已接受 · 等待执行',running:'服务端执行中',cancelling:'正在取消',cancelled:'已取消',publishing:'正在保存回复',completed:'回复已保存',failed:'执行失败'};
const agents=computed(()=>directoryAgents.value?directoryAgents.value.map(a=>{const id=JSON.stringify([a.ownerType||'agent',a.id]),topic=topics.value.find(t=>ownerKey(t)===id);return {...a,sourceId:a.sourceId||topic?.sourceId,sourceLabel:a.sourceLabel||topic?.sourceLabel,id,name:(a.ownerType==='group'?'群聊 · ':'')+a.name};}):[...new Map(topics.value.map(t=>[ownerKey(t),{id:ownerKey(t),name:(t.ownerType==='group'?'群聊 · ':'')+t.agentName,avatar:t.avatar,model:t.model,executable:t.executable,sourceId:t.sourceId,sourceLabel:t.sourceLabel}])).values()]);
const visibleAgents=computed(()=>agents.value.filter(sourceMatches));
const topicSearch=ref('');
const visibleTopics=computed(()=>topics.value.filter(t=>sourceMatches(t)&&ownerKey(t)===agentId.value));
const searchedTopics=computed(()=>{const query=topicSearch.value.trim().toLocaleLowerCase();return query?visibleTopics.value.filter(t=>[t.topicName,t.topicId].some(value=>String(value||'').toLocaleLowerCase().includes(query))):visibleTopics.value;});
const topicLimit=ref(30);
watch([topicSearch,agentId,sourceFilter],()=>{topicLimit.value=30;});
const activeAgent=computed(()=>agents.value.find(a=>a.id===agentId.value));
function openTopic(key){
 if(busy.value)return;
 if(key!==selected.value){selected.value=key;void changeTopic();}
 closePanel();
}
const currentTopic=computed(()=>{const topic=topics.value.find(t=>t.key===selected.value);if(topic&&!historyContextReady.value)return{...topic,executable:false,unavailableReason:'HISTORY_CONTEXT_LOADING'};return topic&&!(topic.sharedSpaceId&&topic.ownerType==='agent')&&historyKey===selected.value&&messages.value.some(m=>m.desktopReferences?.length)?{...topic,executable:false,unavailableReason:'DESKTOP_CONTEXT_REQUIRED'}:topic;});
function draftScope(){const topic=currentTopic.value;return paired.value&&validSessionRecovery(recoveryContext.value)&&topic?JSON.stringify([recoveryContext.value.entryId,recoveryContext.value.sessionMarker,ownerKey(topic),topic.topicId,topic.key]):'';}
function switchDraft(next=draftScope()){
 if(next===composerScope)return;
 resetVoice();
 if(composerScope&&!text.value&&!pendingFiles.value.length&&!composerDraft.value.submitted&&!composerDraft.value.coreSteering&&!composerDraft.value.nextModel&&!composerDraft.value.missingAttachments)drafts.delete(composerScope);
 composerScope=next;composerDraft.value=drafts.get(next)||{text:'',files:[],revision:0};
 steeringStorageError.value='';
 steeringRecordCorrupt.value=false;
 steeringRemovalPrompt.value=false;
 if(next){
  const draft=composerDraft.value;
  drafts.set(next,draft);
  if(!draft.revision&&!draft.ordinaryEditId&&!draft.coreSteering){
   const saved=readOrdinaryText(next);
   if(saved?.quote&&!draft.text){draft.text=saved.text;draft.taskQuote=saved.quote;draft.ordinaryEditId=saved.editId;}
   if(typeof saved?.nextModel==='string'){
    draft.nextModel=saved.nextModel;
    draft.restoredModel=true;
    draft.modelUnavailable=saved.modelUnavailable===true;
   }
   if(Number.isInteger(saved?.localAttachments)&&saved.localAttachments>0&&saved.localAttachments<=8)
    draft.missingAttachments=saved.localAttachments;
  }
  syncSteeringDraft();
  syncRejectedDraft();
 }
}
function syncRejectedDraft(){
 if(!composerScope||composerScope!==draftScope())return;
 const draft=composerDraft.value;
 if(draft.revision||draft.submitted||draft.taskQuote||draft.coreSteering||draft.files.some(item=>item.file))return;
 try{
  const saved=submissionStore.rejectedDraft({...recoveryContext.value,topicKey:selected.value});
  if(!saved&&!draft.rejected)return;
  draft.rejected=saved;
  draft.text=saved?.text||'';
  draft.files=saved?rejectedDraftFiles(saved):[];
 }catch(error){recoveryError.value=recoveryMessage(error);}
}
const composerText=computed({get:()=>text.value,set:value=>{
 text.value=value;
 const draft=composerDraft.value;
 const review=draft.voiceReview;
 if(!value)delete draft.voiceReview;
 if(review||draft.voiceDurable||draft.taskQuote||!draft.rejected||draft.nextModel||draftLocalAttachmentCount(draft))rememberOrdinaryText(draft,composerScope);
 else delete draft.ordinaryEditId;
}});
const ordinaryDraftPrefix='vcp.mobile.draft.v1:';
const steeringDeliveredEditPrefix='vcp.mobile.steering-delivered-edit.v1:';
const steeringDeliveredEditKey=(scope,editId)=>steeringDeliveredEditPrefix+scope+':'+editId;
const ordinaryDraftError=ref('');
function storedOrdinaryText(scope){
 try{
  const item=JSON.parse(localStorage.getItem(ordinaryDraftPrefix+scope));
  if(typeof item?.text!=='string'||typeof item.editId!=='string')return null;
  if(item.quote&&!validTaskQuote(item.quote))return null;
  return item;
 }catch{return null;}
}
function ordinaryEditDelivered(scope,item){
 return item?.quote&&(localStorage.getItem(steeringDeliveredEditKey(scope,item.editId))==='1'||
     localStorage.getItem(steeringDeliveredEditPrefix+scope)===item.editId);
}
function readOrdinaryText(scope){
 try{
  const item=storedOrdinaryText(scope);
  return ordinaryEditDelivered(scope,item)?null:item;
 }catch{return null;}
}
async function restoreOrdinaryText(draft,scope){
 if(draft.revision||draft.coreSteering||draft.voiceLoaded)return;
 const initial=readOrdinaryText(scope);
 if(initial&&!draft.rejected&&!draft.text){
  draft.text=initial.text;
  draft.ordinaryEditId=initial.editId;
 }
 const stored=await readVoiceDraft(scope).catch(()=>null);
 if(composerScope!==scope||composerDraft.value!==draft||draft.revision||draft.coreSteering)return;
 draft.voiceLoaded=true;
 const local=readOrdinaryText(scope);
 const saved=stored&&(!local||stored.savedAt>=(local.savedAt||0))?stored:local;
 if(!saved||!(stored||saved.voiceDurable||saved.voiceReview||saved.voicePreview))return;
 if(saved.requestId&&(saved.requestId!==local?.requestId||saved.editId!==local.editId))return;
 try{if(ordinaryEditDelivered(scope,saved))return;}catch{return;}
 draft.voiceDurable=true;
 draft.ordinaryEditId=saved.editId;
 draft.text=saved.voicePreview?mergeVoiceText(saved.text,saved.voicePreview):saved.text;
 draft.voiceReview=Boolean(draft.text&&(saved.voiceReview===true||(!saved.voicePreviewFinal&&draft.text!==saved.text)));
 if(saved===stored&&saved.editId!==local?.editId){
  draft.taskQuote=saved.quote;
  draft.nextModel=saved.nextModel;
  draft.restoredModel=Boolean(saved.nextModel);
  draft.modelUnavailable=saved.modelUnavailable===true;
  draft.missingAttachments=saved.localAttachments;
 }
 if(saved.voicePreview||saved.editId!==local?.editId){
  draft.revision++;
  rememberOrdinaryText(draft,scope);
  if(saved.voicePreview)saveDraftEdit(draft);
 }
}
function draftLocalAttachmentCount(draft){
 const prepared=draft.submitted?.prepared?draft.submitted.files:[];
 const rejected=draft.rejected;
 const localOnly=(draft.files||[]).filter(item=>{
  const recoverable=rejected&&item.uploadSessionMarker===rejected.sessionMarker&&rejected.attachments.includes(item.uploadId);
  return item.file&&!prepared.includes(item)&&!recoverable;
 });
 return (draft.missingAttachments||0)+localOnly.length;
}
function persistVoiceDraft(draft,scope,record){
 draft.voiceDurable=true;
 draft.voiceLoaded=true;
 const saving=writeVoiceDraft(scope,record).catch(()=>{
  if(scope===composerScope)ordinaryDraftError.value='听写草稿暂无法持久保存，关闭页面前请检查存储。';
 });
 voiceDraftWrites.set(draft,saving);
 void saving.then(()=>{if(voiceDraftWrites.get(draft)===saving)voiceDraftWrites.delete(draft);});
 return saving;
}
const voiceDraftWrites=new WeakMap();
function rememberOrdinaryText(draft,scope){
 if(!scope)return false;
 const previous=storedOrdinaryText(scope);
 const voiceDurable=draft.voiceDurable||previous?.voiceDurable;
 const record={text:draft.text,editId:crypto.randomUUID(),savedAt:performance.timeOrigin+performance.now(),
  ...(voiceDurable&&{voiceDurable:true}),
  ...(draft.voicePreview&&{voicePreview:draft.voicePreview,...(draft.voicePreviewFinal&&{voicePreviewFinal:true})}),
  ...(draft.voiceReview&&{voiceReview:true}),
  ...(draft.taskQuote&&{quote:draft.taskQuote}),...(draft.nextModel&&{nextModel:draft.nextModel}),
  ...(draft.nextModel&&draft.modelUnavailable&&{modelUnavailable:true})};
 const localAttachments=draftLocalAttachmentCount(draft);
 if(localAttachments)record.localAttachments=localAttachments;
 if(voiceDurable)persistVoiceDraft(draft,scope,record);
 try{
  if(draft.text||draft.voicePreview||draft.taskQuote||draft.nextModel||localAttachments){
   localStorage.setItem(ordinaryDraftPrefix+scope,JSON.stringify(record));
   draft.ordinaryEditId=record.editId;
  }else{
   localStorage.removeItem(ordinaryDraftPrefix+scope);
   delete draft.ordinaryEditId;
  }
  if(previous?.quote)localStorage.removeItem(steeringDeliveredEditKey(scope,previous.editId));
  ordinaryDraftError.value='';
  return true;
 }catch{
  ordinaryDraftError.value='草稿暂无法保存在此浏览器，刷新前请检查存储。';
  return false;
 }
}
function markOrdinarySubmission(draft,scope,requestId){
 const saved=readOrdinaryText(scope);
 if(!saved||saved.editId!==draft.ordinaryEditId)return;
 // The durable submission owns its model and upload references from here.
 // Later edits keep their own draft ID and must survive this request's receipt.
 const record={...saved,requestId:draft.revision===draft.submitted.revision?requestId:undefined,
  nextModel:draft.nextModel,modelUnavailable:draft.nextModel&&draft.modelUnavailable||undefined,
  localAttachments:draftLocalAttachmentCount(draft)||undefined};
 if(draft.voiceDurable)persistVoiceDraft(draft,scope,record);
 try{localStorage.setItem(ordinaryDraftPrefix+scope,JSON.stringify(record));}
 catch{ordinaryDraftError.value='草稿暂无法保存在此浏览器，刷新前请检查存储。';}
}
function forgetOrdinarySubmission(record,scope){
 const saved=readOrdinaryText(scope);
 if(saved?.requestId!==record.requestId)return;
 try{localStorage.removeItem(ordinaryDraftPrefix+scope);return saved;}
 catch{ordinaryDraftError.value='本机草稿的送达状态暂无法更新。';}
}
function confirmOrdinaryText(draft,record,scope){
 const saved=forgetOrdinarySubmission(record,scope);
 if(saved&&draft.ordinaryEditId===saved.editId){
  draft.text='';delete draft.voiceReview;delete draft.ordinaryEditId;delete draft.missingAttachments;
  if(draft.voiceDurable)rememberOrdinaryText(draft,scope);
 }
}
watch(composerDraft,draft=>{
 ordinaryDraftError.value='';
 if(composerScope)restoreOrdinaryText(draft,composerScope);
});
function draftContents(draft,sessionMarker){
 return {text:draft.text,attachments:draft.files.filter(file=>file.uploadId&&file.uploadSessionMarker===sessionMarker).map(file=>file.uploadId)};
}
const draftWrites=new WeakMap();
function saveDraftEdit(draft){
 if(!draft.rejected)return;
 const contents=draftContents(draft,draft.rejected.sessionMarker);
 const prior=draftWrites.get(draft)||Promise.resolve();
 const write=prior.catch(()=>{}).then(async()=>{
  if(draft.rejected){draft.rejected=await submissionStore.updateRejectedDraft(draft.rejected,contents);}
 });
 draftWrites.set(draft,write);
 const finish=()=>{if(draftWrites.get(draft)===write)draftWrites.delete(draft);};
 write.then(finish,error=>{
  finish();if(composerDraft.value!==draft)return;
  submissionNoticeHeld=true;notice.value='草稿修改尚未保存：'+recoveryMessage(error);
 });
}
function removeDraftFile(index){
 const draft=composerDraft.value,[removed]=draft.files.splice(index,1);
 draft.revision++;saveDraftEdit(draft);
 if(removed?.file)rememberOrdinaryText(draft,composerScope);
}
function confirmDraft(record,context){
 const draft=drafts.get(context.draftScope),sent=draft?.submitted;
 if(!draft)return;
 confirmOrdinaryText(draft,record,context.draftScope);
 if(!sent||sent.requestId!==record.requestId){syncRejectedDraft();return;}
 draft.rejected=submissionStore.rejectedDraft(record);
 if(draft.revision===sent.revision&&draft.text===record.payload.text){draft.text='';delete draft.voiceReview;}
 draft.files=draft.files.filter(item=>!sent.files.includes(item));
 delete draft.submitted;
 if(context.draftScope!==composerScope&&!draft.text&&!draft.files.length)drafts.delete(context.draftScope);
}
// Keep the original executions for submission reconciliation. This separate
// projection only displays bounded, correlated native task facts.
const displayedToolStatus={...toolLabels,dispatched:'工具已派发，等待返回',unknown:'工具结果待核对'};
const workMessageNames=computed(()=>new Map(messages.value.map(message=>[message.id,
 typeof message.content==='string'?message.content.slice(0,160).trim():'' ])));
const hasWorkReply=job=>job.core&&job.state==='completed'&&workMessageNames.value.has(job.replyId);
const workReplySyncing=job=>job.core&&job.state==='completed'&&Boolean(job.replyId)&&!hasWorkReply(job);
const replyVisibility=shallowReactive(new Map());
const replyElements=new Map();
const renderedReplyIds=computed(()=>new Set(visibleMessages.value.filter(message=>message.role==='assistant').map(message=>message.id)));
let replyObserver;
watch(history,area=>{
 replyObserver?.disconnect();
 replyVisibility.clear();
 replyObserver=area?new IntersectionObserver(entries=>{
  if(history.value!==area)return;
  for(const entry of entries){
   const id=entry.target.dataset.messageId;
   if(replyElements.get(id)===entry.target)replyVisibility.set(id,entry.isIntersecting);
  }
 },{root:area}):undefined;
 if(replyObserver)for(const element of replyElements.values())replyObserver.observe(element);
});
onUnmounted(()=>replyObserver?.disconnect());
function observeReplyElement(id,element){
 const old=replyElements.get(id);
 if(old===element)return;
 if(old)replyObserver?.unobserve(old);
 if(replyVisibility.has(id))replyVisibility.delete(id);
 if(element){replyElements.set(id,element);replyObserver?.observe(element);}
 else replyElements.delete(id);
}
const needsWorkReplyLink=job=>hasWorkReply(job)&&
 (!renderedReplyIds.value.has(job.replyId)||replyVisibility.get(job.replyId)===false);
function observedCoreWork(job){
 const terminal=terminalCoreWorks.get(job.id);
 return terminal?.status==='completed'
  ? {...job,state:'completed',replyId:terminal.replyId||job.replyId}
  : job;
}
async function openWorkReply(job){
 if(job.topicKey!==selected.value||!hasWorkReply(job))return;
 const epoch=generation,area=history.value;
 const index=messages.value.findIndex(message=>message.id===job.replyId);
 historyStart.value=Math.min(historyStart.value,index);
 conversationPanel.value='';
 await nextTick();
 if(epoch!==generation||area!==history.value)return;
 const reply=area?.querySelector('[data-message-id="'+CSS.escape(job.replyId)+'"]');
 reply?.focus({preventScroll:true});
 reply?.scrollIntoView({block:'nearest'});
 trackHistoryEnd();
}
function workTime(createdAt){
 return Number.isFinite(createdAt)?new Date(createdAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}):'';
}
const displayJobs=computed(()=>jobs.value.map(job=>{try{if(job.topicKey!==selected.value)throw Error('NATIVE_TASK_TOPIC_MISMATCH');if(job.core)return {...observedCoreWork(job),nativeTasks:(job.tasks||[]).map(task=>({...task,nativeTaskId:task.id,agentBaseName:task.agent,resultRef:task.revision===1?task.id:null})),toolInvocations:(job.tools||[]).map(tool=>({invocationId:tool.id,pluginName:tool.name,state:tool.status}))};return {...job,...projectNativeWork(job)};}catch{return {...job,nativeTasks:[],toolInvocations:[],nativeTaskError:'原生任务关联暂不能核对，请刷新或在宿主检查。'};}}));
const inlineRuns=computed(()=>{
 const byMessage=new Map();
 for(const job of displayJobs.value){
  if(!job.core||job.topicKey!==selected.value||!job.messageId)continue;
  if(!byMessage.has(job.messageId))byMessage.set(job.messageId,[]);
  byMessage.get(job.messageId).push(job);
 }
 return byMessage;
});
const inlineLive=computed(()=>new Map(corePreviews.value.map(work=>[work.id,work])));
const replyInProgress=new Set(['queued','running','cancelling']);
const backgroundInProgress=new Set(['accepted','waiting','running','cancelling']);
const backgroundTasks=job=>(job.tasks||[]).filter(task=>backgroundInProgress.has(task.state));
const backgroundRunLabel=job=>{
 if(job.state==='waiting_approval'||(!terminalCoreStates.has(job.state)&&inlineLive.value.get(job.id)?.approval))return '等待桌面审批';
 if(backgroundTasks(job).length)return '后台任务进行中';
 return '';
};
const coreDisconnected=computed(()=>!online.value||!browserOnline.value||coreFeed.value==='paused');
const coreReplyPreviews=computed(()=>corePreviews.value.filter(work=>work.text?.trim()||work.presentation));
function checkingCoreWork(job){
 return workReplySyncing(job)||needsReview(job)||(replyInProgress.has(job.state)&&coreDisconnected.value);
}
function waitingForCoreReply(job){
 const preview=inlineLive.value.get(job.id);
 return replyInProgress.has(job.state)&&!checkingCoreWork(job)&&!preview?.text?.trim()&&!preview?.presentation;
}
function checkInlineWork(job){
 if(job.topicKey!==selected.value)return;
 if(needsReview(job))togglePanel('work');
 else void refresh();
}
const failedByMessage=computed(()=>new Map(jobs.value.filter(work=>work.core&&work.topicKey===selected.value&&work.state==='failed'&&work.messageId)
 .map(work=>[work.messageId,work])));
watch([visibleSharedStreams,corePreviews,failedByMessage],async()=>{
 const area=history.value,key=selected.value,stick=nearHistoryEnd(area);
 if(!area)return;
 await nextTick();
 if(area!==history.value||key!==selected.value)return;
 if(stick)returnToLatest();
 else trackHistoryEnd();
});
const keyAllowed=computed(()=>Boolean(isSecureContext&&server.value?.credentialExchangeAllowed));
const pendingSubmission=computed(()=>recoveryRecords.value.find(record=>record.entryId===recoveryContext.value?.entryId&&record.topicKey===selected.value)||null);
const recoveryBlocker=computed(()=>recoveryError.value||(!validSessionRecovery(recoveryContext.value)?'当前服务端未提供可靠提交恢复信息，暂不能发送。':''));
const desktopRelays=computed(()=>jobsInfo.value?.desktopRelays || []);
const workButtonText=computed(()=>{
 if(recoveryBlocker.value)return '提交受限';
 if(pendingSubmission.value)return '提交待确认';
 if(jobsError.value)return '任务状态待核对';
 if(displayJobs.value.some(j=>j.state==='waiting_approval'))return '等待审批';
 if(displayJobs.value.some(needsReview)||desktopRelays.value.some(r=>r.state==='review_required'))return '任务待核对';
 if(desktopRelays.value.some(r=>r.state==='awaiting_handoff'))return '等待桌面接管';
 if(desktopRelays.value.some(r=>r.state==='awaiting_continue'))return '等待桌面继续';
 if(desktopRelays.value.some(r=>r.state==='first_member'||r.state==='continuing'))return '桌面接力中';
 if(displayJobs.value.some(j=>j.core?backgroundRunLabel(j):['running','dispatched','continuing','queued','accepted','publishing'].includes(j.state)))return '任务进行中';
 return '任务状态';
});
const workTone=computed(()=>workButtonText.value==='任务状态'?'neutral':workButtonText.value==='任务进行中'||workButtonText.value==='桌面接力中'?'active':'attention');
const connectionBanner=computed(()=>{
 if(!selected.value)return '';
 if(!browserOnline.value)return '当前设备已离线。已加载的内容仍可阅读。';
 if(!online.value)return '暂未连上服务端。当前显示最近已读到的内容。';
 if(currentTopic.value?.coreSingle&&coreFeed.value==='paused')return '实时更新已断开，正在核对服务端记录。';
 return '';
});
const visibleNotice=computed(()=>{
 if(['正在连接…','中央会话已更新',errors.PAIR_REQUIRED].includes(notice.value))return '';
 if(notice.value.startsWith('云端已接受 · ')){
  const job=displayJobs.value.find(row=>row.id===acceptedReceipt.value?.id);
  // An admission receipt is not a live execution status.
  return job?'':'消息已被服务端接受，可在任务状态中核对。';
 }
 return notice.value;
});
const newSubmissionBlocked=computed(()=>Boolean(recoveryBlocker.value||pendingSubmission.value||steeringStorageError.value||composerDraft.value.coreSteering||!historyContextReady.value));
const recoveryMessages={SUBMISSION_LOCK_UNAVAILABLE:'当前浏览器无法取得跨页面提交保护；已有原记录或草稿会继续保留，提交是否受理请先核对。请使用支持此保护的安全浏览器入口。',SUBMISSION_STORE_UNAVAILABLE:'无法保存或读取待确认提交，请检查浏览器存储后再试。',SUBMISSION_STORE_CORRUPT:'本地待确认提交校验失败，原记录已保留，请先核对。',SUBMISSION_STORE_BUDGET:'本地待确认提交已达到保存上限，请先核对已有提交。',SUBMISSION_STORE_UNVERIFIED:'待确认提交未能完成保存校验，本次未获本地确认。',SUBMISSION_CRYPTO_UNAVAILABLE:'当前入口无法校验提交身份，暂不能发送。',SUBMISSION_RECOVERY_UNAVAILABLE:'当前服务端未提供可靠提交恢复信息，暂不能发送。',SUBMISSION_TOPIC_UNAVAILABLE:'当前会话未获此话题授权，原提交继续保留，请使用原有授权核对。',SUBMISSION_CONTEXT_CHANGED:'提交前会话或入口已变化，服务端未受理，原提交保留待核对。',SUBMISSION_PENDING:'本话题有待确认提交，请先核对原提交；其他话题仍可使用。',SUBMISSION_RECORD_CHANGED:'待确认记录已变化，请重新核对，不会另建提交。',SUBMISSION_RECEIPT_UNVERIFIED:'回执未能唯一匹配原提交，已保留记录等待核对。',SUBMISSION_INVALID:'提交内容或身份不完整，本次未发送。'};
const recoveryReasons={metadata:'缺少可信恢复信息，原提交保留待核对，不会补发。',scope:'执行列表与原话题不一致，原提交保留待核对。',ambiguous:'发现多个同身份候选，原提交保留待核对。',conflict:'云端候选与原提交身份或内容不同，原提交保留待核对。',session:'会话已变更，尚未查到原提交的可信结果；原记录保留，不会在新会话补发。'};
function recoveryMessage(error){return recoveryMessages[error.code]||error.message||'无法核对原提交，请稍后再试。';}
function loadRecovery(){try{recoveryRecords.value=submissionStore.load();recoveryError.value='';return true;}catch(error){recoveryError.value=recoveryMessage(error);return false;}}
function invalidateSession(){conversationPanel.value='';clearSharedObservers();sharedFeatures.value=[];lastDirectory=null;historyCache.clear();directoryRequest++;closeNativeResult();closeAttachment();authEpoch++;submissionNoticeHeld=false;recoveryContext.value=null;switchDraft();recoveryDetail.value='';acceptedReceipt.value=null;resetHistory({remember:false});}
function captureContext(){if(!paired.value||!selected.value||!validSessionRecovery(recoveryContext.value))throw Object.assign(Error(recoveryMessages.SUBMISSION_RECOVERY_UNAVAILABLE),{code:'SUBMISSION_RECOVERY_UNAVAILABLE'});return {topicKey:selected.value,recovery:{...recoveryContext.value},generation,authEpoch,draftScope:draftScope()};}
function sameView(context){return context.topicKey===selected.value&&context.generation===generation&&context.authEpoch===authEpoch&&context.recovery?.entryId===recoveryContext.value?.entryId&&context.recovery?.sessionMarker===recoveryContext.value?.sessionMarker;}
function newSubmissionContext(){if(!loadRecovery())throw Error(recoveryError.value);const context=captureContext();if(!historyContextReady.value)throw Object.assign(Error('正在载入历史并核对上下文'),{code:'HISTORY_CONTEXT_LOADING'});if(!currentTopic.value)throw Object.assign(Error(recoveryMessages.SUBMISSION_TOPIC_UNAVAILABLE),{code:'SUBMISSION_TOPIC_UNAVAILABLE'});if(submissionStore.current({entryId:context.recovery.entryId,topicKey:context.topicKey}))throw Object.assign(Error(recoveryMessages.SUBMISSION_PENDING),{code:'SUBMISSION_PENDING'});return context;}
const errors={CORE_AGENT_INSTRUCTIONS_PLAIN_TEXT:'名称和简短指令请使用纯文本，去掉 VCP 模板标记。',CORE_MODEL_NOT_ALLOWED:'这个模型已不在 Core 允许的目录中，请重新选择',CORE_MODEL_CATALOG_UNAVAILABLE:'暂时无法读取 Core 模型目录',INVALID_PAIRING:'配对码无效、已使用或过期，请生成新码。',CORE_DATABASE_IDENTITY_MISMATCH:'此地址的 Core 数据库身份已变化，连接已暂停。请恢复原数据库。',SHARED_TOPIC_BUSY:'此话题正在另一端执行，草稿已保留；完成后请显式重试',SHARED_GROUP_EXECUTION_NOT_READY:'共享群聊暂为只读，发送接线尚未完成',SHARED_CONFIG_PENDING:'共享配置正在核对，请稍后显式发送',SHARED_CONFIG_CONFLICT:'共享配置存在冲突，请先选择采用的版本',SHARED_EXECUTION_PERMISSION_REQUIRED:'本会话尚未授予共享执行权限',ATTACHMENTS_NOT_ENABLED:'当前服务器尚未启用附件传输，已选择的文件和消息草稿仍保留',SHARED_ATTACHMENTS_NOT_READY:'共享附件发送尚未接通，原文件保留',HISTORY_CONTEXT_LOADING:'正在载入历史并核对上下文',DESKTOP_REFERENCE_CLIENT_UPGRADE_REQUIRED:'此历史包含桌面引用，请更新应用后重开',GROUP_MODE_REQUIRES_DESKTOP:'此群聊模式请在桌面执行',GROUP_MEMBER_UNAVAILABLE:'此成员配置暂不可用',DEPENDENCY_REVIEW_REQUIRED:'同一话题有待核对的执行，请先处理暂停任务',DESKTOP_CONTEXT_REQUIRED:'本轮上下文需要桌面专用内容，请在桌面继续',CONFIG_SNAPSHOT_CORRUPT:'执行配置校验失败，请在桌面重新发布',GROUP_CONTEXT_UNAVAILABLE:'有效上下文暂不可用',ATTACHMENT_BLOB_MISSING:'附件暂未同步，请等待电脑补齐',ATTACHMENT_BLOB_CORRUPT:'附件完整性校验失败，请重新同步',ATTACHMENT_TEXT_UNAVAILABLE:'此文件的文本尚不可用',ATTACHMENT_TYPE_REJECTED:'支持 PNG、JPEG、WebP、PDF 和 UTF-8 文本文件',ATTACHMENT_STORAGE_BUDGET:'附件空间已达到上限',ATTACHMENT_REQUEST_BUDGET:'附件请求过多，请稍后重试',MODEL_IMAGE_UNSUPPORTED:'当前模型不支持图片，请在电脑端选择支持图片的模型并发布配置',EXECUTION_CONFIG_REQUIRED:'请先在电脑端发布有效 Agent 配置',PAIR_REQUIRED:'请使用本入口的配对方式连接会话',HTTPS_REQUIRED:'当前入口尚未启用 HTTPS，不能提交 Key',SERVER_NOT_APPROVED:'此地址尚未由服务端批准，请使用已获授权的服务器',PROTECTED_HOST_NOT_READY:'安全链路或服务端接入尚未就绪，暂不接收访问凭据',AUTH_FAILED:'访问凭据不正确',AUTH_RATE_LIMIT:'尝试过于频繁，请稍后重试',AGENT_NOT_EXECUTABLE:'此 Agent 尚未配置服务端执行能力',EXECUTION_INTERRUPTED_REVIEW_REQUIRED:'执行曾被中断，需确认工具副作用后另行发起，系统不会自动重跑'};
function noteConnectionFailure(error){
 if(!(error instanceof TypeError&&!error.status)&&![502,503,504].includes(error.status))return false;
 online.value=false;
 return true;
}
function apiResponseError(status,code){
 const fallback=status===502?'网关暂时不可用':status>=200&&status<300?'服务端回执无法读取，暂无法确认结果':'请求未完成，请检查连接';
 return Object.assign(Error(errors[code]||fallback),{code,status});
}
async function api(route,body,requestHeaders={},signal,suppressPairRequired=false){
 const requestEpoch=authEpoch;
 const r=await fetch('/mobile/api/'+route,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{'X-NativeSync-Capabilities':'desktop-references-v1,source-data-v2,shared-space-v1',...(body?{'Content-Type':'application/json'}:{}),...requestHeaders,...coreStorageHeaders()},body:body?JSON.stringify(body):undefined,signal});
 let result;
 try{result=await r.json();}catch{throw apiResponseError(r.status);}
 const pinned=localStorage.getItem(coreStorageKey);
 const session=route==='session' && r.ok;
 const freshId=session && result?.server?.mode==='core' && result.storageId;
 const mismatch=result?.error?.code==='CORE_DATABASE_IDENTITY_MISMATCH' ||
  (session && ((pinned && freshId!==pinned) || (result?.server?.mode==='core' && !/^[0-9a-f-]{36}$/.test(freshId||''))));
 if(mismatch){
  if(requestEpoch===authEpoch){paired.value=false;invalidateSession();notice.value=errors.CORE_DATABASE_IDENTITY_MISMATCH;}
  throw Object.assign(Error(errors.CORE_DATABASE_IDENTITY_MISMATCH),{code:'CORE_DATABASE_IDENTITY_MISMATCH',status:409});
 }
 if(freshId && !pinned) localStorage.setItem(coreStorageKey,freshId);
 if(!r.ok){
  if(!suppressPairRequired&&r.status===401&&result?.error?.code==='PAIR_REQUIRED'&&requestEpoch===authEpoch){
   const recover=paired.value&&server.value?.mode==='core';
   markPairRequired();
   needsSessionRecovery=recover;
  }
  throw apiResponseError(r.status,result?.error?.code);
 }
 return result;
}
const coreAgentWorkspace=ref(''), canCreateAgent=ref(false);
const agentCreationDialog=ref(null), creatingAgent=ref(false), agentCreationError=ref(''), agentCreationModels=ref([]);
const agentCreationStorageBlocked=ref(false), agentCreationDefaultModel=ref(null), agentCreationModelsLoading=ref(false);
const agentCreationDraft=ref({name:'', model:'', instructions:''}), pendingAgentCreation=ref(null);
const agentCreationKey=computed(()=>canCreateAgent.value&&paired.value&&coreAgentWorkspace.value&&validSessionRecovery(recoveryContext.value)
 ? 'vcp.mobile.agent-creation.v1:'+recoveryContext.value.entryId+':'+recoveryContext.value.sessionMarker : '');
const agentCreationPath=()=> 'core/'+encodeURIComponent(coreAgentWorkspace.value)+'/agent-creation';

function readAgentCreationPermission(snapshot){
 coreAgentWorkspace.value=snapshot.server?.mode==='core'&&typeof snapshot.workspace==='string'?snapshot.workspace:'';
 canCreateAgent.value=Boolean(coreAgentWorkspace.value&&snapshot.canCreateAgent===true);
}
watch(agentCreationKey,key=>{
 agentCreationDialog.value?.close();
 pendingAgentCreation.value=null;
 agentCreationDraft.value={name:'',model:'',instructions:''};
 agentCreationError.value='';
 agentCreationStorageBlocked.value=false;
 agentCreationModelsLoading.value=false;
 if(!key)return;
 try{
  const raw=sessionStorage.getItem(key);
  if(raw){
   const {requestId,name,model,instructions}=JSON.parse(raw);
   if(!/^[0-9a-f-]{36}$/.test(requestId)||[name,model,instructions].some(value=>typeof value!=='string'))throw Error();
   pendingAgentCreation.value={requestId,name,model,instructions};
   agentCreationDraft.value={name,model,instructions};
  }
 }catch{
  agentCreationStorageBlocked.value=true;
  agentCreationError.value='无法读取待确认的创建请求，请在助手列表核对结果。';
 }
});

async function loadAgentCreationModels(key,{prefill=false}={}){
 agentCreationModelsLoading.value=true;
 agentCreationModels.value=[];
 agentCreationDefaultModel.value=null;
 try{
  const {models,defaultModel}=await api(agentCreationPath()+'/models',undefined,{},AbortSignal.timeout(12000));
  if(key!==agentCreationKey.value)return;
  agentCreationModels.value=models;
  agentCreationDefaultModel.value=models.includes(defaultModel)?defaultModel:null;
  if(!models.includes(agentCreationDraft.value.model)){
   agentCreationDraft.value.model=prefill?agentCreationDefaultModel.value||'':'';
  }
 }catch(error){
  if(key===agentCreationKey.value&&!agentCreationError.value){
   agentCreationError.value=errors[error.code]||'暂时无法读取 Core 模型目录。';
  }
 }finally{
  if(key===agentCreationKey.value)agentCreationModelsLoading.value=false;
 }
}

async function openAgentCreation(){
 const key=agentCreationKey.value;
 if(!key||creatingAgent.value)return;
 agentCreationDialog.value.showModal();
 if(pendingAgentCreation.value||agentCreationStorageBlocked.value)return;
 agentCreationError.value='';
 await loadAgentCreationModels(key,{prefill:!agentCreationDraft.value.name});
}

async function createCoreAgent(){
 const key=agentCreationKey.value;
 if(!key||creatingAgent.value||busy.value||agentCreationStorageBlocked.value)return;
 const pending=pendingAgentCreation.value;
 const {name,model,instructions}=agentCreationDraft.value;
 if(!pending&&(!name.trim()||!agentCreationModels.value.includes(model)))return;
 creatingAgent.value=true;
 const body=pending||{requestId:crypto.randomUUID(),name:name.trim(),model,instructions:instructions.trim()};
 const context=recoveryContext.value;
 let received=false;
 const timeout=()=>AbortSignal.timeout(20000);
 agentCreationError.value='';
 try{
  // Retain the original request across a reload or lost response. Only a user
  // action can send it again.
  sessionStorage.setItem(key,JSON.stringify(body));
  pendingAgentCreation.value=body;
  const receipt=await api(agentCreationPath(),body,{
   'X-NativeSync-Entry-Id':context.entryId,'X-NativeSync-Session-Marker':context.sessionMarker
  },timeout(),true);
  received=true;
  if(key!==agentCreationKey.value)return;
  const snapshot=await api('session',undefined,{},timeout(),true);
  if(key!==agentCreationKey.value||snapshot.recovery?.sessionMarker!==context.sessionMarker)return;
  const topic=snapshot.topics?.find(row=>row.key===receipt.key&&row.ownerId===receipt.agentId&&row.topicId===receipt.topicId);
  if(!topic)throw Error('无法在当前助手列表中核对创建结果。');
  await api('selection',{key:topic.key},{
   'X-NativeSync-Entry-Id':context.entryId,'X-NativeSync-Session-Marker':context.sessionMarker
  },timeout(),true);
  if(key!==agentCreationKey.value)return;
  directoryRequest++;
  await setDirectory(snapshot,{adjustSelection:false});
  sourceFilter.value='*';
  agentId.value=ownerKey(topic);
  selected.value=topic.key;
  sessionStorage.removeItem(key);
  pendingAgentCreation.value=null;
  agentCreationDraft.value={name:'',model:'',instructions:''};
  agentCreationDialog.value.close();
  closePanel();
  resetHistory();
  await refresh();
 }catch(error){
  if(key!==agentCreationKey.value)return;
  if(!pendingAgentCreation.value){
   agentCreationError.value='无法保存待确认请求，创建尚未提交。';
  }else if(!received&&['INVALID_CORE_AGENT_CREATION','CORE_AGENT_INSTRUCTIONS_PLAIN_TEXT','CORE_AGENT_MODEL_REQUIRED','CORE_MODEL_NOT_ALLOWED'].includes(error.code)){
   sessionStorage.removeItem(key);
   pendingAgentCreation.value=null;
   if(['CORE_AGENT_MODEL_REQUIRED','CORE_MODEL_NOT_ALLOWED'].includes(error.code)){
    agentCreationDraft.value.model='';
    agentCreationError.value=errors.CORE_MODEL_NOT_ALLOWED;
    await loadAgentCreationModels(key);
   }else agentCreationError.value=errors[error.code]||'请检查助手名称和简短指令。';
  }else{
   agentCreationError.value=error.status===401||error.status===403?'此设备当前没有创建权限，请核对配对或授权。':
    '创建结果待确认。请点「重试创建」继续原请求。';
  }
 }finally{creatingAgent.value=false;}
}

function cacheBinding(key=historyKey){return paired.value&&validSessionRecovery(recoveryContext.value)?historyCacheKey(recoveryContext.value,topics.value.find(t=>t.key===key)):'';}
function resetHistory({remember=true}={}){clearSharedObservers();terminalCoreWorks.clear();if(remember&&baselineReady&&historyBinding&&historyBinding===cacheBinding())historyCache.put(historyBinding,historyRows,cursor);refreshing?.abort();refreshing=null;historyStart.value=0;historyProgress.value=null;expandedAttachmentText.value=new Set();historyContextReady.value=false;expandedLongText.value=new Set();executionPager.reset();jobsInfo.value=null;jobsError.value='';attachmentPager.reset();baselineReady=false;baselineRequestId='';switchDraft();closeNativeResult();closeAttachment();invitedAgent.value='';reviewChecks.value={};attachmentStates.value={};generation++;submissionNoticeHeld=false;historyKey='';historyBinding='';historyFromCache=false;cursor=0;historyRows=new Map();messages.value=[];jobs.value=[];recoveryDetail.value='';acceptedReceipt.value=null;loadRecovery();}
async function setDirectory(result,{initial=false,selectedTopic=null,adjustSelection=true}={}){
 lastDirectory=result;
 const previous=selected.value,previousAgent=agentId.value;
 const hidden=new Map(sharedSpaces.value.map(space=>[space.id,sharedHidden(localStorage,recoveryContext.value,space.id)]));
 topics.value=result.topics.filter(t=>!t.sharedSpaceId||!hidden.get(t.sharedSpaceId)?.has(t.key)&&!hidden.get(t.sharedSpaceId)?.has(t.sharedOwnerId));
 directoryAgents.value=Array.isArray(result.agents)?result.agents.filter(a=>!sharedSpaces.value.some(space=>hidden.get(space.id)?.has(a.id))):null;sourceProgress.value=result.sourceProgress||[];
 historyCache.retain(topics.value.map(t=>historyCacheKey(recoveryContext.value,t)));
 if(historyKey&&historyBinding&&historyBinding!==cacheBinding())resetHistory({remember:false});
 if(sourceFilter.value!=='*'&&!sources.value.some(s=>s.key===sourceFilter.value))sourceFilter.value='*';
 directoryRevision=result.revision||'';
 directoryFetchError.value='';
 if(adjustSelection){
  const preferred=topics.value.find(t=>sourceMatches(t)&&t.key===(previous||(initial?selectedTopic:null)));
  if(preferred){agentId.value=ownerKey(preferred);selected.value=preferred.key;}
  else{agentId.value=visibleAgents.value.some(a=>a.id===previousAgent)?previousAgent:visibleAgents.value[0]?.id||'';selected.value=visibleTopics.value[0]?.key||'';}
  if(previous&&previous!==selected.value)directoryNotice.value='原话题已删除或当前会话已失去访问权限；本页草稿和待确认提交仍保留。';
  else directoryNotice.value='';
  if(previous!==selected.value)resetHistory();else switchDraft();
 }
}
const pairRequiredNotice=errors.PAIR_REQUIRED+'；本地待确认提交继续保留。';
function markPairRequired(){
 paired.value=false;invalidateSession();notice.value=pairRequiredNotice;
}
const pairRequired=error=>error.status===401&&error.code==='PAIR_REQUIRED';
function readPairedSession(signal){
 return pairingRecovery.openSession((route,body)=>api(route,body,{},signal,true));
}
async function refreshDirectory(force=false,{adjustSelection=true}={}){
 if(!paired.value||(!directoryPaged&&server.value?.mode!=='core')||directoryLoading)return;
 directoryLoading=true;const request=++directoryRequest,epoch=authEpoch;const current=()=>request===directoryRequest&&epoch===authEpoch&&paired.value;
 try{
  if(server.value?.mode==='core'){
   const snapshot=await readPairedSession();if(!current())return;
   if(snapshot.recovery?.sessionMarker!==recoveryContext.value?.sessionMarker){await session();return;}
   readAgentCreationPermission(snapshot);
   await setDirectory({topics:snapshot.topics,agents:snapshot.agents});return;
  }
  const marker=await api('directory?kind=revision');if(!current())return;
  sourceProgress.value=marker.sourceProgress||[];
  if(!force&&marker.revision===directoryRevision){directoryFetchError.value='';return;}
  const result=await readDirectoryPages(api,current);if(result&&current())await setDirectory(result,{adjustSelection});
 }catch(e){if(current()){
  if(pairRequired(e))markPairRequired();
  else directoryFetchError.value='目录暂未更新，保留上次列表：'+e.message;
  throw e;
 }}
 finally{directoryLoading=false;}
}
async function session({startupSignal,alreadyLocked=false}={}){const epoch=authEpoch;try{
 needsSessionRecovery=false;
 const r=alreadyLocked?await api('session',undefined,{},startupSignal,true):await readPairedSession(startupSignal);
 if(epoch!==authEpoch||startupSignal?.aborted||r.authenticated!==true)return;
 if(notice.value===pairRequiredNotice)notice.value='';
 const nextRecovery=validSessionRecovery(r.recovery)?{version:1,entryId:r.recovery.entryId,sessionMarker:r.recovery.sessionMarker}:null;
 if(nextRecovery?.entryId!==recoveryContext.value?.entryId||nextRecovery?.sessionMarker!==recoveryContext.value?.sessionMarker){authEpoch++;switchDraft('');clearSharedObservers();historyCache.clear();closeNativeResult();closeAttachment();submissionNoticeHeld=false;acceptedReceipt.value=null;recoveryDetail.value='';}
 sharedFeatures.value=Array.isArray(r.sharedFeatures)?r.sharedFeatures:[];recoveryContext.value=nextRecovery;sharedSpaces.value=(r.sharedPermissions||[]).filter(v=>v.endsWith(':read')).map(v=>({id:v.split(':')[1],config:r.sharedPermissions.includes(v.replace(/:read$/,':config'))}));paired.value=true;online.value=true;server.value=r.server||server.value;serverUrl.value=r.server?.serverUrl||serverUrl.value;
 readAgentCreationPermission(r);
 directoryPaged=r.directory?.paged===true;
 const currentEpoch=authEpoch,result=directoryPaged?await readDirectoryPages(api,()=>currentEpoch===authEpoch):{topics:r.topics,agents:r.agents};
 if(!result||currentEpoch!==authEpoch)return;await setDirectory(result,{initial:true,selectedTopic:r.selectedTopic});loadRecovery();await refresh();
 }catch(e){if(!startupSignal?.aborted&&epoch===authEpoch){
  if(pairRequired(e))markPairRequired();
  else if(!noteConnectionFailure(e))notice.value=e.message;
 }}}

async function pair(){
 if(busy.value)return;
 busy.value=true;pairError.value='';invalidateSession();
 try{
  await pairingRecovery.withSessionLock(async()=>{
   if(!pairCode.value||pageSuspended)return;
   const enrolled=await pairingRecovery.pair(api,pairCode.value);
   pairCode.value='';
   pairRecoveryNotice.value=enrolled?'':'此浏览器或服务端未启用设备恢复。若浏览器丢失会话，请重新配对。';
   notice.value='';
   resetHistory();await session({alreadyLocked:true});
   if(paired.value)settingsOpen.value=false;
  });
 }catch(e){pairError.value=noteConnectionFailure(e)?'暂未连上服务端，请联网后重试。':e.message;}
 finally{busy.value=false;}
}
async function connectionInfo(){try{server.value=await api('connection');serverUrl.value=server.value.serverUrl||server.value.suggestedServerUrl||'';online.value=true;if(keyAllowed.value){server.value=await api('connection/test',{serverUrl:serverUrl.value});tested.value=true;}}catch(error){notice.value=error.code==='CORE_DATABASE_IDENTITY_MISMATCH'?error.message:'安全连接尚未就绪，尚未提交任何凭据';}}
async function testConnection(){busy.value=true;tested.value=false;accessKey.value='';try{server.value=await api('connection/test',{serverUrl:serverUrl.value});tested.value=true;notice.value='服务器身份和受保护接入已确认';}catch(e){notice.value=e.message;}finally{busy.value=false;}}
async function connect(){
 if(busy.value||!keyAllowed.value||!tested.value)return;
 busy.value=true;const key=accessKey.value;accessKey.value='';invalidateSession();
 try{
  await pairingRecovery.withSessionLock(async()=>{
   if(pageSuspended)return;
   await pairingRecovery.changeSession(()=>api('connection/authenticate',{serverUrl:serverUrl.value,apiKey:key}));
   pairRecoveryNotice.value='';
   resetHistory();await session({alreadyLocked:true});settingsOpen.value=false;
   if(paired.value)notice.value='已保存服务器连接，使用受限设备会话；待确认提交继续保留。';
  });
 }catch(e){notice.value=e.message;}
 finally{busy.value=false;}
}
async function disconnect(){
 if(busy.value)return;
 busy.value=true;accessKey.value='';
 try{
  await pairingRecovery.withSessionLock(async()=>{
   if(pageSuspended)return;
   await pairingRecovery.changeSession(()=>api('connection/disconnect',{}));
   pairRecoveryNotice.value='';
   paired.value=false;invalidateSession();topics.value=[];directoryAgents.value=null;sourceProgress.value=[];directoryRevision='';resetHistory();tested.value=false;settingsOpen.value=true;
   notice.value='此设备会话已撤销。下次连接需要重新配对或认证，待确认提交继续保留。';
  });
 }catch(e){notice.value=e.message;}
 finally{busy.value=false;}
}
function selectAgent(){selected.value=visibleTopics.value[0]?.key||'';changeTopic();}
function selectSource(){
 if(currentTopic.value&&sourceMatches(currentTopic.value))return;
 agentId.value=visibleAgents.value.some(a=>a.id===agentId.value)?agentId.value:visibleAgents.value[0]?.id||'';
 selected.value=visibleTopics.value[0]?.key||'';changeTopic();
}
async function changeTopic(){resetHistory();if(!selected.value)return;try{await api('selection',{key:selected.value});await refresh();}catch(e){if(e.status===401||e.status===403)historyCache.remove(cacheBinding(selected.value));if(!noteConnectionFailure(e))notice.value=e.message;}}
async function authorizeCachedHistory(readApi,current){
 const live=await readApi('session');if(!current())return false;
 if(!validSessionRecovery(live.recovery)||live.recovery.entryId!==recoveryContext.value?.entryId||live.recovery.sessionMarker!==recoveryContext.value?.sessionMarker||Boolean(live.directory?.paged)!==directoryPaged){paired.value=false;invalidateSession();notice.value='设备会话已变化，请刷新页面重新核对；原待确认提交继续保留。';return false;}
 if(directoryPaged){
  const marker=await readApi('directory?kind=revision');if(!current())return false;
  if(marker.revision!==directoryRevision){const directory=await readDirectoryPages(readApi,current);if(!directory||!current())return false;await setDirectory(directory);}
 }
 return current();
}
async function refresh(){
 if(!paired.value||!selected.value||refreshing)return;const controller=new AbortController();refreshing=controller;const readApi=(route,body,headers)=>api(route,body,headers,controller.signal);const key=selected.value,epoch=generation,sessionEpoch=authEpoch,context=validSessionRecovery(recoveryContext.value)?captureContext():null;
 let changed=historyFromCache;
 try{
  if(currentTopic.value?.coreSingle){
   return await refreshCore(currentTopic.value,readApi,context,()=>selected.value===key&&epoch===generation&&sessionEpoch===authEpoch);
  }
  if(historyKey!==key){historyRows=new Map();cursor=0;historyKey=key;baselineReady=false;baselineRequestId='';historyBinding=cacheBinding(key);const saved=historyCache.take(historyBinding);if(saved){historyRows=saved.rows;cursor=saved.cursor;baselineReady=true;historyFromCache=true;changed=true;historyProgress.value={checking:true,loaded:saved.rows.size,total:saved.rows.size};}}let result;
  const current=()=>selected.value===key&&epoch===generation&&sessionEpoch===authEpoch;
  if(historyFromCache&&!await authorizeCachedHistory(readApi,current))return;
  if(currentTopic.value?.historyProtocol===2){
   if(!baselineReady){baselineRequestId ||= crypto.randomUUID();historyProgress.value={loaded:0,total:currentTopic.value?.messageCount||0};const baseline=await readHistoryBaseline(readApi,key,baselineRequestId,current,async page=>{historyProgress.value={loaded:page.loaded,total:page.total};if(page.loaded<page.total)await displayHistory(page.messages,current);});if(!baseline||!current())return;historyRows=baseline.rows;cursor=baseline.cursor;baselineReady=true;changed=true;}
   do{result=await readApi('conversations/'+encodeURIComponent(key)+'/events?after='+cursor+'&limit=100'+(currentTopic.value?.executionProtocol===2?'&executions=paged':''));if(!current())return;
    if(historyFromCache&&result.topicState?.historyReady!==true)throw Object.assign(Error('历史接入状态已变化，请重新加载'),{code:'HISTORY_CACHE_INVALID'});
    cursor=applyHistoryDelta(historyRows,result,cursor,currentTopic.value);if(result.events.length)changed=true;
   }while(result.hasMore);
  }else do{result=await readApi('conversations/'+encodeURIComponent(key)+'?after='+cursor+(currentTopic.value?.executionProtocol===2?'&executions=paged':''));if(!current())return;if(result.messages.length)changed=true;for(const row of result.messages){if(row.deleted)historyRows.delete(row.id);else historyRows.set(row.id,row.message);}cursor=result.next;}while(result.hasMore);
  if(changed)await displayHistory([...historyRows.values()],current);if(!current())return;historyProgress.value=null;historyContextReady.value=true;historyFromCache=false;jobs.value=result.executions||jobs.value;online.value=true;const topicRecord=topics.value.find(t=>t.key===key);if(topicRecord){topicRecord.messageCount=messages.value.length;if(result.topicState)Object.assign(topicRecord,result.topicState);}historyBinding=cacheBinding(key);
  if(currentTopic.value?.executionProtocol===2){try{const page=await executionPager.refresh(readApi,key,current);if(!page||!current())return;result.executions=page.rows;jobs.value=page.rows;jobsInfo.value=page;jobsError.value='';}catch(e){if(!current())return;if(e.status===401||e.status===403)throw e;jobsError.value='执行状态暂未更新，保留最近结果：'+e.message;}}
  if(context&&loadRecovery()){const pending=submissionStore.current({entryId:context.recovery.entryId,topicKey:key});if(pending){const exact=currentTopic.value?.executionProtocol===2?await readApi('conversations/'+encodeURIComponent(key)+'/execution-request?'+new URLSearchParams({requestId:pending.requestId})):result;await reconcileSubmission(pending,exact.executions,context);}}
  if(selected.value!==key||epoch!==generation||sessionEpoch!==authEpoch)return;
  if(currentTopic.value?.attachmentsEnabled){const batch=attachmentPager.select(messages.value);attachmentStates.value=batch.retained;if(batch.ids.length){const status=await readApi('conversations/'+encodeURIComponent(key)+'/attachments/status',{messageIds:batch.ids});if(selected.value!==key||epoch!==generation||sessionEpoch!==authEpoch)return;attachmentStates.value=attachmentPager.merge(batch,status.attachments,messages.value);}}
  syncSharedObservers();
  if(!busy.value&&!submissionNoticeHeld)notice.value=recoveryBlocker.value||(pendingSubmission.value?'本地提交仍待核对，未发起新请求。':'中央会话已更新');
 }catch(e){if(selected.value===key&&epoch===generation&&sessionEpoch===authEpoch){historyContextReady.value=false;if(e.status===401||e.status===403||['HISTORY_PAGE_INVALID','HISTORY_CACHE_INVALID','SYNC_STORAGE_CORRUPT'].includes(e.code)){historyCache.remove(historyBinding);resetHistory({remember:false});}online.value=false;if(historyProgress.value)historyProgress.value={...historyProgress.value,failed:true};if(!noteConnectionFailure(e)&&!submissionNoticeHeld){notice.value=recoveryMessage(e);if(e.code?.startsWith('SUBMISSION_'))submissionNoticeHeld=true;}}}finally{if(refreshing===controller)refreshing=null;}
}
async function nextExecutions(mode){executionPager.next(mode);await refresh();}
async function latestExecutions(){executionPager.reset();await refresh();}
async function reconcileSubmission(record,executions,context){
 const result=await submissionStore.inspect(record,executions,context.recovery);
 if(result.state==='confirmed'){
  await submissionStore.confirm(record,result.execution,context.recovery);
  if(!loadRecovery())throw Error(recoveryError.value);
  if(record.kind==='message')confirmDraft(record,context);
  if(sameView(context)){
   submissionNoticeHeld=false;
   acceptedReceipt.value={requestId:record.requestId,id:result.execution.id};recoveryDetail.value='';
   if(notice.value.startsWith('尚未完成提交确认：')||notice.value==='本地已保存 · 正在等待云端确认…'){
    notice.value='云端已接受 · '+executionLabel(result.execution);
   }
   if(record.kind==='invitation'&&invitedAgent.value===record.payload.agentId)invitedAgent.value='';
  }
 }else if(sameView(context)){recoveryDetail.value=result.state==='absent'?'尚未查到云端接受记录。点击核对 / 重试只会使用原提交身份和内容。':recoveryReasons[result.reason];}
 return result;
}
async function postPrepared(record,context){
 await submissionStore.verify(record);
 return submissionStore.withSendLock(record,async()=>{
  if(!sameView(context))return;
  notice.value='本地已保存 · 正在等待云端确认…';
  const conversation='conversations/'+encodeURIComponent(record.topicKey);
  let accepted;
  try{
   const target=currentTopic.value?.coreSingle ? corePath(currentTopic.value)+(record.kind==='invitation'?'/invitations':'/send') : conversation+(record.kind==='invitation'?'/invitations':'/messages');
   accepted=await api(target,record.payload,{'X-NativeSync-Entry-Id':record.entryId,'X-NativeSync-Session-Marker':record.sessionMarker});
  }catch(error){
   const topic=currentTopic.value;
   const imageRejected=error.code==='MODEL_IMAGE_UNSUPPORTED'&&topic?.coreSingle&&record.payload.attachments?.length;
   const modelRejected=error.code==='CORE_MODEL_NOT_ALLOWED'&&topic?.coreSingle&&topic.ownerType==='agent'&&record.payload.model;
   const coreRejected=imageRejected||modelRejected;
   const desktopRejected=error.code==='DESKTOP_CONTEXT_REQUIRED'&&topic?.ownerType==='agent'&&topic.sharedSpaceId&&topic.executionProtocol===2;
   if(error.status!==409||record.kind!=='message'||!sameView(context)||(!coreRejected&&!desktopRejected))throw error;
   const draft=drafts.get(context.draftScope);
   if(!draft)throw error;
   const receiptRoute=coreRejected?corePath(topic)+'/receipt':conversation+'/execution-request';
   const receiptHeaders=coreRejected?{'X-NativeSync-Entry-Id':record.entryId,'X-NativeSync-Session-Marker':record.sessionMarker}:{};
   const response=await api(receiptRoute+'?'+new URLSearchParams({requestId:record.requestId}),undefined,receiptHeaders);
   if(!sameView(context))throw error;
   const saved=await submissionStore.releaseRejectedMessage(record,error,response.executions,context.recovery,()=>
    draft.submitted?.requestId===record.requestId?draftContents(draft,record.sessionMarker):null);
   if(!saved)throw error;
   forgetOrdinarySubmission(record,context.draftScope);
   if(draft.submitted?.requestId===record.requestId||draft.revision||draft.files.some(item=>item.file)){
    restoreRejectedDraft(draft,record);
   }else{
    draft.text=saved.text;draft.files=rejectedDraftFiles(saved);
   }
   draft.rejected=saved;
   if((imageRejected||modelRejected)&&record.payload.model&&!draft.nextModel)draft.nextModel=record.payload.model;
   if(modelRejected&&draft.nextModel===record.payload.model)draft.modelUnavailable=true;
   if(draft.nextModel||draftLocalAttachmentCount(draft))rememberOrdinaryText(draft,context.draftScope);
   if(!loadRecovery())throw Error(recoveryError.value);
   if(sameView(context)){
    submissionNoticeHeld=true;
    recoveryDetail.value='';acceptedReceipt.value=null;
    notice.value=imageRejected?'当前模型不支持图片。草稿和附件已保留，可换用支持图片的模型或移除图片后手动发送。':
     recoveryMessage(error)+'。草稿和附件已保留，可编辑后重新发送。';
   }
   return;
  }
  const result=await reconcileSubmission(record,[accepted],context);
  if(result.state!=='confirmed')throw Object.assign(Error(recoveryMessages.SUBMISSION_RECEIPT_UNVERIFIED),{code:'SUBMISSION_RECEIPT_UNVERIFIED'});
  if(sameView(context)){
   notice.value='云端已接受 · '+executionLabel(accepted);
   await refresh();
  }
 });
}
async function submit(submission,kind='message',context=newSubmissionContext()){
 busy.value=true;submissionNoticeHeld=false;
 try{
  if(!sameView(context))return;
  const record=await submissionStore.prepare({entryId:context.recovery.entryId,sessionMarker:context.recovery.sessionMarker,topicKey:context.topicKey,kind,payload:submission,rejected:context.rejected});
  const draft=drafts.get(context.draftScope);
  if(submission.model&&draft?.nextModel===submission.model){
   delete draft.nextModel;
   delete draft.restoredModel;
   delete draft.modelUnavailable;
  }
  if(draft?.submitted?.requestId===record.requestId){
   draft.submitted.prepared=true;
   markOrdinarySubmission(draft,context.draftScope,record.requestId);
  }
  if(!loadRecovery())throw Error(recoveryError.value);
  if(sameView(context)){recoveryDetail.value='本地已保存，尚未收到可核验的云端接受回执。';acceptedReceipt.value=null;}
  await postPrepared(record,context);
 }catch(error){loadRecovery();if(sameView(context)){submissionNoticeHeld=true;notice.value='尚未完成提交确认：'+(noteConnectionFailure(error)?(error.status===502?'网关暂时不可用':'暂未连上服务端')+'，原提交仍待核对。':recoveryMessage(error));}}
 finally{busy.value=false;}
}
function selectFiles(event){
 const draft=composerDraft.value,rejected=[];
 const originalCount=draft.files.length;
 for(const file of event.target.files||[]){
  const reason=file.size>20*1024*1024?'单个附件超过 20 MB':draft.files.length>=8?'最多添加 8 个附件':'';
  if(reason)rejected.push({name:file.name,reason});
  else draft.files.push({file,progress:0,error:'',uploadId:null});
 }
 draft.fileRejections=rejected;
 const added=draft.files.length-originalCount;
 if(added){
  if(draft.missingAttachments)draft.missingAttachments=Math.max(0,draft.missingAttachments-added);
  rememberOrdinaryText(draft,composerScope);
 }
 event.target.value='';
}
function attachmentUrl(message,attachment){if(currentTopic.value?.coreSingle)return '/mobile/api/'+corePath(currentTopic.value)+'/blob/'+encodeURIComponent(attachment.hash);return '/mobile/api/conversations/'+encodeURIComponent(selected.value)+'/attachments/messages/'+encodeURIComponent(message.id)+'/'+encodeURIComponent(attachment.id);}
function draftPreviewKind(file){
 if(file?.type.startsWith('image/'))return 'image';
 if(/\.txt$/i.test(file?.name||''))return 'text';
}
function closeAttachment(){
 attachmentReadRequest++;attachmentReadController?.abort();attachmentReadController=null;
 if(attachmentPreview.value?.url)URL.revokeObjectURL(attachmentPreview.value.url);
 attachmentPreview.value=null;if(attachmentDialog.value?.open)attachmentDialog.value.close();
}
async function openDraftAttachment(file){
 const kind=draftPreviewKind(file);
 if(!kind)return;
 closeAttachment();
 const request=attachmentReadRequest;
 const current=()=>request===attachmentReadRequest;
 attachmentPreview.value={name:file.name,localFile:file,loading:true};
 await nextTick();
 if(!current())return;
 attachmentDialog.value?.showModal();
 try{
  const isImage=kind==='image';
  const text=isImage?null:await file.slice(0,attachmentTextPreviewLimit).text();
  if(!current())return;
  attachmentPreview.value={name:file.name,localFile:file,isImage,text,
   url:isImage?URL.createObjectURL(file):null,truncated:!isImage&&file.size>attachmentTextPreviewLimit};
 }catch{
  if(current())attachmentPreview.value={name:file.name,localFile:file,error:'无法预览此文件。'};
 }
}
async function openAttachment(message,attachment){
 closeAttachment();const request=attachmentReadRequest,epoch=authEpoch,view=generation,url=attachmentUrl(message,attachment);
 const current=()=>request===attachmentReadRequest&&epoch===authEpoch&&view===generation&&paired.value;
 attachmentReadController=new AbortController();const signal=attachmentReadController.signal;
 attachmentPreview.value={name:attachment.name||'附件',loading:true,error:'',url:null};
 await nextTick();if(!current())return;attachmentDialog.value?.showModal();
 try{
  const blob=await readAttachment(url,{signal}),isImage=blob.type.startsWith('image/');
  const limit=attachmentTextPreviewLimit,previewText=isImage?null:/^(text\/|application\/json(?:;|$))/.test(blob.type)?await blob.slice(0,limit).text():attachment.extractedText?.slice(0,limit)||null;
  if(!current())return;
  attachmentPreview.value={name:attachment.name||'附件',loading:false,error:'',blob,url:isImage?URL.createObjectURL(blob):null,isImage,text:previewText,truncated:!isImage&&blob.size>limit};
 }catch(error){if(current())attachmentPreview.value={name:attachment.name||'附件',loading:false,error:error.status?error.message:'附件暂时无法读取，请检查连接',url:null};}
}
function draftImageError(event){
 const preview=attachmentPreview.value;
 if(preview?.localFile&&event.target.src===preview.url)preview.error='无法预览此图片。';
}
function downloadAttachment(){const item=attachmentPreview.value;if(item?.blob)saveAttachment(item.blob,item.name);}
const steerableStates=['running','waiting_approval'];
const coreSteeringWork=computed(()=>currentTopic.value?.coreSingle && currentTopic.value.ownerType==='agent'
 ? jobs.value.find(work=>!terminalCoreWorks.has(work.id)&&steerableStates.includes(work.state)) : null);
const taskQuote=computed(()=>composerDraft.value.taskQuote||null);
const quotedWork=computed(()=>jobs.value.find(work=>work.id===taskQuote.value?.id));
const modelPicker=ref(null);
const supportsModelSelection=computed(()=>server.value?.mode==='core'&&server.value.modelSelection&&
 currentTopic.value?.coreSingle&&currentTopic.value.ownerType==='agent');
const shownModel=computed(()=>taskQuote.value?quotedWork.value?.model:
 composerDraft.value.nextModel||pendingSubmission.value?.payload.model||currentTopic.value?.model);
watch([composerDraft,taskQuote,conversationPanel,settingsOpen],()=>{modelPicker.value=null;});
async function readComposerModels(topic){
 const {models,purpose}=await api(corePath(topic)+'/models');
 if(!Array.isArray(models))throw Error('Invalid model catalog');
 return purpose==='chat'?models:filterChatModels(models);
}
watch([composerDraft,supportsModelSelection,historyContextReady],async ([draft,supported,ready])=>{
 const model=draft.nextModel;
 if(!supported||!ready||!model||!draft.restoredModel||draft.modelUnavailable)return;
 try{
  const context=captureContext();
  const models=await readComposerModels(currentTopic.value);
  if(sameView(context)&&draft===composerDraft.value&&draft.restoredModel&&draft.nextModel===model&&!models.includes(model))
   draft.modelUnavailable=true;
 }catch{/* A failed catalog read cannot establish that the model is unavailable. Core still validates sends. */}
});
const modelPickerRoot=ref(null), modelPickerTrigger=ref(null), modelPickerSearch=ref(null);
function modelPickerMotion(layer,done,opening){
 const panel=layer.querySelector('#composer-model-options'),trigger=modelPickerTrigger.value;
 if(!trigger||!panel||matchMedia('(prefers-reduced-motion: reduce)').matches){done();return;}
 const from=trigger.getBoundingClientRect(),to=panel.getBoundingClientRect();
 if(!from.width||!to.width||!from.height||!to.height){done();return;}
 const compact={transform:`translate(${from.left-to.left}px,${from.top-to.top}px) scale(${from.width/to.width},${from.height/to.height})`,borderRadius:'999px'};
 const expanded={transform:'none',borderRadius:'23px'};
 const options={duration:opening?250:185,easing:opening?'cubic-bezier(.18,.82,.24,1)':'cubic-bezier(.4,0,.3,1)',fill:'both'};
 const frame=panel.animate(opening?[compact,expanded]:[expanded,compact],options);
 const content=panel.querySelector('.model-morph-content');
 const fade=content.animate(opening?[{opacity:0},{opacity:0,offset:.30},{opacity:1}]:[{opacity:1},{opacity:0,offset:.45},{opacity:0}],options);
 const scrim=layer.querySelector('.model-picker-scrim').animate(opening?[{opacity:0},{opacity:1}]:[{opacity:1},{opacity:0}],options);
 frame.finished.catch(()=>{}).finally(()=>{
  done();frame.cancel();fade.cancel();scrim.cancel();
 });
}
const modelPickerQuery=computed(()=>modelPicker.value?.query.trim().toLowerCase()||'');
const filteredPickerModels=computed(()=>{
 const terms=modelPickerQuery.value.split(/\s+/u);
 return (modelPicker.value?.models||[]).filter(id=>terms.every(term=>id.toLowerCase().includes(term)));
});
const modelTileRows=computed(()=>{
 const rows=[];
 for(const model of filteredPickerModels.value){
  const capacity=Array.from(model).length<=14?3:2;
  let row=rows.at(-1);
  if(!row||row.capacity!==capacity||row.models.length===capacity){
   row={capacity,models:[]};
   rows.push(row);
  }
  row.models.push(model);
 }
 return rows;
});
function searchModelPickerOnEnter(event){
 if(event.isComposing)return;
 event.preventDefault();
 if(modelPickerQuery.value&&filteredPickerModels.value.length===1)pickNextModel(filteredPickerModels.value[0]);
 else focusModelPickerRow('first');
}
function clearModelPickerSearch(){
 if(!modelPicker.value)return;
 modelPicker.value.query='';
 modelPickerSearch.value?.focus({preventScroll:true});
}
function closeModelPicker(restoreFocus=false){
 modelPicker.value=null;
 if(restoreFocus)modelPickerTrigger.value?.focus({preventScroll:true});
}
function dismissModelPickerOutside(event){
 if(modelPicker.value&&!modelPickerRoot.value?.contains(event.target))closeModelPicker();
}
function modelPickerFocusLeft(event){
 if(modelPicker.value&&!modelPickerRoot.value?.contains(event.relatedTarget))closeModelPicker();
}
function focusModelPickerRow(position='checked'){
 const rows=[...modelPickerRoot.value?.querySelectorAll('[role="menuitemradio"]')||[]];
 const row=position==='last'?rows.at(-1):position==='first'?rows[0]:rows.find(el=>el.getAttribute('aria-checked')==='true')||rows[0];
 row?.focus();
}
function navigateModelPicker(event){
 const keys=['ArrowDown','ArrowUp','Home','End'];
 if(!keys.includes(event.key))return;
 const rows=[...event.currentTarget.querySelectorAll('[role="menuitemradio"]')];
 if(!rows.length)return;
 event.preventDefault();
 const index=rows.indexOf(document.activeElement);
 const next=event.key==='Home'?0:event.key==='End'?rows.length-1:
  event.key==='ArrowUp'?(index<0?rows.length-1:(index+rows.length-1)%rows.length):(index+1)%rows.length;
 rows[next]?.focus();
}
async function openModelPickerFromKey(){
 if(!modelPicker.value)await toggleModelPicker();
 await nextTick();
 if(modelPicker.value&&document.activeElement===modelPickerTrigger.value)focusModelPickerRow();
}
async function toggleModelPicker(){
 if(modelPicker.value){modelPicker.value=null;return;}
 if(!supportsModelSelection.value||!currentTopic.value?.executable||taskQuote.value)return;
 const context=captureContext(),topic=currentTopic.value;
 modelPicker.value={loading:true,models:[],error:'',query:''};
 const picker=modelPicker.value;
 try{
  const models=await readComposerModels(topic);
  if(!sameView(context)||modelPicker.value!==picker)return;
  picker.models=models;
  const draft=composerDraft.value;
  if(draft.nextModel&&!models.includes(draft.nextModel))draft.modelUnavailable=true;
 }catch(error){
  if(sameView(context)&&modelPicker.value===picker)picker.error=errors[error.code]||'暂时无法读取 Core 模型目录';
 }finally{picker.loading=false;}
}
function pickNextModel(model){
 if(busy.value||taskQuote.value||!modelPicker.value)return;
 if(model&&!modelPicker.value.models.includes(model))return;
 const draft=composerDraft.value;
 if(model)draft.nextModel=model;
 else delete draft.nextModel;
 delete draft.restoredModel;
 delete draft.modelUnavailable;
 rememberOrdinaryText(draft,composerScope);
 closeModelPicker(true);
}
const quoteClosed=computed(()=>{
 const quote=taskQuote.value, state=quotedWork.value?.state;
 return quote?.rejected?'rejected':quote?.closed || (state&&!steerableStates.includes(state)?state:'');
});
const quoteUnavailable=computed(()=>!browserOnline.value||!online.value||!coreSteeringWork.value||
 coreSteeringWork.value.id!==taskQuote.value?.id);
const canQuoteTask=computed(()=>Boolean(coreSteeringWork.value&&currentTopic.value?.executable&&
 !busy.value&&!newSubmissionBlocked.value&&browserOnline.value&&online.value&&!pendingFiles.value.length&&!taskQuote.value));
const quoteSendBlocked=computed(()=>quoteUnavailable.value||Boolean(quoteClosed.value)||!text.value.trim()||pendingFiles.value.length>0);
const quoteStatus=computed(()=>composerDraft.value.coreSteering?'追加指令尚未确认':quoteClosed.value
 ? quoteClosed.value==='rejected'?'服务端已拒绝这条追加':quoteClosed.value==='completed'?'任务已完成':'此任务已停止接收追加'
 : quoteUnavailable.value?'暂时无法核对任务状态':pendingFiles.value.length?'附件只能作为新消息发送。':'');
function quoteTask(){
 if(!canQuoteTask.value)return;
 const work=coreSteeringWork.value;
 composerDraft.value.taskQuote={id:work.id,name:currentTopic.value.agentName||'Agent',
  label:workMessageNames.value.get(work.messageId)||currentTopic.value.topicName||'当前任务'};
 rememberOrdinaryText(composerDraft.value,composerScope);
 composer.value?.focus();
}
function clearTaskQuote(){
 if(busy.value||composerDraft.value.coreSteering)return;
 delete composerDraft.value.taskQuote;
 rememberOrdinaryText(composerDraft.value,composerScope);
 composer.value?.focus();
}
const voice=ref({status:'idle',message:'',preview:''}),voiceDisclosure=ref(false),voiceLevel=ref(0);
let voiceConsent=false;
const voiceActive=computed(()=>voice.value.status!=='idle');
const canPickComposerAttachment=computed(()=>Boolean(currentTopic.value?.attachmentsEnabled&&!taskQuote.value&&!voiceActive.value));
const attachmentPickerDisabled=computed(()=>busy.value||newSubmissionBlocked.value||currentTopic.value?.executable===false);
watch(canPickComposerAttachment,available=>{if(!available)composerMenu.value=false;});
const appendVoice=(original,additional)=>original+(original&&additional&&!/\s$/u.test(original)?' ':'')+additional;
function mergeVoiceText(original,preview){
 if(original.length>=12000)return original;
 const next=appendVoice(original,preview).slice(0,12000).replace(/[\uD800-\uDBFF]$/u,'');
 return next.slice(original.length).trim()?next:original;
}
const displayedComposer=computed({
 get:()=>voiceActive.value&&voice.value.preview?mergeVoiceText(composerText.value,voice.value.preview):composerText.value,
 set:value=>{if(!voiceActive.value)composerText.value=value;}
});
let voiceFlight=null;
function clearVoiceFlight(){voiceFlight?.cancel();voiceFlight=null;}
function animateVoiceTranscript(delta){
 const orb=shell.value?.querySelector('.voice-stage-orb'),field=composer.value;
 if(!delta.trim()||!orb||!field||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
 const from=orb.getBoundingClientRect(),to=field.getBoundingClientRect();
 if(!from.width||!to.width||to.top<=from.top)return;
 clearVoiceFlight();
 const node=document.createElement('span');node.className='voice-transcript-flight';node.setAttribute('aria-hidden','true');
 node.textContent=Array.from(delta.trim()).slice(-12).join('');
 Object.assign(node.style,{left:(from.left+from.width*.5)+'px',top:(from.top+from.height*.65)+'px'});
 document.body.appendChild(node);
 const dx=to.left+Math.min(to.width*.46,130)-from.left-from.width*.5;
 const dy=to.bottom-22-from.top-from.height*.65;
 const animation=node.animate([
  {opacity:0,transform:'translateX(-50%) scale(.65)'},
  {opacity:.92,offset:.20,transform:'translate(-50%,12px) scale(.86)'},
  {opacity:.65,offset:.75,transform:`translate(calc(-50% + ${dx*.74}px),${dy*.78}px) scale(.92)`},
  {opacity:0,transform:`translate(calc(-50% + ${dx}px),${dy}px) scale(1)`}
 ],{duration:500,easing:'cubic-bezier(.34,.2,.28,1)'});
 voiceFlight=animation;
 const remove=()=>{node.remove();if(voiceFlight===animation)voiceFlight=null;};
 animation.finished.then(remove,remove);
}
watch(displayedComposer,(value,previous)=>{
 resizeComposer();
 if(!voiceActive.value||!voice.value.preview||!composer.value)return;
 composer.value.scrollTop=composer.value.scrollHeight;
 const before=Array.from(previous||''),after=Array.from(value);
 let common=0;
 while(common<before.length&&common<after.length&&before[common]===after[common])common++;
 animateVoiceTranscript(after.slice(common).join(''));
},{flush:'post'});
watch(voiceActive,active=>{if(!active)clearVoiceFlight();});
const voiceBinding=computed(()=>{
 const scope=draftScope();
 return scope?JSON.stringify([scope,taskQuote.value?.id||null]):'';
});
const voiceScope=computed(()=>{
 if(!browserOnline.value||!paired.value||!currentTopic.value||currentTopic.value.executable===false||settingsOpen.value||conversationPanel.value==='work'||navigationVisible.value||busy.value||newSubmissionBlocked.value)return '';
 return voiceBinding.value;
});
const canEditComposer=computed(()=>Boolean(currentTopic.value&&(currentTopic.value.executable!==false||
 (composerDraft.value.voiceReview&&currentTopic.value.unavailableReason==='HISTORY_CONTEXT_LOADING'&&composerScope===draftScope()))));
const keyboardOrbPreference='vcp.mobile.keyboard-orb';
const keyboardOrbEnabled=ref(false),keyboardOrbMode=ref(false),keyboardOrbPhrase=ref('');
try{keyboardOrbEnabled.value=localStorage.getItem(keyboardOrbPreference)==='on';}catch{}
function setKeyboardOrbEnabled(enabled){
 keyboardOrbEnabled.value=enabled;
 if(!enabled)clearKeyboardOrb();
 try{localStorage.setItem(keyboardOrbPreference,enabled?'on':'off');}catch{}
}

let keyboardOrbBefore='',keyboardOrbBase='',keyboardOrbTimer,keyboardOrbRevision=0;
function clearKeyboardOrb(){
 if(!keyboardOrbMode.value)return;
 keyboardOrbMode.value=false;
 keyboardOrbPhrase.value='';
 keyboardOrbBefore=keyboardOrbBase='';
 keyboardOrbRevision++;
 clearTimeout(keyboardOrbTimer);
 clearVoiceFlight();
}
function beginKeyboardOrb(event){
 const field=event.currentTarget;
 if(!keyboardOrbEnabled.value||!voiceScope.value||!canEditComposer.value||voiceActive.value||document.hidden)return;
 if(keyboardOrbMode.value&&keyboardOrbBefore===field.value)return;
 clearKeyboardOrb();
 keyboardOrbBefore=keyboardOrbBase=field.value;
 keyboardOrbMode.value=true;
}
async function mirrorKeyboardOrb(event){
 if(!keyboardOrbMode.value)return;
 const field=event.currentTarget;
 const before=keyboardOrbBefore;
 keyboardOrbBefore=field.value;
 if(before===field.value)return;
 const change=changedInputText(before,field.value,event.inputType);
 const revision=++keyboardOrbRevision;
 clearTimeout(keyboardOrbTimer);
 clearVoiceFlight();
 if(change===null){keyboardOrbPhrase.value='';keyboardOrbBase=field.value;return;}
 keyboardOrbPhrase.value=changedInputText(keyboardOrbBase,field.value)||'';
 if(!keyboardOrbPhrase.value.trim())return;
 keyboardOrbTimer=setTimeout(()=>{keyboardOrbPhrase.value='';},2000);
 if(!change.trim())return;
 await nextTick();
 if(revision===keyboardOrbRevision&&keyboardOrbMode.value)animateVoiceTranscript(change);
}
watch(voiceScope,clearKeyboardOrb,{flush:'sync'});
watch(voiceActive,active=>{if(active)clearKeyboardOrb();},{flush:'sync'});
const recognitionConstructor=()=>server.value?.localSpeech ? localSpeechRecognition() : null;
const dictation=createVoiceDictation({
 getRecognition:recognitionConstructor,
 getScope:()=>voiceBinding.value,
 update:state=>{voice.value=state;},
 onLevel:level=>{voiceLevel.value=Number.isFinite(level)?level:0;},
 checkpoint:(binding,preview,final)=>{
  const [scope]=JSON.parse(binding);
  const draft=drafts.get(scope);
  if(!draft)return;
  draft.voiceDurable=true;
  draft.voicePreview=preview;
  draft.voicePreviewFinal=final;
  rememberOrdinaryText(draft,scope);
  return voiceDraftWrites.get(draft);
 },
 settle:({scope:binding,text:transcript,review})=>{
  const [scope]=JSON.parse(binding);
  const draft=drafts.get(scope);
  if(!draft||(!transcript&&!draft.voicePreview))return '';
  delete draft.voicePreview;
  delete draft.voicePreviewFinal;
  const next=transcript?mergeVoiceText(draft.text,transcript):draft.text;
  const appended=next.slice(draft.text.length).trim();
  const full=transcript&&appendVoice(draft.text,transcript).length>12000;
  if(appended){
   draft.text=next;
   draft.revision++;
   if(review)draft.voiceReview=true;
   saveDraftEdit(draft);
  }
  const saved=rememberOrdinaryText(draft,scope);
  const message=!saved?ordinaryDraftError.value:full?
   (appended?'草稿达到字数上限，部分语音未写入。':'草稿已满，未写入识别文字。'):'';
  return voiceDraftWrites.get(draft)?.then(()=>message)||message;
 }
});
function toggleVoice(){
 if(voiceActive.value){dictation.stop();return;}
 if(!voiceScope.value||document.hidden)return;
 if(!server.value?.localSpeech){
  dictation.cancel('当前入口未启用本机语音识别。可以打字，或使用系统键盘听写。');
  return;
 }
 if(!recognitionConstructor()){dictation.start();return;}
 if(!voiceConsent){voiceDisclosure.value=!voiceDisclosure.value;return;}
 dictation.start();
}
function allowVoice(){
 if(!voiceScope.value||document.hidden||!server.value?.localSpeech)return;
 voiceConsent=true;voiceDisclosure.value=false;
 dictation.start();
}
function resetVoice(){clearKeyboardOrb();voiceDisclosure.value=false;dictation.cancel();}
function suspendVoice(){
 clearKeyboardOrb();
 voiceDisclosure.value=false;
 dictation.interrupt();
}
function hideVoice(){if(document.hidden)suspendVoice();}
watch(voiceBinding,resetVoice,{flush:'sync'});
watch([settingsOpen,navigationVisible,conversationPanel],()=>{
 if(settingsOpen.value||navigationVisible.value||conversationPanel.value==='work')resetVoice();
},{flush:'sync'});
watch(browserOnline,online=>{
 if(!online){
  voiceDisclosure.value=false;
  dictation.interrupt('连接已断开，原草稿已保留。可以继续打字。');
 }
},{flush:'sync'});
onMounted(()=>{
 document.addEventListener('visibilitychange',hideVoice);
 window.addEventListener('pagehide',suspendVoice);
});
onUnmounted(()=>{
 document.removeEventListener('visibilitychange',hideVoice);
 window.removeEventListener('pagehide',suspendVoice);
 suspendVoice();
});
async function submitComposer(){
 clearKeyboardOrb();
 if(voiceActive.value||busy.value||newSubmissionBlocked.value||currentTopic.value?.executable===false)return;
 if(taskQuote.value){
  if(!currentTopic.value?.executable||quoteSendBlocked.value)return;
  await sendCoreSteering(taskQuote.value);
  return;
 }
 if(!composerDraft.value.modelUnavailable)await send();
}
const validSteeringId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{8,100}$/.test(value);
const validTaskQuote=quote=>validSteeringId(quote?.id)&&typeof quote.name==='string'&&typeof quote.label==='string';
function readSteeringDraft(scope){
 const raw=localStorage.getItem(steeringStoragePrefix+scope);
 if(raw===null)return null;
 const corrupt=()=>{
  if(localStorage.getItem(dismissedSteeringPrefix+scope)===raw)return null;
  throw Object.assign(Error('Invalid steering draft'),{code:'STEERING_RECORD_CORRUPT',raw});
 };
 let saved;
 try{saved=JSON.parse(raw);}catch{return corrupt();}
 const intent=saved?.intent,quote=saved?.quote;
 if(!validSteeringId(intent?.requestId)||!validTaskQuote(quote)||intent.workId!==quote.id||
    (intent.editId!==undefined&&!validSteeringId(intent.editId))||
    typeof intent.text!=='string'||!intent.text.trim()||intent.text.length>12000||
    typeof saved.text!=='string'||saved.text.length>12000||
    !Number.isSafeInteger(intent.revision)||intent.revision<0||
    !Number.isSafeInteger(saved.revision)||saved.revision<0)return corrupt();
 if(localStorage.getItem(confirmedSteeringKey(scope,intent.requestId))===intent.workId)return null;
 return saved;
}
function writeSteeringDraft(scope,draft){
 const key=steeringStoragePrefix+scope;
 const intent=draft.coreSteering;
 let previous;
 try{previous=JSON.parse(localStorage.getItem(key))?.intent;}catch{/* Ignore the discarded invalid version. */}
 localStorage.setItem(key,JSON.stringify({intent,quote:draft.taskQuote,text:draft.text,revision:draft.revision}));
 if(validSteeringId(previous?.requestId)&&previous.requestId!==intent.requestId)
  localStorage.removeItem(confirmedSteeringKey(scope,previous.requestId));
 localStorage.removeItem(dismissedSteeringPrefix+scope);
}
function syncSteeringDraft(){
 if(!composerScope||composerDraft.value.coreSteering)return;
 try{
  const saved=readSteeringDraft(composerScope);
  if(steeringRecordCorrupt.value){
   steeringRecordCorrupt.value=false;
   steeringRemovalPrompt.value=false;
   steeringStorageError.value='';
  }
  if(!saved)return;
  const draft=composerDraft.value;
  if(!draft.revision&&!draft.ordinaryEditId&&!draft.text){
   draft.text=saved.text;
   draft.revision=saved.revision;
   if(saved.intent.editId)draft.ordinaryEditId=saved.intent.editId;
  }
  draft.coreSteering=saved.intent;
  draft.taskQuote ??= saved.quote;
 }catch(error){
  steeringRecordCorrupt.value=error.code==='STEERING_RECORD_CORRUPT';
  steeringStorageError.value=steeringRecordCorrupt.value?'当前话题的本机追加记录损坏。':'无法读取本机追加记录，请检查浏览器存储。';
 }
}
async function removeCorruptSteeringRecord(){
 if(busy.value||!steeringRecordCorrupt.value||!steeringRemovalPrompt.value)return;
 const context=captureContext(),key=steeringStoragePrefix+context.draftScope;
 const remove=()=>{
  if(!sameView(context)||context.draftScope!==composerScope||composerDraft.value.coreSteering)return;
  try{readSteeringDraft(context.draftScope);}
  catch(error){
   if(error.code!=='STEERING_RECORD_CORRUPT')throw error;
   // A Web Lock orders callbacks, but the other tab's storage update may
   // still be invisible here. Dismiss this bad value without deleting the
   // shared pending slot, which may already contain a valid replacement.
   localStorage.setItem(dismissedSteeringPrefix+context.draftScope,error.raw);
  }
  syncSteeringDraft();
 };
 try{
  if(navigator.locks)await navigator.locks.request(key,remove);
  else remove();
 }catch{
  if(sameView(context))steeringStorageError.value='无法移除本机追加记录，请检查浏览器存储。';
 }
}
const steeringPath=(topic,workId)=>corePath(topic)+'/works/'+encodeURIComponent(workId);
const sameSteering=(a,b)=>a?.requestId===b.requestId&&a.workId===b.workId;
function originalSteeringDraft(context,intent){
 if(!sameView(context)||context.draftScope!==composerScope)return;
 const draft=drafts.get(context.draftScope);
 if(sameSteering(draft?.coreSteering,intent))return draft;
}
async function confirmSteering(context,intent,receipt){
 if(!sameSteering(receipt,intent)||
    typeof receipt.messageId!=='string'||!receipt.messageId||!Number.isSafeInteger(receipt.seq)||receipt.seq<1)return;
 const scope=context.draftScope,key=steeringStoragePrefix+scope;
 const settle=()=>{
  const draft=originalSteeringDraft(context,intent);
  if(!draft)return;
  try{
   const saved=readSteeringDraft(scope);
   if(saved&&!sameSteering(saved.intent,intent))return;
   // Delayed receipts may update this tab but cannot overwrite another
   // edit's durable delivery mark.
   const submittedEdit=intent.editId;
   if(submittedEdit){
    if(saved&&storedOrdinaryText(scope)?.editId===submittedEdit)
     localStorage.setItem(steeringDeliveredEditKey(scope,submittedEdit),'1');
   }
   else if(saved?.revision>intent.revision&&!readOrdinaryText(scope)?.quote){
    const later={text:saved.text,taskQuote:saved.quote};
    if(!rememberOrdinaryText(later,scope))return;
    if(draft.revision===intent.revision&&draft.text===intent.text){
     draft.text=later.text;
     draft.ordinaryEditId=later.ordinaryEditId;
     draft.revision=saved.revision;
    }
   }
   // A stale read can survive the lock handoff. Record the verified
   // request, leaving the shared pending slot available to a newer writer.
   if(saved)localStorage.setItem(confirmedSteeringKey(scope,intent.requestId),intent.workId);
   const sent=submittedEdit?draft.ordinaryEditId===submittedEdit:
    draft.revision===intent.revision&&draft.text===intent.text;
   if(sent){draft.text='';delete draft.taskQuote;delete draft.ordinaryEditId;}
   delete draft.coreSteering;
   draft.steeringDelivery='Core 已收到追加指令。是否采纳请查看原回复。';
   steeringStorageError.value='';
  }catch{steeringStorageError.value='已核对 Core 收到追加指令，浏览器暂无法更新本地记录。';}
 };
 if(navigator.locks)await navigator.locks.request(key,settle);
 else settle();
}
async function rejectSteering(context,intent,error){
 const definite=error.status===409&&error.code==='WORK_STEERING_WINDOW_CLOSED'||
  error.status===404&&error.code==='WORK_NOT_FOUND'||
  error.status===429&&error.code==='WORK_STEERING_LIMIT';
 if(!definite)return;
 const key=steeringStoragePrefix+context.draftScope;
 await navigator.locks.request(key,()=>{
  const draft=originalSteeringDraft(context,intent);
  if(!draft)return;
  try{
   const saved=readSteeringDraft(context.draftScope);
   if(saved&&!sameSteering(saved.intent,intent))return;
   if(saved?.revision>draft.revision&&draft.revision===intent.revision&&draft.text===intent.text){
    draft.text=saved.text;
    draft.revision=saved.revision;
   }
   if(!readOrdinaryText(context.draftScope)?.quote&&!rememberOrdinaryText(draft,context.draftScope))return;
   if(saved)localStorage.removeItem(key);
   delete draft.coreSteering;
   if(draft.taskQuote?.id===intent.workId)draft.taskQuote.rejected=true;
   draft.steeringDelivery='服务端已拒绝追加，草稿已保留。';
   steeringStorageError.value='';
  }catch{steeringStorageError.value='服务端已拒绝追加，浏览器暂无法更新本机记录。';}
 });
}
async function reconcileSteering(topic,readApi,context){
 const intent=drafts.get(context.draftScope)?.coreSteering;
 if(!intent||!sameView(context))return;
 try{
  const {receipt}=await readApi(steeringPath(topic,intent.workId)+'/steering-receipt?'+new URLSearchParams({requestId:intent.requestId}));
  await confirmSteering(context,intent,receipt);
 }catch{/* Unknown remains pending. This read never resubmits the intent. */}
}
async function sendCoreSteering(quote){
 const topic=currentTopic.value, draft=composerDraft.value, original=draft.text, revision=draft.revision;
 let context;
 busy.value=true;
 try{
  context=newSubmissionContext();
  if(!navigator.locks)throw Object.assign(Error(recoveryMessages.SUBMISSION_LOCK_UNAVAILABLE),{code:'SUBMISSION_LOCK_UNAVAILABLE'});
  const key=steeringStoragePrefix+context.draftScope;
  const intent=await navigator.locks.request(key,()=>{
   if(!sameView(context)||draft.revision!==revision||draft.taskQuote!==quote)return;
   syncSteeringDraft();
   if(draft.coreSteering||steeringStorageError.value)return;
   if(!draft.ordinaryEditId&&!rememberOrdinaryText(draft,context.draftScope))return;
   const intent={workId:quote.id,text:original,requestId:crypto.randomUUID(),revision,editId:draft.ordinaryEditId};
   writeSteeringDraft(context.draftScope,{...draft,coreSteering:intent});
   draft.coreSteering=intent;
   delete draft.steeringDelivery;
   return intent;
  });
  if(!intent||!sameView(context))return;
  let receipt;
  try{
   receipt=await api(steeringPath(topic,intent.workId)+'/steer',{requestId:intent.requestId,text:original},{
    'X-NativeSync-Entry-Id':context.recovery.entryId,'X-NativeSync-Session-Marker':context.recovery.sessionMarker
   });
  }catch(error){
   // Only a recognized business rejection from this POST can release its intent.
   await rejectSteering(context,intent,error);
  }
  if(receipt)await confirmSteering(context,intent,{...receipt,requestId:intent.requestId});
  void refresh();
 }catch(error){
  if(!context||sameView(context))notice.value=recoveryMessage(error);
 }finally{busy.value=false;}
}
async function send(){
 if((!text.value.trim()&&!pendingFiles.value.length)||busy.value||currentTopic.value?.executable===false)return;
 let context;busy.value=true;submissionNoticeHeld=false;
 try{
  context=newSubmissionContext();
  const draft=composerDraft.value;
  await draftWrites.get(draft);
  if(!sameView(context))return;
  context.rejected=draft.rejected;
  const snapshot={text:draft.text,revision:draft.revision,files:[...draft.files],model:draft.nextModel},ids=[];
  for(const item of snapshot.files){
   item.error='';
   try{
    if(item.uploadSessionMarker!==context.recovery.sessionMarker)item.uploadId=null;
    if(!item.uploadId&&!item.file)throw Error('请移除已上传附件并重新选择原文件');
    item.uploadId=item.uploadId||await uploadAttachment(api,context.topicKey,item.file,n=>item.progress=n,
     currentTopic.value?.coreSingle?corePath(currentTopic.value)+'/attachments':undefined);
    item.uploadSessionMarker=context.recovery.sessionMarker;
    ids.push(item.uploadId);
   }catch(error){item.error=error.message;throw error;}
  }
  if(!sameView(context))return;
  const requestId=crypto.randomUUID();
  draft.submitted={requestId,revision:snapshot.revision,files:snapshot.files};
  await submit({requestId,text:snapshot.text,attachments:ids,...(snapshot.model&&{model:snapshot.model})},'message',context);
 }
 catch(error){if(!context||sameView(context)){submissionNoticeHeld=true;notice.value=recoveryMessage(error);}}finally{busy.value=false;}
}
async function refreshRetrySession(context){
 const result=await api('session');if(!sameView(context))return null;
 const nextRecovery=validSessionRecovery(result.recovery)?{version:1,entryId:result.recovery.entryId,sessionMarker:result.recovery.sessionMarker}:null;
 if(nextRecovery?.entryId!==recoveryContext.value?.entryId||nextRecovery?.sessionMarker!==recoveryContext.value?.sessionMarker){authEpoch++;switchDraft('');clearSharedObservers();historyCache.clear();closeNativeResult();closeAttachment();submissionNoticeHeld=false;acceptedReceipt.value=null;recoveryDetail.value='';}
 sharedFeatures.value=Array.isArray(result.sharedFeatures)?result.sharedFeatures:[];recoveryContext.value=nextRecovery;directoryPaged=result.directory?.paged===true;
 const readEpoch=authEpoch,directory=directoryPaged?await readDirectoryPages(api,()=>readEpoch===authEpoch):{topics:Array.isArray(result.topics)?result.topics:[],agents:result.agents};
 if(!directory||readEpoch!==authEpoch)return null;await setDirectory(directory,{adjustSelection:false});
 switchDraft();
 // Refresh authorization and the live Cookie's noncredential marker without
 // adopting selectedTopic from another page or clearing this page's draft.
 return {...context,authEpoch,recovery:nextRecovery};
}
async function retry(){
 if(busy.value)return;let context;busy.value=true;submissionNoticeHeld=false;
 try{
  if(!loadRecovery())throw Error(recoveryError.value);context=captureContext();
  const record=submissionStore.current({entryId:context.recovery.entryId,topicKey:context.topicKey});if(!record)return;
  context=await refreshRetrySession(context);if(!context)return;
  if(!validSessionRecovery(context.recovery))throw Object.assign(Error(recoveryMessages.SUBMISSION_RECOVERY_UNAVAILABLE),{code:'SUBMISSION_RECOVERY_UNAVAILABLE'});
  if(!topics.value.some(topic=>topic.key===record.topicKey))throw Object.assign(Error(recoveryMessages.SUBMISSION_TOPIC_UNAVAILABLE),{code:'SUBMISSION_TOPIC_UNAVAILABLE'});
  await submissionStore.verify(record);
  // Executions are not paginated by the history cursor. Always query the
  // authorized topic; cached jobs and the latest own job cannot identify it.
  const query=new URLSearchParams({requestId:record.requestId});
  const response=await api(currentTopic.value?.coreSingle ? corePath(currentTopic.value)+'/receipt?'+query :
   'conversations/'+encodeURIComponent(record.topicKey)+(currentTopic.value?.executionProtocol===2?'/execution-request?'+query:'?after=0'));
  if(!sameView(context))return;
  const result=await reconcileSubmission(record,response.executions,context);
  if(result.state==='confirmed'){if(sameView(context)){notice.value='已核对云端接受记录，未重新发送。';await refresh();}return;}
  if(result.state!=='absent'){if(sameView(context)){submissionNoticeHeld=true;notice.value=recoveryReasons[result.reason];}return;}
  // This explicit click is the only resend path. inspect() permits it only
  // when the same session has no candidate for this original request.
  if(sameView(context))await postPrepared(record,context);
 }catch(error){loadRecovery();if(!context||sameView(context)){submissionNoticeHeld=true;notice.value='原提交仍待核对：'+recoveryMessage(error);}}
 finally{busy.value=false;}
}
async function invite(){
 if(!invitedAgent.value||busy.value||currentTopic.value?.executable===false)return;
 submissionNoticeHeld=false;
 try{
  const topic=currentTopic.value;
  if(topic?.coreSingle&&topic.groupMode==='jev'){
   const agentId=invitedAgent.value;
   const result=await api(corePath(topic)+'/jev',{action:'invite',agentId});
   if(!result.success)throw Error(result.error||'JEV 未接受邀请');
   if(currentTopic.value?.key===topic.key&&invitedAgent.value===agentId)invitedAgent.value='';
   await refresh();
   return;
  }
  const context=newSubmissionContext();
  await submit({requestId:crypto.randomUUID(),agentId:invitedAgent.value},'invitation',context);
 }catch(error){submissionNoticeHeld=true;notice.value=recoveryMessage(error);}
}
function waitingForGroupTasks(job){
 return job.state==='recovering' && !job.remainingCancelled && job.steps?.length &&
  job.steps.every(step=>step.state==='completed') && job.nativeTasks.some(task=>['accepted','running','waiting','cancelling'].includes(task.state));
}
function executionLabel(j){
 if(workReplySyncing(j))return '正在同步回复';
 if(j.state==='completed'&&j.kind==='group_message'&&j.stepCount===0)return '消息已保存 · 未触发成员回复';
 if(waitingForGroupTasks(j))return '成员回复已保存，等待原生任务结束';
 if(j.remainingCancelled && j.state==='cancelled')return '剩余接力已取消';
 if(j.state==='cancelled' && j.reviewResolved && j.errorCode==='EXECUTION_INTERRUPTED_REVIEW_REQUIRED')return '已人工结清，剩余工作已放弃';
 return errors[j.errorCode]||labels[j.state]||j.state;
}
function needsReview(j){return j.nativeTasks?.some(task=>task.reviewRequired&&!task.reviewResolved)||(!j.reviewResolved&&(['review_required','blocked_config'].includes(j.state)||j.errorCode?.endsWith('REVIEW_REQUIRED')));}
function canResolveReview(j){
 if(!needsReview(j))return false;
 if(!Array.isArray(j.steps)&&!['group_message','group_invitation'].includes(j.kind))return true;
 return ['review_required','blocked_config','failed','cancelled','completed'].includes(j.state)&&!(j.steps||[]).some(step=>['running','waiting_approval','publishing'].includes(step.state));
}
function closeNativeResult(){nativeResultRequest++;nativeResult.value=null;}
async function showNativeResult(job,task){
 const context={topicKey:selected.value,generation,authEpoch},request=++nativeResultRequest;
 const current=()=>request===nativeResultRequest&&context.topicKey===selected.value&&context.generation===generation&&context.authEpoch===authEpoch;
 nativeResult.value={taskId:task.nativeTaskId,loading:true,content:null,error:null};
 try{
  const base=job.core ? corePath(currentTopic.value)+'/works/'+encodeURIComponent(job.id)+'/tasks/' :
    'conversations/'+encodeURIComponent(context.topicKey)+'/executions/'+encodeURIComponent(job.id)+'/native-tasks/';
  const value=await api(base+encodeURIComponent(task.nativeTaskId)+(job.core?'':'/result'));
  const verified=job.core?value:await verifyNativeResult(value,job.id,task,resultHash);
  if(job.core&&(verified.id!==task.nativeTaskId||verified.revision!==task.revision||typeof verified.content!=='string'))throw Error('NATIVE_TASK_RESULT_MISMATCH');
  if(current()){nativeResult.value={taskId:task.nativeTaskId,loading:false,content:verified.content,error:null};await nextTick();if(current())nativeResultPanel.value?.scrollIntoView({block:'nearest'});}
 }catch(error){if(current())nativeResult.value={taskId:task.nativeTaskId,loading:false,content:null,error:'报告暂不可核对，原任务记录保留。'+(error.code?'（'+error.code+'）':'')};}
}
async function abandon(j){if(!canResolveReview(j)||!reviewChecks.value[j.id])return;try{
 if(j.core)await api(corePath(currentTopic.value)+'/works/'+encodeURIComponent(j.id)+'/release',{requestId:crypto.randomUUID(),confirmed:true});
 else await api('executions/'+j.id+'/resolve',{action:'acknowledge_and_abandon_remaining'});notice.value='已记录人工核对并解除本次暂停；旧请求不会重跑。这不代表已取消 AA 或撤回工具副作用。';await refresh();}catch(e){notice.value=e.message;}}
const supportsCancelRemaining = computed(() => Boolean(currentTopic.value?.sharedSpaceId)
 && sharedFeatures.value.includes('group-cancel-remaining-v1'));
async function cancelRemaining(job) {
 if (!job.own || !supportsCancelRemaining.value || job.topicKey !== selected.value) return;
 let context;
 try {
  context = captureContext();
  const result = await api('executions/'+encodeURIComponent(job.id)+'/cancel-remaining', {}, {
   'X-NativeSync-Entry-Id':context.recovery.entryId, 'X-NativeSync-Session-Marker':context.recovery.sessionMarker,
  });
  if (!sameView(context)) return;
  if (result.id !== job.id) throw Error('工作编号不匹配，请重新核对执行状态。');
  if (result.remainingCancelled) notice.value = '已取消剩余接力';
  else notice.value = result.steps?.some(step => step.state === 'queued') ? '工作状态已变化，请核对接力进度。' : '没有剩余接力';
  await refresh();
 } catch (e) {
  if (!context || sameView(context)) notice.value = '请核对本轮接力状态。'+e.message;
 }
}
async function cancel(id){try{
 if(currentTopic.value?.coreSingle)await api(corePath(currentTopic.value)+'/works/'+encodeURIComponent(id)+'/cancel',{requestId:crypto.randomUUID()});
 else await api('executions/'+id+'/cancel',{});
 await refresh();}catch(e){notice.value=e.message;}}
function applyPairingLink(code){if(!code)return;if(!connectionInitialized){incomingPairing=code;return;}if(paired.value)return;pairCode.value=code;pairingLinkOpen.value=true;settingsOpen.value=true;notice.value='已读取一次性配对码，请确认连接会话。';}
function pairingHashChanged(){applyPairingLink(consumePairingLink({location:window.location,history:window.history,secureContext:window.isSecureContext}));}
async function deviceVisibilityChanged(){resetHistory({remember:false});if(lastDirectory)await setDirectory(lastDirectory);await refreshDirectory(true);await refresh();}
function clearTransientKey(){pageSuspended=true;startupSessionController?.abort();refreshing?.abort();refreshing=null;generation++;clearSharedObservers();sharedObserver.suspend();historyCache.clear();accessKey.value='';pairCode.value='';incomingPairing=null;closeAttachment();}
function storageChanged(event){if(event.key===steeringStoragePrefix+composerScope)syncSteeringDraft();if(event.key===SUBMISSION_STORAGE_KEY||event.key===null){if(loadRecovery())syncRejectedDraft();recoveryDetail.value='';}}
async function refreshView(){if(pageSuspended)return;if(needsSessionRecovery&&browserOnline.value){await session();return;}try{await refreshDirectory();}catch{}if(sharedObserver.hasLive()&&historyContextReady.value&&!pendingSubmission.value&&!sharedRefreshPending)return;await refresh();}
function markOffline(){browserOnline.value=false;}
async function reconnect(){browserOnline.value=true;if(pageSuspended||!connectionInitialized)return;clearSharedObservers();sharedObserver.resume();loadRecovery();await session();}
async function pageShown(){pageSuspended=false;sharedObserver.resume();if(connectionInitialized)await session();}
onMounted(async()=>{
 loadRecovery();
 fitViewport();
 window.visualViewport?.addEventListener('resize',fitViewport);
 window.addEventListener('resize',resizeComposer);
 window.addEventListener('offline',markOffline);
 prefersDark.addEventListener('change',syncTheme);
 window.addEventListener('hashchange',pairingHashChanged);
 window.addEventListener('pagehide',clearTransientKey);
 window.addEventListener('pageshow',pageShown);
 window.addEventListener('storage',storageChanged);
 window.addEventListener('online',reconnect);
 const controller=new AbortController();
 startupSessionController=controller;
 await connectionInfo();
 if(!controller.signal.aborted)await session({startupSignal:controller.signal});
 startupSessionController=null;
 connectionInitialized=true;busy.value=false;
 if(controller.signal.aborted&&!pageSuspended)await session();
 applyPairingLink(incomingPairing);incomingPairing=null;timer=setInterval(refreshView,2000);
});
onUnmounted(()=>{window.visualViewport?.removeEventListener('resize',fitViewport);window.removeEventListener('resize',resizeComposer);window.removeEventListener('offline',markOffline);prefersDark.removeEventListener('change',syncTheme);sharedObserver.close();clearTimeout(sharedRefreshTimer);refreshing?.abort();refreshing=null;clearInterval(timer);window.removeEventListener('hashchange',pairingHashChanged);window.removeEventListener('pagehide',clearTransientKey);window.removeEventListener('pageshow',pageShown);window.removeEventListener('storage',storageChanged);window.removeEventListener('online',reconnect);clearTransientKey();});
</script>
<template>
 <div ref="shell" class="shell" :style="viewportHeight ? {'--visual-height':viewportHeight+'px'} : null" @pointerdown="dismissModelPickerOutside" @keydown.esc="modelPicker?closeModelPicker(true):composerMenu?composerMenu=false:conversationPanel&&closePanel()">
<dialog ref="agentCreationDialog" class="agent-creation-dialog" aria-labelledby="agent-creation-title" @keydown.esc.stop @cancel="creatingAgent && $event.preventDefault()">
   <form @submit.prevent="createCoreAgent">
    <h2 id="agent-creation-title">新建助手</h2>
    <label for="agent-creation-name">名称</label>
    <input id="agent-creation-name" v-model="agentCreationDraft.name" maxlength="100" required autofocus :readonly="Boolean(pendingAgentCreation)||creatingAgent">
    <label for="agent-creation-model">模型</label>
    <select id="agent-creation-model" v-model="agentCreationDraft.model" required
      :aria-busy="agentCreationModelsLoading||undefined" :disabled="agentCreationModelsLoading||Boolean(pendingAgentCreation)||creatingAgent">
     <option value="" disabled>{{agentCreationModelsLoading?'正在读取模型…':'请选择模型'}}</option>
     <option v-if="pendingAgentCreation&&agentCreationDraft.model&&!agentCreationModels.includes(agentCreationDraft.model)" :value="agentCreationDraft.model">{{agentCreationDraft.model}}</option>
     <option v-for="model in agentCreationModels" :key="model" :value="model">{{model}}{{model===agentCreationDefaultModel?'（Core 默认）':''}}</option>
    </select>
    <label for="agent-creation-instructions">简短指令（可选）</label>
    <textarea id="agent-creation-instructions" v-model="agentCreationDraft.instructions" maxlength="1000" rows="3" :readonly="Boolean(pendingAgentCreation)||creatingAgent"></textarea>
    <p v-if="agentCreationError" role="alert">{{agentCreationError}}</p>
    <p v-else-if="pendingAgentCreation&&!creatingAgent" role="status">创建结果待确认。</p>
    <div class="agent-creation-actions">
     <button class="quiet-button" type="button" :disabled="creatingAgent" @click="agentCreationDialog.close()">关闭</button>
     <button type="submit" :disabled="creatingAgent||busy||!agentCreationKey||agentCreationStorageBlocked||!agentCreationDraft.name.trim()||(!pendingAgentCreation&&!agentCreationModels.includes(agentCreationDraft.model))">{{creatingAgent?'正在确认…':pendingAgentCreation?'重试创建':'创建'}}</button>
    </div>
   </form>
 </dialog>
 <dialog v-if="attachmentPreview" ref="attachmentDialog" id="attachment-viewer" class="attachment-viewer" aria-labelledby="attachment-title" @cancel.prevent="closeAttachment">
   <div class="attachment-viewer-heading"><strong id="attachment-title">{{attachmentPreview.name}}</strong><button id="attachment-close" @click="closeAttachment" autofocus>关闭</button></div>
   <p v-if="attachmentPreview.loading" role="status">正在读取附件…</p><p v-else-if="attachmentPreview.error" role="alert">{{attachmentPreview.error}}</p>
   <template v-else>
    <div class="attachment-viewer-content">
     <img v-if="attachmentPreview.isImage" :src="attachmentPreview.url" :alt="attachmentPreview.name" @error="draftImageError">
     <TextPages v-else-if="attachmentPreview.text!==null" :text="attachmentPreview.text" :complete="!attachmentPreview.truncated"/>
     <p v-else>此文件暂无页内预览，可以保存后打开。</p>
     <small v-if="attachmentPreview.truncated">{{attachmentPreview.localFile?'仅显示文件开头。':'预览已截取，保存文件可查看完整内容。'}}</small>
    </div>
    <button v-if="!attachmentPreview.localFile" id="attachment-save" @click="downloadAttachment">保存文件</button>
   </template>
  </dialog>
  <header :class="{'chat-header': paired && !settingsOpen}">
   <template v-if="paired && !settingsOpen">
    <button id="topic-toggle" ref="topicToggle" class="icon-button" type="button" aria-controls="conversation-navigation"
      :aria-expanded="navigationVisible" aria-label="切换话题" @click="togglePanel('topics')"><MobileIcon name="menu"/></button>
    <div class="conversation-title">
     <AgentAvatar :src="currentTopic?.avatar||activeAgent?.avatar" :name="currentTopic?.agentName||activeAgent?.name"/>
     <div v-if="supportsModelSelection && !navigationVisible && conversationPanel!=='work'" class="composer-model header-model" ref="modelPickerRoot" @focusout="modelPickerFocusLeft">
      <span v-if="taskQuote" id="composer-model-current" :title="'追加沿用 · '+(shownModel||'原任务模型')"><span class="sr-only">追加沿用 · {{shownModel||'原任务模型'}}</span><ModelBrandMark :model="shownModel"/></span>
      <button v-else id="composer-model-current" ref="modelPickerTrigger" type="button" aria-haspopup="dialog" aria-controls="composer-model-options" :aria-expanded="Boolean(modelPicker)" :title="shownModel||'Agent 默认'" @keydown.down.prevent="openModelPickerFromKey"
        :disabled="busy||newSubmissionBlocked||!currentTopic?.executable" @click="toggleModelPicker">
       <span class="sr-only">{{composerDraft.nextModel?'下一条模型：':pendingSubmission?.payload.model?'待确认模型：':'当前模型：'}}</span><span class="sr-only">{{shownModel||'Agent 默认'}}</span><ModelBrandMark :model="shownModel"/>
      </button>
      <Transition :css="false" @enter="(el,done)=>modelPickerMotion(el,done,true)" @leave="(el,done)=>modelPickerMotion(el,done,false)">
       <div v-if="modelPicker" class="model-picker-overlay" @pointerdown.self.prevent="closeModelPicker(true)">
        <div class="model-picker-scrim" aria-hidden="true" @pointerdown.prevent="closeModelPicker(true)"></div>
        <div id="composer-model-options" class="composer-model-options model-morph-panel" role="dialog" aria-labelledby="model-morph-title">
         <div class="model-morph-content">
          <div class="model-morph-header">
           <strong id="model-morph-title">选择模型</strong>
           <button class="model-morph-close" type="button" aria-label="关闭模型选择" @click="closeModelPicker(true)"><MobileIcon name="close"/></button>
          </div>
       <div class="model-menu-search">
        <MobileIcon name="search" class="model-search-symbol"/>
        <input id="model-picker-search" ref="modelPickerSearch" v-model="modelPicker.query" type="search" aria-label="搜索模型"
         placeholder="搜索模型" autocomplete="off" autocapitalize="none" spellcheck="false"
         @keydown.down.prevent="focusModelPickerRow('first')" @keydown.enter="searchModelPickerOnEnter">
        <button v-if="modelPicker.query" class="model-search-clear" type="button" aria-label="清空搜索"
         @pointerdown.prevent @click="clearModelPickerSearch"><MobileIcon name="close"/></button>
       </div>
       <p v-if="modelPicker.loading" role="status">正在读取 Core 模型目录…</p>
       <p v-else-if="modelPicker.error" role="status">{{modelPicker.error}}</p>
       <p v-else-if="!modelPicker.models.length" role="status">Core 暂无可选模型</p>
       <p v-else-if="modelPickerQuery&&!filteredPickerModels.length" role="status">没有匹配的模型</p>
       <div class="model-menu-items" role="menu" aria-label="可选模型" @keydown="navigateModelPicker">
        <button v-if="!modelPickerQuery" class="model-menu-default" type="button" role="menuitemradio"
          :aria-checked="!composerDraft.nextModel" @click="pickNextModel(null)">Agent 默认</button>
        <div v-for="row in modelTileRows" :key="row.models[0]" class="model-tile-row" :data-capacity="row.capacity" role="presentation">
         <button v-for="model in row.models" :key="model" type="button" role="menuitemradio"
          :aria-checked="composerDraft.nextModel===model" @click="pickNextModel(model)"><span class="model-tile-name">{{model}}</span></button>
        </div>
       </div>
         </div>
        </div>
       </div>
      </Transition>
     </div>
     <div class="title-lines">
      <strong>{{ currentTopic?.topicName || '选择话题' }}</strong>
      <span class="title-meta"><span class="context-name">{{ currentTopic?.agentName || activeAgent?.name || 'VCP Mobile' }}</span><span v-if="!browserOnline||!online" class="connection offline">· 离线</span></span>
     </div>
    </div>
   </template>
   <div v-else class="brand"><img :src="'/mobile/icon.svg'" alt=""><strong>VCP Mobile</strong></div>
   <button id="open-settings" class="icon-button" type="button" :aria-label="settingsOpen?'关闭设置':'设置'" :aria-expanded="settingsOpen" @click="conversationPanel='';settingsOpen=!settingsOpen"><MobileIcon :name="settingsOpen?'close':'settings'"/></button>
  </header>
  <main v-if="settingsOpen||!paired" class="pairing settings">
   <h1 class="intro">{{paired?'设置':'连接你的会话'}}</h1>
   <p v-if="!paired">{{!server?'正在核对连接方式。':server?.mode==='core'||server?.credentialExchangeAllowed===false?'在电脑上生成手机配对码，即可在这里继续同一个话题。':'使用 VCPToolBox API Key 或一次性配对码连接。'}}</p>
   <form v-if="server && server.mode!=='core' && server.credentialExchangeAllowed!==false" @submit.prevent="connect">
    <details class="connection-choice" :open="settingsOpen"><summary>连接设置</summary><label for="server-address">后端地址</label><input id="server-address" v-model="serverUrl" type="url" required @input="tested=false;accessKey=''" :disabled="busy">
    <button id="test-connection" type="button" @click="testConnection" :disabled="busy">测试连接</button>
    <p v-if="server" id="server-info">{{server.service}} · {{server.plugin}}<br>{{server.serverUrl||'尚未配置正式后端'}}</p></details>
    <p v-if="!keyAllowed" id="connection-blocker">{{server?.credentialExchangeAllowed===false?'请使用下方一次性配对入口。':'安全接入尚未确认，访问凭据输入暂不可用。'}}</p>
    <label for="server-key">访问凭据 · VCPToolBox API Key</label><input id="server-key" v-model="accessKey" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" :disabled="busy||!keyAllowed||!tested" :placeholder="keyAllowed&&tested?'只需输入你的 Key':'HTTPS 安全入口就绪后可输入'" :required="keyAllowed&&tested">
    <button id="save-connection" :disabled="busy||!tested||!keyAllowed||!accessKey">{{paired?'重新认证并保存连接':'保存服务器连接'}}</button>
   </form>
   <div v-if="paired" class="device-actions"><button id="disconnect" @click="disconnect" :disabled="busy">断开此设备</button><button id="close-settings" @click="settingsOpen=false">返回会话</button></div>
   <p v-if="paired" class="pair-help">临时断网会自动重连。此浏览器的配对保留期间，重新打开可直接进入。断开此设备、配对被撤销或清除浏览器数据后，需要重新配对。</p>
   <details v-if="!paired" class="connection-choice" :open="pairingLinkOpen||server?.mode==='core'||server?.credentialExchangeAllowed===false">
    <summary>使用一次性配对码</summary>
    <form @submit.prevent="pair">
     <p id="pair-help" class="pair-help">
      <template v-if="server?.mode==='core'">在运行 ToolBox 的电脑上，请管理员用 ToolBox 账户在安装目录执行 <code>node apps/server/core/pairDevice.js pair mobile</code> 生成新码。</template>
      <template v-else>请让管理 ToolBox 的人从 NativeSync 生成此设备的一次性配对码。</template>
     </p>
     <label for="pair-code">一次性配对码</label>
     <input id="pair-code" v-model="pairCode" type="password" autocomplete="off" required
       :aria-invalid="Boolean(pairError)" :aria-describedby="pairError?'pair-help pair-error':'pair-help'" @input="pairError=''">
     <p v-if="pairError" id="pair-error" class="pair-error" role="alert">{{pairError}}</p>
     <button id="pair-submit" :aria-busy="busy||undefined" :disabled="busy">{{busy?'正在连接…':'连接会话'}}</button>
    </form>
   </details>
   <fieldset class="theme-settings"><legend>外观</legend><label v-for="(mode,index) in themeModes" :key="mode">
    <input type="radio" name="appearance" :value="mode" :checked="theme===mode" @change="applyTheme(mode)"><span>{{['跟随系统','浅色','深色'][index]}}</span>
   </label></fieldset>
   <div class="input-motion-setting">
    <label for="keyboard-orb-setting"><input id="keyboard-orb-setting" type="checkbox" role="switch" :checked="keyboardOrbEnabled"
      aria-describedby="keyboard-orb-setting-help" @change="setKeyboardOrbEnabled($event.target.checked)">输入动效</label>
    <small id="keyboard-orb-setting-help">开启后，键盘听写、打字和选词都可触发数字球。只在本设备生效。</small>
   </div>
   <p v-if="recoveryRecords.length" id="saved-submissions">此设备保留 {{recoveryRecords.length}} 条待确认提交。重新连接后会核对原记录，不会自动重发。</p><p v-if="recoveryError" role="alert">{{recoveryError}}</p><p v-if="pairRecoveryNotice" role="status">{{pairRecoveryNotice}}</p><p role="status">{{notice}}</p>
  </main>
  <template v-else>
   <p v-if="connectionBanner" class="connection-banner" role="status">{{connectionBanner}}</p>
   <div class="conversation-content">
   <nav v-show="navigationVisible" id="conversation-navigation" aria-label="切换话题">
    <div class="panel-heading"><h1 id="topics-heading" tabindex="-1">话题</h1><button v-if="selected" class="icon-button" type="button" aria-label="返回聊天" @click="closePanel"><MobileIcon name="close"/></button></div>
    <div class="topic-filters">
     <template v-if="sources.length>1"><label for="source-select">来源</label><select id="source-select" v-model="sourceFilter" @change="selectSource" :disabled="busy"><option value="*">全部已授权来源</option><option v-for="s in sources" :key="s.key" :value="s.key">{{s.label}}</option></select></template>
     <div class="agent-heading"><AgentAvatar :src="activeAgent?.avatar" :name="activeAgent?.name"/><div>
      <label for="agent-select">Agent / 群聊</label><select id="agent-select" v-model="agentId" @change="selectAgent" :disabled="busy"><option v-for="a in visibleAgents" :key="a.id" :value="a.id">{{a.name}}<template v-if="sourceFilter==='*'&&sources.length>1"> · {{sourceName(a)}}</template></option></select>
     </div><button v-if="agentCreationKey" class="quiet-button" type="button" :disabled="busy" @click="openAgentCreation">{{pendingAgentCreation?'重试创建':'新建助手'}}</button></div>
     <label class="topic-search"><MobileIcon name="search"/><span class="sr-only">搜索当前 Agent 的话题</span><input id="topic-search" v-model="topicSearch" type="search" placeholder="搜索话题名称或 ID" maxlength="160"></label>
    </div>
    <ul v-if="searchedTopics.length" class="topic-list">
     <li v-for="t in searchedTopics.slice(0,topicLimit)" :key="t.key">
      <button type="button" :data-topic-key="t.key" :aria-current="t.key===selected?'true':undefined" :disabled="busy" @click="openTopic(t.key)">
       <span><strong>{{t.topicName}}</strong><small>{{t.messageCount??0}} 条消息<template v-if="t.originLabel"> · {{t.originLabel}}</template></small></span><MobileIcon v-if="t.key!==selected" name="chevron"/>
      </button>
     </li>
    </ul>
    <button v-if="searchedTopics.length>topicLimit" class="quiet-button" type="button" @click="topicLimit+=30">显示更多话题</button>
    <p v-if="visibleTopics.length&&!searchedTopics.length" class="empty" role="status">没有匹配的话题，当前会话和草稿仍保留。</p>
    <p v-if="!visibleTopics.length" class="empty">此 Agent 暂无话题。</p>
    <p v-if="directoryNotice" role="status">{{directoryNotice}}</p><p v-if="directoryFetchError" role="status">{{directoryFetchError}}</p>
    <details class="topic-options">
     <summary>话题详情与快速跳转</summary>
     <label for="topic-select">跳转到历史话题</label><select id="topic-select" v-model="selected" @change="changeTopic();closePanel()" :disabled="busy"><option v-if="!searchedTopics.some(t=>t.key===selected)" :value="selected" disabled>{{currentTopic?.topicName||'请选择话题'}} · 不在当前筛选结果</option><option v-for="t in searchedTopics" :key="t.key" :value="t.key">{{t.topicName}}<template v-if="t.originLabel"> · 原来源 {{t.originLabel}}</template> · {{t.messageCount}} 条</option></select>
     <small v-if="currentTopic" class="topic-detail"><template v-if="currentTopic.configVersion">配置 v{{currentTopic.configVersion}} · </template>{{currentTopic.topicId}} · {{currentTopic.model||'未配置模型'}} · {{currentTopic.historyReady===false?'等待电脑首次同步':currentTopic.executable===false?(errors[currentTopic.unavailableReason]||'仅可阅读'):'可继续对话'}}<template v-if="currentTopic.updatedAt"> · {{new Date(currentTopic.updatedAt).toLocaleString()}}</template></small>
     <small v-if="sources.length===1" class="source-label">来源：{{sources[0].label}}</small>
     <small v-for="progress in sourceProgress" :key="progress.sourceId" class="source-progress">{{progress.sourceLabel||'来源'}} · 最近已知：目录待核对 {{progress.directoryErrors??'未知'}} · 历史待接入 {{progress.pendingImports??'未知'}} · 本地操作待确认 {{progress.pendingOperations??'未知'}} · 冲突 {{progress.conflicts??'未知'}} · 附件待就绪 {{progress.attachmentsPending??'未知'}}<template v-if="progress.configurationPending!==undefined"> · 续聊配置待就绪 {{progress.configurationPending??'核对中'}} · 配置异常 {{progress.configurationErrors}}</template></small>
    </details>
    <details class="topic-options">
     <summary>消息与附件</summary>
     <p>普通草稿暂存于本页。被拒绝的草稿保存在此设备，返回原话题可继续编辑。</p>
     <p v-if="currentTopic?.attachmentsEnabled">附件支持 PNG、JPEG、WebP、PDF 和文本，最多 8 个，每个 20 MB。</p>
     <p v-else-if="currentTopic?.sharedSpaceId">此话题尚未启用附件传输。</p>
    </details>
   <details v-if="sharedSpaces.length" class="shared-tools"><summary>共享目录与配置</summary>
   <SharedDirectoryView v-for="space in sharedSpaces" :key="space.id" :space="space" :context="recoveryContext" :api="api" :on-device-visibility="deviceVisibilityChanged" />
   <SharedConfigEditor v-if="currentTopic?.sharedSpaceId&&sharedSpaces.some(s=>s.id===currentTopic.sharedSpaceId&&s.config)" :key="currentTopic.sharedOwnerId" :topic="currentTopic" :context="recoveryContext" :api="api" />
   </details>
   </nav>
   <section ref="history" id="history" @scroll.passive="trackHistoryEnd" aria-label="聊天历史" :inert="navigationVisible || conversationPanel==='work'"><p v-if="historyProgress" class="history-progress" role="status">{{historyProgress.failed?'历史暂未加载完成，稍后重试':historyProgress.checking?'正在核对历史增量':'正在加载历史'}}<template v-if="historyProgress.total"> · {{historyProgress.loaded}} / {{historyProgress.total}}</template></p><button v-if="historyStart>0" class="earlier-messages" @click="showEarlierMessages">查看更早消息（还有 {{historyStart}} 条）</button><template v-for="m in visibleMessages" :key="m.id"><article class="message" :class="[m.role,{'snapshot-message':m.contextCompaction}]" :data-message-id="m.id" :tabindex="m.role==='assistant'?-1:undefined" :ref="m.role==='assistant'?el=>observeReplyElement(m.id,el):undefined"><div class="message-author" v-if="m.role!=='user'||m.name==='Flowlock'"><AgentAvatar v-if="m.role!=='user'&&!m.contextCompaction" :src="currentTopic?.ownerType==='group'?undefined:currentTopic?.avatar||activeAgent?.avatar" :name="m.name||currentTopic?.agentName"/><small>{{m.contextCompaction?'上下文快照':m.role==='user'?(m.name==='Flowlock'?'Flowlock':'你'):(m.name||currentTopic?.agentName||'Agent')}}</small></div><div v-if="m.content?.length>128000" class="long-message"><button @click="toggleLongText(m)">{{expandedLongText.has(longTextKey(m))?'收起全文':'查看长文本'}} · {{m.content.length}} 字符</button><TextPages v-if="expandedLongText.has(longTextKey(m))" :text="m.content" class="bubble" style="max-height:60vh;overflow:auto"/></div><div v-else-if="m.content||!m.attachments?.length" class="bubble">{{typeof m.content==='string'?m.content:'此消息包含非文本内容，请在桌面查看'}}</div><details v-if="m.desktopReferences?.length" class="desktop-references"><summary>桌面活引用 {{m.desktopReferences.length}} 项 · 原件和提取文本未同步</summary><div v-for="r in m.desktopReferences" :key="r.id"><strong>{{r.name}}</strong><small>{{r.workspaceRef ? r.workspaceRef.alias+' / '+r.workspaceRef.relPath : r.target}} · 需在来源电脑核对</small></div></details><div v-if="m.attachments?.length" class="attachments"><div v-for="(a,index) in m.attachments" :key="a.id+'/'+index" class="attachment"><template v-if="attachmentStates[m.id+'/'+a.id]?.state==='available'"><SharedAttachmentImage v-if="currentTopic?.sharedSpaceId&&attachmentStates[m.id+'/'+a.id]?.type?.startsWith('image/')" :key="generation+'/'+m.id+'/'+a.id" :url="attachmentUrl(m,a)" :alt="a.name||'图片附件'"></SharedAttachmentImage><img v-else-if="attachmentStates[m.id+'/'+a.id]?.type?.startsWith('image/')" :src="attachmentUrl(m,a)" :alt="a.name||'图片附件'" loading="lazy"><button class="attachment-open" @click="openAttachment(m,a)"><MobileIcon name="file"/><span>{{a.name||'查看附件'}}</span><MobileIcon name="chevron"/></button><details v-if="a.extractedText" class="attachment-text" @toggle="toggleAttachmentText(m,a,index,$event)"><summary>查看文本</summary><TextPages v-if="expandedAttachmentText.has(attachmentTextKey(m,a,index))" :text="a.extractedText"/></details></template><span v-else>{{a.name||'附件'}} · {{attachmentStates[m.id+'/'+a.id]?.state==='unsupported'?'原件类型暂不支持，引用已保留':attachmentStates[m.id+'/'+a.id]?.state==='corrupt'?'完整性校验失败':'附件暂未同步或正在确认'}}</span></div></div></article>
    <template v-for="run in inlineRuns.get(m.id)" :key="run.id">
     <InlineAgentRun v-if="backgroundRunLabel(run)" :job="run" :status="backgroundRunLabel(run)" :tasks="backgroundTasks(run)"
      :connected="!coreDisconnected"/>
     <div v-if="checkingCoreWork(run)||needsWorkReplyLink(run)||(!backgroundRunLabel(run)&&waitingForCoreReply(run))"
      class="inline-reply-status" :data-reply-work-id="run.id">
      <button v-if="checkingCoreWork(run)" type="button" class="work-reply" @click="checkInlineWork(run)">核对任务</button>
      <span v-else-if="!backgroundRunLabel(run)&&waitingForCoreReply(run)" role="status">正在回复</span>
      <button v-if="needsWorkReplyLink(run)" type="button" class="work-reply" @click="openWorkReply(run)">查看原回复</button>
     </div>
    </template>
    <article v-if="failedByMessage.has(m.id)" class="failed-work" :data-failed-work="failedByMessage.get(m.id).id">
     <strong>任务执行失败</strong>
     <p>{{failedByMessage.get(m.id).errorCode==='UPSTREAM_ERROR'?'模型服务暂不可用。':'本次任务已停止。'}}请先核对任务状态，再决定是否发起新消息。</p>
     <button type="button" @click="togglePanel('work')">查看任务状态</button>
    </article>
   </template><p v-if="!messages.length&&!historyProgress&&!visibleSharedStreams.length" class="empty">{{currentTopic?.historyReady===false?'正在等待电脑同步所选历史，完成后即可接续。':currentTopic?.executable===false?'还没有消息。':'还没有消息，发送一条开始会话。'}}</p>
   <section v-if="currentTopic?.coreSingle && coreReplyPreviews.length" aria-label="正在回复">
    <article v-for="work in coreReplyPreviews" :key="work.id" class="message assistant live-message" :data-live-work-id="work.id">
     <div class="message-author"><AgentAvatar :src="currentTopic?.avatar||activeAgent?.avatar" :name="work.speakerName||currentTopic?.agentName"/><small>{{work.speakerName||currentTopic?.agentName||'Agent'}}</small></div>
     <div v-if="work.text" class="bubble">{{work.text}}</div>
     <div v-if="work.presentation" class="bubble"><strong>{{work.presentation.title}}</strong><p>{{work.presentation.challenge}}</p></div>
    </article>
   </section>
   <section v-if="visibleSharedStreams.length" id="shared-live-replies" aria-label="正在生成的共享回复">
    <article v-for="stream in visibleSharedStreams" :key="stream.previewId" class="message assistant live-message" :data-live-execution="stream.executionId" :data-native-request="stream.nativeRequestId"><small>{{stream.memberName||currentTopic?.agentName||'Agent'}}<template v-if="stream.kind==='controlled-text'"> · 第 {{stream.nativeGeneration+1}} 代</template> · {{stream.settled?'正在核对最终记录':stream.activity?sharedActivityLabels[stream.activity.state]||'正在核对原生任务':labels[stream.state]||'正在核对原生任务'}} · {{stream.connection==='online'?'实时观察':stream.connection==='disconnected'?'实时连接已暂停':'正在恢复连接'}}</small><div v-if="stream.text" class="bubble">{{stream.text}}</div><small v-if="stream.gap">仅显示目前可核对的临时片段，完整内容以保存后的会话为准。</small><small v-if="stream.settled&&stream.request?.state!=='completed'">{{labels[stream.request?.state]||'执行已暂停，请核对原生状态'}} · 已收到的片段暂存于此页。</small></article>
   </section>
   </section>
   <button v-if="selected&&!historyAtEnd&&!navigationVisible&&conversationPanel!=='work'"
    id="return-latest" class="return-latest" type="button" @click="returnToLatest">回到最新</button>
   <section v-show="conversationPanel==='work'" id="conversation-work" aria-label="任务状态">
    <div class="panel-heading"><h1 id="work-heading" tabindex="-1">任务状态</h1><button class="icon-button" type="button" aria-label="返回聊天" @click="closePanel"><MobileIcon name="close"/></button></div>
    <p v-if="!jobs.length && !desktopRelays.length && !jobsError && !pendingSubmission && !recoveryBlocker && !acceptedReceipt" class="empty">暂无任务记录</p>
   <section v-if="recoveryBlocker||pendingSubmission||acceptedReceipt||recoveryRecords.length" id="submission-recovery" class="submission-recovery" :class="{'is-receipt':acceptedReceipt&&!pendingSubmission&&!recoveryBlocker}" aria-label="提交确认状态" aria-live="polite"><p v-if="recoveryBlocker" role="alert">{{recoveryBlocker}}</p><div v-if="pendingSubmission" id="pending-submission" :data-request-id="pendingSubmission.requestId"><strong>本地已保存 · 云端接受尚待确认</strong><p>{{pendingSubmission.kind==='invitation'?'邀请成员：'+pendingSubmission.payload.agentId:pendingSubmission.payload.text.slice(0,120)||'附件消息'}}</p><small>提交 {{pendingSubmission.requestId}}<template v-if="pendingSubmission.payload.attachments?.length"> · {{pendingSubmission.payload.attachments.length}} 个附件</template></small><p id="submission-recovery-detail">{{recoveryDetail||'原提交已保留。刷新或重连只核对云端记录，不会自动发送。'}}</p></div><details v-else-if="acceptedReceipt" id="accepted-submission" :data-request-id="acceptedReceipt.requestId"><summary>查看提交回执</summary><p>服务端已接受 · {{acceptedReceipt.requestId}}</p></details><small v-if="recoveryRecords.length>(pendingSubmission?1:0)">此设备另有 {{recoveryRecords.length-(pendingSubmission?1:0)}} 条待确认提交，返回对应入口和话题可核对。</small></section>
   <section class="executions" aria-label="原生执行状态">
    <p v-if="jobsError" role="status">{{jobsError}}</p>
    <small v-if="desktopRelays.length && !online">最近已知的接力状态，联网后核对。</small>
    <DesktopRelayStatus v-for="relay in desktopRelays" :key="relay.id" :relay="relay"/>
    <div v-if="jobsInfo && (jobs.length || !desktopRelays.length)" class="execution-pages"><small>本页 {{jobs.length}} 项 · 历史范围共 {{jobsInfo.total}} 项 · 待处理／核对范围 {{jobsInfo.attentionTotal}} 项</small><button v-if="jobsInfo.moreAttention" @click="nextExecutions('attention')" :disabled="busy">下一页待处理／核对</button><button v-if="jobsInfo.moreRecent" @click="nextExecutions('recent')" :disabled="busy">更早任务</button><button v-if="jobsInfo.historyPage" @click="latestExecutions" :disabled="busy">返回最新任务</button></div>
    <small v-if="jobs.length">{{online?'服务端任务记录':'最近已知状态，联网后重新核对'}}</small>
    <article v-for="j in displayJobs" :key="j.id" class="execution-job" :data-exec-id="j.id" :data-state="j.state">
     <div class="execution-row"><span class="execution-label"><MobileIcon :name="j.state==='completed'?'check':'work'"/>{{executionLabel(j)}}<template v-if="j.steps?.length"> · {{j.steps.filter(s=>s.state==='completed').length}} / {{j.stepCount}} 位成员</template></span><template v-if="j.own && j.steps && supportsCancelRemaining">
      <button v-if="j.canCancelRemaining" :data-cancel-remaining-id="j.id" :disabled="!online" @click="cancelRemaining(j)">取消剩余接力</button>
     </template>
     <button v-else-if="j.own && ['queued','running','waiting_approval'].includes(j.state)" :data-cancel-id="j.id" @click="cancel(j.id)">{{j.steps?'中止本轮群聊':'请求取消本次回复'}}</button></div>
     <div v-if="j.core && (workMessageNames.get(j.messageId)||workTime(j.createdAt))" class="work-meta">
      <span v-if="workMessageNames.get(j.messageId)">{{workMessageNames.get(j.messageId)}}</span><time v-if="workTime(j.createdAt)">{{workTime(j.createdAt)}}</time>
     </div>
     <button v-if="hasWorkReply(j)" class="work-reply" type="button" @click="openWorkReply(j)">查看原回复</button>
     <p v-if="j.remainingCancelled && j.state!=='cancelled'" role="status">后续接力已取消<template v-if="j.steps?.some(step => ['running','publishing','waiting_approval'].includes(step.state))">，等待当前成员结束</template>。</p>
     <ol v-if="j.steps" class="group-steps"><li v-for="step in j.steps" :key="step.id">{{step.name}} · {{labels[step.state]||step.state}}<small v-if="step.errorCode"> · {{errors[step.errorCode]||'本步异常，详情请核对原生宿主'}}</small></li></ol>
     <p v-if="j.nativeTaskError" class="native-task-error" role="alert">{{j.nativeTaskError}}</p>
     <details v-if="j.toolInvocations.length" class="native-tools"><summary>工具调用 · {{j.toolInvocations.length}} 项</summary><ul><li v-for="call in j.toolInvocations" :key="call.invocationId">{{call.pluginName}} · {{displayedToolStatus[call.state]||'工具状态待核对'}}<small> · 调用 {{call.invocationId}}</small></li></ul></details>
     <details v-for="task in j.nativeTasks" :key="task.nativeTaskId" class="native-aa-task" :data-task-id="task.nativeTaskId" :data-state="task.state">
      <summary>{{nativeTaskLabels[task.state]}} · {{task.agentBaseName}}</summary>
      <small>任务 {{task.nativeTaskId}}<br>调用 {{task.invocationId}}<template v-if="task.stepId && task.stepId!==j.id"><br>群聊步骤 {{task.stepId}}</template></small>
      <p v-if="task.summary">{{task.summary}}</p>
      <p v-if="task.reviewRequired">{{task.reviewResolved?'已记录人工核对；原生任务状态仍按上方记录显示。':'请在原生宿主核对任务与可能的工具副作用。'}}</p>
      <button v-if="task.resultRef" class="native-result-read" @click="showNativeResult(j,task)">查看已核对报告</button>
     </details>
     <div v-if="j.own&&needsReview(j)" class="review-state"><p>工具是否已经生效仍需核对。解除暂停不会批准工具、重跑旧请求、取消 AA 或撤回副作用。</p><p v-if="!canResolveReview(j)" role="status">当前群成员仍在执行或收尾，请等待当前步骤稳定暂停后再确认。</p><label><input type="checkbox" v-model="reviewChecks[j.id]" :disabled="!canResolveReview(j)">我已核对，放弃本次未完成的后续工作</label><button @click="abandon(j)" :disabled="!canResolveReview(j)||!reviewChecks[j.id]">记录核对并解除暂停</button></div>
     <p v-else-if="j.reviewResolved" class="review-state">已记录人工核对；这不表示已取消 AA 或撤回工具副作用。</p>
    </article>
    <section v-if="nativeResult" ref="nativeResultPanel" id="native-task-result" class="native-task-result" aria-label="原生 AA 报告"><p role="status">{{nativeResult.loading?'正在只读核对原生报告…':nativeResult.error||'原生报告已核对，仅本次查看，不作为聊天消息。'}}</p><small>{{nativeResult.taskId}}</small><pre v-if="nativeResult.content!==null">{{nativeResult.content}}</pre><button @click="closeNativeResult">关闭报告</button></section>
   </section>
   </section>
   </div>
   <footer v-show="selected && !navigationVisible" :class="{'is-work-view':conversationPanel==='work'}">
    <div class="composer-tools">
     <button v-if="canQuoteTask && conversationPanel!=='work'" class="quote-task" id="quote-task" type="button" @click="quoteTask">
      <MobileIcon name="reply"/><span>追加指令</span>
     </button>
     <div v-if="currentTopic?.ownerType==='group' && conversationPanel!=='work'" class="group-invitation"><label class="sr-only" for="group-invite">邀请成员发言</label><select id="group-invite" v-model="invitedAgent" :disabled="busy||newSubmissionBlocked||currentTopic.executable===false"><option value="">选择发言成员</option><option v-for="member in currentTopic.members||[]" :key="member.id" :value="member.id" :disabled="member.unavailable">{{member.name}}{{member.unavailable?' · 暂不可用':''}}</option></select><button @click="invite" :disabled="busy||newSubmissionBlocked||!invitedAgent||currentTopic.executable===false">邀请</button></div>
     <button id="work-toggle" ref="workToggle" type="button" aria-controls="conversation-work"
       :aria-expanded="conversationPanel==='work'" :data-tone="workTone" @click="togglePanel('work')"><MobileIcon name="work"/><span>{{workButtonText}}</span></button>
    </div>
    <div v-show="conversationPanel!=='work'" class="composer-body">
    <p v-if="!taskQuote&&composerDraft.modelUnavailable" id="composer-model-unavailable" class="attachment-selection-notice" role="status">
     模型「{{composerDraft.nextModel}}」已不在 Core 允许的目录中，请重新选择。
    </p>
    <div v-if="pendingFiles.length" class="pending-files compact-attachments">
     <div v-for="(item,i) in pendingFiles" :key="i" class="pending-file">
      <button class="attachment-detail-toggle" type="button" :aria-label="'附件 '+(i+1)+' 详情'"
        :aria-expanded="expandedDraftAttachment===item" @click="expandedDraftAttachment=expandedDraftAttachment===item?null:item">
       <MobileIcon :name="draftPreviewKind(item.file)==='image'?'image':'file'"/>
      </button>
      <div v-if="expandedDraftAttachment===item" class="attachment-draft-detail">
       <span>{{item.file?.name||'已上传附件 '+(i+1)}}<template v-if="item.error||item.progress"> · {{item.error||item.progress+'%'}}</template></span>
       <small v-if="!draftPreviewKind(item.file)">{{item.file?'不支持预览':'本机无原文件，无法预览'}}</small>
       <button v-if="draftPreviewKind(item.file)" type="button" class="pending-preview"
        :aria-label="'预览 '+item.file.name" @click="openDraftAttachment(item.file)">预览</button>
       <button type="button" @click="removeDraftFile(i);expandedDraftAttachment=null" :disabled="busy" aria-label="移除附件"><MobileIcon name="close"/></button>
      </div>
     </div>
    </div>
    <ul v-if="composerDraft.fileRejections?.length" id="attachment-selection-notice" class="attachment-selection-notice" aria-label="未添加的附件" role="status">
     <li v-for="(item,index) in composerDraft.fileRejections" :key="index">{{item.name}} · 未添加（{{item.reason}}）</li>
    </ul>
    <p v-if="composerDraft.missingAttachments&&!pendingSubmission" id="attachment-reselection-notice" class="attachment-selection-notice" role="status">
     {{composerDraft.missingAttachments}} 个草稿附件未恢复，请重新选择。
    </p>
    <p v-if="ordinaryDraftError" class="pair-error" role="status">{{ordinaryDraftError}}</p>
    <div v-if="taskQuote" id="task-quote" class="task-quote" :data-closed="Boolean(quoteClosed)">
     <MobileIcon name="reply"/>
     <div class="task-quote-copy" role="status">
      <strong>{{quoteStatus||'追加给 '+taskQuote.name}}</strong>
      <span :title="taskQuote.label">{{taskQuote.label}}</span>
     </div>
     <p v-if="composerDraft.coreSteering" class="quote-delivery-note">原追加已保留，正在只读核对。</p>
     <button v-else-if="taskQuote.rejected" id="quote-exit-rejected" class="quote-exit" type="button" :disabled="busy" @click="clearTaskQuote">退出引用</button>
     <button v-else-if="quoteClosed" id="quote-new-message" class="quote-exit" type="button" :disabled="busy" @click="clearTaskQuote">改发新消息</button>
     <button v-else id="quote-clear" class="icon-button" type="button" :disabled="busy" aria-label="取消引用，保留草稿" @click="clearTaskQuote"><MobileIcon name="close"/></button>
    </div>
    <p v-if="steeringStorageError||composerDraft.steeringDelivery" id="steering-delivery" role="status">{{steeringStorageError||composerDraft.steeringDelivery}}</p>
    <div v-if="steeringRecordCorrupt" class="send-state">
     <button v-if="!steeringRemovalPrompt" id="steering-remove-local" type="button" :disabled="busy" @click="steeringRemovalPrompt=true">移除本机记录</button>
     <template v-else>
      <p id="steering-remove-warning">只移除当前话题的本机追加记录。不会撤回已发内容，也不能证明未送达。</p>
      <button id="steering-confirm-remove" type="button" :disabled="busy" @click="removeCorruptSteeringRecord">确认移除</button>
      <button id="steering-cancel-remove" type="button" @click="steeringRemovalPrompt=false">取消</button>
     </template>
    </div>
    <section v-if="voiceDisclosure" class="voice-panel" aria-label="语音输入说明">
     <p>麦克风音频只送到当前私有入口的本机识别服务。识别文字只进入草稿，发送由你确认。</p>
     <div><button id="voice-start" type="button" @click="allowVoice">开始语音输入</button><button type="button" @click="voiceDisclosure=false">不用了</button></div>
    </section>
    <VoiceStage v-else-if="voiceActive" :level="voiceLevel" :phrase="voice.preview" :phase="voice.status"
      @stop="dictation.stop()" @cancel="dictation.cancel('已取消语音输入，草稿未改动。')"/>
    <div v-else-if="voice.message" class="voice-feedback"><span role="status">{{voice.message}}</span>
     <button type="button" aria-label="关闭语音提示" @click="resetVoice">关闭</button>
    </div>
    <VoiceStage v-if="keyboardOrbMode&&keyboardOrbPhrase.trim()" keyboard :phrase="keyboardOrbPhrase"/>
    <small v-if="composerDraft.voiceReview&&text" id="voice-review" role="status">听写草稿 · 待校对</small>
    <div v-if="composerMenu&&canPickComposerAttachment" class="composer-attach-menu" id="composer-attach-menu">
     <button type="button" :disabled="attachmentPickerDisabled" @click="pickComposerAttachment('image')"><MobileIcon name="image"/>图片</button>
     <button type="button" :disabled="attachmentPickerDisabled" @click="pickComposerAttachment('file')"><MobileIcon name="file"/>文件</button>
    </div>
    <form class="message-composer" :class="{dictating:voiceActive}" @submit.prevent="submitComposer">
     <template v-if="canPickComposerAttachment">
      <input ref="imagePicker" id="composer-image-picker" type="file" accept=".png,.jpg,.jpeg,.webp" multiple hidden
        :disabled="attachmentPickerDisabled" @change="selectFiles">
      <input ref="filePicker" id="composer-file-picker" type="file" accept=".pdf,.txt,.md,.csv,.json" multiple hidden
        :disabled="attachmentPickerDisabled" @change="selectFiles">
      <button type="button" class="composer-plus" :aria-expanded="composerMenu" aria-controls="composer-attach-menu"
        :aria-label="composerMenu?'收起附件菜单':'展开附件菜单'" :disabled="attachmentPickerDisabled"
        @click="composerMenu=!composerMenu"><MobileIcon name="plus"/></button>
     </template>
     <label class="sr-only" for="message-text">消息</label>
     <textarea ref="composer" id="message-text" v-model="displayedComposer" @focus="beginKeyboardOrb" @beforeinput="beginKeyboardOrb" @input="mirrorKeyboardOrb" @blur="clearKeyboardOrb" :readonly="voiceActive" :aria-describedby="taskQuote?'task-quote':undefined" :placeholder="currentTopic?.executable===false?(errors[currentTopic.unavailableReason]||'仅可阅读'):taskQuote?'补充给当前任务…':'输入消息…'" rows="1" maxlength="12000" :disabled="!canEditComposer"></textarea>
     <button v-if="!voiceActive" id="voice-input" type="button" :disabled="!voiceScope||!server?.localSpeech" :aria-pressed="voiceActive"
       :aria-label="server?.localSpeech?'语音输入':'语音识别未启用'" :title="server?.localSpeech?'语音输入':'语音识别未启用'" @click="toggleVoice"><VoiceOrb/></button>
     <button id="send" type="submit" :aria-label="taskQuote?'发送追加指令':'发送新消息'" :title="taskQuote?'发送追加指令':'发送新消息'" :disabled="voiceActive||!currentTopic||busy||newSubmissionBlocked||currentTopic?.executable===false||(taskQuote?quoteSendBlocked:composerDraft.modelUnavailable||(!text.trim()&&!pendingFiles.length))"><MobileIcon name="send"/></button>
    </form>
    <div v-show="visibleNotice||pairRecoveryNotice||pendingSubmission" class="send-state"><span v-if="visibleNotice" id="send-state" role="status">{{visibleNotice}}</span><span v-if="pairRecoveryNotice" role="status">{{pairRecoveryNotice}}</span><button id="retry-last" v-show="pendingSubmission" @click="retry" :disabled="busy||!pendingSubmission||Boolean(recoveryBlocker)">核对 / 同会话重试</button></div>
    </div>
   </footer>
  </template>
 </div>
</template>

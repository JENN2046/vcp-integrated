// Keep one recognition result bound to the composer that started it.
export function createVoiceDictation({getRecognition, getScope, update, checkpoint=()=>{}, settle, onLevel=()=>{}, language='zh-CN'}) {
 let active=null,completing=null;
 const publish=(status='idle', message='', preview='')=>update({status,message,preview});
 const messages={
  'not-allowed':'未获麦克风或语音识别权限。可以在浏览器设置中允许，或用键盘语音输入。',
  'service-not-allowed':'此浏览器未开放语音识别。请用手机键盘的麦克风。',
  'audio-capture':'无法使用麦克风。请检查设备，或用键盘语音输入。',
  'network':'本机语音识别连接已断开。可以重试，或用键盘输入。',
  'pair-required':'设备配对已断开，原草稿已保留。',
  'limit':'本次语音达到识别上限。原草稿已保留，可以重新开始。',
  'no-speech':'没听清，再试一次，或用键盘输入。',
  'language-not-supported':'此浏览器不支持普通话识别。请用手机键盘的麦克风。'
 };
 function finish(session, {save=false, recover=false, message='', abort=false}={}) {
  if(active!==session)return;
  active=null;
  clearTimeout(session.deadline);
  const {recognition}=session;
  recognition.onstart=recognition.onresult=recognition.onerror=recognition.onend=null;
  if('onlevel' in recognition)recognition.onlevel=null;
  if('onsettling' in recognition)recognition.onsettling=null;
  onLevel(0);
  if(abort){try{recognition.abort();}catch{}}
  const sameScope=getScope()===session.scope;
  const final=sameScope&&(save||recover)?session.result.trim():'';
  const preview=sameScope&&recover&&!final?session.preview:'';
  const text=final||preview;
  completing=session;
  const done=outcome=>{
   if(completing!==session)return;
   completing=null;
   publish('idle',getScope()===session.scope?(outcome||(text?(preview?'已保留听写草稿，待校对。':'已写入草稿，请检查后发送。'):
    message||(save?messages['no-speech']:''))):'');
  };
  if(sameScope)publish('finishing');
  const outcome=settle({scope:session.scope, text, review:Boolean(preview)});
  if(outcome?.then)void outcome.then(done);else done(outcome);
 }
 function start() {
  const scope=getScope();
  if(active||completing||!scope)return;
  const Recognition=getRecognition();
  if(typeof Recognition!=='function'){
   publish('idle','此浏览器不支持本机语音输入，可以打字或用系统键盘听写。');
   return;
  }
  let recognition;
  try{recognition=new Recognition();}catch{
   publish('idle','语音输入未能启动。请用手机键盘的麦克风。');return;
  }
  const session={recognition,scope,result:'',preview:'',staged:'',stagedFinal:false,stage:0,deadline:null,phase:'starting'};
  active=session;
  if('onlevel' in recognition)recognition.onlevel=level=>{if(active===session&&getScope()===scope)onLevel(level);};
  recognition.lang=language;
  recognition.continuous=false;
  recognition.interimResults=true;
  const same=()=>active===session&&getScope()===scope;
  if('onsettling' in recognition)recognition.onsettling=()=>{
   if(!same())return;session.phase='finishing';publish('finishing','',session.preview);
  };
  recognition.onstart=()=>{
   if(!same()||session.phase!=='starting')return;
   session.phase='listening';publish('listening');
  };
  recognition.onresult=event=>{
   if(!same())return;
   let final='',interim='';
   for(const result of Array.from(event.results||[])){
    const segment=result[0]?.transcript||'';
    if(result.isFinal)final+=segment;else interim+=segment;
   }
   session.result=final;
   const preview=(final+interim).trim().slice(0,12000);
   const previewFinal=Boolean(final.trim()&&!interim);
   if(!preview||(preview===session.staged&&previewFinal===session.stagedFinal))return;
   session.staged=preview;
   session.stagedFinal=previewFinal;
   const stage=++session.stage;
   const show=()=>{
    if(!same()||stage!==session.stage)return;
    session.preview=preview;
    publish(session.phase,'',preview);
   };
   const saved=checkpoint(scope,preview,previewFinal);
   if(saved?.then)void saved.then(show);else show();
  };
  recognition.onerror=event=>finish(session,{recover:event.error==='network',message:messages[event.error]||
   (event.error==='aborted'?'语音输入已结束。':'语音识别未完成，请重试或用键盘输入。'),abort:true});
  recognition.onend=()=>finish(session,{save:true,recover:true});
  publish('starting');
  session.deadline=setTimeout(()=>finish(session,{recover:true,message:'语音输入已超时，请重新开始。',abort:true}),65000);
  try{recognition.start();}catch{
   finish(session,{message:'语音输入未能启动。请检查浏览器权限，或用键盘输入。',abort:true});
  }
 }
 function stop(){
  const session=active;
  if(!session)return;
  if(session.phase==='starting'){cancel();return;}
  if(session.phase==='finishing')return;
  session.phase='finishing';
  publish('finishing','',session.preview);
  clearTimeout(session.deadline);
  session.deadline=setTimeout(()=>finish(session,{recover:true,message:'未收到识别结果，请再试一次。',abort:true}),2500);
  try{session.recognition.stop();}catch{
   finish(session,{recover:true,message:'未收到识别结果，请再试一次。',abort:true});
  }
 }
 function cancel(message=''){
  if(active)finish(active,{message,abort:true});
  else if(!completing||getScope()!==completing.scope){completing=null;publish('idle',message);}
 }
 function interrupt(message=''){
  if(active)finish(active,{recover:true,message,abort:true});
 }
 return {start,stop,cancel,interrupt};
}

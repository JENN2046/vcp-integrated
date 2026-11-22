'use strict';
const fs=require('node:fs'),Module=require('node:module'),ah=require('node:async_hooks');
const base=process.env.NS_METER_PREFIX+'-';const main=process.type==='browser',backend=process.env.NS_METER_BACKEND==='1';
if((main||backend)&&!global.__nsIdleMeter){global.__nsIdleMeter=true;install(main?'main':'backend')}
function install(role){
 const now=()=>{const v=process.threadCpuUsage();return v.user+v.system},als=new ah.AsyncLocalStorage(),windows=[],patched=new Set(),handles=new WeakMap(),hooked=new Set();
 let schedule=null,current=null,startCpu=0;
 const blank=()=>({cpuUs:{},invocations:{},files:{},http:{},origins:{},snapshots:{},snapshotTopics:{}});
 function bucket(t=Date.now()){if(!schedule)return null;const i=Math.floor((t-schedule.start)/60000);return i>=0&&i<schedule.n?windows[i]:null;}
 function switchTo(v){if(current===v)return;const t=now(),w=bucket();if(current&&w)w.cpuUs[current]=(w.cpuUs[current]||0)+t-startCpu;current=v;startCpu=t;}
 function sync(tag,fn){const prev=current;switchTo(tag);try{return fn()}finally{switchTo(prev)}}
 function within(tag,fn){const w=bucket();if(w)w.invocations[tag]=(w.invocations[tag]||0)+1;return als.run(tag,()=>sync(tag,fn))}
 const stack=[];ah.createHook({before(){const next=als.getStore()||null;stack.push(current);switchTo(next)},after(){switchTo(stack.pop()||null)}}).enable();
 function route(raw){const p=raw.split('?')[0];
 if(p.endsWith('/shared/session-events')){
   const scope=new URLSearchParams(raw.slice(p.length+1)).get('scope');
   return scope==='topic'?'shared/session-events/topic':'shared/session-events/work';
 }if(p.startsWith('/api/plugins/NativeSync/'))return p.includes('attachment')?'attachment':'plugin-other';
 if(p.startsWith('/api/v1/sync/')){const parts=p.slice(13).split('/');const whitelist=/^(shared|source|changes|pull|push|info|matches|wait|watch|session-events|session-status|config|join|bind|baselines|projections|ack|execution-trace|match-state|progress|directory|bindings|work|active|status|baselines|baseline|topic-history|session-send|mobile|feed|capabilities)$/;return parts.slice(0,2).filter(Boolean).map(x=>whitelist.test(x)?x:'other').join('/')||'root'}
 if(p.startsWith('/mobile'))return 'mobile';return null}
 function bytes(v,enc){return !v?0:typeof v==='string'?Buffer.byteLength(v,typeof enc==='string'?enc:undefined):v.byteLength||0}
 if(role==='backend'){
 const proto=require('node:http').Server.prototype,emit=proto.emit;proto.emit=function(ev,...args){
  if(ev!=='request')return emit.call(this,ev,...args);
  const [req,res]=args,k=route(req.url);
  if(!k){const w=bucket();if(w)w.otherBackendHttpStarts=(w.otherBackendHttpStarts||0)+1;return emit.call(this,ev,...args);}
  function cell(){const w=bucket();return w&&(w.http[k]||=( {requests:0,finished:0,requestBytes:0,responseBytes:0,codes:{},verbs:{}}))}
  const row=cell();if(row){row.requests++;row.verbs[req.method]=(row.verbs[req.method]||0)+1;const w=bucket(),id=req.headers['x-nativesync-source-id']||req.headers['x-nativesync-source'];const key=k==='mobile'?'mobile':id?String(id).endsWith('_peer')?'peer':'source':'unspecified';w.origins[key]=(w.origins[key]||0)+1;}
  const em=req.emit;req.emit=function(e,...a){if(e==='data'){const b=cell();if(b)b.requestBytes+=bytes(a[0])}return em.call(this,e,...a)};
  for (const name of ['write', 'end']) {
   const original = res[name];
   res[name] = function (value, encoding, ...args) {
    const size = bytes(value, encoding);
    const metrics = size && cell();
    if (metrics) {
     metrics.responseBytes += size;
     if (String(res.getHeader('content-type')).includes('text/event-stream')) {
      const data = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
      metrics.sseBytes = (metrics.sseBytes || 0) + size;
      metrics.sseDataFrames = (metrics.sseDataFrames || 0) + (data.match(/^data:/gm) || []).length;
      metrics.sseCommentFrames = (metrics.sseCommentFrames || 0) + (data.match(/^:/gm) || []).length;
     }
    }
    return original.call(this, value, encoding, ...args);
   };
  }
  res.once('finish',()=>{const b=cell();if(b){b.finished++;b.codes[res.statusCode]=(b.codes[res.statusCode]||0)+1}});
  return within(k,()=>emit.call(this,ev,...args))
 };
 }
 function category(p){p=typeof p==='string'?p:'';return /\/history\.json$/.test(p)?'history':p.includes('/.native-sync/')?'sync-state':p.endsWith('config.json')?'config':p.includes('/attachments/')?'attachment':'other'}
 const addFile=(tag,kind,path,n)=>{const w=bucket();if(!w||!tag)return;const k=tag+'|'+kind+'|'+category(path),v=w.files[k]||=[0,0];v[0]++;v[1]+=n};
 function fileMethod(obj,key,handle=false){const orig=obj[key];if(typeof orig!=='function')return;obj[key]=function(...args){
  const tag=als.getStore();if(!tag)return orig.apply(this,args);
  const path=handle?handles.get(this):args[0];const data=args[handle?0:1],opt=args[handle?1:2];
  return orig.apply(this,args).then(value=>{addFile(tag,key,path,key==='readFile'?bytes(value):key==='read'?value.bytesRead:key==='write'?value.bytesWritten:bytes(data,typeof opt==='string'?opt:opt?.encoding));return value});
 }}
 for(const k of ['readFile','writeFile','appendFile'])fileMethod(fs.promises,k);
 const open=fs.promises.open;fs.promises.open=function(p,...args){if(!als.getStore())return open.call(this,p,...args);return open.call(this,p,...args).then(h=>{handles.set(h,p);const proto=Object.getPrototypeOf(h);if(!hooked.has(proto)){hooked.add(proto);for(const k of ['readFile','writeFile','appendFile','read','write'])fileMethod(proto,k,true)}return h})};
 for(const k of ['readFileSync','writeFileSync']){const orig=fs[k];fs[k]=function(p,...args){const v=orig.call(this,p,...args);const tag=als.getStore();if(tag)addFile(tag,k,p,k==='readFileSync'?bytes(v):bytes(args[0],args[1]));return v}}
 const methods = {
  SharedWaitClient: ['watch', 'listen', 'configure', 'take'],
  AttachmentWork: ['run', 'inventory', 'offer'],
  SharedRuntime: [
   'tick', 'tickCore', 'runTick', 'planTick', 'scheduleTick', 'configureWatch', 'discover',
   'materialize', 'readLocal', 'pollDirectory', 'backfill', 'recoverRegistration', 'getExecutionStatus', 'nativeTrajectory',
  ],
  DesktopAttachments: ['restoreRemote', 'uploadLocal'],
  SharedMatching: ['poll'],
  SharedExecution: ['reconcile'],
  SharedSessionClient: ['reconcile', 'watch', 'watchTopic'],
  NativeSyncAdapter: ['synchronize'],
 };
 if(role==='main'){
 const load=Module._load;Module._load=function(id,parent,...rest){
  const exp=load.call(this,id,parent,...rest);
  if(!exp||typeof exp!=='object'||!(
     String(id).includes('nativeSync')||String(parent?.filename).includes('/nativeSync/')||String(id).includes('historyMutationQueue')
  ))return exp;
  for(const [cl,names] of Object.entries(methods)){const proto=exp[cl]?.prototype;if(!proto||patched.has(cl))continue;patched.add(cl);
   for(const name of names){const orig=proto[name];if(typeof orig==='function')proto[name]=function(...a){return within(cl+'.'+name,()=>orig.apply(this,a))}}
  }
  const proto=exp.HistoryMutationQueue?.prototype;
  if(proto&&!patched.has('HistoryMutationQueue')){patched.add('HistoryMutationQueue');const orig=proto.readSnapshot;proto.readSnapshot=function(d,...a){const w=bucket(),tag=als.getStore();if(tag&&w){w.snapshots[tag]=(w.snapshots[tag]||0)+1;(w.snapshotTopics[tag]||=new Set()).add(d?.topicId)}return orig.call(this,d,...a)}}
  return exp;
 }
 }
 const safeWrite=(key,value)=>{const p=base+role+'-'+key+'.json';fs.writeFileSync(p+'.tmp',JSON.stringify(value));fs.renameSync(p+'.tmp',p)};
 let saved=0;safeWrite('ready',{pid:process.pid,role});
 const scheduleFile = base + 'schedule.json';
 const change = fs.watch(require('node:path').dirname(scheduleFile), { persistent: false }, () => arm());
 function arm() {
  if (schedule) return;
  try {
   schedule = JSON.parse(fs.readFileSync(scheduleFile, 'utf8'));
  } catch {
   return;
  }
  change.close();
  for (let i = 0; i < schedule.n; i++) windows.push(blank());
  safeWrite('armed', { pid: process.pid, patched: [...patched] });
  for (let i = 0; i < schedule.n; i++) {
   const deadline = schedule.start + (i + 1) * 60000 + 500;
   setTimeout(() => {
    const window = windows[i];
    window.snapshotTopics = Object.fromEntries(Object.entries(window.snapshotTopics).map(([k, v]) => [k, v.size]));
    safeWrite('w' + (i + 1), window);
   }, Math.max(0, deadline - Date.now())).unref();
  }
 }
 arm();
}

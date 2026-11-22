'use strict';
const fs=require('node:fs');
const path=require('node:path');
const readline=require('node:readline');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {createRequire}=require('node:module');
const {createHash,X509Certificate}=require('node:crypto');
const assert=require('node:assert/strict');
const {setTimeout:delay}=require('node:timers/promises');

const root=path.resolve(__dirname,'../..');
const desktop=path.join(root,'apps/desktop');
const [specFile, endpoint, evidenceFile, caFile]=process.argv.slice(2);
if(!specFile||!endpoint||!evidenceFile)throw Error('Usage: node tests/context-chain/native-run.cjs <fixture.json> <loopback ToolBox completion URL> <evidence.json> [CA PEM]');
const target=new URL(endpoint);
assert.ok(target.hostname==='127.0.0.1'&&['http:','https:'].includes(target.protocol));
const spec=JSON.parse(fs.readFileSync(specFile,'utf8'));
const out=fs.mkdtempSync(path.join(os.tmpdir(),'vcp-context-native-'));
const profile=path.join(out,'profile');
const launchFile=path.join(__dirname,'native-electron.cjs');
const agentId='context-native-agent', topicId='context-native-topic';
const name=spec.agentName;
const J=JSON.stringify;
const sha=data=>createHash('sha256').update(data).digest('hex');
function write(relative, data) {
    const file=path.join(profile,relative);
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,J(data));
}
async function until(fn,name,ms=30000){
    const end=Date.now()+ms;
    do { const value=await fn();if(value)return value;await delay(30); } while(Date.now()<end);
    throw Error('Timed out waiting for '+name);
}
async function main(){
    const seed=structuredClone(spec.history);
    const attach=spec.attachment;
    assert.ok(Array.isArray(seed)&&typeof spec.input==='string'&&attach);
    assert.equal(path.basename(attach.name),attach.name);
    const bytes=Buffer.from(attach.text,'utf8');
    assert.ok(bytes.length>0);
    const attachmentFile=path.join(out,attach.name);
    fs.writeFileSync(attachmentFile,bytes);
    write('settings.json',{ChatDataServiceEnabled:true,ChatDataServiceNotifyEnabled:false,ChatDataServiceTantivyEnabled:false,
        vcpServerUrl:target.href, vcpApiKey:'synthetic-only',userName:spec.userName||'用户',disableAsana:true,
        disableUpdateCheck:true,enableVcpLog:false,enableDistributedServer:false,voiceMode:'local',
        voiceLocalSettings:{sovitsUrl:target.origin},...(spec.settings||{})});
    write('Agents/'+agentId+'/config.json',{id:agentId,name,model:spec.model,systemPrompt:spec.systemPrompt,streamOutput:false,
        ...(spec.agent||{}),topics:[{id:topicId,name:'Synthetic context chain',createdAt:1}],current_topic_id:topicId});
    const fileManager=createRequire(path.join(desktop,'package.json'))('./modules/fileManager');
    fileManager.initializeFileManager(path.join(profile,'UserData'),path.join(profile,'Agents'));
    const stored=await fileManager.storeFile(attachmentFile,attach.name,agentId,topicId,attach.type);
    assert.equal(stored.extractedText,attach.text);
    seed.find(row=>row.id==='ctx-retained-user').attachments=[stored];
    const relative='UserData/'+agentId+'/topics/'+topicId+'/history.json';
    write(relative,seed);
    if(spec.rules)write('VCPChatTarven.json',Array.isArray(spec.rules)?{rules:spec.rules}:spec.rules);
    const handlerFile=path.resolve(evidenceFile+'.handler.jsonl');
    assert.ok(!fs.existsSync(handlerFile),'fresh handler evidence file required');

    const screen=spawn(process.env.XVFB_BIN||'Xvfb',['-displayfd','1','-screen','0','1600x1100x24','-nolisten','tcp'],{stdio:['ignore','pipe','ignore']});
    const stoppedScreen=once(screen,'exit');
    let client,exited;
    const pending=new Map(),events=[];
    let id=0;
    async function command(action,script){
        const seq=++id,reply=Promise.withResolvers();
        pending.set(seq,reply.resolve);
        client.stdin.write(J({id:seq,action,script})+'\n');
        const value=await Promise.race([reply.promise,delay(10000,null,{ref:false})]);
        pending.delete(seq);
        if (!value||value.error)throw Error(value?.error||'command timed out: '+action);
        return value.result;
    }
    const evaluate=script=>command('eval',script);
    async function click(selector,text){
        const point=await until(()=>evaluate(`(() => {
            const node=[...document.querySelectorAll(${J(selector)})].find(n=>n.checkVisibility()&&(${J(text??null)}===null||n.innerText.trim()===${J(text??null)}));
            if(!node)return null; node.scrollIntoView({block:'center',behavior:'instant'});
            const r=node.getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2);
            return node.contains(document.elementFromPoint(x,y))?{x,y}:null;
        })()`),'click '+selector);
        await command('mouse',point);
    }
    try{
        const output = readline.createInterface({ input:screen.stdout });
        const display=':'+(await Promise.race([once(output,'line'),
            stoppedScreen.then(() => { throw Error('Xvfb exited before display initialization'); })]))[0];
        const home=path.join(out,'home');fs.mkdirSync(home);
        const electron=process.env.ELECTRON_BIN||createRequire(path.join(desktop,'package.json'))('electron');
        const env={PATH:'/usr/bin:/bin',LANG:'C.UTF-8',DISPLAY:display,HOME:home,XDG_CONFIG_HOME:path.join(home,'config'),
            NS_HOST:desktop,VCPCHAT_E2E_TEST:'1',VCPCHAT_APP_DATA_DIR:profile,NS_CONTEXT_HANDLER_EVIDENCE:handlerFile};
        if(caFile){env.NODE_EXTRA_CA_CERTS=path.resolve(caFile);env.NS_CERT_FINGERPRINT=new X509Certificate(fs.readFileSync(caFile)).fingerprint256;}
        client=spawn(electron,['--ozone-platform=x11','--disable-background-networking',
            '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',launchFile],
            {cwd:desktop,env,stdio:['pipe','pipe','ignore']});
        exited=once(client,'exit');
        client.stdin.on('error',()=>{});
        readline.createInterface({input:client.stdout}).on('line',line=>{
            if(!line.startsWith('NS_MEASURE '))return;
            const v=JSON.parse(line.slice(11));
            if(v.event==='answer')pending.get(v.data.id)?.(v.data);
            else events.push(v);
        });
        await until(()=>events.some(e=>e.event==='renderer-ready'),'actual renderer');
        await command('trace');
        await click('#agentList li .agent-name',name);
        await until(()=>evaluate(`window.VCPStateChannels.get('conversation.current').get().topicId===${J(topicId)}`),'native topic selection');
        await click('#messageInput');
        await command('context-type',spec.input);
        assert.equal(await evaluate("document.querySelector('#messageInput').value"),spec.input);
        await command('context-coverage-start');
        await command('packet-coverage-start');
        await click('#sendMessageBtn');
        const rows=await until(()=>{
            const found=JSON.parse(fs.readFileSync(path.join(profile,relative),'utf8'));
            return found.length===seed.length+2&&found.at(-1)?.role==='assistant'&&!found.at(-1).isThinking&&
                String(found.at(-1).content).includes(spec.reply)&&found;
        },'native History user and terminal reply',60000);
        const user=rows.at(-2), assistant=rows.at(-1);
        assert.equal(user.role,'user');
        assert.equal(rows.find(row=>row.id==='ctx-retained-user').attachments[0].hash,sha(bytes));
        const captured=fs.readFileSync(handlerFile,'utf8').trim().split('\n').map(row=>JSON.parse(row));
        assert.equal(captured.length,1);
        assert.equal(captured[0].messageId,assistant.id);
        assert.equal(captured[0].isGroupCall,false);
        const coverage=await command('context-coverage-take');
        const packetCoverage=await command('packet-coverage-take');
        const serialized=structuredClone(rows);
        const storedRow=serialized.find(row=>row.id==='ctx-retained-user').attachments[0];
        storedRow.internalPath='isolated-content-addressed:'+storedRow.internalFileName;
        fs.writeFileSync(evidenceFile+'.history.json',J(serialized,null,2)+'\n',{mode:0o600});
        await until(()=>evaluate(`document.querySelector('#chatMessages').innerText.includes(${J(spec.reply)})`),'visible native terminal');
        const screenCopy=path.resolve(evidenceFile+'.png');
        await command('picture',screenCopy);
        const evidence={variant:'native-desktop',seedIds:seed.map(r=>r.id),inputId:user.id,replyId:assistant.id,
            source:target.origin,attachment:{name:attach.name,bytes:bytes.length,sha256:sha(bytes),storedAt:'ctx-retained-user',realFileManager:true},
            terminalVisible:await evaluate(`document.querySelector('#chatMessages').innerText.includes(${J(spec.reply)})`), coverage,packetCoverage,
            historyCount:rows.length,renderer:events.find(e=>e.event==='electron-ready')?.data};
        fs.writeFileSync(evidenceFile,J(evidence,null,2)+'\n',{mode:0o600});
        console.log(J(evidence));
    } finally {
        if(client?.exitCode===null&&client.signalCode===null){
            await command('quit').catch(()=>{});
            let value=await Promise.race([exited,delay(5000,null,{ref:false})]);
            if (!value) { client.kill('SIGTERM'); value=await exited; }
            assert.deepEqual(value,[0,null],'native Electron exited normally');
        }
        if(screen.exitCode===null&&screen.signalCode===null){screen.kill();await stoppedScreen;}
        fs.rmSync(out,{recursive:true,force:true});
    }
}
main().catch(error=>{
    fs.rmSync(out,{recursive:true,force:true});
    console.error(error.stack);
    process.exitCode=1;
});

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

const root=process.env.NS_GROUP_SOURCE || path.resolve(__dirname,'../..');
const desktop=path.join(root,'apps/desktop');
const [specFile, endpoint, evidenceFile, caFile, variant='candidate']=process.argv.slice(2);
if(!specFile||!endpoint||!evidenceFile)throw Error('Usage: node tests/group-context/native-run.cjs <fixture.json> <loopback ToolBox completion URL> <evidence.json> [CA PEM] [variant]');
const target=new URL(endpoint);
assert.ok(target.hostname==='127.0.0.1'&&['http:','https:'].includes(target.protocol));
const spec=JSON.parse(fs.readFileSync(specFile,'utf8'));
const out=fs.mkdtempSync(path.join(os.tmpdir(),'vcp-group-context-native-'));
const profile=path.join(out,'profile');
const launchFile=path.join(__dirname,'native-electron.cjs');
const groupId='gc-group', topicId='gc-topic';
const speakerOrder=spec.plan;
const members=spec.speakers.map(member=>member.id);
assert.deepEqual([...speakerOrder].sort(), [...members].sort(), 'native fixture uses persisted shared speaker IDs mapped to native member IDs');
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
    for (const agent of spec.speakers) write('Agents/'+agent.id+'/config.json', {
        ...agent, topics:[{id:topicId,name:'Synthetic group context',createdAt:1}],current_topic_id:topicId,
    });
    const groupConfigRelative='AgentGroups/'+groupId+'/config.json';
    write(groupConfigRelative, {
        ...spec.group, id:groupId, members,
        modeSettings:{ ...spec.group.modeSettings, sequential:{ speakerOrder } },
        topics:[{id:topicId,name:'Synthetic group context',createdAt:1, isTitleLocked:true}],
    });
    const fileManager=createRequire(path.join(desktop,'package.json'))('./modules/fileManager');
    fileManager.initializeFileManager(path.join(profile,'UserData'),path.join(profile,'Agents'));
    const stored=await fileManager.storeFile(attachmentFile,attach.name,groupId,topicId,attach.type);
    assert.equal(stored.extractedText,attach.text);
    seed.find(row=>row.id===attach.messageId).attachments=[stored];
    const relative='UserData/'+groupId+'/topics/'+topicId+'/history.json';
    write(relative,seed);
    if(spec.rules)write('VCPChatTarven.json',Array.isArray(spec.rules)?{rules:spec.rules}:spec.rules);
    const dispatchFile=path.resolve(evidenceFile+'.dispatch.jsonl');
    assert.ok(!fs.existsSync(dispatchFile),'fresh dispatch evidence file required');

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
    async function click(selector){
        const point=await until(()=>evaluate(`(() => {
            const node=[...document.querySelectorAll(${J(selector)})].find(n=>n.checkVisibility());
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
            NS_HOST:desktop,VCPCHAT_E2E_TEST:'1',VCPCHAT_APP_DATA_DIR:profile,
            NS_GROUP_DISPATCH:dispatchFile,NS_GROUP_ENDPOINT:target.href,NS_GROUP_HISTORY:path.join(profile,relative)};
        if(caFile){env.NODE_EXTRA_CA_CERTS=path.resolve(caFile);env.NS_CERT_FINGERPRINT=new X509Certificate(fs.readFileSync(caFile)).fingerprint256;}
        client=spawn(electron,['--ozone-platform=x11','--disable-background-networking',
            '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',launchFile],
            {cwd:desktop,env,stdio:['pipe','pipe',process.env.NS_GROUP_VERBOSE?'inherit':'ignore']});
        exited=once(client,'exit');
        client.stdin.on('error',()=>{});
        readline.createInterface({input:client.stdout}).on('line',line=>{
            if(!line.startsWith('NS_MEASURE ')){if(process.env.NS_GROUP_VERBOSE)console.error(line);return;}
            const v=JSON.parse(line.slice(11));
            if(v.event==='answer')pending.get(v.data.id)?.(v.data);
            else events.push(v);
        });
        await until(()=>{
            if (client.exitCode!==null||client.signalCode!==null) {
                throw Error('Electron exited before renderer readiness ('+(client.signalCode||client.exitCode)+
                    '). Check ELECTRON_BIN and the Electron sandbox helper.');
            }
            return events.some(e=>e.event==='renderer-ready');
        },'actual renderer');
        await command('trace');
        await click(`#agentList li[data-item-id="${groupId}"][data-item-type="group"]`);
        await until(()=>evaluate(`window.VCPStateChannels.get('conversation.current').get().topicId===${J(topicId)}`),'native group topic selection');
        await command('group-coverage-start');
        const groupMessage={
            id:spec.current.id,role:'user',name:spec.current.name||spec.userName||'用户',
            content:{text:spec.current.content},originalUserText:spec.current.content,
        };
        const admission=await evaluate(`window.chatAPI.sendGroupChatMessage(${J(groupId)},${J(topicId)},${J(groupMessage)})`);
        assert.notEqual(admission?.success,false,admission?.error);
        const rows=await until(()=>{
            try {
                const found=JSON.parse(fs.readFileSync(path.join(profile,relative),'utf8'));
                if (found.length!==seed.length+3) return null;
                const finalContent=found.at(-1)?.content;
                return (spec.expectedModelError ? finalContent?.includes(spec.expectedModelError) : finalContent===spec.replyB) && found;
            } catch (error) {
                if (error instanceof SyntaxError) return null;
                throw error;
            }
        },'native History with both terminal replies',60000);
        const coverage=await command('group-coverage-take');
        const [user, replyA, replyB]=rows.slice(-3);
        assert.deepEqual([user.id,user.content],[spec.current.id,spec.current.content]);
        assert.deepEqual([replyA.agentId,replyB.agentId],speakerOrder);
        if (spec.expectedModelError) {
            const captured=fs.readFileSync(dispatchFile,'utf8').trim().split('\n').map(JSON.parse);
            assert.deepEqual(captured.map(row=>row.kind),['group-send-ipc']);
            assert.ok([replyA,replyB].every(row=>row.content.includes(spec.expectedModelError)));
            const evidence={surface:'native-desktop', sequence:speakerOrder, errors:[replyA.content,replyB.content],
                completionDispatches:0, coverage};
            fs.writeFileSync(evidenceFile,J(evidence,null,2)+'\n',{mode:0o600});
            return;
        }
        assert.deepEqual([replyA.content,replyB.content],[spec.replyA,spec.replyB]);
        assert.equal(rows.find(row=>row.id===attach.messageId).attachments[0].hash,sha(bytes));
        const captured=fs.readFileSync(dispatchFile,'utf8').trim().split('\n').map(row=>JSON.parse(row));
        const [ipc, dispatchA, dispatchB]=captured;
        assert.deepEqual(captured.map(row=>row.kind),['group-send-ipc','dispatch','dispatch']);
        assert.equal(ipc.inputId,user.id);
        assert.equal(dispatchA.body.messageId,replyA.id);
        assert.equal(dispatchB.body.messageId,replyB.id);
        assert.equal(dispatchA.committed.some(row=>row.id===replyA.id),false);
        assert.deepEqual(dispatchB.committed.filter(row=>row.id===replyA.id),[
            {id:replyA.id,role:'assistant',content:spec.replyA},
        ]);
        assert.equal(dispatchA.body.vcpchatExtensions.messageTimestampBindings.some(binding=>binding.messageId===replyA.id),false);
        const matchesReplyText=row=>row.role==='assistant'&&JSON.stringify(row.content).includes(spec.replyA);
        const seedMatches=seed.filter(matchesReplyText).length;
        assert.equal(dispatchA.body.messages.filter(matchesReplyText).length,seedMatches);
        const aBindings=dispatchB.body.vcpchatExtensions.messageTimestampBindings.filter(binding=>binding.messageId===replyA.id);
        assert.equal(aBindings.length,1);
        const aBound=dispatchB.body.messages[aBindings[0].sentMessageIndex];
        assert.equal(aBound.role,'assistant');
        assert.ok(JSON.stringify(aBound.content).includes(spec.replyA));
        assert.equal(dispatchB.body.messages.filter(matchesReplyText).length,seedMatches+1);
        const serialized=structuredClone(rows);
        const storedRow=serialized.find(row=>row.id===attach.messageId).attachments[0];
        storedRow.internalPath='isolated-content-addressed:'+storedRow.internalFileName;
        fs.writeFileSync(evidenceFile+'.history.json',J(serialized,null,2)+'\n',{mode:0o600});
        await evaluate(`document.querySelector('#agentList li[data-item-id="${groupId}"]').click(); true`);
        await until(()=>evaluate(`[${J(spec.replyA)},${J(spec.replyB)}].every(reply=>document.querySelector('#chatMessages').innerText.includes(reply))`),'visible native terminal');
        await command('picture',path.resolve(evidenceFile+'.png'));
        const sources=await command('loaded-sources',{
            main:['apps/desktop/Groupmodules/groupchat.js','apps/desktop/modules/ipc/groupChatHandlers.js',
                'packages/core-rules/group/modes/sequentialMode.js','apps/desktop/Groupmodules/groupContextWindow.js',
                'packages/core-rules/group/groupContextWindow.js','packages/core-rules/group/modelSelection.js',
                'packages/core-rules/group/streamDelta.js','apps/desktop/modules/tavernRulesEngine.js'],
            renderer:['apps/desktop/Groupmodules/grouprenderer.js'],
        });
        assert.ok(sources.main.some(row=>row.file.endsWith('/groupchat.js')));
        const hit=(file, name)=>coverage.find(row=>row.file===file)?.hitFunctions.find(row=>row.name===name)?.count || 0;
        assert.equal(hit('apps/desktop/Groupmodules/groupchat.js','handleGroupChatMessage'),1);
        assert.equal(hit('packages/core-rules/group/modes/sequentialMode.js','determineSpeakers'),1);
        assert.equal(hit('packages/core-rules/group/groupContextWindow.js','selectGroupContextHistory'),2);
        if(variant==='candidate') assert.equal(hit('packages/core-rules/group/groupContextWindow.js','applyGroupContextRules'),2);
        assert.ok(sources.renderer.some(row=>row.file.endsWith('/grouprenderer.js')));
        const configBytes=fs.readFileSync(path.join(profile,groupConfigRelative));
        const savedGroup=JSON.parse(configBytes);
        assert.deepEqual(savedGroup.modeSettings.sequential.speakerOrder,speakerOrder);
        const evidence={variant, surface:'native-desktop', seedIds:seed.map(row=>row.id), inputId:user.id,
            replyIds:[replyA.id,replyB.id], committedReplyABinding:aBindings[0],
            source:target.origin, attachment:{name:attach.name,bytes:bytes.length,sha256:sha(bytes),storedAt:attach.messageId,realFileManager:true},
            terminalVisible:true, historyCount:rows.length, renderer:events.find(e=>e.event==='electron-ready')?.data,
            sources, coverage, configuredPlan:{ file:groupConfigRelative, mode:savedGroup.mode, speakerOrder, sha256:sha(configBytes) }};
        if (spec.streamFrames) {
            await command('group-coverage-start');
            const invited = await evaluate(`window.chatAPI.inviteAgentToSpeak(${J(groupId)},${J(topicId)},${J(speakerOrder[0])})`);
            assert.equal(invited.success, true, invited.error);
            const invitedHistory = JSON.parse(fs.readFileSync(path.join(profile,relative),'utf8'));
            assert.equal(invitedHistory.length, rows.length + 1);
            const { id, agentId, content, finishReason } = invitedHistory.at(-1);
            assert.equal(agentId, speakerOrder[0]);
            assert.equal(content, spec.replyA);
            assert.equal(finishReason, 'completed');
            const dispatch = JSON.parse(fs.readFileSync(dispatchFile,'utf8').trim().split('\n').at(-1));
            assert.equal(dispatch.body.messageId, id);
            evidence.invited = { id, agentId, model: dispatch.body.model, content, finishReason,
                coverage: await command('group-coverage-take') };
        }
        fs.writeFileSync(evidenceFile,J(evidence,null,2)+'\n',{mode:0o600});
        console.log(J(evidence));
    } finally {
        let clientExit;
        if(client?.exitCode===null&&client.signalCode===null){
            await command('quit').catch(()=>{});
            let value=await Promise.race([exited,delay(5000,null,{ref:false})]);
            if (!value) { client.kill('SIGTERM'); value=await exited; }
            clientExit=value;
        }
        if(screen.exitCode===null&&screen.signalCode===null){screen.kill();await stoppedScreen;}
        fs.rmSync(out,{recursive:true,force:true});
        if (clientExit) assert.deepEqual(clientExit,[0,null],'native Electron exited normally');
    }
}
main().catch(error=>{
    fs.rmSync(out,{recursive:true,force:true});
    console.error(error.stack);
    process.exitCode=1;
});

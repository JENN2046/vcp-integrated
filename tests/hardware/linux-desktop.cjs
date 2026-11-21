'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { X509Certificate } = require('node:crypto');
const { createRequire } = require('node:module');
const { setTimeout: delay } = require('node:timers/promises');
const project = path.resolve(__dirname, '../..');
const { restoreProfile } = require('../integration/profile.cjs');
const run = path.resolve(process.argv[2]);
assert.equal(path.dirname(run), path.join(project, '.runs/hardware'));
const ready = JSON.parse(fs.readFileSync(path.join(run,'ready.json'),'utf8'));
const desktop = path.join(project,'apps/desktop');
const base = { HOME:path.join(run,'home-A'), XDG_CONFIG_HOME:path.join(run,'home-A/config'),
    XDG_CACHE_HOME:path.join(run,'home-A/cache'), PATH:'/usr/bin:/bin', LANG:'C.UTF-8', DISPLAY:process.env.DISPLAY,
    ...(process.env.XAUTHORITY ? { XAUTHORITY:process.env.XAUTHORITY } : {}),
    NS_HOST:desktop, VCPCHAT_APP_DATA_DIR:path.join(run,'profile-A'), VCPCHAT_E2E_TEST:'1',
    NODE_EXTRA_CA_CERTS:ready.publicCa, NS_CERT_FINGERPRINT:new X509Certificate(fs.readFileSync(ready.publicLeaf)).fingerprint256 };
const electron = process.env.ELECTRON_BIN || createRequire(path.join(desktop,'package.json'))('electron');
const pidFile = path.join(run,'linux-supervisor.pid');
const profile = base.VCPCHAT_APP_DATA_DIR;
let child;
const pending = new Map();
const startup = Promise.withResolvers();
const exited = Promise.withResolvers();
let sequence = 0;
const reply = (event,value) => console.log(JSON.stringify({event,value}));
async function command(action, script) {
    const id = ++sequence;
    const answer = Promise.withResolvers();
    pending.set(id, answer.resolve);
    child.stdin.write(JSON.stringify({id,action,script})+'\n');
    const value = await Promise.race([answer.promise,delay(7000,null,{ ref:false })]);
    pending.delete(id);
    if (!value || value.error) throw Error(value?.error || 'Electron command timed out');
    return value.result;
}
const j = JSON.stringify;
const evalJs = code => command('eval',code);
async function click(selector,text) {
    const point = await evalJs(`(() => {
        const node=[...document.querySelectorAll(${j(selector)})].find(x=>x.checkVisibility()&&(${j(text??null)}===null||x.innerText.trim()===${j(text??null)}));
        if(!node)return null;
        node.scrollIntoView({block:'center',behavior:'instant'});
        const r=node.getBoundingClientRect();
        return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
    })()`);
    if(!point) throw Error('Target control unavailable');
    await command('mouse',point);
}
const selection = () => evalJs('window.VCPStateChannels.get("conversation.current").get()');
const readView = async () => {
    const view = await evalJs(`(() => {
        const area=document.querySelector('#chatMessages');
        const scroller=[area,...(function*(node){while(node.parentElement){node=node.parentElement;yield node;}})(area)]
            .find(node=>/^(?:auto|scroll)$/.test(getComputedStyle(node).overflowY))||area;
        const selected=window.getSelection();
        return {context:window.VCPStateChannels.get('conversation.current').get(), text:area.innerText,
            composer:document.querySelector('#messageInput').value, selectionText:selected.toString(),
            selectionInTranscript:area.contains(selected.anchorNode),
            reading:{scrollTop:scroller.scrollTop,height:scroller.clientHeight,scrollHeight:scroller.scrollHeight}};
    })()`);
    const {itemId,topicId}=ready.desktopDescriptor;
    const historyFile=path.join(run,'profile-A','UserData',itemId,'topics',topicId,'history.json');
    const history=fs.existsSync(historyFile)?JSON.parse(fs.readFileSync(historyFile,'utf8')):[];
    return { ...view, history:history.map(row=>({id:row.id,role:row.role})) };
};
async function markContext() {
    const draft='Synthetic draft retained during shared observation.';
    const result=await evalJs(`(() => {
        const input=document.querySelector('#messageInput');
        input.focus();
        input.value=${j(draft)};
        input.dispatchEvent(new Event('input',{bubbles:true}));
        const area=document.querySelector('#chatMessages');
        const walker=document.createTreeWalker(area,NodeFilter.SHOW_TEXT);
        for(let node=walker.nextNode();node;node=walker.nextNode()){
            const start=node.data.indexOf(${j(ready.input)});
            if(start<0)continue;
            const range=document.createRange();range.setStart(node,start);range.setEnd(node,start+${ready.input.length});
            window.getSelection().removeAllRanges();window.getSelection().addRange(range);
            return true;
        }
        return false;
    })()`);
    assert.equal(result,true,'original user input visible and selectable');
}
async function record(stage) {
    const view=await readView();
    fs.writeFileSync(path.join(run,'linux-'+stage+'.json'),JSON.stringify(view,null,2)+'\n',{mode:0o600});
    reply('linux-'+stage,view);
}
async function main() {
    fs.writeFileSync(pidFile, String(process.pid), {flag:'wx',mode:0o600});
    if (!fs.existsSync(profile)) {
        await restoreProfile(path.join(run,'seed','desktopA'), profile, new URL(ready.url).origin, 'A');
        const settings = path.join(profile,'settings.json');
        const data = JSON.parse(fs.readFileSync(settings,'utf8'));
        fs.writeFileSync(settings, JSON.stringify({ ...data, ChatDataServiceEnabled:true,
            ChatDataServiceNotifyEnabled:false, ChatDataServiceTantivyEnabled:false, disableUpdateCheck:true }));
    }
    fs.mkdirSync(base.HOME, {recursive:true,mode:0o700});
    child = spawn(electron, ['--ozone-platform=x11','--disable-background-networking',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
        path.join(project,'tests/integration/electron.cjs')], {cwd:desktop,env:base,stdio:['pipe','pipe','pipe']});
    child.stderr.resume();
    readline.createInterface({input:child.stdout}).on('line', line => {
        if (!line.startsWith('NS_MEASURE ')) return;
        const event = JSON.parse(line.slice(11));
        if (event.event === 'renderer-ready') startup.resolve();
        if (event.event === 'answer') pending.get(event.data.id)?.(event.data);
    });
    child.on('error', startup.reject);
    child.on('exit', (code,signal) => {
        startup.reject(Error('Electron exited'));
        exited.resolve({code,signal});
    });
    if (!await Promise.race([startup.promise.then(()=>true),delay(30000,false,{ref:false})])) throw Error('Isolated Electron did not finish startup');
    await click('#agentList li .agent-name',ready.agent);
    const deadline=Date.now()+10000;
    let selected;
    do {
        selected=await selection();
        if (selected.topicId===ready.desktopDescriptor.topicId) break;
        await delay(50);
    } while (Date.now()<deadline);
    assert.equal(selected.itemId,ready.desktopDescriptor.itemId);
    assert.equal(selected.topicId,ready.desktopDescriptor.topicId);
    reply('linux-ready',selected);
    const requireReaderProof = process.argv[3] === '--require-reader-proof';
    let attempted=false;
    const terminal=readline.createInterface({input:process.stdin,terminal:false});
    terminal.on('line',async line=>{
        try {
            if(line==='observe') reply('linux-observation',await readView());
            if(line==='mark') { await markContext(); await record('held'); }
            if(line==='record') await record('completed');
            if(line==='capture') { await command('picture',path.join(run,'linux-topic.png')); reply('linux-captured',true); }
            if(line==='send'){
                assert.equal(attempted,false,'the original send can be attempted only once');
                if (requireReaderProof) {
                    const proof = JSON.parse(fs.readFileSync(path.join(run,'windows-pin-pass.json'),'utf8'));
                    assert.ok(proof.pass && proof.runId === path.basename(run) &&
                        proof.sharedTopicId === ready.sharedTopicId && proof.topicId === ready.windowsDescriptor.topicId,
                        'Windows baseline must be verified for this run before sending');
                }
                attempted=true;
                const state=JSON.parse(fs.readFileSync(path.join(run,'status.json'),'utf8'));
                assert.equal(state.work.length,0);
                assert.equal((await selection()).topicId,ready.desktopDescriptor.topicId);
                await evalJs(`(() => {
                    const input=document.querySelector('#messageInput'); input.focus(); input.value=${j(ready.input)};
                    input.dispatchEvent(new Event('input',{bubbles:true}));
                })()`);
                await click('#sendMessageBtn');
                reply('linux-submitted',true);
            }
            if(line==='stop') terminal.close();
        }catch(error){reply('linux-command-failed',error.message);}
    });
    await new Promise(resolve=>{
        terminal.once('close',resolve);
        process.once('SIGINT',()=>terminal.close());
        process.once('SIGTERM',()=>terminal.close());
    });
}
main().catch(error=>{
    reply('linux-failed',error.message);
    process.exitCode=1;
}).finally(async()=>{
    if(child?.exitCode===null&&child.signalCode===null){
        await command('quit').catch(()=>{});
        const value=await Promise.race([exited.promise,delay(10000,null,{ref:false})]);
        if (!value) throw Error('Isolated Electron did not confirm normal exit');
        assert.deepEqual(value,{code:0,signal:null});
    }
    if (fs.existsSync(pidFile) && fs.readFileSync(pidFile,'utf8') === String(process.pid)) fs.rmSync(pidFile);
});

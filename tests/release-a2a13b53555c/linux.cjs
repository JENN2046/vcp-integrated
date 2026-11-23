'use strict';

const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {X509Certificate} = require('node:crypto');
const fs = require('node:fs');
const {createRequire} = require('node:module');
const path = require('node:path');
const readline = require('node:readline');
const {setTimeout:delay} = require('node:timers/promises');

const candidate = path.resolve(process.argv[2]);
const run = path.resolve(process.argv[3]);
const ready = JSON.parse(fs.readFileSync(path.join(run,'ready.json')));
const desktop = path.join(candidate,'apps/desktop');
const {restoreProfile} = require(path.join(candidate,'tests/integration/profile.cjs'));
const electron = createRequire(path.join(desktop,'package.json'))('electron');
const profile = path.join(run,'profile-A');
const home = path.join(run,'home-A');
const environment = {
    HOME:home, XDG_CONFIG_HOME:path.join(home,'config'), XDG_CACHE_HOME:path.join(home,'cache'),
    PATH:'/usr/bin:/bin', LANG:'C.UTF-8', DISPLAY:process.env.DISPLAY,
    ...(process.env.XAUTHORITY && {XAUTHORITY:process.env.XAUTHORITY}),
    NS_HOST:desktop, VCPCHAT_APP_DATA_DIR:profile, VCPCHAT_E2E_TEST:'1',
    NODE_EXTRA_CA_CERTS:ready.publicCa,
    NS_CERT_FINGERPRINT:new X509Certificate(fs.readFileSync(ready.publicLeaf)).fingerprint256,
};
const panel = '.native-sync-controlled-work';
const query = JSON.stringify;
const selection = "window.VCPStateChannels.get('conversation.current').get()";
const event = (name, value) => console.log(JSON.stringify({event:name, value}));
let child, childExit, sequence = 0, selected;
let launch = Math.max(0,...fs.readdirSync(run).map(file => Number(file.match(/^linux-(\d+)-loaded\.json$/)?.[1] || 0)));
const pending = new Map();

async function request(action, script) {
    const id = ++sequence;
    const answer = Promise.withResolvers();
    pending.set(id, answer.resolve);
    child.stdin.write(JSON.stringify({id,action,script}) + '\n');
    try {
        const value = await Promise.race([answer.promise,delay(12000,null,{ref:false})]);
        if (!value || value.error) throw Error(value?.error || 'Electron command timed out');
        return value.result;
    } finally { pending.delete(id); }
}
const evaluate = source => request('eval',source);
async function wait(probe, what) {
    const until = Date.now() + 14000;
    do {
        const value = await probe();
        if (value) return value;
        await delay(100);
    } while (Date.now() < until);
    throw Error('Timed out waiting for ' + what);
}
async function click(selector, text, method = 'mouse') {
    const point = await wait(() => evaluate(`(() => {
        const node = [...document.querySelectorAll(${query(selector)})].find(el =>
            el.checkVisibility() && (${query(text ?? null)} === null || el.innerText.trim() === ${query(text ?? null)}));
        if (!node) return false;
        node.scrollIntoView({block:'center',behavior:'instant'});
        const r = node.getBoundingClientRect();
        const x = Math.round(r.left+r.width/2), y = Math.round(r.top+r.height/2);
        return node.contains(document.elementFromPoint(x,y)) && {x,y};
    })()`), text || selector);
    await request(method, point);
}
async function fill(selector, text) {
    await evaluate(`(() => {
        const input = document.querySelector(${query(selector)});
        input.focus();
        input.value = ${query(text)};
        input.dispatchEvent(new Event('input', {bubbles:true}));
    })()`);
}
async function open(which) {
    if (!await evaluate("document.querySelector('#tabContentAgents').classList.contains('active')")) {
        await click('.sidebar-tab-button[data-tab="agents"]');
    }
    const target = which === 'group' ? ready.groupBindings.A : ready.singleDescriptors.A;
    if (which === 'group') await click(`#agentList > li[data-item-type="group"][data-item-id=${query(target.itemId)}]`);
    else await click('#agentList > li .agent-name', ready.singleAgent);
    await wait(async () => (await evaluate(selection))?.itemId === target.itemId, 'item selected');
    if ((await evaluate(selection))?.topicId !== target.topicId) {
        await click('.sidebar-tab-button[data-tab="topics"]');
        await click(`#topicList [data-topic-id=${query(target.topicId)}] .topic-title-display`);
    }
    assert.equal((await evaluate(selection)).topicId, target.topicId);
    if (which === 'group') {
        await wait(() => evaluate(`document.querySelector('${panel}:not([hidden]) summary')?.checkVisibility()`), 'group handoff panel');
        if (!await evaluate(`document.querySelector('${panel}').open`)) await click(panel + ' summary');
    }
    selected = which;
    event('selected', {which,target});
}
async function start() {
    const startup = Promise.withResolvers();
    const boot = ++launch;
    child = spawn(electron, ['--ozone-platform=x11','--disable-background-networking',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
        path.join(candidate,'tests/integration/electron.cjs')],
        {cwd:desktop, env:environment, stdio:['pipe','pipe','pipe']});
    child.stderr.pipe(fs.createWriteStream(path.join(run,`linux-${boot}.stderr`),{mode:0o600}));
    const log = fs.createWriteStream(path.join(run,`linux-${boot}.jsonl`),{mode:0o600});
    readline.createInterface({input:child.stdout}).on('line', line => {
        if (!line.startsWith('NS_MEASURE ')) return;
        const record = JSON.parse(line.slice(11));
        const {event,data} = record;
        if (event === 'renderer-ready') startup.resolve();
        if (event === 'answer') pending.get(data.id)?.(data);
        if (event !== 'answer') log.write(JSON.stringify(record) + '\n');
    });
    childExit = new Promise(resolve => child.once('exit', (code, signal) => {
        log.end();
        startup.reject(Error('Electron exited before startup'));
        resolve({code,signal});
    }));
    child.on('error', startup.reject);
    if (!await Promise.race([startup.promise.then(()=>true),delay(35000,false,{ref:false})])) throw Error('Electron startup timed out');
    const sources = await request('loaded-sources', {
        main:[
            'apps/desktop/Groupmodules/groupchat.js',
            'apps/desktop/modules/services/nativeSync/sharedGroupHandoff.js',
            'apps/desktop/modules/services/nativeSync/sharedExecution.js',
        ],
        renderer:[
            'apps/desktop/modules/renderer/controlledWorkView.mjs',
            'apps/desktop/modules/renderer/messageContextMenu.js',
        ],
    });
    fs.writeFileSync(path.join(run,`linux-${boot}-loaded.json`),JSON.stringify(sources,null,2)+'\n');
    event('linux-ready', {pid:child.pid,launch});
}
async function stop(crash) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (crash) child.kill('SIGKILL');
    else await request('quit').catch(() => {});
    const outcome = await Promise.race([childExit,delay(10000,null,{ref:false})]);
    assert.deepEqual(outcome, crash ? {code:null,signal:'SIGKILL'} : {code:0,signal:null});
    event('linux-exit', {launch,...outcome});
}
async function record(label) {
    const binding = selected === 'group' ? ready.groupBindings.A : ready.singleDescriptors.A;
    const view = await evaluate(`(() => ({
        context:${selection}, text:document.querySelector('#chatMessages').innerText,
        controlledWork:document.querySelector('${panel} [role="status"]')?.innerText,
        status:document.querySelector('.native-sync-execution-status')?.innerText
    }))()`);
    const file = path.join(profile,'UserData',binding.itemId,'topics',binding.topicId,'history.json');
    const history = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : [];
    await request('picture',path.join(run,'linux-' + label + '.png'));
    fs.writeFileSync(path.join(run,'linux-' + label + '.json'),JSON.stringify({launch,view,history},null,2)+'\n');
    event('recorded', {label,view,rows:history.length});
}
async function perform(line) {
    if (line === 'group' || line === 'single') return open(line);
    if (line === 'trace') return request('trace');
    if (line === 'group-start') {
        assert.equal(selected,'group');
        await fill(panel + ' textarea[aria-label="受控任务文本"]', ready.groupInput);
        return click(panel + ' button:not(:disabled)', '开始顺序接力');
    }
    if (line === 'takeover' || line === 'continue') {
        assert.equal(selected,'group');
        return click(panel + ' button:not(:disabled)', line === 'takeover' ? '接管到本端' : '本端继续执行');
    }
    if (line === 'crash-reopen' || line === 'reopen') {
        await stop(line === 'crash-reopen');
        await start();
        if (selected) await open(selected);
        return;
    }
    if (line === 'single-first' || line === 'single-next') {
        assert.equal(selected,'single');
        await fill('#messageInput',ready.singleInputs[line === 'single-first' ? 0 : 1]);
        return click('#sendMessageBtn:not(:disabled)');
    }
    if (line === 'settle' || line === 'delete') {
        assert.equal(selected,'single');
        const status = JSON.parse(fs.readFileSync(ready.status));
        const original = status.single.work[0];
        assert.ok(original);
        if (line === 'settle') {
            assert.equal(original.state,'review_required');
            const statusPanel = '.native-sync-execution-status';
            if (!await evaluate(`document.querySelector('${statusPanel}').open`)) {
                await click(statusPanel + ' summary');
                await delay(450);
            }
            const work = statusPanel + ' [data-work-id=' + query(original.id) + ']';
            const checkbox = work + ' input[type=checkbox]';
            if (!await evaluate(`document.querySelector(${query(checkbox)})?.checked`)) {
                await click(work + ' label');
            }
            await wait(() => evaluate(`document.querySelector(${query(checkbox)})?.checked`), 'review confirmation checkbox');
            await record('single-confirmation-checked');
            return click(work + ' button:not(:disabled)', '确认放弃并解除暂停');
        }
        assert.equal(original.state,'cancelled');
        await click('#chatMessages .message-item[data-message-id=' + query(original.user_message_id) + ']', undefined, 'mouse-right');
        await click('#chatContextMenu .context-menu-item','删除消息');
        await record('single-delete-confirmation');
        return click('#confirm-dialog-overlay .confirm-dialog-confirm','删除');
    }
    if (/^record [a-z][a-z0-9-]+$/.test(line)) return record(line.slice(7));
    throw Error('Unknown Linux control command');
}
async function main() {
    if (!fs.existsSync(profile)) {
        await restoreProfile(ready.linuxSeed, profile, new URL(ready.url).origin, 'A');
        const filename = path.join(profile,'settings.json');
        const settings = JSON.parse(fs.readFileSync(filename));
        fs.writeFileSync(filename, JSON.stringify({
            ...settings, ChatDataServiceEnabled:true, ChatDataServiceNotifyEnabled:false,
            ChatDataServiceTantivyEnabled:false, disableUpdateCheck:true,
        }));
    }
    fs.mkdirSync(home,{recursive:true,mode:0o700});
    fs.writeFileSync(path.join(run,'linux-supervisor.pid'),String(process.pid),{flag:'wx',mode:0o600});
    await start();
    const input = readline.createInterface({input:process.stdin});
    input.once('close',()=>process.stdin.pause());
    process.once('SIGTERM',()=>input.close());
    process.once('SIGINT',()=>input.close());
    for await (const line of input) {
        if (line === 'stop') break;
        try {
            await perform(line);
            event('command-finished',line);
        } catch (error) { event('command-failed',{line,message:error.message}); }
    }
}
main().catch(error => { event('linux-failed',error.stack); process.exitCode = 1; }).finally(async () => {
    await stop(false);
    const pid = path.join(run,'linux-supervisor.pid');
    if (fs.existsSync(pid) && fs.readFileSync(pid,'utf8') === String(process.pid)) fs.rmSync(pid);
}).then(() => process.exit(process.exitCode || 0), error => {
    event('linux-failed',error.stack);
    process.exit(1);
});

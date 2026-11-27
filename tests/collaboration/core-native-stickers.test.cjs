'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const {createHash,X509Certificate} = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {BOX,wait} = require('../native/fixtures/sharedSingleHarness.cjs');
const {localProvider,host} = require('../native/fixtures/coreSingleHarness.cjs');
const {projectPreview} = require(BOX+'/core/nativeStickers');

test('Core mobile only displays scoped native sticker assets from the original message', {timeout:35000}, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(),'core-stickers-'));
    const directory = path.join(root,'core');
    const image = path.join(root,'image');
    const pack = '验收表情包';
    const category = path.join(image,pack);
    const imageKey = 'fixture-native-image-key';
    const imageOrigin = 'https://native-images.invalid';
    const tag = (file, origin=imageOrigin) => '<img src="'+origin+'/pw='+imageKey+'/images/'+pack+'/'+file+'" width="80">';
    const png = await require(BOX+'/node_modules/sharp')({create:{width:4,height:4,channels:3,background:'#44ba77'}}).png().toBuffer();
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
    await fs.mkdir(category,{recursive:true});
    await fs.writeFile(path.join(category,'静态.png'),png);
    await fs.writeFile(path.join(category,'动图.gif'),gif);
    await fs.symlink(path.join(category,'静态.png'),path.join(category,'符号链接.png'));
    const provider=await localProvider(t);
    const {chat}=host(provider);
    chat.config.cachedEmojiLists = new Map([[pack,'静态.png|动图.gif']]);
    const manual='桌面正文 '+tag('动图.gif')+' 结束。';
    const native='模型正文 '+tag('静态.png')+' 结束。';
    const missing='缺图正文 '+tag('已移除.png')+tag('符号链接.png')+tag('静态.png','https://untrusted.invalid')+' 结束。';
    provider.setReply((body,res)=>{
        const value=JSON.stringify(body.messages.at(-1).content);
        const content=value.includes('缺图')?missing:value.includes('纯文字')?'纯文字回复。':native;
        res.end(JSON.stringify({choices:[{message:{role:'assistant',content},finish_reason:'stop'}]}));
    });
    const express=require(BOX+'/node_modules/express');
    const app=express();
    const {CoreService}=require(BOX+'/core/service');
    const {localTopicKey}=require(BOX+'/core/localWorkspace');
    const {administer}=require(BOX+'/core/pairDevice');
    const keyFile=path.join(root,'key.pem'), certFile=path.join(root,'cert.pem');
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1',
        '-addext','subjectAltName=IP:127.0.0.1','-keyout',keyFile,'-out',certFile],{stdio:'ignore'});
    const certificate=await fs.readFile(certFile);
    const spki=createHash('sha256').update(new X509Certificate(certificate).publicKey.export({type:'spki',format:'der'})).digest('base64');
    const server=https.createServer({cert:certificate,key:await fs.readFile(keyFile)},app);
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin='https://127.0.0.1:'+server.address().port;
    const config={origin,hours:2};
    const core=new CoreService({directory,workspace:'personal',chat,remoteConfig:config,
        nativeStickers:{root:image,origin:imageOrigin,imageKey:()=>imageKey}});
    const env={VCP_CORE_DATA_DIR:directory,VCP_CORE_REMOTE_ORIGIN:origin};
    let sends=0,browser;
    app.use((q,_r,next)=>{if(q.method==='POST'&&q.path.endsWith('/send'))sends++;next();});
    app.use('/mobile',core.remote.router('mobile'));
    app.use('/core/api',core.remote.router('desktop'));
    const define=async name=>{
        const key=localTopicKey('agent','fixture',name);
        await core.local.define(key,{ownerType:'agent',ownerId:'fixture',topicId:name,name,
            config:{name:'Sticker fixture',model:'synthetic',systemPrompt:'原生可选素材：{{验收表情包}}',streamOutput:false}},()=>true);
        return key;
    };
    function request(route,{token,body}={}){
        return new Promise((resolve,reject)=>{
            const r=https.request(origin+route,{ca:certificate,method:body?'POST':'GET',headers:{
                Origin:origin,...(token&&{Authorization:'Bearer '+token}),...(body&&{'Content-Type':'application/json'})
            }},s=>{const buffers=[];s.on('data',b=>buffers.push(b));s.on('end',()=>resolve({status:s.statusCode,bytes:Buffer.concat(buffers)}));});
            r.on('error',reject);r.end(body?JSON.stringify(body):undefined);
        });
    }
    try{
        const main=await define('main'), other=await define('other');
        const pair=administer(env,['pair','desktop']);
        const desktop=await request('/core/api/pair',{body:{code:pair.pairingCode}});
        assert.equal(desktop.status,200);
        const {token}=JSON.parse(desktop.bytes);
        const rootApi='/core/api/personal/'+main;
        for(const [requestId,text] of [['desktop-sticker',manual],['desktop-optional','纯文字'],['desktop-missing','缺图']]){
            const admitted=await request(rootApi+'/send',{token,body:{requestId,text}});
            assert.equal(admitted.status,202);
            await wait(()=>core.store.work(JSON.parse(admitted.bytes).id).status==='completed','original Work completed');
        }
        assert.match(JSON.stringify(provider.calls[0].messages[0]),/静态/);
        assert.match(JSON.stringify(provider.calls[0].messages[0]),/动图/);
        assert.ok(!JSON.stringify(provider.calls[0].messages[0]).includes('{{验收表情包}}'));
        const desktopHistory=await request(rootApi+'/messages',{token});
        assert.ok(JSON.parse(desktopHistory.bytes).messages.some(row=>row.content===manual));
        const mobileRoot='/mobile/api/core/personal/'+main;
        const user=core.store.snapshot(main,Number.MAX_SAFE_INTEGER,20).find(m=>m.content===manual);
        assert.equal((await request(mobileRoot+'/stickers/'+user.id+'/0')).status,401);
        browser=await require(BOX+'/node_modules/puppeteer').launch({executablePath:process.env.CHROME_BIN||'/opt/google/chrome/chrome',
            headless:true,userDataDir:path.join(root,'browser'),args:['--ignore-certificate-errors-spki-list='+spki,
                '--disable-background-networking','--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
        const page=await browser.newPage();
        await page.setViewport({width:393,height:852,isMobile:true,hasTouch:true});
        await page.goto(origin+'/mobile/#pair='+administer(env,['pair','mobile']).pairingCode);
        await page.click('#pair-submit');
        await page.waitForSelector('#topic-select');
        await page.select('#topic-select',main);
        await page.waitForFunction(()=>document.querySelectorAll('#history img.native-sticker').length===2 &&
            [...document.querySelectorAll('#history img.native-sticker')].every(img=>img.naturalWidth>0));
        const first=await page.evaluate(()=>[...document.querySelectorAll('img.native-sticker')].map(img=>img.getAttribute('src')));
        assert.equal(first.length,2);
        assert.ok(first.every(s=>s.startsWith('/mobile/api/core/')));
        await page.waitForFunction(()=>document.querySelectorAll('.native-sticker-unavailable').length===3);
        assert.ok(!(await page.$eval('#history',h=>h.textContent)).includes(imageKey));
        assert.match(await page.$eval('#history',h=>h.textContent),/缺图正文.*结束。/s);
        const projection=await page.evaluate(async paths=>{
            const history=await fetch(paths.messages).then(r=>r.json());
            const code=(await fetch(paths.wrongTopic)).status;
            const data=await Promise.all(paths.assets.map(async p=>[...new Uint8Array(await fetch(p).then(r=>r.arrayBuffer()))]));
            return {history,code,data};
        },{messages:mobileRoot+'/messages',wrongTopic:'/mobile/api/core/personal/'+other+'/stickers/'+user.id+'/0',assets:first});
        assert.equal(projection.code,404);
        assert.ok(!JSON.stringify(projection.history).includes(imageKey));
        assert.ok(projection.data.some(bytes=>Buffer.from(bytes).equals(png)));
        assert.ok(projection.data.some(bytes=>Buffer.from(bytes).equals(gif)));
        const before=sends;
        await page.reload({waitUntil:'domcontentloaded'});
        await page.waitForFunction(()=>document.querySelectorAll('#history img.native-sticker').length===2);
        assert.equal(sends,before);
        assert.equal(core.store.db.prepare('select count(*) n from works').get().n,3);
        assert.equal(provider.calls.length,3);
        assert.equal(projectPreview('正文 '+tag('静态.png').slice(0,-1)),'正文 ');
        assert.equal(projectPreview(native),'模型正文  结束。');
        t.diagnostic('Controlled provider fixture: real Core and Chromium read path, not proof of a live Agent selecting stickers.');
    } finally {
        await browser?.close();server.closeAllConnections();
        await new Promise(resolve=>server.close(resolve));await core.close();
        await fs.rm(root,{recursive:true,force:true});
    }
});

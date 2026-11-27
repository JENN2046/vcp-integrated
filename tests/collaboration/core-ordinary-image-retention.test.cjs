'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const {createHash,X509Certificate} = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {BOX,wait} = require('../native/fixtures/sharedSingleHarness.cjs');
const {localProvider,host} = require('../native/fixtures/coreSingleHarness.cjs');

test('ordinary Core PWA image send commits its links with admission and never resends after a lost receipt', {timeout:45000}, async t => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'ordinary-image-retention-'));
    const directory=path.join(root,'core');
    const provider=await localProvider(t);
    const {chat}=host(provider);
    const express=require(BOX+'/node_modules/express');
    const sharp=require(BOX+'/node_modules/sharp');
    const {CoreService}=require(BOX+'/core/service');
    const {localTopicKey}=require(BOX+'/core/localWorkspace');
    const {administer}=require(BOX+'/core/pairDevice');
    const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
    const png=color=>sharp({create:{width:24,height:24,channels:3,background:color}}).png().toBuffer();
    const green=await png('#22aa55'),red=await png('#dd3311'),blue=await png('#3366dd');
    const picture=path.join(root,'side.png');
    await fs.writeFile(picture,green);
    const received=[];
    provider.setReply(async(body,res)=>{
        try {
            const image=body.messages.flatMap(row=>Array.isArray(row.content)?row.content:[])
                .find(part=>part.type==='image_url'&&part.image_url?.url.startsWith('data:image/'));
            const bytes=Buffer.from(image.image_url.url.split(',')[1],'base64');
            const rgb=[...await sharp(bytes).resize(1,1).removeAlpha().raw().toBuffer()];
            assert.ok(rgb[1]>rgb[0]+50&&rgb[1]>rgb[2]+50);
            received.push({rgb,wireHash:hash(bytes)});
            res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'已核对绿色侧面图。'},finish_reason:'stop'}]}));
        }catch(error){res.writeHead(422).end('{}');console.error(error);}
    });
    const keyFile=path.join(root,'key.pem'),certFile=path.join(root,'cert.pem');
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1',
        '-addext','subjectAltName=IP:127.0.0.1','-keyout',keyFile,'-out',certFile],{stdio:'ignore'});
    const cert=await fs.readFile(certFile);
    const spki=createHash('sha256').update(new X509Certificate(cert).publicKey.export({type:'spki',format:'der'})).digest('base64');
    const app=express(),server=https.createServer({cert,key:await fs.readFile(keyFile)},app);
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin='https://127.0.0.1:'+server.address().port;
    const pair=()=>administer({VCP_CORE_DATA_DIR:directory,VCP_CORE_REMOTE_ORIGIN:origin},['pair','mobile']).pairingCode;
    const realNow=Date.now,posts=[],lookups=[];
    let core,mobile,browser,clock,mainSend,postReceipt,holdLookup=false,admissionClock,associationClock;
    const install=()=>{
        core=new CoreService({directory,workspace:'personal',chat,remoteConfig:{origin,hours:720}});
        core.local.imageModels.push('synthetic');mobile=core.remote.router('mobile');
    };
    app.use(express.json());
    app.use((req,res,next)=>{
        if(req.method==='POST' && req.path.endsWith('/send'))posts.push({path:req.path,requestId:req.body.requestId});
        if(req.method==='GET' && req.path.endsWith('/receipt')){
            lookups.push(req.query.requestId);
            if(holdLookup)return res.status(503).json({});
        }
        if(req.method==='POST'&&req.path===mainSend){
            const upload=core.store.db.prepare('SELECT expires FROM attachment_uploads WHERE id=?').get(req.body.attachments[0]);
            clock=admissionClock=upload.expires-1;
            const json=res.json.bind(res);
            res.json=value=>{
                if(res.statusCode!==202)return json(value);
                postReceipt=value;
                res.set('Content-Type','application/json').set('Content-Length','400').write('{');
                setTimeout(()=>res.destroy(),35);
            };
        }
        next();
    });
    app.use('/mobile',(req,res,next)=>mobile?mobile(req,res,next):res.status(503).json({}));
    try {
        install();
        const storageId=core.store.storageId;
        const define=async name=>{
            const key=localTopicKey('agent','fixture',name);
            await core.local.define(key,{ownerType:'agent',ownerId:'fixture',topicId:name,name,
                config:{name:'Image fixture',model:'synthetic',systemPrompt:'Synthetic only.',streamOutput:false}},()=>true);
            return key;
        };
        const main=await define('main'),rejected=await define('rejected');
        const launchBrowser=()=>require(BOX+'/node_modules/puppeteer').launch({
            executablePath:process.env.CHROME_BIN||'/opt/google/chrome/chrome',headless:true,
            userDataDir:path.join(root,'browser'),args:['--ignore-certificate-errors-spki-list='+spki,
                '--disable-background-networking','--no-first-run','--no-proxy-server',
                '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']
        });
        const openMobile=async()=>{
            browser=await launchBrowser();
            const tab=await browser.newPage();
            tab.setDefaultTimeout(10000);
            await tab.setViewport({width:393,height:852,isMobile:true,hasTouch:true});
            await tab.goto(origin+'/mobile/',{waitUntil:'domcontentloaded'});
            return tab;
        };
        let page=await openMobile();
        await page.waitForSelector('#pair-code',{visible:true});
        await page.type('#pair-code',pair());
        await page.click('#pair-submit');
        await page.waitForSelector('#topic-select');
        const base=key=>'/mobile/api/core/personal/'+key;
        const upload=(key,bytes,requestId)=>page.evaluate(async (base,data,size,hash,requestId)=>{
            const write=async (route,body,status)=>{
                const response=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
                if(response.status!==status)throw Error('Unexpected upload HTTP '+response.status);
                return response.json();
            };
            const info=await write('/attachments/uploads',{requestId,name:requestId+'.png',size,
                expectedHash:hash,type:'image/png'},201);
            const route='/attachments/uploads/'+info.uploadId;
            await write(route+'/chunks',{offset:0,data},200);
            return write(route+'/finish',{},200);
        },base(key),bytes.toString('base64'),bytes.length,hash(bytes),requestId);
        const first=await upload(rejected,red,'first-rollback-image');
        const second=await upload(rejected,blue,'second-rollback-image');
        const db=core.store.db;
        const counts=()=>Object.fromEntries(['messages','works','idempotency_receipts','change_log','attachment_links'].map(table=>
            [table,db.prepare('SELECT count(*) n FROM '+table).get().n]));
        const beforeFailure=counts();
        db.exec(`CREATE TEMP TRIGGER omit_second_image AFTER INSERT ON attachment_links
             WHEN NEW.hash='${hash(blue)}'
             BEGIN DELETE FROM attachment_links WHERE msg_id=NEW.msg_id AND attachment_id=NEW.attachment_id; END`);
        const failure=await page.evaluate(async (route,uploads)=>{
            const session=await fetch('/mobile/api/session').then(response=>response.json());
            const headers={'Content-Type':'application/json','X-NativeSync-Entry-Id':session.recovery.entryId,
                'X-NativeSync-Session-Marker':session.recovery.sessionMarker};
            const attempt=await fetch(route+'/send',{method:'POST',headers,body:JSON.stringify({
                requestId:'ordinary-image-rejected',text:'rollback both links',attachments:uploads
            })});
            const receipt=await fetch(route+'/receipt?requestId=ordinary-image-rejected');
            return {http:attempt.status,error:(await attempt.json()).error?.code,receipts:(await receipt.json()).executions};
        },base(rejected),[first.uploadId,second.uploadId]);
        assert.deepEqual(failure,{http:500,error:'ATTACHMENT_LINK_FAILED',receipts:[]});
        const afterFailure=counts();
        assert.deepEqual(afterFailure,beforeFailure);
        assert.equal(provider.calls.length,0);
        db.exec('DROP TRIGGER omit_second_image');

        const orphan=await upload(main,red,'unreferenced-control');
        const orphanPath=core.attachments.blobPath(orphan.hash);
        assert.ok(await fs.stat(orphanPath));
        let wakes=0;
        core.runner.wake=()=>{wakes++;};
        Date.now=()=>clock??realNow();
        const claim=core.attachments.claim.bind(core.attachments);
        core.attachments.claim=(...args)=>{
            const files=claim(...args);
            if(clock!==undefined && args[1]===main)clock=associationClock=admissionClock+1;
            return files;
        };
        mainSend=base(main)+'/send';holdLookup=true;
        await page.select('#topic-select',main);
        const picker=await page.waitForSelector('.attachment-picker input[type="file"]:not([disabled])');
        await picker.uploadFile(picture);
        await page.waitForSelector('#send:not([disabled])');
        await page.$eval('.message-composer',form=>form.requestSubmit());
        await wait(()=>postReceipt,'Core accepted image before original response was cut');
        assert.equal(wakes,1);
        const receipt=postReceipt;
        const work=core.store.work(receipt.id);
        assert.equal(work.status,'queued');assert.equal(work.dispatched,0);
        assert.equal(provider.calls.length,0);
        assert.equal(associationClock,admissionClock+1);
        assert.deepEqual(counts(),{messages:1,works:1,idempotency_receipts:1,change_log:1,attachment_links:1});
        const uploadRow=db.prepare('SELECT id,expires FROM attachment_uploads WHERE hash=?').get(hash(green));
        assert.equal(uploadRow.expires,associationClock);
        const link=db.prepare('SELECT hash FROM attachment_links WHERE msg_id=?').get(work.user_message_id);
        assert.equal(link.hash,hash(green));
        const photoPath=core.attachments.blobPath(hash(green));
        const before=await fs.readFile(photoPath);
        clock=db.prepare('SELECT max(expires) AS expires FROM attachment_uploads').get().expires+1;
        core.attachments.expire();
        assert.equal(db.prepare('SELECT 1 FROM attachment_uploads WHERE id=?').get(uploadRow.id),undefined);
        await assert.rejects(()=>fs.stat(orphanPath),{code:'ENOENT'});
        assert.deepEqual(await fs.readFile(photoPath),before);
        assert.equal(hash(before),hash(green));
        await page.waitForSelector('#pending-submission');
        const initialPosts=posts.length, lookupsBefore=lookups.length;
        await browser.close();
        browser=null;
        const old=core;mobile=null;core=null;await old.close();install();
        assert.equal(core.store.storageId,storageId);
        page=await openMobile();
        await page.waitForSelector('#pending-submission');
        holdLookup=false;
        await page.waitForSelector('#pending-submission',{hidden:true});
        await wait(()=>core.store.work(work.id).status==='completed','same Work completed with committed image');
        assert.equal(posts.length,initialPosts);
        const exact=await page.evaluate(async route=>await fetch(route).then(response=>response.json()),
            base(main)+'/receipt?requestId='+encodeURIComponent(receipt.requestId));
        assert.deepEqual([...new Set(lookups.slice(lookupsBefore))],[receipt.requestId]);
        assert.equal(exact.executions.length,1);
        assert.equal(exact.executions[0].id,work.id);
        assert.equal(exact.executions[0].requestId,receipt.requestId);
        const final=core.store.work(work.id);
        const run='[data-run-id="'+work.id+'"][data-run-state="completed"]';
        const image='[data-message-id="'+work.user_message_id+'"] .attachment-open';
        await page.waitForSelector(run+' summary',{visible:true});
        await page.click(run+' summary');
        await page.waitForSelector(run+' .work-reply',{visible:true});
        await page.click(run+' .work-reply');
        assert.equal(await page.evaluate(()=>document.activeElement?.dataset.messageId),final.reply_message_id);
        await page.waitForSelector(image,{visible:true});
        await page.click(image);
        await page.waitForFunction(()=>document.querySelector('#attachment-viewer')?.open &&
            document.querySelector('#attachment-viewer img')?.naturalWidth>0);
        const original=core.store.snapshot(main,Number.MAX_SAFE_INTEGER,20).find(row=>row.id===work.user_message_id);
        assert.equal(original.attachments[0].hash,hash(green));
        const downloaded=await page.evaluate(async route=>[...new Uint8Array(await fetch(route).then(r=>r.arrayBuffer()))],
            base(main)+'/blob/'+hash(green));
        assert.deepEqual(Buffer.from(downloaded),green);
        assert.equal(provider.calls.length,1);
        assert.equal(received.length,1);
        assert.equal(core.store.db.prepare('SELECT count(*) n FROM works').get().n,1);
        assert.equal(core.store.db.prepare("SELECT count(*) n FROM messages WHERE role='user'").get().n,1);
        t.diagnostic(JSON.stringify({case:'ordinary-image-retention',admissionClock,associationClock,receipt:{http:202,
            requestId:receipt.requestId,workId:work.id,messageId:work.user_message_id,hash:hash(green)},
            afterCleanup:{uploadRemoved:true,orphanRemoved:true,digest:hash(before)},
            recovered:{receiptRequestId:exact.executions[0].requestId,replyId:final.reply_message_id,
                sendsAfterRestart:posts.length-initialPosts,workCount:1,
                chromiumColdOpen:true,originalReplyFocused:true,attachmentPreviewOpened:true,imageCalls:provider.calls.length,received},
            failedLink:{requestId:'ordinary-image-rejected',...failure,before:beforeFailure,after:afterFailure}}));
    } finally {
        Date.now=realNow;
        await browser?.close();
        server.closeAllConnections();
        await new Promise(resolve=>server.close(resolve));
        await core?.close();
        await fs.rm(root,{recursive:true,force:true});
    }
});

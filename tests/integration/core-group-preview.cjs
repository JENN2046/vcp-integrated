'use strict';

const assert = require('node:assert/strict');
const { createHash, randomUUID, X509Certificate } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { administer } = require('../../apps/server/core/pairDevice');
const { localTopicKey } = require('../../apps/server/core/localWorkspace');

// Opt-in core-remote scenario using two actual desktop/PWA observers on the same
// group. The loopback model pauses each member so a preview is observable before
// that member's formal message exists.
module.exports = (context, { call, cert, out }) => {
    const groupId = 'group_stability';
    const topicId = 'two-members';
    const key = localTopicKey('group', groupId, topicId);
    const base = '/core/api/personal/' + key;
    const members = [
        { id:'stability-a', name:'Ada', streamOutput:false },
        { id:'stability-b', name:'Bruno', streamOutput:true }
    ].map(member => ({ ...member, model:'synthetic', systemPrompt:'Synthetic group preview fixture.' }));
    const pending = [];
    let expectedOutcome;
    context.serviceOptions.coreRemote.groupPreviewReply = (body, res) => {
        pending.push({ body, res });
        if (body.stream && expectedOutcome !== 'failed') {
            res.writeHead(200, { 'Content-Type':'text/event-stream' });
            res.write('data: {"choices":[{"index":0,"delta":{"content":"Bruno streaming "},"finish_reason":null}]}\n\n');
        }
    };
    const pairDesktops = context.pairDesktops;
    context.pairDesktops = async service => {
        await pairDesktops(service);
        for (const { id, ...config } of members) {
            const owner = await call('/core/api/personal/agents/' + id, { token:context.tokens.A, method:'PUT', body:{ config } });
            assert.equal(owner.status, 200, JSON.stringify(owner.data));
        }
        const result = await call(base + '/definition', { token:context.tokens.A, method:'PUT', body:{
            ownerType:'group', ownerId:groupId, topicId, name:'Preview topic',
            config:{group:{name:'Preview team', mode:'sequential', members:members.map(member=>member.id)}, agents:members}
        }});
        assert.equal(result.status,200,JSON.stringify(result.data));
    };
    context.run = async ({ clients:{A}, evalJs, click, waitUntil, result }) => {
        const fingerprint = createHash('sha256').update(new X509Certificate(fs.readFileSync(cert)).publicKey.export({format:'der',type:'spki'})).digest('base64');
        const browser = await require('../../apps/server/node_modules/puppeteer').launch({
            executablePath:process.env.CHROME_BIN || '/opt/google/chrome/chrome',
            userDataDir:path.join(out,'group-pwa'),headless:true,
            args:['--disable-gpu','--disable-background-networking','--ignore-certificate-errors-spki-list='+fingerprint,
                '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']
        });
        try {
            const pwa = await browser.newPage();
            await pwa.goto(context.origin+'/mobile/');
            await pwa.waitForSelector('#pair-code');
            const code = administer(context.env, ['pair','mobile-reader']).pairingCode;
            await pwa.type('#pair-code', code);
            await pwa.click('#pair-submit');
            const agentLabel = await pwa.waitForFunction(() => [...document.querySelectorAll('#agent-select option')].find(o=>o.textContent.includes('Preview team'))?.value);
            await pwa.select('#agent-select', await agentLabel.jsonValue());
            await pwa.waitForFunction(id=>[...document.querySelectorAll('#topic-select option')].some(o=>o.value===id),{},key);
            await pwa.select('#topic-select',key);
            await click(A, '#agentList li[data-item-id="'+groupId+'"]');
            await waitUntil(()=>evalJs(A,`window.VCPStateChannels.get('conversation.current').get()?.topicId === '${topicId}'`),'Electron selected group topic');
            const read = () => call(base+'/messages', { token:context.tokens.A }).then(value=>value.data.messages);
            const runs = [];
            for (const [round, outcome] of ['completed', 'cancelled', 'failed', 'review_required'].entries()) {
                expectedOutcome = outcome;
                const send = await call(base+'/send', { token:context.tokens.A, body:{
                    requestId:randomUUID(), text:'Group preview check '+outcome
                } });
                assert.equal(send.status,202,JSON.stringify(send.data));
                const workId = send.data.workId || send.data.id;
                const official = async () => (await read()).filter(message=>message.role==='assistant' && message.sourceWorkId===workId);
                const observations = [];
                for (const [step, member] of members.entries()) {
                    const request = await waitUntil(()=>pending[round*members.length + step], 'model step '+step);
                    const { body, res } = request;
                    assert.equal(body.stream, member.streamOutput);
                    const desktopSelector = '[data-native-sync-execution="'+workId+'"][data-core-speaker="'+member.id+'"]';
                    const pwaSelector = '[data-live-work-id="'+workId+'"][data-core-speaker="'+member.id+'"]';
                    const hasPartial = member.streamOutput && outcome !== 'failed';
                    const desktop = await waitUntil(async()=>{
                        const seen = await evalJs(A,`(() => {
                            const el = document.querySelector(${JSON.stringify(desktopSelector)});
                            return el && { speaker:el.dataset.coreSpeaker, status:el.querySelector('p').textContent,
                                text:el.querySelector('pre').textContent };
                        })()`);
                        return seen?.status.includes(member.name) && (!hasPartial || seen.text === 'Bruno streaming ') && seen;
                    },'Electron preview '+member.id);
                    await pwa.waitForFunction((sel,name,partial)=>{
                        const el = document.querySelector(sel);
                        return el?.querySelector('.message-author small')?.textContent === name &&
                            (!partial || el.querySelector('.bubble')?.textContent === 'Bruno streaming ');
                    },{},pwaSelector,member.name,hasPartial);
                    const mobile = await pwa.$eval(pwaSelector, el=>({ speaker:el.dataset.coreSpeaker,
                        name:el.querySelector('.message-author small').textContent, text:el.querySelector('.bubble')?.textContent || '' }));
                    assert.equal(desktop.speaker,member.id);
                    assert.equal(mobile.speaker,member.id);
                    assert.equal(mobile.text,desktop.text);
                    assert.deepEqual((await official()).map(message=>message.agentId), members.slice(0,step).map(m=>m.id));
                    observations.push({ step, member:member.id, desktop, mobile });
                    if (!member.streamOutput) {
                        res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({
                            choices:[{ index:0, message:{role:'assistant',content:'Ada final'}, finish_reason:'stop' }]
                        }));
                    } else if (outcome === 'cancelled') {
                        const cancelled = await call(base+'/works/'+workId+'/cancel', {
                            token:context.tokens.A, body:{ requestId:randomUUID() }
                        });
                        assert.equal(cancelled.status,200);
                    } else if (outcome === 'failed') {
                        res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:{message:'fixture failure'}}));
                    } else {
                        const choice = outcome === 'completed'
                            ? { index:0, delta:{content:'final'}, finish_reason:'stop' }
                            : { index:0, delta:{}, finish_reason:'length' };
                        res.end('data: '+JSON.stringify({choices:[choice]})+'\n\ndata: [DONE]\n\n');
                    }
                }
                await waitUntil(async()=>(await call(base+'/works',{token:context.tokens.A})).data.works
                    .some(work=>work.id===workId && work.status===outcome), 'terminal '+outcome);
                const finals = await official();
                const expected = [['stability-a','Ada','Ada final']];
                if (outcome === 'completed') expected.push(['stability-b','Bruno','Bruno streaming final']);
                assert.deepEqual(finals.map(m=>[m.agentId,m.name,m.content]),expected);
                // Every browser must retire the transient speaker on both normal
                // and abnormal terminal states, then display the actual final IDs.
                const finalIds = finals.map(message=>message.id);
                await pwa.waitForFunction((id,ids)=>!document.querySelector('[data-live-work-id="'+id+'"]')
                    && ids.every(message=>document.querySelector('#history [data-message-id="'+message+'"]')),{},workId,finalIds);
                await waitUntil(()=>evalJs(A,`!document.querySelector('[data-native-sync-execution="${workId}"]') && ${JSON.stringify(finalIds)}.every(id=>document.querySelector('#chatMessages [data-message-id="'+id+'"]'))`),
                    'Electron retired '+outcome+' preview');
                runs.push({ workId, outcome, observations, formalReplies:finals.map(({agentId,name,content})=>({agentId,name,content})) });
            }
            assert.equal(pending.length,8);
            result.groupPreview = { runs, providerCalls:pending.length };
        } finally {
            for (const {res} of pending) if(!res.writableEnded)res.destroy();
            await browser.close();
        }
    };
};

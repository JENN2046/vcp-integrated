'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const chat = path.resolve(__dirname,'../../apps/desktop');
const { JSDOM } = require(path.join(chat,'node_modules/jsdom'));

async function fixture(t, type = 'text/plain') {
    const dom = new JSDOM('<main><div></div></main>');
    t.after(() => dom.window.close());
    const win = dom.window, wrapper = win.document.querySelector('div');
    const { createAttachmentInteraction } = await import(pathToFileURL(path.join(chat,'modules/services/nativeSync/attachmentPresentation.mjs')));
    const calls = [], notices = [];
    let result = {missing:false};
    win.chatAPI = {checkOpenedAttachment:async request => {calls.push(request);return result;}};
    win.uiHelperFunctions = {showToastNotification:msg => notices.push(msg)};
    win.VCPStateChannels = {get:() => ({get:() => ({itemType:'agent',itemId:'A',topicId:'T'})})};
    const hash = 'a'.repeat(64), attachment = {type,_fileManagerData:{id:'F',hash}};
    const prepare = () => createAttachmentInteraction(win);
    const call = (policy, reason='open') => policy?.({reason, wrapper, messageId:'M', attachment});
    return {win,wrapper,calls,notices,attachment,hash,prepare,call,set:r => {result=r}};
}
test('open gate uses the selected reference and leaves native open available for healthy files or unavailable IPC',async t=>{
    const f=await fixture(t),gate=f.prepare();
    assert.equal(await f.call(gate),false);
    assert.deepEqual(f.calls[0],{itemType:'agent',itemId:'A',topicId:'T',messageId:'M',attachmentId:'F',hash:f.hash});
    f.set({missing:true});assert.equal(await f.call(gate),true);assert.equal(f.notices.length,1);
    f.set({success:false});assert.equal(await f.call(gate),false);
    f.win.chatAPI.checkOpenedAttachment=async()=>{throw Error('closed')};assert.equal(await f.call(gate),false);
    delete f.win.chatAPI;assert.equal(f.prepare(),undefined);
});
test('resource errors use the same scoped recovery without an open-action notice',async t=>{
    for(const tag of ['audio','video']){
        const f=await fixture(t,tag+'/test');
        f.set({missing:true});assert.equal(await f.call(f.prepare(),'resource-error'),true);
        assert.equal(f.calls.length,1);assert.equal(f.notices.length,0);
    }
});
test('a detached card and a reference without a valid digest do not request recovery',async t=>{
    const f=await fixture(t),gate=f.prepare();f.wrapper.remove();assert.equal(f.call(gate),undefined);assert.equal(f.calls.length,0);
    f.win.document.querySelector('main').append(f.wrapper);f.attachment._fileManagerData.hash='invalid';assert.equal(f.call(gate),undefined);
});

test('an image resource error leaves its native thumbnail behavior intact', async t => {
    const f=await fixture(t,'image/png');
    assert.equal(f.call(f.prepare(),'resource-error'),undefined);
    assert.equal(f.calls.length,0);
});

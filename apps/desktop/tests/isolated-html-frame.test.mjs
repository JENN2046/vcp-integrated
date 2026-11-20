import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import vm from 'node:vm';
import { prepareIsolatedHtmlMarkup, createOpaqueHtmlFrame, validatePngSnapshot, withIsolatedHtmlSnapshots } from '../modules/renderer/isolatedHtmlFrame.js';

test('before insertion, scripts and handler attributes stay only in an inert source template', () => {
    const dom = new JSDOM('<!doctype html><body></body>');
    const doc = dom.window.document;
    const html = prepareIsolatedHtmlMarkup('<div id="own"><p>normal</p><img onerror="selfOnly()"><script type="text/ecmascript">selfOnly()</script></div>', doc);
    const template = doc.createElement('template'); template.innerHTML = html;
    assert.equal(template.content.querySelectorAll('script, [onerror]').length, 0);
    assert.equal(template.content.querySelectorAll('[data-vcp-isolated-html]').length, 1);
    const source = template.content.querySelector('template[data-vcp-isolated-source]');
    assert(source.innerHTML.includes('text/ecmascript'));
    assert(source.innerHTML.includes('id="own"'));
    dom.window.close();
});
test('input reserved markers cannot bypass sealing or retain a live handler', () => {
    const dom = new JSDOM('<!doctype html><body></body>'), doc = dom.window.document;
    for (const source of [
        '<div data-vcp-isolated-html><script>selfOnly()</script></div>',
        '<div data-vcp-isolated-html onpointerover="selfOnly()"><template data-vcp-isolated-source><p>normal</p></template><span data-vcp-isolated-waiting onerror="selfOnly()">x</span></div>',
    ]) {
        const html=prepareIsolatedHtmlMarkup(source, doc), parsed=doc.createElement('template');parsed.innerHTML=html;
        assert.equal(parsed.content.querySelectorAll('script, [onpointerover], [onerror]').length, 0);
    }
    dom.window.close();
});
test('encoded URL protocols are parsed inertly before host insertion', () => {
    const dom = new JSDOM('<!doctype html><body></body>'),doc=dom.window.document;
    const html=prepareIsolatedHtmlMarkup('<a href="&#106;ava&#10;script:selfOnly()">normal label</a>',doc),parsed=doc.createElement('template');parsed.innerHTML=html;
    assert.equal(parsed.content.querySelectorAll('a[href]').length,0);
    assert(parsed.content.querySelector('template[data-vcp-isolated-source]'));
    dom.window.close();
});
test('read-only code and tool-data remain data; static Markdown and math are untouched', () => {
    const dom = new JSDOM('<!doctype html><body></body>'), doc = dom.window.document;
    const plain='<p>normal <strong>text</strong> \\(x+y\\)</p>';
    assert.equal(prepareIsolatedHtmlMarkup(plain, doc), plain);
    const html=prepareIsolatedHtmlMarkup('<pre><script>literal()</script><img onerror="literal()"></pre><div data-vcp-tool-data><script>literal()</script></div>',doc), parsed=doc.createElement('template');parsed.innerHTML=html;
    assert.equal(parsed.content.querySelectorAll('[data-vcp-isolated-html], script, [onerror]').length,0);
    assert(parsed.content.querySelector('pre').textContent.includes('<script>literal()</script>'));
    dom.window.close();
});
test('actual diagram failure markup keeps exception strings as text', () => {
    const source=fs.readFileSync(new URL('../modules/messageRenderer.js',import.meta.url),'utf8'),line=source.split('\n').find(line=>line.includes('el.innerHTML =')&&line.includes('mermaid-error'));
    const raw='normal failure <img src=x onerror="selfOnly()">',el={},escapeHtml=value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    vm.runInNewContext(line,{el,error:{message:raw},originalCode:'normal code',escapeHtml});
    const dom=new JSDOM('<!doctype html><body></body>'),template=dom.window.document.createElement('template');template.innerHTML=el.innerHTML;
    assert.equal(template.content.querySelectorAll('img,[onerror]').length,0);assert(template.content.textContent.includes(raw));dom.window.close();
});

function fixture() {
    const dom=new JSDOM('<!doctype html><body><main></main></body>',{url:'https://vcpchat.local/'});
    const doc=dom.window.document,root=doc.querySelector('main');
    const frame=createOpaqueHtmlFrame({html:'<p>normal own content</p>',ownerDocument:doc});root.appendChild(frame.frame);
    frame.frame.getBoundingClientRect=()=>({width:300,height:110});
    const token=frame.frame.name.slice('vcp-opaque-'.length);
    const reply=(data,{source=frame.frame.contentWindow,origin='null',nonce=token}={})=>dom.window.dispatchEvent(new dom.window.MessageEvent('message',{source,origin,data:{channel:'vcp-isolated-html',nonce,...data}}));
    return {dom,root,frame,reply};
}
test('height messages require exact child, opaque origin and nonce; cleanup revokes them', async()=>{
    const f=fixture();
    try {
        f.reply({kind:'height',height:130},{source:f.dom.window});
        f.reply({kind:'height',height:130},{nonce:'other-frame'});
        f.reply({kind:'height',height:130},{origin:'https://vcpchat.local'});
        assert.equal(f.frame.isReady,false);
        f.reply({kind:'height',height:130});await f.frame.ready;
        assert.equal(f.frame.frame.style.height,'130px');
        f.frame.dispose();f.reply({kind:'height',height:500});
        assert.equal(f.frame.frame.style.height,'130px');
    } finally {f.frame.dispose();f.dom.window.close();}
});
function png(width,height){const bytes=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);bytes.write('IHDR',12);bytes.writeUInt32BE(width,16);bytes.writeUInt32BE(height,20);return {mime:'image/png',data:'data:image/png;base64,'+bytes.toString('base64')};}
test('bitmap reply rejects SVG, corrupt header, oversized decoded geometry and aborts pending decode', async()=>{
    let image;
    class PendingImage {constructor(){image=this;}set src(value){this.value=value;}decode(){return new Promise(()=>{});}}
    const win={atob:value=>Buffer.from(value,'base64').toString('binary'),Image:PendingImage};
    await assert.rejects(validatePngSnapshot({mime:'image/svg+xml',data:'data:image/svg+xml,<svg/>'},win),/Unsupported/);
    await assert.rejects(validatePngSnapshot({mime:'image/png',data:'data:image/png;base64,YWJj'},win),/Invalid/);
    await assert.rejects(validatePngSnapshot(png(8192,8192),win),/dimensions/);
    const controller=new AbortController(),pending=validatePngSnapshot(png(2,2),win,{signal:controller.signal});controller.abort();await assert.rejects(pending,/cancelled/);assert.equal(image.value,'');
});
test('multi-frame export enforces decoded pixel budget and restores local display after rejection',async()=>{
    const f=fixture(),extra=[];let rendered=false;const oldScroll=f.dom.window.scrollTo;f.dom.window.scrollTo=()=>{};
    const own=handle=>{handle.frame.getBoundingClientRect=()=>({width:300,height:110});handle.snapshot=async()=>({dataUrl:'data:image/png;base64,AA==',width:4000,height:4000,bytes:2});return handle;};
    const decode=f.dom.window.HTMLImageElement.prototype.decode;f.dom.window.HTMLImageElement.prototype.decode=async()=>{};
    own(f.frame);
    try{
        for(let n=0;n<2;n++){const handle=createOpaqueHtmlFrame({html:'<p>own</p>',ownerDocument:f.root.ownerDocument});f.root.appendChild(handle.frame);extra.push(own(handle));}
        const displays=[...f.root.querySelectorAll('iframe')].map(frame=>frame.style.display);
        await assert.rejects(withIsolatedHtmlSnapshots(f.root,()=>{rendered=true}),/total rendering budget/);
        assert.equal(rendered,false);assert.equal(f.root.querySelectorAll('[data-vcp-render-snapshot]').length,0);
        assert.deepEqual([...f.root.querySelectorAll('iframe')].map(frame=>frame.style.display),displays);
    }finally{f.frame.dispose();extra.forEach(handle=>handle.dispose());f.dom.window.HTMLImageElement.prototype.decode=decode;f.dom.window.scrollTo=oldScroll;f.dom.window.close();}
});

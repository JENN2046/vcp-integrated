// Model/document HTML is display data. Its scripts run in an opaque browser
// frame, never in the application's preload/DOM context.
export const DISPLAY_ONLY_HTML = 'pre, code, .vcp-html-preview-container, .html-preview-container, .vcp-stream-code-block, [data-vcp-tool-data], [data-vcp-block-type="tool-batch"], .vcp-tool-result-bubble, .vcp-tool-use-bubble';
const SLOT = '[data-vcp-isolated-html]';
const frameHandles = new WeakMap();
const ownerHandles = new WeakMap();
const retiredSlots = new WeakSet();
const assets = new Map();
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_DIM = 8192;
const MAX_SNAPSHOT_PIXELS = 16 * 1024 * 1024;
const VENDORS = Object.freeze({
    three: new URL('../../vendor/three.min.js', import.meta.url).href,
    pixi: new URL('../../vendor/pixi.min.js', import.meta.url).href,
    pixiUnsafe: new URL('../../vendor/pixi-unsafe-eval.min.js', import.meta.url).href,
    anime: new URL('../../vendor/anime.min.js', import.meta.url).href,
});
const PYODIDE = new URL('../../vendor/pyodide.js', import.meta.url).href;
const PYODIDE_INDEX = 'https://cdn.jsdelivr.net/pyodide/v0.25.1/full/';
const SCREENSHOT = new URL('../../vendor/modern-screenshot.js', import.meta.url).href;
function nonce(win) { return win.crypto?.randomUUID?.() || 'frame-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); }
function asset(url) { if (!assets.has(url)) assets.set(url, fetch(url).then(response => { if (!response.ok) throw new Error('Preview vendor unavailable'); return response.text(); }).catch(error => { assets.delete(url); throw error; })); return assets.get(url); }
function isDisplayOnly(node) { return Boolean(node?.closest?.(DISPLAY_ONLY_HTML)); }
function activeAttribute(attribute) { return /^on/i.test(attribute.name) || /^(?:href|xlink:href|src|action|formaction)$/i.test(attribute.name) && /^javascript:/i.test(attribute.value.replace(/[\u0000-\u0020]/g, '')); }
function executable(node) {
    if (!node?.localName) return false;
    // Browser-recognized script MIME aliases are wider than a short JS list.
    // Every script outside a display-only domain belongs in the opaque frame.
    if (node.localName === 'script') return true;
    return ['iframe','object','embed','base','meta','link','form','animate','set'].includes(node.localName) || [...node.attributes].some(activeAttribute);
}
function containsActive(node) { return executable(node) || [...(node.querySelectorAll?.('*') || [])].some(child => !isDisplayOnly(child) && executable(child)); }
function neutralizeReadonly(root, doc) {
    for (const node of [root, ...(root.querySelectorAll?.('*') || [])]) {
        if (!node?.localName) continue;
        if (['script','style','iframe','object','embed','base','meta','link'].includes(node.localName)) { node.replaceWith(doc.createTextNode(node.outerHTML)); continue; }
        for (const attribute of [...node.attributes]) if (activeAttribute(attribute)) node.removeAttribute(attribute.name);
    }
}
function normalizeInertSlot(slot, doc) {
    const source=slot.querySelector(':scope > template[data-vcp-isolated-source]');
    const htmlNamespace='http://www.w3.org/1999/xhtml';
    if(slot.namespaceURI!==htmlNamespace||slot.localName!=='div'){slot.removeAttribute('data-vcp-isolated-html');return false;}
    if(retiredSlots.has(slot))return true;
    const safeSource=source&&source.namespaceURI===htmlNamespace&&source.content?.nodeType===11&&!source.hasAttribute('shadowrootmode');
    const liveFrame=slot.querySelector(':scope > iframe[data-vcp-opaque-html]'),live=liveFrame&&frameHandles.get(liveFrame);
    if(safeSource&&live&&!live.isDestroyed&&[...slot.childNodes].every(node=>node===source||node===liveFrame||node.nodeType===3&&!node.textContent.trim())){
        for(const attribute of [...slot.attributes])if(activeAttribute(attribute))slot.removeAttribute(attribute.name);
        return true;
    }
    const safeChildren=safeSource&&[...slot.childNodes].every(node=>node===source||node.nodeType===3&&!node.textContent.trim()||node.nodeType===1&&node.namespaceURI===htmlNamespace&&node.localName==='span'&&node.hasAttribute('data-vcp-isolated-waiting')&&!node.children.length);
    if(!safeChildren){slot.removeAttribute('data-vcp-isolated-html');return false;}
    // An input marker is not a private brand. Rebuild only an actually inert
    // template shape, removing every input handler/attribute/live child.
    const freshSource=doc.createElement('template');freshSource.setAttribute('data-vcp-isolated-source','');freshSource.innerHTML=source.innerHTML;
    const waiting=doc.createElement('span');waiting.setAttribute('data-vcp-isolated-waiting','');waiting.textContent='交互内容';
    for(const attribute of [...slot.attributes])slot.removeAttribute(attribute.name);
    slot.setAttribute('data-vcp-isolated-html','');slot.className='vcp-isolated-html';lockSlotLayout(slot);slot.replaceChildren(freshSource,waiting);return true;
}
function lockSlotLayout(slot){slot.style.cssText='all:initial!important;display:block!important;position:relative!important;contain:layout paint!important;max-width:100%!important;min-width:0!important;overflow:hidden!important;isolation:isolate!important;';}
function sealParent(parent, doc) {
    // Split around native code/tool regions; those controls stay in the host.
    for (const child of [...parent.children]) {
        if (child.matches(SLOT)&&normalizeInertSlot(child,doc)) continue;
        if (child.matches(DISPLAY_ONLY_HTML)) neutralizeReadonly(child, doc);
        else if (child.querySelector(DISPLAY_ONLY_HTML)) {
            for (const attribute of [...child.attributes]) if (activeAttribute(attribute)) child.removeAttribute(attribute.name);
            sealParent(child, doc);
        }
    }
    const nodes = [...parent.childNodes], groups = [];
    const eligible = node => node?.nodeType === 1 && !node.matches(`${DISPLAY_ONLY_HTML},${SLOT}`) && !node.querySelector(DISPLAY_ONLY_HTML);
    nodes.forEach((node, index) => {
        if (!eligible(node) || !containsActive(node)) return;
        let start = index;
        // A sibling script keeps its preceding bare HTML island, including a
        // run of external/inline script tags in their original order.
        if (node.localName === 'script') {
            let previous = node.previousElementSibling;
            while (previous && eligible(previous)) {
                if (previous.localName !== 'script' && !previous.matches('div,section,article,figure,main,aside,details,table,form,svg,canvas,[id],[class],[style]')) break;
                start = nodes.indexOf(previous);
                if (previous.localName !== 'script') break;
                previous = previous.previousElementSibling;
            }
        }
        groups.push([start, index]);
    });
    groups.sort((a,b) => a[0]-b[0]);
    const merged = [];
    for (const range of groups) { const last = merged.at(-1); if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]); else merged.push([...range]); }
    for (const [start,end] of merged.reverse()) {
        const slot = doc.createElement('div'), source = doc.createElement('template'), waiting = doc.createElement('span');
        slot.setAttribute('data-vcp-isolated-html',''); slot.className = 'vcp-isolated-html';
        lockSlotLayout(slot);
        source.setAttribute('data-vcp-isolated-source',''); waiting.textContent = '交互内容'; waiting.setAttribute('data-vcp-isolated-waiting','');
        parent.insertBefore(slot, nodes[start]);
        for (let i=start;i<=end;i++) source.content.appendChild(nodes[i]);
        slot.append(source, waiting);
    }
}
export function sealActiveHtmlTemplate(template, ownerDocument) { sealParent(template.content, ownerDocument); return template; }
export function sealActiveHtmlRoot(root) { sealParent(root,root.ownerDocument); return root; }
export function prepareIsolatedHtmlMarkup(html, ownerDocument) {
    // Parse before deciding: character references/control characters in URL
    // attributes are normalized by the browser, not by a raw-string signature.
    if (typeof html !== 'string' || !html) return html;
    if(!ownerDocument?.createElement)return html.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const template = ownerDocument.createElement('template'); template.innerHTML = html;
    sealActiveHtmlTemplate(template, ownerDocument); return template.innerHTML;
}
function script(doc, source) { const node = doc.createElement('script'); node.textContent = source.replace(/<\/script/gi, '<\\/script'); return node; }
function knownVendor(src) {
    const clean=String(src).split(/[?#]/)[0];
    for(const [name,url] of Object.entries(VENDORS)) {
        if(clean===url||new RegExp('^(?:\\.\\./|\\./)?vendor/'+pathTail(url).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$','i').test(clean))return name;
    }
    if(/^https?:\/\/(?:cdnjs\.cloudflare\.com\/ajax\/libs\/three\.js\/[^/]+\/three(?:\.min)?\.js|(?:cdn\.jsdelivr\.net\/npm|unpkg\.com)\/three(?:@[^/]+)?\/(?:build\/)?three(?:\.min)?\.js)$/i.test(clean))return 'three';
    if(/^https?:\/\/(?:cdnjs\.cloudflare\.com\/ajax\/libs\/animejs\/[^/]+\/anime(?:\.min)?\.js|(?:cdn\.jsdelivr\.net\/npm|unpkg\.com)\/animejs(?:@[^/]+)?\/(?:lib\/)?anime(?:\.min)?\.js)$/i.test(clean))return 'anime';
    if(/^https?:\/\/(?:cdnjs\.cloudflare\.com\/ajax\/libs\/pixi\.js\/[^/]+\/pixi(?:\.min)?\.js|(?:cdn\.jsdelivr\.net\/npm|unpkg\.com)\/pixi\.js(?:@[^/]+)?\/(?:dist\/)?pixi(?:\.min)?\.js)$/i.test(clean))return 'pixi';
    return null;
}

// This function is serialized into the opaque child. It has no parent API,
// path, selector or command service. Only render lifecycle/data messages exist.
function childBootstrap(config) {
    const ownPost = data => parent.postMessage({ channel:'vcp-isolated-html', nonce:config.nonce, ...data }, '*');
    const native = { raf:requestAnimationFrame.bind(window), cancel:cancelAnimationFrame.bind(window), timeout:setTimeout.bind(window), clear:clearTimeout.bind(window), interval:setInterval.bind(window), clearInterval:clearInterval.bind(window) };
    let paused = config.paused;
    document.documentElement.setAttribute('data-vcp-activity',paused?'paused':'running');
    const glCanvases=new WeakMap(),getContext=HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext=function(type,...args){const result=getContext.call(this,type,...args);if(result&&/^(?:webgl2?|experimental-webgl)$/i.test(type))glCanvases.set(this,result);return result;};
    const rafs = new Map(), timers = new Map(); let sequence = 0;
    window.requestAnimationFrame = callback => { const id=++sequence, record={callback,native:null};rafs.set(id,record);if(!paused)record.native=native.raf(time=>{rafs.delete(id);callback(time)});return id; };
    window.cancelAnimationFrame = id => { const record=rafs.get(id);if(record?.native)native.cancel(record.native);rafs.delete(id); };
    const schedule = (callback, delay, repeat, args) => { const id=++sequence, record={callback,delay:Math.max(0,Number(delay)||0),repeat,args,native:null};timers.set(id,record);const run=()=>{record.native=null;if(paused)return;if(!repeat)timers.delete(id);try{typeof callback==='function'?callback(...args):(0,eval)(String(callback))}finally{if(repeat&&timers.has(id))record.native=native.timeout(run,record.delay)}};record.run=run;if(!paused)record.native=native.timeout(run,record.delay);return id; };
    window.setTimeout=(fn,ms,...args)=>schedule(fn,ms,false,args);window.setInterval=(fn,ms,...args)=>schedule(fn,ms,true,args);
    window.clearTimeout=window.clearInterval=id=>{const record=timers.get(id);if(record?.native)native.clear(record.native);timers.delete(id);};
    const setPaused = value => {
        paused=value;
        document.documentElement.setAttribute('data-vcp-activity',paused?'paused':'running');
        for(const record of rafs.values()){if(paused&&record.native){native.cancel(record.native);record.native=null}else if(!paused&&!record.native)record.native=native.raf(time=>{for(const [id,item] of rafs)if(item===record){rafs.delete(id);break}record.callback(time)})}
        for(const record of timers.values()){if(paused&&record.native){native.clear(record.native);record.native=null}else if(!paused&&!record.native)record.native=native.timeout(record.run,record.delay)}
        try{for(const animation of document.getAnimations())paused?animation.pause():animation.play()}catch{}
    };
    Object.defineProperty(window,'container',{ configurable:true,get:()=>document.getElementById(config.rootId) });
    const size = () => { const root=document.getElementById(config.rootId);if(root)ownPost({ kind:'height', height:Math.max(root.scrollHeight,root.getBoundingClientRect().height) }); };
    const showError = value => {const text=String(value||'Interactive content error').slice(0,240);ownPost({kind:'error',error:text});const root=document.getElementById(config.rootId);if(root){const error=document.createElement('pre');error.textContent=text;root.appendChild(error)}};
    addEventListener('error',event=>showError(event.message));
    addEventListener('unhandledrejection',event=>showError(event.reason?.message||event.reason));
    let snapshotLibrary;
    addEventListener('message',async event=>{
        const data=event.data;if(event.source!==parent||data?.channel!=='vcp-isolated-html'||data.nonce!==config.nonce)return;
        if(data.kind==='activity'&&typeof data.paused==='boolean'){setPaused(data.paused);return}
        if(data.kind!=='snapshot'||typeof data.requestId!=='string')return;
        try{
            if(document.querySelector('iframe'))throw Error('Nested frame snapshot is unavailable');
            for(const canvas of document.querySelectorAll('canvas')){
                if(canvas.width>8192||canvas.height>8192||canvas.width*canvas.height>16777216)throw Error('Canvas snapshot dimensions exceed limit');
                const gl=glCanvases.get(canvas);if(gl&&!gl.getContextAttributes()?.preserveDrawingBuffer)throw Error('WebGL snapshot has no retained drawing buffer');
                try{canvas.toDataURL('image/png')}catch{throw Error('Canvas snapshot is blocked by browser security')}
            }
            if(!snapshotLibrary){
                if(typeof data.librarySource!=='string'||data.librarySource.length>2097152)throw Error('Snapshot renderer unavailable');
                const key='__vcpSnapshotTimer_'+config.nonce;
                // Bind only this fixed renderer dependency to native timers so
                // an offscreen paused island can be captured without advancing
                // the document's own callbacks. This grants no parent access.
                Object.defineProperty(window,key,{value:{setTimeout:native.timeout,clearTimeout:native.clear},configurable:true});
                const prefix='const {setTimeout,clearTimeout}=window['+JSON.stringify(key)+'];\n';
                const url=URL.createObjectURL(new Blob([prefix,data.librarySource],{type:'text/javascript'}));try{snapshotLibrary=await import(url)}finally{delete window[key];URL.revokeObjectURL(url)}
            }
            const width=Math.max(1,document.documentElement.scrollWidth),height=Math.max(1,document.documentElement.scrollHeight),scale=Math.min(2,8192/Math.max(width,height),Math.sqrt(16777216/(width*height)));
            if(!(scale>0))throw Error('Interactive snapshot dimensions unavailable');
            const blob=await snapshotLibrary.domToBlob(document.body,{type:'image/png',scale,width,height});if(!blob||blob.size>8388608)throw Error('Interactive snapshot exceeds byte limit');
            const value=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('Interactive snapshot encoding failed'));reader.readAsDataURL(blob)});
            ownPost({kind:'snapshot',requestId:data.requestId,mime:'image/png',data:value});
        }catch(error){ownPost({kind:'snapshot',requestId:data.requestId,error:String(error.message||error).slice(0,240)})}
    });
    addEventListener('load',()=>{size();const root=document.getElementById(config.rootId);if(root)new ResizeObserver(size).observe(root)});
}

async function frameDocument(html, ownerDocument, config) {
    const doc=ownerDocument.implementation.createHTMLDocument('交互内容');
    const policy=doc.createElement('meta');policy.httpEquiv='Content-Security-Policy';policy.content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: data:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; worker-src blob:; frame-src about: data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'";
    if(config.runtime === 'pyodide-0.25.1') {
        // Only this published runtime tree is available to browser Python;
        // arbitrary APIs/package indexes retain the default network denial.
        policy.content=policy.content.replace("script-src 'unsafe-inline' 'unsafe-eval' blob: data:","script-src 'unsafe-inline' 'unsafe-eval' blob: data: "+PYODIDE_INDEX).replace("connect-src 'none'","connect-src "+PYODIDE_INDEX);
    }
    doc.head.appendChild(policy);
    doc.head.appendChild(script(doc,`(${childBootstrap.toString()})(${JSON.stringify(config).replace(/</g,'\\u003c')});`));
    const style=doc.createElement('style');style.textContent=`html,body{margin:0;padding:0;background:transparent;color:${config.color};font-family:${config.font};font-size:${config.fontSize};line-height:${config.lineHeight}}*{box-sizing:border-box}html[data-vcp-activity="paused"] *{animation-play-state:paused!important}`+'\n'+config.css;doc.head.appendChild(style);
    if(config.runtime === 'pyodide-0.25.1')doc.head.appendChild(script(doc,await asset(PYODIDE)));
    const template=doc.createElement('template');template.innerHTML=html;
    template.content.querySelectorAll('audio,video').forEach(media=>{media.removeAttribute('autoplay');media.removeAttribute('loop');media.setAttribute('preload','metadata');media.setAttribute('controls','')});
    const text=html.toLowerCase(), needed=[];
    if(/three\b/.test(text))needed.push('three');if(/pixi\b/.test(text))needed.push('pixi','pixiUnsafe');if(/anime\b/.test(text))needed.push('anime');
    // Only immutable known package vendors are fetched/inlined. Unknown src
    // remains an ordinary child resource, never read by the privileged host.
    for(const name of needed)doc.head.appendChild(script(doc,await asset(VENDORS[name])));
    for(const node of [...template.content.querySelectorAll('script[src]')])if(knownVendor(node.getAttribute('src'))!==null){node.removeAttribute('src');node.type='application/vnd.vcp-public-vendor';node.textContent='';}
    if(config.wrapScripts)for(const node of template.content.querySelectorAll('script:not([src])'))if(!node.type||/^(?:(?:text|application)\/(?:x-)?(?:java|ecma)script|text\/(?:jscript|livescript))$/i.test(node.type)){
        // Keep only the old currentScript convenience across await/callbacks.
        // Every other property/method is the real child document; there is no
        // parent/global selector fallback or virtual DOM authority.
        node.textContent='(function(ownScript){const ownDocument=new Proxy(document,{get(target,key){if(key==="currentScript")return ownScript;const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value},set(target,key,value){return Reflect.set(target,key,value,target)}});(async function(document){\n'+node.textContent+'\n}).call(window,ownDocument)})(document.currentScript);';
    }
    const outer=doc.createElement('div');if(config.scopeId)outer.id=config.scopeId;outer.className='message-item';const root=doc.createElement('div');root.id=config.rootId;root.className='md-content';root.appendChild(template.content);outer.appendChild(root);doc.body.appendChild(outer);
    return '<!doctype html>'+doc.documentElement.outerHTML;
}
function pathTail(url){return url.slice(url.lastIndexOf('/')+1)}

export function createOpaqueHtmlFrame({html,ownerDocument,scopeId='',css='',onError=()=>{},paused=false,wrapScripts=false,runtime=null}) {
    const win=ownerDocument.defaultView, token=nonce(win), frame=ownerDocument.createElement('iframe'), pending=new Map(),disposers=new Set();let disposed=false,resolveReady,rejectReady;
    const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject});
    const readyTimer=win.setTimeout(()=>rejectReady(Error('Interactive frame did not become ready')),15000);
    frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('data-vcp-opaque-html','');frame.name='vcp-opaque-'+token;frame.title='交互内容';frame.style.cssText='all:initial!important;display:block!important;position:static!important;width:100%!important;max-width:100%!important;height:120px!important;min-height:0!important;border:0!important;background:transparent!important;transform:none!important;';
    frame.allow="camera 'none'; microphone 'none'; geolocation 'none'; usb 'none'; serial 'none'; hid 'none'; bluetooth 'none'; clipboard-read 'none'; display-capture 'none'; autoplay 'none'";
    const send = data => { if(!disposed)frame.contentWindow?.postMessage({channel:'vcp-isolated-html',nonce:token,...data},'*'); };
    const control={ frame,paused,isPaused:paused,isReady:false,isDestroyed:false,usesPixi:/pixi/i.test(html),ready,
        onDispose(callback){disposers.add(callback)},
        dispose(){if(disposed)return;disposed=true;control.isDestroyed=true;win.clearTimeout(readyTimer);rejectReady(Error('Interactive frame was removed'));win.removeEventListener('message',receive);for(const row of pending.values()){win.clearTimeout(row.timer);row.abort.abort();row.reject(Error('Interactive frame was removed'))}pending.clear();for(const release of disposers)release();disposers.clear();frame.remove();frameHandles.delete(frame)},
        destroy(){control.dispose()},
        pause(){control.paused=control.isPaused=true;send({kind:'activity',paused:true})},resume(){control.paused=control.isPaused=false;send({kind:'activity',paused:false})},
        async snapshot(){if(disposed)throw Error('Interactive frame unavailable');await ready;if(pending.size)throw Error('Interactive snapshot is already pending');const librarySource=await asset(SCREENSHOT);if(disposed)throw Error('Interactive frame unavailable');const requestId=nonce(win);return new Promise((resolve,reject)=>{const abort=new win.AbortController(),timer=win.setTimeout(()=>{pending.delete(requestId);abort.abort();reject(Error('Interactive snapshot timed out'))},10000);pending.set(requestId,{resolve,reject,timer,abort,validating:false});send({kind:'snapshot',requestId,librarySource})})}};
    function receive(event){const data=event.data;if(disposed||event.source!==frame.contentWindow||event.origin!=='null'||data?.channel!=='vcp-isolated-html'||data.nonce!==token)return;
        if(data.kind==='height'&&Number.isFinite(data.height)){frame.style.setProperty('height',Math.min(20000,Math.max(24,Math.ceil(data.height)))+'px','important');if(!control.isReady){control.isReady=true;win.clearTimeout(readyTimer);resolveReady(control)}return}
        if(data.kind==='error'&&typeof data.error==='string'){onError(data.error.slice(0,240));return}
        if(data.kind!=='snapshot'||typeof data.requestId!=='string'||!pending.has(data.requestId))return;const row=pending.get(data.requestId);if(row.validating)return;
        if(typeof data.error==='string'){pending.delete(data.requestId);win.clearTimeout(row.timer);row.reject(Error(data.error.slice(0,240)));return}
        row.validating=true;
        const finish=(method,value)=>{if(pending.get(data.requestId)!==row)return;pending.delete(data.requestId);win.clearTimeout(row.timer);row[method](value)};
        validatePngSnapshot(data,win,{signal:row.abort.signal}).then(value=>finish('resolve',value),error=>finish('reject',error));
    }
    win.addEventListener('message',receive);frame.addEventListener('load',()=>send({kind:'activity',paused:control.paused}));
    const hostStyle=win.getComputedStyle(ownerDocument.body),rootId='vcp-island-'+token;
    frameDocument(html,ownerDocument,{nonce:token,rootId,scopeId,css,color:hostStyle.color||'#222',font:hostStyle.fontFamily||'sans-serif',fontSize:hostStyle.fontSize||'16px',lineHeight:hostStyle.lineHeight||'normal',paused,wrapScripts,runtime}).then(source=>{if(!disposed)frame.srcdoc=source}).catch(error=>{win.clearTimeout(readyTimer);rejectReady(error);if(!disposed)onError(String(error.message).slice(0,240))});
    ready.catch(()=>{});frameHandles.set(frame,control);return control;
}

export async function validatePngSnapshot(data,win,{signal}={}) {
    if(data.mime!=='image/png'||typeof data.data!=='string'||!data.data.startsWith('data:image/png;base64,')||data.data.length>Math.ceil(MAX_SNAPSHOT_BYTES*4/3)+64)throw Error('Unsupported interactive snapshot');
    let bytes;try{bytes=Uint8Array.from(win.atob(data.data.slice(22)),c=>c.charCodeAt(0))}catch{throw Error('Invalid interactive PNG encoding')}
    if(bytes.length>MAX_SNAPSHOT_BYTES||bytes.length<24||![137,80,78,71,13,10,26,10].every((n,i)=>bytes[i]===n)||String.fromCharCode(...bytes.slice(12,16))!=='IHDR')throw Error('Invalid interactive PNG');
    const view=new DataView(bytes.buffer),width=view.getUint32(16),height=view.getUint32(20);if(!width||!height||width>MAX_SNAPSHOT_DIM||height>MAX_SNAPSHOT_DIM||width*height>MAX_SNAPSHOT_PIXELS)throw Error('Interactive snapshot dimensions exceed limit');
    if(signal?.aborted)throw Error('Interactive PNG validation cancelled');
    const image=new win.Image();let rejectAbort;const aborted=new Promise((_,reject)=>{rejectAbort=reject});const cancel=()=>{image.src='';rejectAbort(Error('Interactive PNG validation cancelled'))};signal?.addEventListener('abort',cancel,{once:true});
    try{image.src=data.data;await Promise.race([image.decode(),aborted]);if(signal?.aborted)throw Error('Interactive PNG validation cancelled');if(image.naturalWidth!==width||image.naturalHeight!==height)throw Error('Interactive PNG decode mismatch');return {dataUrl:data.data,width,height,bytes:bytes.length};}finally{signal?.removeEventListener('abort',cancel);image.src='';}
}

export function mountIsolatedHtmlIslands(container,{visibilityOptimizer=null}={}) {
    const owner=container.ownerDocument,scopeId=container.closest?.('.message-item')?.id||container.id||'',messageItem=container.closest?.('.message-item');let handles=ownerHandles.get(container);if(!handles){handles=new Set();ownerHandles.set(container,handles)}
    const css=[...owner.querySelectorAll('style[data-vcp-scope-id]')].filter(node=>node.getAttribute('data-vcp-scope-id')===scopeId).map(node=>node.textContent).join('\n');
    for(const slot of container.querySelectorAll(SLOT)){
        if(isDisplayOnly(slot)||retiredSlots.has(slot)||slot.querySelector(':scope > iframe[data-vcp-opaque-html]'))continue;const source=slot.querySelector(':scope > template[data-vcp-isolated-source]');if(!source)continue;
        const handle=createOpaqueHtmlFrame({html:source.innerHTML,ownerDocument:owner,scopeId,css,wrapScripts:true,paused:Boolean(messageItem&&visibilityOptimizer),onError:error=>{slot.setAttribute('data-vcp-isolated-error',error)}});handles.add(handle);handle.onDispose(()=>{handles.delete(handle);retiredSlots.add(slot)});slot.querySelector('[data-vcp-isolated-waiting]')?.remove();slot.appendChild(handle.frame);
        if(messageItem&&visibilityOptimizer?.registerIsolatedFrame){const register=()=>{if(!handle.isDestroyed){const release=visibilityOptimizer.registerIsolatedFrame(messageItem,handle);if(release)handle.onDispose(release)}};register();handle.ready.then(register).catch(()=>{});}
    }
}
export function ownOpaqueHtmlFrame(container,handle){let handles=ownerHandles.get(container);if(!handles){handles=new Set();ownerHandles.set(container,handles)}handles.add(handle);handle.onDispose(()=>handles.delete(handle));return handle;}
export function cleanupIsolatedHtmlIslands(container) { const handles=ownerHandles.get(container);if(!handles)return;for(const handle of handles)handle.dispose();handles.clear();ownerHandles.delete(container); }

export async function withIsolatedHtmlSnapshots(root,render) {
    const replacements=[],scrolls=[];let total=0,pixels=0,count=0;
    for(let node=root;node;node=node.parentElement)scrolls.push([node,node.scrollLeft,node.scrollTop]);
    const win=root.ownerDocument.defaultView,windowScroll=[win.scrollX,win.scrollY];
    try{
        for(const frame of root.querySelectorAll('iframe[data-vcp-opaque-html]')){
            const rect=frame.getBoundingClientRect();if(!rect.width||!rect.height||win.getComputedStyle(frame).display==='none')continue;
            if(++count>16)throw Error('Interactive snapshot export exceeds frame count limit');
            const handle=frameHandles.get(frame);if(!handle)throw Error('Unregistered interactive frame cannot be exported');const shot=await handle.snapshot();total+=shot.bytes;pixels+=shot.width*shot.height;if(total>32*1024*1024||pixels>32*1024*1024)throw Error('Interactive snapshot export exceeds total rendering budget');if(!frame.isConnected||!root.contains(frame))throw Error('Content changed during interactive export');
            const image=root.ownerDocument.createElement('img'),display=frame.style.getPropertyValue('display'),priority=frame.style.getPropertyPriority('display');image.src=shot.dataUrl;await image.decode();image.style.cssText=`display:block;width:${rect.width}px;height:${rect.height}px;object-fit:fill;`;image.setAttribute('data-vcp-render-snapshot','');frame.before(image);frame.style.setProperty('display','none','important');replacements.push({frame,image,display,priority});
        }
        return await render();
    }finally{for(const {frame,image,display,priority} of replacements.reverse()){image.remove();image.removeAttribute('src');if(display)frame.style.setProperty('display',display,priority);else frame.style.removeProperty('display')}for(const [node,x,y] of scrolls){node.scrollLeft=x;node.scrollTop=y}try{win.scrollTo(...windowScroll)}catch{}}
}

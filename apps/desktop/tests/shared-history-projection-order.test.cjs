const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{JSDOM}=require('jsdom');
const source=fs.readFileSync(path.join(__dirname,'../modules/chatManager.js'),'utf8');const start=source.indexOf('        const sharedOrder =',source.indexOf('async function syncHistoryFromFile'));const end=source.indexOf('        // If messages were added',start);assert.ok(start>0&&end>start);
const project=new Function('historyInMem','newHistory','shared','root','protectedStreamingIds',`const itemId='owner',itemType='group',topicId='topic',chatRepository={isSyncEnabled:()=>shared},elements={chatMessagesDiv:root},isSyncCurrent=()=>true;let value;const currentChatHistoryRef={set:v=>value=v};${source.slice(start,end)}return value;`);
function fixture(){const dom=new JSDOM('<div id="root"><p id="timestamp">header</p><div class="message-item" data-message-id="u2"></div><div class="message-item" data-message-id="u1"></div><div class="message-item" data-message-id="a2"></div><div class="message-item" data-message-id="a1"></div></div>');return{dom,root:dom.window.document.getElementById('root')};}
const messages=[{id:'u1',timestamp:100},{id:'a1',timestamp:101},{id:'u2',timestamp:1},{id:'a2',timestamp:2}];
test('Shared DOM and memory follow committed History despite an eight-hour device clock skew',()=>{
 const {dom,root}=fixture(),original=[...root.querySelectorAll('.message-item')];try{const result=project([...messages],messages,true,root,new Set());assert.deepEqual(result.map(x=>x.id),['u1','a1','u2','a2']);assert.deepEqual([...root.querySelectorAll('.message-item')].map(x=>x.dataset.messageId),['u1','a1','u2','a2']);assert.equal(root.firstElementChild.id,'timestamp');assert.ok(original.every(node=>node.isConnected));assert.deepEqual(messages.map(x=>x.timestamp),[100,101,1,2]);}finally{dom.window.close();}
});
test('protected transient replies remain owned and offscreen History does not create DOM rows',()=>{
 const {dom,root}=fixture();try{root.querySelector('[data-message-id="a2"]').remove();const result=project([...messages,{id:'pending',timestamp:0}],messages,true,root,new Set(['pending']));assert.equal(result.at(-1).id,'pending');assert.equal(root.querySelectorAll('.message-item').length,3);assert.equal(root.querySelector('[data-message-id="pending"]'),null);}finally{dom.window.close();}
});
test('local history keeps its original timestamp ordering and DOM behavior',()=>{
 const {dom,root}=fixture();try{const before=root.innerHTML;const result=project([...messages],messages,false,root,new Set());assert.deepEqual(result.map(x=>x.id),['u2','a2','u1','a1']);assert.equal(root.innerHTML,before);}finally{dom.window.close();}
});

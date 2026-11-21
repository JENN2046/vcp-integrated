'use strict';
const {effectiveContextHistory,isContextCheckpoint}=require('@vcp/native-history-window');
const {applyContextRules}=require('@vcp/native-history-window/tavern-context');
const {attachTimestampMetadata}=require('../nativeRules/modules/chat/requestMetadata');
const {stripHiddenToolResults}=require('../nativeRules/modules/renderer/toolResultRegions');
const tavern=require('../nativeRules/modules/tavernRulesEngine');

function readJournalHistory(store,topic,throughSeq,predecessorReplies=[]){
    return store.readProjected(db=>db.prepare(`SELECT * FROM (
        SELECT *,row_number() OVER(PARTITION BY msg_id ORDER BY seq DESC) AS r,
            min(seq) OVER(PARTITION BY msg_id) AS first_seq
        FROM journal WHERE owner_type=? AND owner_id=? AND topic_id=? AND
        (seq<=? OR msg_id IN (SELECT value FROM json_each(?))))
        WHERE r=1 AND action='upsert' ORDER BY seq`).all(...topic,throughSeq,JSON.stringify(predecessorReplies)));
}

function journalOrder(records){
    // Editing a message changes its body without moving its checkpoint position.
    return [...records].sort((a,b)=>a.row.first_seq-b.row.first_seq).map(record=>record.message);
}

function selectHistory(history,currentId,journalHistory){
    if(!journalHistory)return effectiveContextHistory(history);
    const current=history.find(message=>message.id===currentId);
    const selected=effectiveContextHistory(journalHistory.filter(message=>message.id!==currentId));
    const checkpoint=isContextCheckpoint(selected[0])?selected[0]:null;
    const retained=new Set(selected.map(message=>message.id));
    // Preserve the worker's conversation order within the Journal-selected tail.
    const ordered=history.filter(message=>retained.has(message.id)&&message.id!==checkpoint?.id);
    if(checkpoint)ordered.unshift(checkpoint);
    if(current&&!current.isThinking)ordered.push(current);
    return ordered;
}

function requiresDesktopContext(messages){
    const {requiresDesktopPlaceholder}=require('./groupRequest');
    return messages.some(message=>message.desktopReferences?.length)||requiresDesktopPlaceholder(messages);
}

function assertPortableHistory(messages){
    if(requiresDesktopContext(messages))throw Object.assign(Error('DESKTOP_CONTEXT_REQUIRED'),{code:'DESKTOP_CONTEXT_REQUIRED',status:409});
}

function admissionHistory(store,topic,head){
    const history=journalOrder(readJournalHistory(store,topic,head));
    return selectHistory(history,undefined,history);
}

// IO is supplied by the CAS adapter; context selection and Tavern semantics
// remain the author's locally deployed pure rules.
async function effectiveRequest(history,config,currentId,buildContent=async m=>[{type:'text',text:stripHiddenToolResults(m.content)}],journalHistory){
    const rules=config.tavernRules||[],messages=[];
    const selected=selectHistory(history,currentId,journalHistory);
    if(journalHistory)assertPortableHistory(selected);
    const transform=require('../sync/contracts.generated.cjs').sharedContextTransform(selected,config.stripRegexes,currentId);
    for(const message of selected){
        const checkpoint=isContextCheckpoint(message);
        let content=checkpoint?[{type:'text',text:message.content}]:await buildContent({...message,content:stripHiddenToolResults(message.content)});
        if(!checkpoint&&config.authority?.sharedSpaceId)content=content.map((part,i)=>i===0&&part.type==='text'?{...part,text:transform(part.text,message)}:part);
        if(!checkpoint&&message.role==='user'&&message.id===currentId)content=content.map((p,i)=>i===0&&p.type==='text'?{...p,text:tavern.applyUserSuffix(p.text,rules,'agent')}:p);
        messages.push(attachTimestampMetadata({role:message.role,content,...(checkpoint?{__vcpContextCheckpoint:true}:{}),...(message.name?{name:message.name}:{}),...(message.tool_calls?{tool_calls:message.tool_calls}:{}),...(message.tool_call_id?{tool_call_id:message.tool_call_id}:{})},message));
    }
    const base=require('./snapshotPrompt').snapshotPrompt(config);
    const prompt=tavern.applySystemSuffix(base,rules,'agent');
    if(prompt.trim())messages.unshift({role:'system',content:prompt});
    return applyContextRules(messages,rules,tavern);
}
module.exports={effectiveRequest,readJournalHistory,journalOrder,admissionHistory,requiresDesktopContext,assertPortableHistory};

'use strict';
const {effectiveContextHistory,isContextCheckpoint}=require('@vcp/native-history-window');
const {applyContextRules}=require('@vcp/native-history-window/tavern-context');
const {attachTimestampMetadata}=require('../nativeRules/modules/chat/requestMetadata');
const {stripHiddenToolResults}=require('../nativeRules/modules/renderer/toolResultRegions');
const tavern=require('../nativeRules/modules/tavernRulesEngine');

// IO is supplied by the CAS adapter; context selection and Tavern semantics
// remain the author's locally deployed pure rules.
async function effectiveRequest(history,config,currentId,buildContent=async m=>[{type:'text',text:stripHiddenToolResults(m.content)}]){
    const rules=config.tavernRules||[],messages=[],selected=effectiveContextHistory(history);
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
module.exports={effectiveRequest};

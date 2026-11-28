'use strict';

const fail = (code, status = 409) => Object.assign(new Error(code), { code, status });
const fields = ['name','systemPrompt','model','temperature','contextTokenLimit','maxOutputTokens','tavernRules','executionPolicy','streamOutput'];
const groupFields = ['name','members','mode','memberTags','groupPrompt','invitePrompt','useUnifiedModel','unifiedModel','enableContextMessageWindow','contextMessageWindowSize','tagMatchMode','createdAt','modeSettings','sequentialSpeakerOrder'];

// Normalizes native execution inputs. Admission, authority and snapshot
// persistence belong to the workspace that supplied them.
class ExecutionConfiguration {
    constructor(agentManager) { this.agentManager = agentManager; }
    async normalize(topic, input) {
        const { imageModels } = topic;
        if (topic.ownerType === 'group') {
            if (!input || Object.keys(input).some(k=>!['group','agents','tavernRules','executionPolicy'].includes(k))) throw fail('INVALID_GROUP_CONFIG',400);
            const group=input.group;
            const sequential = group?.mode === 'sequential';
            if (!group || Object.keys(group).some(k=>!groupFields.includes(k)) || typeof group.name!=='string' || !['sequential','naturerandom','invite_only','jev','game'].includes(group.mode) || !Array.isArray(group.members) || (!sequential && group.members.length>32) || new Set(group.members).size!==group.members.length || !Array.isArray(input.agents) || input.agents.length!==group.members.length || JSON.stringify(group).length>64000) throw fail('INVALID_GROUP_CONFIG',400);
            if(group.members.some(id=>typeof id!=='string'||!id||id.length>200))throw fail('INVALID_GROUP_CONFIG',400);
            for(const order of [group.modeSettings?.sequential?.speakerOrder,group.sequentialSpeakerOrder])if(order!==undefined&&(!Array.isArray(order)||(!sequential&&order.length>1000)||order.some(id=>typeof id!=='string')))throw fail('INVALID_GROUP_CONFIG',400);
            const agents=await Promise.all(group.members.map(async id=>{
                const value=input.agents.find(a=>a.id===id);
                if(value?.unavailable===true&&Object.keys(value).every(k=>['id','unavailable'].includes(k)))return {id,unavailable:true};
                if (!value) throw fail('GROUP_MEMBER_NOT_AUTHORIZED',403);
                const {id:_,...config}=value;
                return {id,...await this.normalize({ownerType:'agent',imageModels},config)};
            }));
            if (group.memberTags && (typeof group.memberTags!=='object'||Array.isArray(group.memberTags)||Object.entries(group.memberTags).some(([id,tags])=>!group.members.includes(id)||typeof tags!=='string'))) throw fail('INVALID_GROUP_CONFIG',400);
            if (group.useUnifiedModel && (typeof group.unifiedModel!=='string'||!group.unifiedModel.trim())) throw fail('INVALID_GROUP_CONFIG',400);
            if (this.hasAgentReference(group.groupPrompt||'').length || this.hasAgentReference(group.invitePrompt||'').length) throw fail('CONFIG_PROMPT_AUTHORITY_CONFLICT');
            const value={name:group.name,group:JSON.parse(JSON.stringify(group)),agents,imageModels:Array.isArray(imageModels)?imageModels.filter(m=>typeof m==='string'):[],executionPolicy:this.policy(input.executionPolicy),tavernRules:this.rules(input.tavernRules),model:group.useUnifiedModel?group.unifiedModel:agents.find(a=>!a.unavailable)?.model||null,promptPolicy:'desktop'};
            return value;
        }
        if (!input || Object.keys(input).some(k => !fields.includes(k)&&k!=='stripRegexes') || topic.ownerType !== 'agent') throw fail('INVALID_EXECUTION_CONFIG',400);
        if (typeof input.name !== 'string' || !input.name || input.name.length > 200 || typeof input.systemPrompt !== 'string' || input.systemPrompt.length > 128000 || typeof input.model !== 'string' || !input.model.trim() || input.model.length > 200) throw fail('INVALID_EXECUTION_CONFIG',400);
        let prompt=input.systemPrompt.replace(/\{\{AgentName\}\}/g,input.name),promptPolicy='desktop',promptTemplate;
        const references=text=>this.hasAgentReference(text);
        const refs=references(prompt);
        // Resolve a template through its single native Agent alias.
        const agentAlias = refs[0]?.[1];
        if(refs.length){
            if(!agentAlias||!this.agentManager.isAgent(agentAlias))throw fail('CONFIG_PROMPT_SNAPSHOT_UNAVAILABLE');
            if(refs.some(reference=>reference[1]!==agentAlias))throw fail('CONFIG_PROMPT_AUTHORITY_CONFLICT');
            promptTemplate=prompt;
            prompt=await this.agentManager.getAgentPrompt(agentAlias);
            if(typeof prompt!=='string'||!prompt||references(prompt).length||prompt.startsWith('[AgentManager:')||prompt===input.systemPrompt)throw fail('CONFIG_PROMPT_SNAPSHOT_UNAVAILABLE');
            promptPolicy='native-alias-snapshot';
        }
        const value = {name:input.name,systemPrompt:prompt,...(promptTemplate?{promptTemplate}:{}),model:input.model.trim(),executionPolicy:this.policy(input.executionPolicy),streamOutput:input.streamOutput===true||input.streamOutput==='true',promptPolicy,...(agentAlias && {agentAlias}),imageSupported:Array.isArray(imageModels)&&imageModels.includes(input.model),tavernRules:this.rules(input.tavernRules)};
        if(input.stripRegexes!==undefined){
            const validated=require('../Plugin/NativeSync/sync/contracts.generated.cjs').sharedConfig('agent',{name:input.name,systemPrompt:input.systemPrompt,model:input.model,stripRegexes:input.stripRegexes});
            value.stripRegexes=validated.stripRegexes;
        }
        for (const [key,min,max] of [['temperature',0,2],['contextTokenLimit',1,2000000],['maxOutputTokens',1,2000000]]) {
            if (input[key] !== undefined) {
                if (!Number.isFinite(input[key]) || input[key] < min || input[key] > max || (key !== 'temperature' && !Number.isSafeInteger(input[key]))) throw fail('INVALID_EXECUTION_CONFIG',400);
                value[key] = input[key];
            }
        }
        return value;
    }
    policy(value={}) {
        const compactionModels=['contextCompactionModel','contextCompactionFallbackModel'];
        const keys=['userName','enableThoughtChainInjection','enableContextSanitizer','contextSanitizerDepth','enableVcpToolInjection','enableContextCompaction',...compactionModels];
        if(!value||Object.keys(value).some(k=>!keys.includes(k))||value.userName!==undefined&&(typeof value.userName!=='string'||value.userName.length>200))throw fail('INVALID_EXECUTION_POLICY',400);
        for(const key of ['enableThoughtChainInjection','enableContextSanitizer','enableVcpToolInjection','enableContextCompaction'])if(value[key]!==undefined&&typeof value[key]!=='boolean')throw fail('INVALID_EXECUTION_POLICY',400);
        for (const key of compactionModels) if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 200)) throw fail('INVALID_EXECUTION_POLICY',400);
        const depth=value.contextSanitizerDepth??2;if(!Number.isSafeInteger(depth)||depth<0||depth>10000)throw fail('INVALID_EXECUTION_POLICY',400);
        return {userName:value.userName||'用户',enableThoughtChainInjection:value.enableThoughtChainInjection===true,enableContextSanitizer:value.enableContextSanitizer===true,contextSanitizerDepth:depth,enableVcpToolInjection:value.enableVcpToolInjection===true,
            ...(typeof value.enableContextCompaction==='boolean' && {enableContextCompaction:value.enableContextCompaction}),
            ...Object.fromEntries(compactionModels.filter(key=>value[key]).map(key=>[key,value[key].trim()]))};
    }
    rules(value=[]) {
        const keys=['id','name','type','enabled','content','scope','builtinKey','isBuiltin','role','depth','wrap','order','source'];
        if(!Array.isArray(value)||value.length>200||JSON.stringify(value).length>128000||value.some(r=>!r||typeof r!=='object'||Object.keys(r).some(k=>!keys.includes(k))||!['system_suffix','user_suffix','context_inject'].includes(r.type)||typeof r.content!=='string'||(r.type==='context_inject'&&(!['user','assistant'].includes(r.role)||!Number.isSafeInteger(r.depth)||r.depth<0||r.depth>10000))))throw fail('INVALID_TAVERN_RULES',400);
        if(value.some(r=>this.hasAgentReference(r.content).length))throw fail('CONFIG_PROMPT_AUTHORITY_CONFLICT');
        return JSON.parse(JSON.stringify(value));
    }
    hasAgentReference(text) { return [...text.matchAll(/\{\{(?:agent:)?([^{}]+)\}\}/g)].filter(m=>m[0].startsWith('{{agent:')||this.agentManager.isAgent(m[1])); }
}

module.exports = { ExecutionConfiguration };

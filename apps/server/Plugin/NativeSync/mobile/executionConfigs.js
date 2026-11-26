'use strict';
const { stable, sha256 } = require('../sync/protocol');
const fail = (code, status = 409) => Object.assign(new Error(code), { code, status });
const { ExecutionConfiguration, assertSourcePortable } = require('../../../core/executionConfiguration');

// Private immutable execution inputs, not another Agent registry. Identity and
// alias authority remain the explicit host topic scope and native AgentManager.
class ExecutionConfigs extends ExecutionConfiguration {
    constructor(db, topics, agentManager, required = false, sourceCatalog = null) {
        super(agentManager);
        this.db = db; this.topics = topics; this.required = required; this.sourceCatalog=sourceCatalog;
        db.exec(`CREATE TABLE IF NOT EXISTS owner_execution_configs(
            topic_key TEXT NOT NULL, version INTEGER NOT NULL, hash TEXT NOT NULL,
            config_json TEXT NOT NULL, created_at INTEGER NOT NULL,
            PRIMARY KEY(topic_key,version));`);
    }
    latest(key) { return this.db.prepare('SELECT * FROM owner_execution_configs WHERE topic_key=? ORDER BY version DESC LIMIT 1').get(key); }
    issue(key){return this.sourceCatalog?JSON.parse(this.db.prepare('SELECT value FROM native_sync_metadata WHERE key=?').get('sourceExecutionIssue:'+key)?.value||'null'):null;}
    public(key) {
        const issue=this.issue(key),r=this.latest(key);if(issue)return {configVersion:r?.version??null,configHash:r?.hash??null,configError:issue.code};if(!r)return {configVersion:null,configHash:null};
        try{const c=JSON.parse(r.config_json);return {configVersion:r.version,configHash:r.hash,model:c.model,...(c.group?{groupMode:c.group.mode,members:c.agents.map(a=>({id:a.id,name:a.name||a.id,model:a.model||null,unavailable:a.unavailable===true}))}:{})};}
        catch{return {configVersion:null,configHash:null,configError:'CONFIG_SNAPSHOT_CORRUPT'};}
    }
    authority(topic) {
        if(topic?.sharedSpaceId){
            const shared=this.sourceCatalog?.store.shared,row=shared?.row(topic.sharedSpaceId,topic.key);
            if(!row||row.owner_type!==topic.ownerType||row.owner_id!==topic.ownerId||row.topic_id!==topic.topicId)throw fail('SHARED_OBJECT_NOT_FOUND',403);
            const grant=this.sourceCatalog.grants.get(row.origin_source);
            return {sharedSpaceId:topic.sharedSpaceId,sharedId:row.id,sourceId:row.origin_source,deviceId:grant?.deviceId||null,spaceId:this.sourceCatalog.spaceId,ownerType:topic.ownerType,ownerId:topic.ownerId,topicId:topic.topicId};
        }
        const catalog=this.sourceCatalog,grant=catalog?.grants.get(topic?.sourceId);
        if(grant?.executionMode!=='all-supported')return null;
        const row=catalog.activeTopic(topic.sourceId,topic);
        if(!row)throw fail('SOURCE_TOPIC_NOT_APPROVED',403);
        return {sourceId:topic.sourceId,deviceId:grant.deviceId,spaceId:catalog.spaceId,ownerType:topic.ownerType,ownerId:topic.ownerId,topicId:topic.topicId};
    }
    memberAuthority(topic,id) {
        const authority=this.authority(topic);if(!authority)return null;
        if(authority.sharedSpaceId){const row=this.sourceCatalog.store.shared.row(authority.sharedSpaceId,id);if(row.kind!=='agent')throw fail('GROUP_MEMBER_NOT_AUTHORIZED',403);return {...authority,memberId:id};}
        const owner=this.sourceCatalog.entity(topic.sourceId,'agent',id,'');
        if(!owner||owner.deleted)throw fail('GROUP_MEMBER_NOT_AUTHORIZED',403);
        return {...authority,memberId:id};
    }
    assertRunnable(topic,snapshot) {
        if(snapshot?.authority){this.verify(topic,snapshot);return;}
        if(!topic?.agentAlias||!this.agentManager.isAgent(topic.agentAlias)||!(snapshot?.model||topic.model))throw fail('AGENT_NOT_EXECUTABLE');
    }
    imageModelsFor(topic, authority) {
        return authority ? this.sourceCatalog.grants.get(authority.sourceId)?.imageModels || [] : topic.imageModels;
    }
    async publish(body) {
        if (!body || Object.keys(body).some(k=>k!=='topics') || !Array.isArray(body.topics) || body.topics.length > this.topics.length) throw fail('INVALID_EXECUTION_CONFIG',400);
        const rows = await Promise.all(body.topics.map(async row => {
            if (!row || Object.keys(row).some(k=>!['ownerType','ownerId','topicId','expectedVersion','config'].includes(k)) || !Number.isSafeInteger(row.expectedVersion) || row.expectedVersion < 0) throw fail('INVALID_EXECUTION_CONFIG',400);
            const topic = this.topics.find(t=>t.ownerType===row.ownerType && t.ownerId===row.ownerId && t.topicId===row.topicId);
            if (!topic) throw fail('TOPIC_NOT_ALLOWED',403);
            this.sourceCatalog?.store?.shared?.legacyGuard(topic);
            let config;try{config=await this.normalize(topic,row.config);}catch(e){if(this.authority(topic))this.db.prepare('INSERT INTO native_sync_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('sourceExecutionIssue:'+topic.key,JSON.stringify({code:e.code||'INVALID_EXECUTION_CONFIG'}));throw e;}
            return {topic,row,config,hash:sha256(stable(config))};
        }));
        if (new Set(rows.map(r=>r.topic.key)).size !== rows.length) throw fail('DUPLICATE_CONFIG_TOPIC',400);
        this.db.exec('BEGIN IMMEDIATE');
        try {
            for (const {topic,row,config,hash} of rows) {
                const latest = this.latest(topic.key);
                if(this.sourceCatalog)this.db.prepare('DELETE FROM native_sync_metadata WHERE key=?').run('sourceExecutionIssue:'+topic.key);
                if (latest?.hash === hash) continue;
                if ((latest?.version || 0) !== row.expectedVersion) throw fail('CONFIG_VERSION_CONFLICT');
                // Reverting to an older payload still creates a newer version.
                this.db.prepare('INSERT INTO owner_execution_configs(topic_key,version,hash,config_json,created_at) VALUES(?,?,?,?,?)').run(topic.key,(latest?.version||0)+1,hash,JSON.stringify(config),Date.now());
            }
            this.db.exec('COMMIT');
        } catch(e) { this.db.exec('ROLLBACK'); throw e; }
        return {topics:rows.map(r=>({key:r.topic.key,...this.public(r.topic.key)}))};
    }
    snapshot(topic) {
        const issue=this.issue(topic.key);if(issue)throw fail(issue.code);
        const row = this.latest(topic.key);
        if (!row) { if (this.required) throw fail('EXECUTION_CONFIG_REQUIRED'); return null; }
        const config = JSON.parse(row.config_json);
        if(topic.sharedSpaceId&&config.sharedTemplateHash!==this.sourceCatalog.store.shared.freeze(this.sourceCatalog.store.shared.row(topic.sharedSpaceId,topic.key)).hash)throw fail('SHARED_CONFIG_PENDING');
        if(config.authority){this.verify(topic,{version:row.version,hash:row.hash,...config});}
        else if (topic.ownerType==='group') {
            if(config.agents.some(a=>!a.unavailable&&(topic.memberAliases?.[a.id]!==a.agentAlias||!this.agentManager.isAgent(a.agentAlias))))throw fail('EXECUTION_CONFIG_IDENTITY_MISMATCH');
        } else if (config.agentAlias !== topic.agentAlias || !this.agentManager.isAgent(config.agentAlias)) throw fail('EXECUTION_CONFIG_IDENTITY_MISMATCH');
        return this.verify(topic,{version:row.version,hash:row.hash,...config});
    }
    verify(topic,snapshot,{desktopContext=false}={}){
        const {version,hash,...config}=snapshot;
        const row=this.db.prepare('SELECT hash FROM owner_execution_configs WHERE topic_key=? AND version=?').get(topic.key,version);
        if(!row||row.hash!==hash||sha256(stable(config))!==hash)throw fail('CONFIG_SNAPSHOT_CORRUPT');
        if(config.authority){
            const expected=this.authority(topic);
            if(!expected||stable(expected)!==stable(config.authority))throw fail('EXECUTION_CONFIG_IDENTITY_MISMATCH');
            if(!(expected.sharedSpaceId&&desktopContext))assertSourcePortable(config);
            for(const member of config.agents||[])if(!member.unavailable&&stable(member.authority)!==stable(this.memberAuthority(topic,member.id)))throw fail('EXECUTION_CONFIG_IDENTITY_MISMATCH');
        }
        return snapshot;
    }
}
module.exports = { ExecutionConfigs };

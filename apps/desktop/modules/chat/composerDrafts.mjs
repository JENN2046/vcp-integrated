/** Local composer state is private to this Electron profile, never a send queue. */
export const composerDraftKey = scope => scope?.itemId && scope?.topicId
    ? 'vcp.composer.v2:' + encodeURIComponent(JSON.stringify([scope.spaceId || 'local', scope.itemType || 'agent', scope.itemId, scope.topicId, scope.surface || 'main'])) : null;

const stablePath=value=>typeof value==='string'&&value.length<=8192&&!/^(?:data|blob):/i.test(value)&&!value.includes('\0')?value:null;
export function attachmentReferences(files = []) {
    return files.map(value => {
        const data = value._fileManagerData || {}, file = value.file || {},src=stablePath(value.localPath||value.src||data.internalPath);
        const native={};for(const key of ['id','name','type','size','isLiveReference','liveSource'])if(['string','number','boolean'].includes(typeof data[key]))native[key]=data[key];
        for(const key of ['internalPath','sourcePath'])if(stablePath(data[key]))native[key]=data[key];
        if(typeof data.hash==='string'&&/^[a-f0-9]{64}$/.test(data.hash))native.hash=data.hash;
        return {name:value.originalName||value.name||file.name||data.name||'',type:file.type||value.type||data.type||'application/octet-stream',size:Number(file.size??value.size??data.size??0),src,
            hash:value.hash||native.hash||null,availability:src?'unverified':'missing_reference',_fileManagerData:native};
    });
}

export function createComposerDraftStore(getStorage) {
    const access = (scope, action) => {
        try { const key = composerDraftKey(scope); if (!key) throw Error('COMPOSER_SCOPE_REQUIRED'); return action(getStorage(), key); }
        catch (error) { return { ok: false, error }; }
    };
    return Object.freeze({
        read(scope) { return access(scope, (storage, key) => {
            const raw = storage.getItem(key); if (raw === null) return { ok: true, draft: null };
            const data = JSON.parse(raw); if (data.version !== 2 || typeof data.text !== 'string' || !Array.isArray(data.attachments)) throw Error('COMPOSER_DRAFT_INVALID');
            return { ok: true, draft: data };
        }); },
        save(scope, draft) { return access(scope, (storage, key) => {
            const value={ version: 2, text: typeof draft.text === 'string' ? draft.text : '', attachments: attachmentReferences(draft.attachments), model: draft.model || null, editId:draft.editId||null,inputId:draft.inputId||null };
            const raw=storage.getItem(key),prior=raw?JSON.parse(raw):null;
            if(prior){if(prior.version!==2||typeof prior.text!=='string'||!Array.isArray(prior.attachments))throw Error('COMPOSER_DRAFT_INVALID');}
            const comparable=v=>JSON.stringify({...v,revision:undefined});
            value.revision=prior&&comparable(prior)===comparable(value)?prior.revision||0:(prior?.revision||0)+1;
            storage.setItem(key, JSON.stringify(value));
            return { ok: true,revision:value.revision };
        }); },
    });
}

export function createComposerDraftController({ input, getAttachments, setAttachments, getScope, getStorage, onRestored = () => {}, onError = () => {}, ownerWindow = globalThis.window }) {
    const store = createComposerDraftStore(getStorage);
    let scope = getScope(), timer, disposed = false, transientEdited = false, blocked = null, editId=null,inputId=null;
    const snapshot = () => ({ text: input.value, attachments: getAttachments(),editId,inputId });
    const save = () => { clearTimeout(timer); if(blocked)return {ok:!input.value&&!getAttachments().length,error:blocked};if (scope) { const prior=store.read(scope);if(!prior.ok){onError(prior.error);return prior;}if(inputId&&prior.draft&&(prior.draft.text!==input.value||(prior.draft.editId||null)!==editId||JSON.stringify(prior.draft.attachments)!==JSON.stringify(attachmentReferences(getAttachments()))))inputId=null;const result = store.save(scope, snapshot()); if (!result.ok) onError(result.error); return result; } return { ok: true }; };
    const edited = () => {inputId=null; editId=Date.now().toString(36)+Math.random().toString(36).slice(2); if(!scope)transientEdited=true;clearTimeout(timer); timer = setTimeout(save, 400); };
    input.addEventListener('input', edited);
    const select = () => {
        if(disposed)return false;
        const next = getScope();
        if (!blocked && composerDraftKey(next) === composerDraftKey(scope)) return true;
        // A failed target read never acquires ownership of the old topic input.
        if(blocked){if(input.value||getAttachments().length)return false;}
        else if (!save().ok) return false;
        const result = next ? store.read(next) : {ok:true,draft:null};
        if(!result.ok){blocked=result.error;input.value='';setAttachments([]);onRestored();onError(result.error);return false;}
        blocked=null;
        const wasUnscoped=!scope;scope=next;
        if(!scope){input.value='';setAttachments([]);onRestored();return true;}
        if(wasUnscoped&&transientEdited){transientEdited=false;save();return true;}
        const draft=result.draft||{text:'',attachments:[]};input.value=draft.text;editId=draft.editId||null;inputId=draft.inputId||null;
        setAttachments(draft.attachments.map(ref=>({...ref,localPath:ref.src,originalName:ref.name,file:{name:ref.name,type:ref.type,size:ref.size}})));
        onRestored();return true;
    };
    const unload = event => {if(!save().ok){event?.preventDefault?.();if(event)event.returnValue=false;return false;}}; ownerWindow?.addEventListener('beforeunload', unload);
    if (scope && !input.value && !getAttachments().length) { const result = store.read(scope);if(!result.ok){blocked=result.error;onError(result.error);}if (result.ok && result.draft) { input.value = result.draft.text;editId=result.draft.editId||null;inputId=result.draft.inputId||null; setAttachments(result.draft.attachments.map(ref => ({ ...ref, localPath: ref.src, originalName: ref.name, file: { name: ref.name, type: ref.type, size: ref.size } }))); onRestored(); } }
    return Object.freeze({ flush: save, capture(){let result=save();if(result.ok&&scope&&!inputId){inputId='msg_'+Date.now()+'_user_'+Math.random().toString(36).slice(2,12);result=save();}return result.ok?{ok:true,scope:scope?{...scope}:null,revision:result.revision,inputId}:result;}, select, suspend(){if(!save().ok)return false;scope=null;inputId=null;transientEdited=false;input.value='';setAttachments([]);onRestored();return true;}, consumed(token) {
        if(disposed)return {ok:false};if(!token)return save();if(!token.scope)return {ok:true};
        if(composerDraftKey(scope)===composerDraftKey(token.scope)){const live=save();if(!live.ok)return live;}const prior=store.read(token.scope);if(!prior.ok)return prior;
        if(prior.draft?.revision!==token.revision)return {ok:true,consumed:false};
        // Consume the captured slot even after navigation; never replace a later edit.
        const current=composerDraftKey(scope)===composerDraftKey(token.scope);
        const matches=current&&input.value===prior.draft.text&&editId===(prior.draft.editId||null)&&JSON.stringify(attachmentReferences(getAttachments()))===JSON.stringify(prior.draft.attachments);
        const result=store.save(token.scope,{text:'',attachments:[],editId:null,inputId:null});
        if(result.ok&&matches){input.value='';setAttachments([]);editId=null;inputId=null;onRestored();}
        return result;
    }, dispose() { if (disposed) return; save(); disposed = true; input.removeEventListener('input', edited); ownerWindow?.removeEventListener('beforeunload', unload); clearTimeout(timer); } });
}

import {prepareNativeDeletion, nativeDeletionOptions, nativeDeletionText} from '../../chat/nativeDirectoryActions.mjs';

export function createTopicManagement(api) {
    const shared = config => Boolean(config?.__nativeSyncSharedBase);
    let control;
    function clearControl() {
        if (!control) return;
        control.button.remove();
        if (control.panel) control.panel.style.flexWrap=control.wrap;
        control.parent.style.marginInlineStart=control.margin;
        control = null;
    }

    async function removal({owner, topics, batch, total}, localOnly = false) {
        const mode = localOnly ? 'device' : 'all';
        if (localOnly && topics.length >= total) throw Error('至少需要保留一个话题。');
        const contexts = new Map();
        for (const topic of topics) {
            const ctx = await prepareNativeDeletion(api, {itemType:owner.type, itemId:owner.id, topicId:topic.id});
            if (localOnly && ctx.kind !== 'shared') throw Error('仅能从本机移除共享话题，请调整选择。');
            if (ctx.pendingMode && ctx.pendingMode !== mode) throw Error('所选话题有其他范围的操作待核对。');
            contexts.set(topic.id,ctx);
        }
        if (![...contexts.values()].some(ctx=>ctx.kind==='shared')) throw Error('共享绑定已变化，请刷新后重试。');
        const names = topics.map(t=>t.name).join('、');
        const text = batch
            ? localOnly ? `仅将选中的 ${topics.length} 个话题从本机移除？其他设备仍可查看，共享历史和执行记录保留。\n${names}`
                        : `删除选中的 ${topics.length} 个话题？其中共享话题会同步到所有设备；原账本和执行回执保留。`
            : nativeDeletionText(contexts.get(topics[0].id),'',names,mode);
        return {
            dialog:[text, batch ? localOnly ? '批量移出本机' : '批量删除话题' : localOnly ? '移出本机' : '删除话题',
                localOnly ? batch ? '仅移出本机' : '移除' : '删除', '取消', !localOnly || !batch],
            remove(topic) {
                const options=nativeDeletionOptions(contexts.get(topic.id),mode);
                return owner.type==='group' ? api.deleteGroupTopic(owner.id,topic.id,options) : api.deleteTopic(owner.id,topic.id,options);
            },
            success:count=>localOnly ? `已从本机移除 ${count} 个话题。` : `已删除 ${count} 个话题。`,
            failed:localOnly ? '以下话题尚未确认移除：' : '以下话题尚未确认删除：'
        };
    }
    const device = input => removal(input,true);
    return {
        formatTitle(title, topic) { return topic.nativeSyncOriginSource ? title+' · 原来源 '+topic.nativeSyncOriginSource : title; },
        forOwner(config) {
            if (!shared(config)) return;
            return {
                removal,
                async rename(scope) {
                    const ctx=await prepareNativeDeletion(api,scope);
                    if (ctx.kind !== 'shared') throw Error('共享绑定已变化，请刷新后重试。');
                    if (ctx.pendingMode) throw Error('目录操作正在核对，请稍后再编辑标题。');
                    return nativeDeletionOptions(ctx);
                },
                extendMenu(menu, run) {
                    const item=menu.ownerDocument.createElement('div');
                    item.className='context-menu-item'; item.textContent='仅从本机移除';
                    item.onclick=()=>run(device); menu.append(item);
                }
            };
        },
        updateControls({config, anchor, disabled, run}) {
            if (!anchor || !shared(config)) { clearControl();return; }
            if (control?.anchor!==anchor) {
                clearControl();
                const button=anchor.ownerDocument.createElement('button'),panel=anchor.closest('.next-ui-topic-manage-panel');
                button.type='button';button.id='nextUiRemoveLocalTopicsBtn';button.className='next-ui-topic-manage-button';
                button.textContent='仅移出本机';button.title='仅从本机移除所选共享话题';
                button.style.cssText='width:auto;white-space:nowrap;padding-inline:0.4em';
                const parent=anchor.parentElement;
                control={anchor,button,panel,parent,wrap:panel?.style.flexWrap,margin:parent.style.marginInlineStart};
                if (panel) panel.style.flexWrap='wrap';
                parent.style.marginInlineStart='auto';anchor.before(button);
            }
            control.button.disabled=disabled;
            control.button.onclick=()=>run(device);
        },
        dispose:clearControl
    };
}

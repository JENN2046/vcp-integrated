// Status refers to the running client. The saved startup preference can differ until restart.
export function connectionStatus(view, explain) {
    const c = view.current;
    const issue = c.transportError || c.degraded || c.configurationError;
    const offline = [c.transportError, c.degraded, c.configurationError].includes('NETWORK_UNAVAILABLE');
    const problem = (title, detail, action = 'diagnostics') => ({ title, detail, tone: 'attention', action });
    if (view.error) return problem('连接状态待核对', explain(view.error));
    if (offline) return problem('连接暂时中断', '这台电脑暂时连不上' + (view.sharedSpaceId || '服务器') + '。', 'check');
    if ([c.transportError, c.degraded, c.configurationError].includes('AUTH_FAILED')) return problem('连接验证失败', explain('AUTH_FAILED'), 'check');
    if (!c.active) {
        if (view.restartRequired && view.enabled) return problem('等待重启后连接', '启动设置已保存，重新打开 VCPChat 后生效。');
        if (!view.enabled && view.configured) return {
            title: '这台电脑已停用同步', detail: view.bindingLocked ? '原绑定保留，受保护的话题可能无法发送或新建。' : '可以在启动设置中恢复连接。',
            tone: 'muted'
        };
        if (!view.configured && !view.bindingLocked && !issue) return { title: '这台电脑尚未接入', detail: '', tone: 'muted' };
        return problem(c.readOnly ? '本机处于只读保护' : '同步尚未就绪', issue ? explain(issue) : '请检查连接详情。');
    }
    if (view.sharedMode && (!c.shared?.ready || c.shared.spaceId !== view.sharedSpaceId)) {
        return problem('正在核对共享连接', issue ? explain(issue) : '共享空间尚未就绪。');
    }
    const title = view.sharedMode ? '这台电脑已连接' : '这台电脑已启动同步';
    if (c.readOnly) return problem(title + ' · 只读', '当前只能查看已同步的内容。');
    const count = c.shared?.configurationConflicts || 0;
    if (count) return problem(title, `${count} 项配置需要你确认。`, 'conflicts');
    if (c.conflicts) return problem(title, `${c.conflicts} 项同步冲突需要核对。`, 'history');
    if (c.shared?.executionBlockingDrafts) return problem(title, '有本机配置草稿需要确认。', 'drafts');
    if (issue || c.attachmentError || view.connectionError) return problem(title, explain(issue || c.attachmentError || view.connectionError));
    if (c.missingDownloads) return problem(title, `${c.missingDownloads} 项附件等待重试。`);
    if (c.source?.directoryErrors || c.source?.configurationErrors) return problem(title, '来源目录或配置需要核对。');
    const work = [];
    if (c.buffered) work.push(`已收到 ${c.buffered} 项更新，正在写入本机`);
    if (c.pendingOperations) work.push(`${c.pendingOperations} 项本地更改待上传`);
    if (c.source?.pendingImports) work.push(`${c.source.pendingImports} 项历史待接入`);
    if (c.source?.configurationPending) work.push(`${c.source.configurationPending} 项配置待就绪`);
    const known = [c.buffered, c.pendingOperations, c.conflicts].every(Number.isSafeInteger);
    return { title, detail: work.length ? work.join('。') + '。' : known ? '没有待同步内容，也没有冲突。' : '同步进度待核对。', tone: 'connected' };
}

export function renderDirectory(list, entries, search) {
    const doc = list.ownerDocument;
    const query = search.trim().toLocaleLowerCase();
    const matches = name => name.toLocaleLowerCase().includes(query);
    const byName = (a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id);
    const children = new Map();
    for (const item of entries) {
        if (item.kind !== 'topic') continue;
        if (!children.has(item.parentId)) children.set(item.parentId, []);
        children.get(item.parentId).push(item);
    }
    const fragment = doc.createDocumentFragment();
    for (const owner of entries.filter(item => item.kind !== 'topic').sort(byName)) {
        const topics = children.get(owner.id) || [];
        const visible = (matches(owner.name) ? topics : topics.filter(t => matches(t.name))).slice().sort(byName);
        if (!matches(owner.name) && !visible.length) continue;
        const group = doc.createElement(topics.length ? 'details' : 'div');
        group.className = 'ns-directory-group';
        const header = doc.createElement(topics.length ? 'summary' : 'div');
        const name = doc.createElement('strong');
        name.textContent = owner.name;
        const meta = doc.createElement('small');
        meta.textContent = [{agent:'Agent', group:'群聊', rules:'规则'}[owner.kind], topics.length ? `${topics.length} 个话题` : ''].filter(Boolean).join(' · ');
        header.append(name, meta);
        group.append(header);
        if (topics.length) {
            group.open = Boolean(query);
            const items = doc.createElement('ul');
            for (const t of visible) {
                const li = doc.createElement('li');
                li.textContent = t.name;
                items.append(li);
            }
            group.append(items);
        }
        fragment.append(group);
    }
    if (!fragment.childNodes.length) {
        const msg = doc.createElement('p');
        msg.textContent = query ? '没有匹配的条目。' : '目录为空。';
        fragment.append(msg);
    }
    list.replaceChildren(fragment);
}

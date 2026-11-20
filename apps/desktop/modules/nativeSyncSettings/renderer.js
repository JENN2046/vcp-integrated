import { connectionStatus, renderDirectory } from './connectionPage.js';
import {mountSharedMatching} from './sharedMatching.js';
import {mountSharedDirectory} from './sharedDirectory.js';
import { mountSharedEditor } from './sharedEditor.js';
import { sharedConfig } from './contracts.generated.js';
import { registerSettingsSection, requestSettingsSection } from '../settings/extensions.js';
import { section, custom } from '../settings/schema/kernel.js';

const messages = {
    SHARED_LAST_LOCAL_TOPIC:'本机至少需要保留一个话题。',
    SHARED_NATIVE_BINDING_CHANGED:'共享绑定已变化，请刷新后再确认删除。',
    SHARED_PARENT_NOT_LOCAL:'请先恢复所属 Agent 或群聊。',
    SHARED_TOPIC_BUSY:'话题仍有在途请求，请先完成或核对后再操作。',
    SHARED_CONFIG_EDITOR_REQUIRED:'请在 NativeSync 的共享配置中修改此项。',
    SHARED_CONFIG_BASE_REQUIRED:'编辑版本已失效，请打开共享配置核对原草稿。',
    SHARED_LOCAL_REMOVED:'此副本已从本机移除，请先在共享目录恢复。',
    SOURCE_EXECUTION_NOT_APPROVED: '服务器尚未批准此来源的全量同步和自动续聊，请核对预配置的来源与设备身份。',
    FULL_SOURCE_BINDING_REQUIRED: '请填写服务器预配置的 Source ID，并核对下方设备标识。',
    SOURCE_SCOPE_NOT_SETTLED: '原同步仍有待处理工作，请先完成同步或核对冲突，再转换为全量。',
    SOURCE_BINDING_CHANGED: '来源或空间身份不一致，原状态已保留。',
    SOURCE_SCOPE_MISMATCH: '服务器范围与当前绑定不一致，请先核对原范围和待重启配置。',
    SYNC_CONNECTION_REQUIRED: '同步已停用，原绑定与待同步数据保留。',
    APPROVED_HISTORY_SNAPSHOT_REQUIRED: '首次历史尚未确认，请检查并保存接入配置。',
    SYNC_HTTPS_REQUIRED: '请先在「服务器连接」中保存 HTTPS 地址。',
    EXISTING_DESKTOP_KEY_REQUIRED: '请先在「服务器连接」中保存访问 Key。',
    DESKTOP_BACKEND_IDENTITY_MISMATCH: '当前服务器连接与原同步绑定不一致，请恢复原连接后再操作。',
    SETUP_CONNECTION_CHANGED: '服务器连接已改变，请重新检查。',
    SETUP_CONFIG_CHANGED: '配置已被其他操作更新，请刷新后重新确认。',
    APPROVED_HISTORY_CHANGED: '所选历史在检查后发生了变化，请重新检查并确认。',
    SETUP_CONFIRMATION_REQUIRED: '请先检查连接与历史，并勾选确认。',
    SETUP_SERVER_TOPIC_REQUIRED: '服务端尚未配置这个话题的手机接续入口，请先完成服务端绑定。',
    SETUP_SCOPE_CHANGE_REQUIRED: '已有绑定的范围需要通过受控范围变更处理，不能在这里直接改写。',
    SETUP_SOURCE_READ_ONLY: '此环境由 Source 范围管理，本面板只显示状态。',
    SETUP_TOPIC_UNAVAILABLE: '所选话题已不存在，请刷新列表。',
    OWNER_PATH_ALIAS: '所选目录或文件存在路径别名，请先核对本机数据位置。',
    OWNER_PATH_CONFLICT: '所选话题映射到同一历史文件，请核对原生话题身份。',
    SETUP_BINDING_MISMATCH: '保存的配置与原同步身份不一致，已保留原数据并停止修改。',
    SETUP_RECOVERY_REQUIRED: '现有同步处于恢复保护，不能作为全新接入处理；原绑定与数据会保留。',
    INVALID_SYNC_STATE: '同步状态需要核对；本面板不会重置数据或游标。',
    NETWORK_UNAVAILABLE: '服务器暂不可达，请检查连接后重试。',
    AUTH_FAILED: '服务器认证失败，请核对「服务器连接」中的 Key。',
    INITIAL_IMPORT_CONTENT_CONFLICT: '本机与服务器的同一消息内容不一致，已停止接入。',
    INITIAL_IMPORT_REMOTE_TOMBSTONE: '所选本机消息在服务器已有删除记录，已停止接入。',
    SETUP_DURABILITY_UNCONFIRMED: '配置内容已经写入，但持久确认未完成。请刷新核对，暂勿退出。',
    SETUP_SAVE_UNCONFIRMED: '保存结果未能确认，请刷新核对，暂勿退出。',
    ENOENT: '未找到已保存历史，请先在桌面打开并保存所选话题。',
    SHARED_SOURCE_NOT_SETTLED:'当前来源仍有待处理工作，请完成后再检查共享接入。',
    SHARED_SOURCE_STATE_REQUIRED:'请先完成当前 Source 的全量历史接入，再加入共享空间。',
    SHARED_SPACE_NOT_APPROVED:'服务器尚未批准这台设备加入该共享空间。',
    SHARED_BINDING_LOCKED:'已加入的共享空间不能在此直接切换，原绑定保持。',
    SHARED_EXECUTION_NOT_READY:'共享同步与读取已接入，发送功能尚未就绪。',
    SHARED_CONFIG_CONFLICT:'共享配置有冲突，本地修改和服务器版本均已保留。',
};
const key = d => JSON.stringify([d.itemType || 'agent', d.itemId, d.topicId]);
const explain = code => messages[code] || `暂未完成，请核对后重试。（${code || 'SETUP_UNAVAILABLE'}）`;

function buildPanel(doc) {
    const panel = doc.createElement('div');
    panel.id = 'nativeSyncSetupPanel';
    panel.className = 'ns-setup';
    const api = doc.defaultView?.chatAPI || doc.defaultView?.electronAPI;
    const el = (tag, text, className) => {
        const node = doc.createElement(tag);
        if (text) node.textContent = text;
        if (className) node.className = className;
        return node;
    };
    const button = (id, label) => {
        const b = el('button', label, 'sidebar-button small-button');
        b.type = 'button'; if (id) b.id = id; return b;
    };
    const intro = el('p', '把电脑上的已保存话题接续到手机。接入会按确认范围同步历史和手机续聊所需的助手设定（包括提示词）；遇到历史冲突会停止，不自动覆盖。访问 Key 沿用现有服务器设置。');
    const server = el('p'); server.id = 'nativeSyncServer';
    const connection = button('nativeSyncOpenConnection', '打开服务器连接设置');
    connection.onclick = () => requestSettingsSection('server-connection');
    const status = el('p'); status.id = 'nativeSyncCurrent'; status.setAttribute('role', 'status');
    const counts = el('p'); counts.id = 'nativeSyncCounts';
    const desired = el('label', '', 'ns-setup-switch');
    const enabled = el('input'); enabled.type = 'checkbox'; enabled.id = 'nativeSyncEnabled';
    desired.append(enabled, el('span', '下次启动启用同步'));
    const binding = el('p'); binding.id = 'nativeSyncBinding';
    const mode=el('select');mode.id='nativeSyncScopeMode';mode.setAttribute('aria-label','同步范围');for(const [value,label] of [['selected','选定话题'],['source','全部 Agent／群聊'],['shared','多端共享空间'],['managed','Source 管理（只读）']]){const option=el('option',label);option.value=value;mode.append(option);}
    const sourceFields=el('div');sourceFields.id='nativeSyncSourceFields';sourceFields.hidden=true;
    const sourceId=el('input');sourceId.id='nativeSyncSourceId';sourceId.placeholder='服务器预配置的 Source ID';sourceId.setAttribute('aria-label',sourceId.placeholder);
    const deviceId=el('p');deviceId.id='nativeSyncDeviceId';sourceFields.append(sourceId,deviceId);
    const sharedFields=el('div');sharedFields.id='nativeSyncSharedFields';sharedFields.hidden=true;
    const sharedSpaceId=el('input');sharedSpaceId.id='nativeSyncSharedSpaceId';sharedSpaceId.placeholder='服务器已批准的共享空间';sharedSpaceId.setAttribute('aria-label',sharedSpaceId.placeholder);sharedFields.append(sharedSpaceId,el('p','加入后同步整个空间及未来新增内容。已有不同会话先分别保留，历史归并需另行确认。'));
    const search = el('input'); search.type = 'search'; search.placeholder = '搜索助手、群聊或话题'; search.setAttribute('aria-label', search.placeholder); search.id = 'nativeSyncSearch';
    const selection = el('p'); selection.id = 'nativeSyncSelectionCount'; selection.setAttribute('aria-live', 'polite');
    const list = el('div', '', 'ns-setup-topics'); list.id = 'nativeSyncTopics'; list.setAttribute('aria-label', '可同步的话题');
    const review = el('section', '', 'ns-setup-review'); review.id = 'nativeSyncReview'; review.hidden = true;
    const reviewText = el('p');
    const confirmation = el('label', '', 'ns-setup-switch');
    const confirmed = el('input'); confirmed.type = 'checkbox'; confirmed.id = 'nativeSyncConfirmed';
    const confirmationText = el('span'); confirmation.append(confirmed, confirmationText); review.append(reviewText, confirmation);
    const actions = el('div', '', 'ns-setup-actions');
    const refresh = button('nativeSyncRefresh', '刷新状态');
    const preview = button('nativeSyncPreview', '检查连接与历史');
    const save = button('nativeSyncSave', '保存，重启后生效');
    const retryAttachments = button('nativeSyncRetryMissingAttachments', '重试缺失附件');
    retryAttachments.hidden = true;
    actions.append(refresh, retryAttachments, preview, save);
    const notice = el('p'); notice.id = 'nativeSyncNotice'; notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
    const quit = button('nativeSyncQuit', '退出 VCPChat'); quit.hidden = true;
    const makePage = id => {
        const page = el('section', '', 'ns-page');
        page.id = id;
        page.hidden = true;
        return page;
    };
    const home = makePage('nativeSyncHome'), form = makePage('nativeSyncForm');
    const diagnostics = makePage('nativeSyncDiagnostics'), directory = makePage('nativeSyncDirectory');
    const tools = makePage('nativeSyncTools'), issues = makePage('nativeSyncIssues');
    const nav = el('div', '', 'ns-navigation'), back = button('nativeSyncBack', '返回连接页'), title = el('h3');
    nav.append(back, title);
    const heading = el('div', '', 'ns-heading'), spaceName = el('h3', 'NativeSync');
    refresh.textContent = '刷新';
    heading.append(spaceName, refresh);
    const live = el('div', '', 'ns-live');
    live.setAttribute('role', 'status');
    const connectionTitle = el('p', '正在读取连接状态…', 'ns-live-title'), summary = el('p', '', 'ns-summary');
    live.append(connectionTitle, summary);
    const attention = button('nativeSyncAttention', '');
    const rows = el('div', '', 'ns-rows');
    function row(label, action) {
        const line = el('div', '', 'ns-row');
        const value = el('span', '', 'ns-value');
        line.append(el('span', label, 'ns-label'), value);
        if (action) line.append(action);
        rows.append(line);
        return value;
    }
    const directoryButton = button('nativeSyncBrowse', '查看'), edit = button('nativeSyncEditStartup', '更改');
    const scopeValue = row('共享范围'), directoryValue = row('共享目录', directoryButton), startupValue = row('启动设置', edit);
    directoryButton.setAttribute('aria-label','查看共享目录'); edit.setAttribute('aria-label','更改启动设置');
    const details = button('nativeSyncDetails', '连接详情与诊断');
    details.classList.add('ns-disclosure');
    home.append(heading, live, attention, rows, details);
    const startupNow = el('p'), consequence = el('p', '', 'ns-consequence');
    const setupFields = el('div', '', 'ns-fields');
    setupFields.append(intro, mode, sourceFields, sharedFields, selection, search, list);
    form.append(startupNow, desired, consequence, setupFields, review, actions);
    actions.replaceChildren(preview, save);
    const inspect = button('nativeSyncCheckConnection', '检查连接与历史');
    const changeScope = button('nativeSyncChangeScope', '更改接入范围');
    const identity = el('p');
    const openShared = button('shared-config-open', '管理共享配置与目录');
    diagnostics.append(server, identity, status, counts, binding, connection, inspect, retryAttachments, changeScope, openShared);
    const directorySearch = el('input');
    directorySearch.type = 'search'; directorySearch.id = 'nativeSyncDirectorySearch';
    directorySearch.placeholder = '搜索 Agent、群聊或话题';
    directorySearch.setAttribute('aria-label', directorySearch.placeholder);
    const directoryList = el('div', '', 'ns-directory');
    directory.append(directorySearch, directoryList);
    const editorRoot = el('div'), matchingRoot = el('div'), directoryRoot = el('div');
    tools.append(editorRoot, directoryRoot, matchingRoot);
    panel.append(nav, home, directory, form, diagnostics, issues, tools, notice, quit);
    let page = 'home', navigation = 0, entries = [], toolsMounted = [];
    const pages = {home, directory, startup:form, setup:form, diagnostics, issues, tools};
    function navigate(next, headingText = '') {
        navigation++;
        if (page === 'tools') {
            for (const tool of toolsMounted) tool.dispose();
            toolsMounted = [];
        }
        page = next;
        for (const node of new Set(Object.values(pages))) node.hidden = node !== pages[next];
        nav.hidden = next === 'home';
        back.disabled = busy; title.textContent = headingText;
        notice.textContent = ''; quit.hidden = !(view?.restartRequired && (next === 'diagnostics' || next === 'startup'));
        if (next !== 'home') back.focus();
    }
    async function sharedRequest(route, body) {
        const result = await api.sharedConfigRequest({route, body});
        if (result?.success === false) throw Object.assign(Error(explain(result.error)), {code:result.error});
        return result;
    }
    async function openTools(id) {
        navigate('tools', id ? '核对共享配置' : '共享配置与目录');
        const turn = navigation;
        try {
            const info = await api.sharedConfigContext();
            if (turn !== navigation) return;
            if (!info?.enabled || info.topic.sharedSpaceId !== view.sharedSpaceId) throw Error('共享空间尚未就绪。');
            const topic = id ? {...info.topic, sharedOwnerId:id} : info.topic;
            toolsMounted.push(mountSharedEditor(editorRoot, {api:sharedRequest, normalize:sharedConfig, topic, context:info.context,
                resolveLocal: body => sharedRequest('shared/config-resolution', {sharedSpaceId:topic.sharedSpaceId,...body})}));
            if (!id) {
                toolsMounted.push(mountSharedDirectory(directoryRoot, {api:sharedRequest, spaceId:topic.sharedSpaceId, context:info.context, desktop:true}));
                toolsMounted.push(mountSharedMatching(matchingRoot, {api:sharedRequest, spaceId:topic.sharedSpaceId}));
            }
        } catch (error) { if (turn === navigation) notice.textContent = error.message; }
    }
    async function browse(kind = 'directory') {
        const isDirectory = kind === 'directory';
        navigate(isDirectory ? 'directory' : 'issues', isDirectory ? '共享目录' : kind === 'conflicts' ? '查看冲突' : '待确认的配置');
        const turn = navigation;
        directorySearch.value = ''; entries = []; directoryList.replaceChildren(); issues.replaceChildren();
        try {
            const result = await sharedRequest('shared/directory-view?' + new URLSearchParams({sharedSpaceId:view.sharedSpaceId}));
            if (turn !== navigation) return;
            entries = result.entries;
            if (isDirectory) {
                renderDirectory(directoryList, entries, '');
                directorySearch.focus();
                return;
            }
            const affected = entries.filter(o => kind === 'conflicts' ? o.conflict : o.pending);
            if (affected.length === 1) return openTools(affected[0].id);
            if (!affected.length) issues.append(el('p', '当前没有待处理的配置。'));
            affected.forEach(o => {
                const item = button('', o.name);
                item.onclick = () => openTools(o.id);
                issues.append(item);
            });
        } catch (error) { if (turn === navigation) notice.textContent = error.message; }
    }
    async function showHistoryConflicts() {
        navigate('issues', '同步冲突');
        const turn = navigation;
        issues.replaceChildren();
        try {
            const result = await api.nativeSyncSetupOverview('history-conflicts');
            if (turn !== navigation) return;
            if (!result?.success) throw Error(result?.error);
            for (const conflict of result.conflicts) {
                issues.append(el('p', [conflict.msgId && '消息 ' + conflict.msgId, conflict.opId && '操作 ' + conflict.opId, conflict.code].filter(Boolean).join(' · ')));
            }
            if (!result.conflicts.length) issues.append(el('p', '当前没有同步冲突。'));
        } catch (error) { if (turn === navigation) notice.textContent = explain(error.message); }
    }
    directorySearch.oninput = () => renderDirectory(directoryList, entries, directorySearch.value);
    directoryButton.onclick = () => browse();
    openShared.onclick = () => openTools();
    details.onclick = () => navigate('diagnostics', '连接详情与诊断');
    function openForm(next) {
        navigate(next, next === 'startup' ? '启动设置' : '接入设置');
        resetForm();
        if (next === 'setup' && !view.configured) enabled.checked = true;
        invalidate();
    }
    edit.onclick = () => openForm(view.configured ? 'startup' : 'setup');
    changeScope.onclick = () => openForm('setup');
    back.onclick = () => {
        navigate('home'); refresh.focus();
        void load();
    };
    function resetForm() {
        enabled.checked = view.enabled;
        mode.value = view.sharedMode ? 'shared' : view.sourceMode ? (view.fullSource ? 'source' : 'managed') : 'selected';
        for (const option of mode.options) if (option.value === 'managed') option.hidden = mode.value !== 'managed';
        sourceId.value = view.sourceId || ''; sharedSpaceId.value = view.sharedSpaceId || '';
        selected = new Set(view.topics.map(key)); renderTopics();
    }
    function showOverview() {
        const c = view.current, state = connectionStatus(view, explain);
        spaceName.textContent = view.sharedSpaceId || (view.sourceId || '本机连接');
        connectionTitle.textContent = state.title; live.dataset.tone = state.tone;
        summary.textContent = state.detail; summary.hidden = !state.detail;
        rows.hidden = false;
        scopeValue.textContent = view.sharedMode ? '整个空间，含以后新增的内容' : view.fullSource ? '全部来源，含以后新增的话题' :
            view.sourceMode ? '服务器限定的来源范围' : view.configured ? `已选 ${view.topics.length} 个话题` : '尚未设置';
        directoryValue.parentElement.hidden = !view.sharedMode;
        directoryValue.textContent = c.shared?.ready ? `${c.shared.objects} 项` : '尚未就绪';
        directoryButton.disabled = !c.shared?.ready;
        startupValue.textContent = view.enabled ? '下次启动时连接' : '下次启动时停用';
        if (view.restartRequired) startupValue.textContent += ' · 待重启';
        edit.textContent = view.configured ? '更改' : '设置';
        edit.disabled = Boolean(view.error) || (view.sourceMode && !view.fullSource);
        attention.hidden = !state.action;
        attention.textContent = {check:'检查连接',conflicts:'查看冲突',history:'查看冲突',drafts:'查看草稿',diagnostics:'查看详情'}[state.action] || '';
        attention.onclick = () => {
            if (state.action === 'history') return showHistoryConflicts();
            if (state.action === 'conflicts' || state.action === 'drafts') return browse(state.action);
            navigate('diagnostics', '连接详情与诊断');
            if (state.action === 'check') void checkConnection();
        };
        startupNow.textContent = '当前状态 · ' + state.title;
        status.textContent = state.title + (state.detail ? '。' + state.detail : '');
        counts.textContent = `待上传 ${c.pendingOperations ?? '待核对'} · 待写入 ${c.buffered ?? '待核对'} · 同步冲突 ${c.conflicts ?? '待核对'}`;
        if (c.shared) counts.textContent += ` · 配置冲突 ${c.shared.configurationConflicts}`;
        if (c.source) counts.textContent += ` · 已接入 ${c.source.completedImports} · 待接入 ${c.source.pendingImports} · 目录异常 ${c.source.directoryErrors}`;
        identity.textContent = [view.sourceId && 'Source ID · ' + view.sourceId, view.deviceId && '设备 ID · ' + view.deviceId].filter(Boolean).join('　');
        server.textContent = '服务器 · ' + (view.serverOrigin || view.backendOrigin || '尚未配置 HTTPS 连接');
        openShared.hidden = !c.shared?.ready;
        inspect.disabled = busy || !view.configured || Boolean(view.error) || (view.sourceMode && !view.fullSource);
        changeScope.hidden = !(view.canJoinShared || view.canExpandSource || !view.bindingLocked);
        retryAttachments.hidden = !c.missingDownloads || typeof api.retryMissingAttachments !== 'function';
    }
    async function checkConnection() {
        if (inspect.disabled) return;
        busy = true; update(); inspect.disabled = true;
        try {
            const input = view.sharedMode ? {scopeMode:'shared',sharedSpaceId:view.sharedSpaceId} :
                view.fullSource ? {scopeMode:'source',sourceId:view.sourceId} : {topics:view.topics};
            const result = await api.nativeSyncSetupPreview({expectedRevision:view.revision,...input});
            if (!result?.success) throw Error(result?.error || 'SETUP_UNAVAILABLE');
            notice.textContent = '连接与已保存的范围已核对。';
        } catch (error) { notice.textContent = explain(error.message); }
        finally { busy = false; update(); showOverview(); }
    }
    inspect.onclick = checkConnection;
    // This section has its own persistence authority; do not trigger global settings autosave.
    panel.addEventListener('input', event => event.stopPropagation());
    panel.addEventListener('change', event => event.stopPropagation());
    let view = null, approval = null, busy = false, selected = new Set();
    function invalidate() { approval = null; review.hidden = true; confirmed.checked = false; update(); }
    function update() {
        back.disabled = busy;
        edit.disabled = busy || !view || Boolean(view.error) || (view.sourceMode && !view.fullSource);
        details.disabled = !view || busy;
        directoryButton.disabled = busy || !view?.current.shared?.ready;
        attention.disabled = busy || !view;
        setupFields.hidden = page !== 'setup';
        startupNow.hidden = page !== 'startup';
        consequence.hidden = page !== 'startup';
        consequence.textContent = enabled.checked ? '重新打开 VCPChat 后，按已保存的范围连接。' :
            view?.bindingLocked ? '下次启动后停用同步。已有共享绑定会保留，受保护的话题可能无法发送或新建。' : '下次启动后停用同步。';
        save.textContent = page === 'startup' ? '保存启动设置' : '保存，重启后生效';
        save.hidden = page === 'startup' && enabled.checked === view?.enabled;
        preview.hidden = page === 'startup' && (enabled.checked === view?.enabled || !enabled.checked);
        sourceFields.hidden=mode.value!=='source';list.hidden=search.hidden=mode.value!=='selected';
        sharedFields.hidden=mode.value!=='shared';
        selection.textContent = mode.value==='shared'?'共享整个空间的 Agent、群聊、话题和配置':mode.value==='managed'?'同步范围由现有 Source 配置管理':mode.value==='source' ? '全部原生 Agent、群聊及以后新增的话题' : `已选择 ${selected.size} / 8 个话题`;
        const limited = view?.sourceMode && !view.fullSource;
        const blocked = !view || Boolean(view.error) || (limited && !(view.canExpandSource && mode.value==='source'));
        enabled.disabled = busy || blocked || limited;
        preview.disabled = busy || blocked || !enabled.checked || (mode.value==='shared'?!sharedSpaceId.value.trim():mode.value==='source'?!sourceId.value.trim():!selected.size);
        save.disabled = busy || blocked || (!enabled.checked && !view?.configured) || (enabled.checked && (!approval || !confirmed.checked));
        refresh.disabled = busy;
        if(view) inspect.disabled = busy || !view.configured || Boolean(view.error) || (view.sourceMode && !view.fullSource);
        mode.disabled=busy||!view||Boolean(view.error)||view.sharedMode||(view.sourceMode&&!view.canExpandSource&&!view.canJoinShared);
        sourceId.disabled=busy||blocked||view?.sourceMode;
        sharedSpaceId.disabled=busy||blocked||view?.sharedMode;
        for(const option of mode.options)if(option.value==='selected')option.disabled=Boolean(view?.sourceMode);
        for(const option of mode.options)if(option.value==='shared')option.disabled=!view?.canJoinShared&&!view?.sharedMode;
        for (const input of list.querySelectorAll('input')) input.disabled = busy || blocked || view?.bindingLocked || !enabled.checked;
    }
    function renderTopics() {
        list.replaceChildren();
        const choices = [...(view?.choices || [])];
        for (const d of view?.topics || []) if (!choices.some(c => key(c) === key(d))) choices.push({ ...d, ownerName: d.itemId, topicName: d.topicId });
        for (const topic of choices) {
            const label = el('label', '', 'ns-setup-topic');
            const input = el('input'); input.type = 'checkbox'; input.checked = selected.has(key(topic)); input.dataset.topicKey = key(topic);
            const copy = el('span'); copy.append(el('strong', topic.ownerName), el('small', `${topic.itemType === 'group' ? '群聊 · ' : ''}${topic.topicName}`));
            label.append(input, copy); label.dataset.search = `${topic.ownerName} ${topic.topicName}`.toLowerCase();
            input.onchange = () => {
                if (input.checked && selected.size >= 8) { input.checked = false; notice.textContent = '本模式最多选择 8 个话题。'; return; }
                if (input.checked) selected.add(key(topic)); else selected.delete(key(topic));
                invalidate();
            };
            list.append(label);
        }
        if (!choices.length) list.append(el('p', '还没有可选择的话题，请先在电脑上创建并保存话题。'));
        filter(); update();
    }
    function filter() { for (const row of list.querySelectorAll('[data-search]')) row.hidden = !row.dataset.search.includes(search.value.trim().toLowerCase()); }
    search.oninput = filter;
    async function load() {
        if (busy) return;
        busy = true; update();
        try {
            const result = await api.nativeSyncSetupOverview();
            if (!result?.success) throw Error(result?.error || 'SETUP_UNAVAILABLE');
            view = result;
            deviceId.textContent = '本机设备标识 · ' + result.deviceId;
            binding.textContent = result.sourceMode && !result.fullSource ? '此设备使用服务器限定的来源范围。' :
                result.bindingLocked ? '已绑定原设备与同步范围。' : '首次接入需要确认范围。';
            resetForm(); invalidate(); showOverview();
            notice.textContent = result.error ? explain(result.error) : '';
        } catch (error) {
            view = null; approval = null; rows.hidden = true; attention.hidden = true;
            spaceName.textContent = '本机连接';
            connectionTitle.textContent = '连接状态待核对'; live.dataset.tone = 'attention';
            summary.textContent = ''; notice.textContent = explain(error.message);
        } finally { busy = false; update(); }
    }
    mode.onchange=()=>{if(view?.canExpandSource)enabled.checked=mode.value==='source'?true:view.enabled;invalidate();notice.textContent=mode.value==='shared'?'将使用现有设备加入获批共享空间；检查不写服务器，保存后正常重启才提交加入。':mode.value==='source'?'全量模式将包含全部历史、支持的附件、续聊所需设定及未来新增会话。':'';};sourceId.oninput=invalidate;sharedSpaceId.oninput=invalidate;
    enabled.onchange = () => { invalidate(); if (page === 'startup') { notice.textContent = ''; return; } notice.textContent = enabled.checked ? '先检查连接与历史，再确认保存。' : '保存后，下次启动停用同步；已有绑定、消息和待同步数据会保留。'; };
    confirmed.onchange = update;
    refresh.onclick = load;
    retryAttachments.onclick = async () => {
        retryAttachments.disabled = true;
        try {
            const result = await api.retryMissingAttachments();
            if (!result?.success) throw Error(result?.error || 'ATTACHMENT_SYNC_UNAVAILABLE');
            retryAttachments.hidden = true;
            notice.textContent = result.released
                ? `已解除 ${result.released} 项附件下载的等待，下一轮同步会重新检查当前可访问的附件。`
                : '当前没有等待重试的附件。';
        } catch (error) { notice.textContent = explain(error.message); }
        finally { retryAttachments.disabled = false; }
    };
    preview.onclick = async () => {
        busy = true; invalidate(); notice.textContent = '正在只读检查连接与所选历史…';
        try {
            const topics = [...selected].map(k => { const [itemType, itemId, topicId] = JSON.parse(k); return { itemType, itemId, topicId }; });
            const r = await api.nativeSyncSetupPreview(mode.value==='shared'?{expectedRevision:view.revision,scopeMode:'shared',sharedSpaceId:sharedSpaceId.value.trim()}:mode.value==='source'?{expectedRevision:view.revision,scopeMode:'source',sourceId:sourceId.value.trim()}:{expectedRevision:view.revision,topics});
            if (!r?.success) throw Error(r?.error || 'SETUP_UNAVAILABLE');
            approval = r.token;
            reviewText.textContent = r.sharedMode?`已只读核对服务器 ${r.serverOrigin}、来源 ${r.sourceId} 和共享空间 ${r.sharedSpaceId}。重启后才加入，包含受支持附件（单文件20 MB）；原设备和账本保留，凭据和本机路径不共享。`:r.sourceMode?`已核对服务器 ${r.serverOrigin} 和来源 ${r.sourceId}：${r.agentCount} 个 Agent、${r.groupCount} 个群聊、${r.selectedTopics} 个话题；目录异常 ${r.directoryErrors}。${r.scopeExpansion?'扩围将在重启时由服务器核对受理。':''}历史将在重启后分批接入。`:r.existingState ? `已核对服务器 ${r.serverOrigin}，沿用 ${r.selectedTopics} 个话题的原绑定和同步进度。` : `已核对 ${r.selectedTopics} 个话题：本机 ${r.localMessages} 条消息，其中 ${r.identicalRemoteMessages} 条与服务器相同，${r.newLocalMessages} 条待上传，服务器另有 ${r.remoteOnlyMessages} 条待接收。`;
            confirmationText.textContent = r.sharedMode?'确认加入整个共享空间，同步历史与配置及未来新增内容；冲突保留，不按同名自动归并':r.sourceMode?'确认同步全部历史、支持的附件、续聊设定（包括提示词）及以后新增的会话，并允许所有受支持会话在手机续聊':r.existingState ? '确认使用原绑定恢复同步' : '确认将所选历史和手机续聊所需的助手设定同步到上述服务器';
            if (page === 'startup' && view.sharedMode && view.bindingLocked) {
                reviewText.textContent = '已核对原空间 ' + view.sharedSpaceId + ' 和本机绑定。';
                confirmationText.textContent = '确认下次启动时恢复原连接';
            }
            review.hidden = false; notice.textContent = '检查未修改本机历史或服务器数据。';
        } catch (error) { notice.textContent = explain(error.message); }
        finally { busy = false; update(); }
    };
    save.onclick = async () => {
        busy = true; update();
        try {
            const r = await api.nativeSyncSetupSave({ expectedRevision: view.revision, enabled: enabled.checked, ...(enabled.checked ? { approvalToken: approval, confirmed: confirmed.checked } : {}) });
            if (!r?.success) throw Error(r?.error || 'SETUP_UNAVAILABLE');
            busy = false;
            navigate('home'); await load(); edit.focus();
            notice.textContent = r.warning ? explain(r.warning) : r.restartRequired ? '配置已保存。请退出后从原启动入口重新打开 VCPChat；当前运行配置尚未切换。' : '配置已保存，与当前运行配置一致。';
            quit.hidden = true;
        } catch (error) { notice.textContent = explain(error.message); invalidate(); }
        finally { busy = false; update(); }
    };
    quit.onclick = () => api.closeApp?.();
    navigate('home');
    if (api?.nativeSyncSetupOverview) void load();
    else { notice.textContent = '此窗口未提供接入管理能力。'; update(); }
    // Only sample in-memory runtime counters while the connection page is visible.
    if (api?.nativeSyncSetupOverview && doc.defaultView?.IntersectionObserver) {
        let timer, visible = false, reading = false;
        const poll = async () => {
            if (!visible || !panel.isConnected || reading) return;
            reading = true;
            if (!doc.hidden && !busy && view && page === 'home') {
                const snapshot = view;
                try {
                    const result = await api.nativeSyncSetupOverview('current');
                    if (result?.success && result.current && view === snapshot && page === 'home' && !busy) {
                        view.current = result.current; showOverview();
                    }
                } catch { /* An explicit refresh also checks the saved connection. */ }
            }
            reading = false;
            clearTimeout(timer);
            if (visible && panel.isConnected) timer = setTimeout(poll, 5000);
        };
        const observer = new doc.defaultView.IntersectionObserver(([entry]) => {
            visible = entry.isIntersecting; clearTimeout(timer);
            if (visible) timer = setTimeout(poll, 5000);
        });
        observer.observe(home);
    }
    return panel;
}

let installed = false;
export function install() {
    if (installed) return;
    installed = true;
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = new URL('./settings.css', import.meta.url).href; document.head.append(link);
    registerSettingsSection({ section: section('native-sync', 'NativeSync', [custom('nativeSyncSetup', buildPanel)]), label: 'NativeSync', icon: 'refresh-cw' });
}

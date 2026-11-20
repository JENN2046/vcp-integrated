import { installNameEditor } from './nameEdit.js';
import { registerSettingsSection, requestSettingsSection } from '../settings/extensions.js';
import { section, custom } from '../settings/schema/kernel.js';

const sectionKey = 'native-sync-profile';

function profilePanel(doc, canSaveName) {
    const panel = doc.createElement('div');
    const note = doc.createElement('p');
    note.textContent = canSaveName ? '本机连接配置' : '本机配置 · 当前仅提供查询';
    const details = doc.createElement('dl');
    details.setAttribute('aria-live', 'polite');
    const refresh = doc.createElement('button');
    refresh.type = 'button';
    refresh.className = 'sidebar-button small-button';
    refresh.textContent = '刷新';
    async function load() {
        refresh.disabled = true;
        try {
            const status = await doc.defaultView.chatAPI.getNativeSyncDesktopStatus();
            if (!status?.success || !status.profile) throw Error('Profile unavailable');
            const { configured, enabled, sharedSpaceId, serverOrigin } = status.profile;
            details.replaceChildren();
            for (const [name, value] of [
                ['宿主服务器', serverOrigin || '未设置'], ['共享空间', sharedSpaceId || '未绑定'],
                ['启动同步设置', configured ? (enabled ? '开启' : '关闭') : '未配置'],
            ]) {
                const term = doc.createElement('dt'), description = doc.createElement('dd');
                term.textContent = name;
                description.textContent = value;
                details.append(term, description);
            }
        } catch {
            details.textContent = '无法读取本机连接配置。';
        } finally {
            refresh.disabled = false;
        }
    }
    refresh.addEventListener('click', load);
    panel.append(note, details, refresh);
    void load();
    return panel;
}

export async function install(context) {
    const status = await context.chatAPI.getNativeSyncDesktopStatus();
    if (status?.mode === 'integrated') {
        const runtime = await import('./renderer.js');
        return runtime.install(context);
    }
    if (!['profile-only', 'agent-name'].includes(status?.mode)) throw Error('NativeSync desktop status unavailable');
    if (status.mode === 'agent-name') installNameEditor(window, context.chatAPI);
    registerSettingsSection({ section: section(sectionKey, 'NativeSync', [custom('nativeSyncProfileStatus', doc => profilePanel(doc, status.mode === 'agent-name'))]),
        label: 'NativeSync', icon: 'refresh-cw' });
    const off = context.chatAPI.onNativeSyncShowProfileStatus(() => {
        requestSettingsSection(sectionKey);
        context.globalSettingsBtn?.click();
    });
    window.addEventListener('unload', off, { once: true });
}

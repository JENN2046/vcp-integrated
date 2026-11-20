// The native form owns the input and drafts. One editor lives with the edit
// that opened it, including when the form temporarily switches to another Agent.
export function installNameEditor(win, api) {
    const slots = win.VCPSettingsSlots ||= {};
    const create = (agentId, opened) => {
        let ticket = opened.ticket;
        let conflict = null;
        let panel = null;
        let resolve = null;

        async function save(name, shown, choice) {
            if (shown && (shown !== conflict || shown.intent !== name)) return { success: false, stale: true };
            if (!shown && conflict?.intent === name) return attention();
            const result = await api.saveAgentSettingsName(agentId, shown?.ticket || ticket, name, choice);
            if (result?.conflict) {
                conflict = { ...result.conflict, intent: name };
                return attention();
            }
            if (result?.success) {
                ticket = result.ticket;
                conflict = null;
            }
            return result;
        }

        function attention() {
            return { success: false, needsAttention: true, error: 'agent-name-conflict' };
        }

        function render(input, pending, submit) {
            const shown = conflict;
            if (!shown || !input?.parentElement || input.value.trim() !== shown.intent) {
                panel?.remove();
                panel = null;
                resolve = null;
                return false;
            }
            const field = input.closest('.agent-name-wrapper') || input.parentElement;
            if (panel?.parentElement !== field) {
                panel?.remove();
                const doc = input.ownerDocument;
                panel = doc.createElement('div');
                panel.id = 'agentNameConflict';
                const message = doc.createElement('p');
                message.id = 'agentNameConflictMessage';
                message.setAttribute('role', 'status');
                const button = (id, choice) => {
                    const el = doc.createElement('button');
                    el.id = id;
                    el.type = 'button';
                    el.className = 'small-button';
                    el.addEventListener('click', () => { if (el.isConnected) resolve?.(choice); });
                    return el;
                };
                const keep = button('agentNameConflictKeepMine', 'keep-mine');
                keep.textContent = '保留我的名称';
                panel.append(message, keep, ' ', button('agentNameConflictUseCurrent', 'use-current'));
                field.append(panel);
            }
            const [message, keep, use] = panel.children;
            message.textContent = `另一台设备已改为『${shown.name}』`;
            use.textContent = `使用「${shown.name}」`;
            keep.disabled = use.disabled = pending;
            resolve = pending ? null : choice => submit(name => save(name, shown, choice));
            return true;
        }

        return { save, render, get needsAttention() { return Boolean(conflict); } };
    };
    slots.agentNameEditor = create;
    win.addEventListener('unload', () => {
        if (slots.agentNameEditor === create) delete slots.agentNameEditor;
    }, { once: true });
}

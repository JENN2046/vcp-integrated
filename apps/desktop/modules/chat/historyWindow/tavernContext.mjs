// Tavern depth is measured within the conversation, after the history window is selected.
export function applyContextRules(messages, rules, engine) {
    if (!engine || rules.length === 0) return messages;
    const systemMessages = messages.filter(message => message.role === 'system');
    const conversationMessages = messages.filter(message => message.role !== 'system');
    const injected = engine.applyContextInject(conversationMessages, rules, 'agent', {
        makeMessage: (role, text) => ({
            role,
            content: [{ type: 'text', text }],
            __tavernInjected: true,
        }),
    });
    return [...systemMessages, ...injected];
}

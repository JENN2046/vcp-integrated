'use strict';

const { groupRequest } = require('../Plugin/NativeSync/mobile/groupRequest');
const modes = {
    sequential: require('../Plugin/NativeSync/nativeRules/Groupmodules/modes/sequentialMode'),
    naturerandom: require('../Plugin/NativeSync/nativeRules/Groupmodules/modes/natureRandomMode'),
    invite_only: require('../Plugin/NativeSync/nativeRules/Groupmodules/modes/inviteOnlyMode')
};
const { failure } = require('./store');

function isCoreGroupMode(mode) { return Object.hasOwn(modes, mode); }

function planGroup(config, history, userMessageId, signal) {
    const active = config.group.members.map(id => config.agents.find(agent => agent.id === id && !agent.unavailable)).filter(Boolean);
    if (config.inviteAgentId) {
        if (!active.some(agent => agent.id === config.inviteAgentId)) throw failure('GROUP_MEMBER_UNAVAILABLE', 403);
        return [config.inviteAgentId];
    }
    if (config.group.mode === 'jev') return [];
    const user = history.find(message => message.id === userMessageId);
    if (!user) throw failure('WORK_INPUT_UNAVAILABLE');
    return modes[config.group.mode].determineSpeakers(active, history, config.group, user,
        { isAborted: () => signal.aborted }).map(agent => agent.id);
}

function buildGroupPacket(topic, work, config, member, history, attachments, desktopContext) {
    if (config.game) {
        member = { ...member, ...(config.game.model && { model: config.game.model }),
            maxOutputTokens: Math.min(member.maxOutputTokens || 16384, 16384) };
        const { nativeGamePrompts } = require('./game');
        const { GAME_SYSTEM_PROMPT, DOUDIZHU_SYSTEM_PROMPT } = nativeGamePrompts();
        const groupPrompt = [config.group.groupPrompt, GAME_SYSTEM_PROMPT, DOUDIZHU_SYSTEM_PROMPT].filter(Boolean).join('\n\n');
        config = { ...config, group: { ...config.group, groupPrompt, useUnifiedModel: false, invitePrompt: config.game.invitePrompt } };
    }
    return groupRequest({ topic, config, member, history, attachments, desktopContext, currentUserId: work.user_message_id,
        requestId: work.id + '_group_' + work.group_step, seq: work.admitted_seq });
}

module.exports = { isCoreGroupMode, planGroup, buildGroupPacket };

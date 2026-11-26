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
    const user = history.find(message => message.id === userMessageId);
    if (!user) throw failure('WORK_INPUT_UNAVAILABLE');
    return modes[config.group.mode].determineSpeakers(active, history, config.group, user,
        { isAborted: () => signal.aborted }).map(agent => agent.id);
}

function buildGroupPacket(topic, work, config, member, history, attachments) {
    return groupRequest({ topic, config, member, history, attachments, currentUserId: work.user_message_id,
        requestId: work.id + '_group_' + work.group_step, seq: work.admitted_seq });
}

module.exports = { isCoreGroupMode, planGroup, buildGroupPacket };

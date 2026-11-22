'use strict';

/**
 * Resolve the model that should be used for this agent in group chat.
 * When unified model is enabled, it has priority over per-agent model.
 * @param {object} groupConfig
 * @param {object} agentConfig
 * @returns {{usingUnifiedModel: boolean, unifiedModel: string, agentModel: string, effectiveModel: string}}
 */
function resolveEffectiveModel(groupConfig, agentConfig) {
    const usingUnifiedModel = groupConfig && groupConfig.useUnifiedModel === true;
    const unifiedModel = (groupConfig && typeof groupConfig.unifiedModel === 'string')
        ? groupConfig.unifiedModel.trim()
        : '';
    const agentModel = (agentConfig && typeof agentConfig.model === 'string')
        ? agentConfig.model.trim()
        : '';

    return {
        usingUnifiedModel,
        unifiedModel,
        agentModel,
        effectiveModel: usingUnifiedModel ? unifiedModel : agentModel
    };
}

module.exports = { resolveEffectiveModel };

'use strict';

const path = require('node:path');
const { failure } = require('./store');

function nativeGamePrompts() {
    const desktop = path.resolve(path.dirname(require.resolve('@vcp/native-history-window')), '../../..');
    return require(path.join(desktop, 'Groupmodules/modes/gamePrompts'));
}

function isCoreGame(config) {
    return config?.mode === 'game' && config.modeSettings?.game?.gameTypeId === 'doudizhu';
}

function gameDecision(observation) {
    if (!observation || typeof observation.matchId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(observation.matchId) ||
        !Number.isSafeInteger(observation.revision) || observation.revision < 0 ||
        observation.decisionId !== observation.matchId + ':' + observation.revision ||
        ![0, 1, 2].includes(observation.seat) || !['bidding','playing'].includes(observation.phase) ||
        !Array.isArray(observation.hand) || observation.hand.length > 20) throw failure('INVALID_CORE_GAME_DECISION', 400);
    return { matchId: observation.matchId, decisionId: observation.decisionId, revision: observation.revision };
}

module.exports = { nativeGamePrompts, isCoreGame, gameDecision };

'use strict';

const path = require('node:path');

function nativeGamePrompts() {
    const desktop = path.resolve(path.dirname(require.resolve('@vcp/native-history-window')), '../../..');
    return require(path.join(desktop, 'Groupmodules/modes/gamePrompts'));
}

module.exports = { nativeGamePrompts };

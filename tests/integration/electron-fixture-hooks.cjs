'use strict';

// The standard fixture runs without hooks. A dedicated test entry can
// register its own observers and commands before loading the fixture.
let hooks;
function install(value) {
    if (hooks) throw Error('Electron fixture hooks already installed');
    hooks = value;
}
function get() { return hooks; }
module.exports = { install, get };

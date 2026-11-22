'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const loaded = require(path.join(process.cwd(), 'Plugin/NativeSync/mobile/nativeTasks.js'));
const prototype = loaded.NativeTaskLinks.prototype;
const original = prototype.hooks;
prototype.hooks = function (...args) {
    const bridge = original.apply(this, args);
    const settle = bridge.onToolSettled;
    bridge.onToolSettled = async event => {
        if (event.pluginName === 'AgentAssistant' && event.outcome === 'returned') {
            const gate = path.join(process.env.HOME, 'release-parent-tool-settlement');
            fs.writeFileSync(path.join(process.env.HOME, 'held-parent-tool-settlement'), JSON.stringify({
                nativeRequestId: event.nativeRequestId, invocationId: event.invocationId,
            }));
            const end = Date.now() + 60000;
            while (!fs.existsSync(gate)) {
                if (Date.now() >= end) throw Error('Fixture failed to release the parent tool settlement');
                await delay(20);
            }
        }
        return settle(event);
    };
    return bridge;
};

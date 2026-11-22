'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const counter = require('./counter.cjs');
const { role, hold } = require('./scenario.json');
const marker = name => path.join(__dirname, name);

module.exports = {
    async processToolCall(args) {
        const result = await counter.processToolCall(args);
        if (role === 'first') {
            fs.writeFileSync(marker('held-before-receipt'), 'effect fsynced');
            const deadline = Date.now() + 15000;
            while (!fs.existsSync(marker('release-receipt'))) {
                if (Date.now() > deadline) throw Error('Synthetic first receipt was not released');
                await delay(20);
            }
        } else {
            if (hold) {
                fs.writeFileSync(marker('held-before-receipt'), 'effect fsynced');
                return new Promise(() => {});
            }
            result.content[0].text = 'second ' + result.content[0].text;
        }
        return result;
    },
};

'use strict';

const fs = require('node:fs');
const path = require('node:path');

module.exports = {
    async processToolCall({ command, marker }) {
        if (command !== 'Count' || !/^ORDINARY_TOOL_(APPROVE|DENY|CANCEL|CRASH|TIMEOUT|THROW|LOCAL)$/.test(marker)) {
            throw Error('Unexpected synthetic invocation');
        }
        const file = path.join(__dirname, 'invocations.jsonl');
        const fd = fs.openSync(file, 'a', 0o600);
        try {
            fs.writeFileSync(fd, JSON.stringify({ marker }) + '\n');
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        if (marker === 'ORDINARY_TOOL_THROW') throw Error('Synthetic failure after the durable counter write');
        if (marker === 'ORDINARY_TOOL_CRASH' || marker === 'ORDINARY_TOOL_TIMEOUT') {
            // Keep the external result unknown after the durable side effect.
            return new Promise(() => {});
        }
        return { content: [{ type: 'text', text: 'ordinary tool invocation recorded for ' + marker }] };
    },
};

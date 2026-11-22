'use strict';

// Observe the installed handlers and their actual tool and RAG inputs. All original
// implementations receive the original arguments and return the original values.
const fs = require('node:fs');
const path = require('node:path');
const output = process.env.VCP_TEST_PAYLOAD_OBSERVATIONS;
const write = (kind, value) => fs.appendFileSync(output, JSON.stringify({ kind, value }) + '\n');
const fromBox = modulePath => require(path.join(process.cwd(), modulePath));

const ToolExecutor = fromBox('modules/vcpLoop/toolExecutor.js');
const executeAll = ToolExecutor.prototype.executeAll;
ToolExecutor.prototype.executeAll = async function (...args) {
    const results = await executeAll.apply(this, args);
    write('executor', results);
    return results;
};

for (const mode of ['nonStream', 'stream']) {
    const Handler = fromBox('modules/handlers/' + mode + 'Handler.js');
    const handle = Handler.prototype.handle;
    Handler.prototype.handle = function (...args) {
        const refresh = this.context._refreshRagBlocksIfNeeded;
        this.context._refreshRagBlocksIfNeeded = function (messages, input, ...rest) {
            write('rag', JSON.parse(input.toolResultsText));
            return refresh.call(this, messages, input, ...rest);
        };
        return handle.apply(this, args);
    };
}

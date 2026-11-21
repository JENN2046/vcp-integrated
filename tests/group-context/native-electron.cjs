'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Session } = require('node:inspector/promises');
const { fileURLToPath } = require('node:url');
const { install } = require('../integration/electron-fixture-hooks.cjs');

const evidence = process.env.NS_GROUP_DISPATCH;
const historyFile = process.env.NS_GROUP_HISTORY;
const sourceRoot = path.resolve(process.env.NS_HOST, '../..');
const inspector = new Session();
const endpoint = new URL(process.env.NS_GROUP_ENDPOINT);
assert.equal(endpoint.hostname, '127.0.0.1');
assert.ok(path.isAbsolute(evidence) && path.isAbsolute(historyFile));

function capture(row) {
    fs.appendFileSync(evidence, JSON.stringify(row) + '\n', { mode: 0o600 });
}

const originalFetch = global.fetch;
global.fetch = function (address, options) {
    const target = typeof address === 'string' ? address : address?.href;
    if (options?.method === 'POST' && target === endpoint.href) {
        const body = JSON.parse(options.body);
        if (body.messages.some(row => row.role === 'system' && /GC_MEMBER_[AB]/.test(row.content))) {
            const history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
            capture({ kind: 'dispatch', body, committed: history.map(({ id, role, content }) => ({ id, role, content })) });
        }
    }
    return originalFetch.apply(this, arguments);
};

install({
    onIpc(channel, args) {
        if (channel !== 'send-group-chat-message') return;
        const [groupId, topicId, message] = args;
        capture({ kind: 'group-send-ipc', groupId, topicId, inputId: message.id, content: message.content });
    },
    commands: {
        async 'group-coverage-start'() {
            inspector.connect();
            await inspector.post('Profiler.enable');
            await inspector.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
        },
        async 'group-coverage-take'() {
            try {
                const { result } = await inspector.post('Profiler.takePreciseCoverage');
                return result.filter(row => row.url.startsWith('file:') && /(?:groupchat|groupChatHandlers|sequentialMode|groupContextWindow|tavernRulesEngine)\.js$/.test(row.url))
                    .map(row => ({
                        file: path.relative(sourceRoot, fileURLToPath(row.url)),
                        hitFunctions: row.functions.filter(fn => fn.functionName && fn.ranges[0]?.count > 0)
                            .map(fn => ({ name: fn.functionName, count: fn.ranges[0].count })),
                    }));
            } finally {
                await inspector.post('Profiler.stopPreciseCoverage');
                inspector.disconnect();
            }
        },
    },
});
require('../integration/electron.cjs');

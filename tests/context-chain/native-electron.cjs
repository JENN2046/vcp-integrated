'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { install } = require('../integration/electron-fixture-hooks.cjs');
const evidence = process.env.NS_CONTEXT_HANDLER_EVIDENCE;
if (!evidence || !path.isAbsolute(evidence)) throw Error('Native context capture requires an absolute evidence path');

const coverageFiles = ['contextCompactionState.js','historyWindow/index.mjs',
    'chatContextPipeline.js','historyWindow/tavernContext.mjs','tavernRulesEngine.js','singleChatRequestOrchestrator.js','chatManager.js'];

function debuggerFor(window) {
    if (!window || window.isDestroyed()) throw Error('The native context window is unavailable');
    const debuggerApi = window.webContents.debugger;
    if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');
    return debuggerApi;
}

install({
    onIpc(channel, args) {
        if (channel !== 'send-to-vcp') return;
        const [url, , messages, modelConfig, messageId, isGroupCall, context] = args;
        const parsed = new URL(url);
        if (parsed.hostname !== '127.0.0.1') throw Error('Native context fixture targets loopback only');
        fs.appendFileSync(evidence, JSON.stringify({
            route:parsed.pathname, messages, modelConfig, messageId, isGroupCall, context,
        }) + '\n', { mode:0o600 });
    },
    commands: {
        async 'context-type'(window, text) {
            await debuggerFor(window).sendCommand('Input.insertText', { text });
        },
        async 'context-coverage-start'(window) {
            const api = debuggerFor(window);
            await api.sendCommand('Profiler.enable');
            await api.sendCommand('Profiler.startPreciseCoverage', { callCount:true, detailed:true });
        },
        async 'context-coverage-take'(window) {
            const api = debuggerFor(window);
            const coverage = await api.sendCommand('Profiler.takePreciseCoverage');
            await api.sendCommand('Profiler.stopPreciseCoverage');
            await api.sendCommand('Profiler.disable');
            return coverage.result.filter(script=>coverageFiles.some(file=>script.url.endsWith('/'+file)))
                .map(script=>({ url:script.url,
                    hitFunctions:script.functions.filter(fn=>fn.ranges[0]?.count>0&&fn.functionName)
                        .map(fn=>({name:fn.functionName,count:fn.ranges[0].count})),
                }));
        },
    },
});
require('../integration/electron.cjs');

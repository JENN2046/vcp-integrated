import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';

const source = fs.readFileSync(new URL('../modules/chatManager.js', import.meta.url), 'utf8');
const functionNames = new Set([
    'executionAuthority',
    'checkStreamContextBudget',
    'finishStreamContextCompaction',
    'abandonStreamContextCompaction',
]);
const wanted = new Map();
function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration' && functionNames.has(node.id.name)) wanted.set(node.id.name, source.slice(node.start, node.end));
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') visit(value);
    }
}
const syntax = parse(source, { sourceType: 'module' });
visit(syntax);
assert.equal(wanted.size, functionNames.size);
const timers = syntax.program.body.filter(node => node.type === 'VariableDeclaration'
    && node.declarations.some(declaration => ['INTERRUPT_SETTLE_MS', 'settlesWithin'].includes(declaration.id.name)));
assert.equal(timers.length, 2, 'the fixture must load both real interruption timer declarations');
const timerCode = timers.map(node => source.slice(node.start, node.end)).join('\n');
function fixture(success = true) {
    const events = [], timers = new Map(), requests = new Map(), signals = new Map();
    let nextTimer = 0;
    const scope = { agentId: 'A', topicId: 'T' };
    const selected = { id: 'A', type: 'agent', config: { contextTokenLimit: 1 } };
    const context = { disposed: false, streamCompactionRequests: requests, streamCompactionTerminalSignals: signals,
        streamBoundaryChecks: new Map(),
        electronAPI: { getTopicExecutionAuthority: async () => ({ success: true, kind: 'local' }) },
        globalSettingsRef: { get: () => ({ enableContextCompaction: true }) },
        currentSelectedItemRef: { get: () => selected }, currentTopicIdRef: { get: () => 'T' },
        currentChatHistoryRef: { get: () => [] }, effectiveContextHistory: value => value, estimateContextTokens: () => 2,
        getHistory: async () => [], notifySendStateChanged() {},
        compactionFlowlock: { suspendForContextCompaction: () => events.push('suspend') },
        interruptCapability: { interrupt: async () => { events.push('interrupt'); return { success }; } },
        contextCompactionService: { compact: async () => { events.push('compact'); return null; } },
        uiHelper: { showToastNotification() {} }, console,
        setTimeout: (callback, ms) => { const id = ++nextTimer; timers.set(id, { callback, ms }); return id; },
        clearTimeout: id => timers.delete(id),
    };
    vm.createContext(context);
    vm.runInContext(timerCode + '\n' + [...wanted.values()].join('\n'), context);
    const start = () => context.checkStreamContextBudget({ messageId: 'M', context: scope, text: 'synthetic text',
        cancelStream: async () => { events.push('cancel'); await context.finishStreamContextCompaction({ messageId: 'M' }); } });
    return { context, events, timers, requests, signals, start };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

function testWithDeadline(name, run) {
    test(name, async () => {
        // Keep the test runner alive long enough to report a stuck synthetic wait.
        let timer;
        const deadline = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Test did not settle within 1 second')), 1000);
        });
        try {
            await Promise.race([run(), deadline]);
        } finally {
            clearTimeout(timer);
        }
    });
}

testWithDeadline('an interrupt acknowledgement without a terminal event falls back after a bounded wait', async () => {
    const f = fixture();
    const checking = f.start();
    await flush();
    assert.equal(f.timers.size, 1, 'successful acknowledgement must not end the terminal wait');
    const timer = [...f.timers.values()][0];
    assert.equal(timer.ms, 3000);
    timer.callback();
    await checking;
    assert.deepEqual(f.events, ['suspend', 'interrupt', 'cancel', 'compact']);
    assert.equal(f.requests.size, 0);
    assert.equal(f.signals.size, 0);
});
testWithDeadline('a durably finalized stream completes the wait without local cancellation', async () => {
    const f = fixture();
    let settled = false;
    const checking = f.start().then(() => { settled = true; });
    await flush();
    assert.equal(settled, false);
    await f.context.finishStreamContextCompaction({ messageId: 'M' });
    await checking;
    assert.deepEqual(f.events, ['suspend', 'interrupt', 'compact']);
    assert.equal(f.timers.size, 0);
    assert.equal(f.signals.size, 0);
});
testWithDeadline('a refused upstream interrupt uses local cancellation immediately', async () => {
    const f = fixture(false);
    await f.start();
    assert.deepEqual(f.events, ['suspend', 'interrupt', 'cancel', 'compact']);
    assert.equal(f.timers.size, 0);
});

testWithDeadline('failed terminal persistence releases the waiter without resuming compaction', async () => {
    const f = fixture();
    const checking = f.start();
    await flush();
    f.context.abandonStreamContextCompaction({ messageId: 'M', event: { outcome: { persistence: { error: 'synthetic write failure' } } } });
    await checking;
    assert.deepEqual(f.events, ['suspend', 'interrupt']);
    assert.equal(f.requests.size, 0);
    assert.equal(f.signals.size, 0);
});

for (const stage of ['configuration', 'history']) testWithDeadline(`a background stream retired during ${stage} loading cannot suspend the conversation`, async () => {
    const f = fixture();
    let active = true, release;
    let enteredStage = false;
    const pending = new Promise(resolve => { release = resolve; });
    f.context.currentSelectedItemRef = { get: () => ({ id: 'B', type: 'agent' }) };
    f.context.electronAPI.getAgentConfig = async () => {
        if (stage !== 'configuration') return { contextTokenLimit: 1 };
        enteredStage = true;
        return pending;
    };
    f.context.getHistory = async () => {
        if (stage !== 'history') return [];
        enteredStage = true;
        return pending;
    };
    const checking = f.context.checkStreamContextBudget({ messageId: 'M', context: { agentId: 'A', topicId: 'T' }, text: 'synthetic',
        isStreamActive: () => active, cancelStream: async () => { f.events.push('cancel'); await f.context.finishStreamContextCompaction({ messageId: 'M' }); } });
    await flush();
    assert.equal(enteredStage, true, 'the stream must reach the intended asynchronous load');
    active = false;
    await f.context.finishStreamContextCompaction({ messageId: 'M' });
    release(stage === 'configuration' ? { contextTokenLimit: 1 } : []);
    await flush();
    assert.deepEqual(f.events, [], 'a retired stream must not register a budget request or suspend Flowlock');
    await checking;
    assert.equal(f.requests.size, 0);
});

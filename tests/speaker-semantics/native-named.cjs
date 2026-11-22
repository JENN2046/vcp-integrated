'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const execute = require('node:util').promisify(require('node:child_process').execFile);
const { start } = require('../context-chain/server-fixture.cjs');
const original = require('../context-chain/input.json');

const output = process.argv[2];
assert.ok(output, 'Usage: node tests/speaker-semantics/native-named.cjs <report.json>');
const contract = { ...original, userName: '历史访客', history: original.history.map(message =>
    message.id === 'ctx-retained-user' ? { ...message, name: '留名访客' } : message) };
const project = messages => {
    const row = messages.find(message => JSON.stringify(message.content).includes('CTX_RETAINED_INPUT'));
    assert.equal(row?.role, 'user');
    const text = typeof row.content === 'string' ? row.content : row.content.filter(part => part.type === 'text').map(part => part.text).join('');
    assert.ok(!text.includes('的发言]'));
    return { role: row.role, text: text.split('\n')[0], name: row.name ?? null };
};

async function main() {
    const fixture = await start({ contract, preload: path.join(__dirname, 'server-capture.cjs') });
    const file = name => path.join(fixture.out, name);
    try {
        fs.writeFileSync(file('input.json'), JSON.stringify(contract, null, 2));
        await execute(process.execPath, [path.join(__dirname, '../context-chain/native-run.cjs'),
            file('input.json'), fixture.completionUrl, file('native.json'), fixture.cert], { timeout: 120000, env:{...process.env,NODE_EXTRA_CA_CERTS:fixture.cert} });
        const native = JSON.parse(fs.readFileSync(file('native.json'), 'utf8'));
        const ipc = JSON.parse(fs.readFileSync(file('native.json.handler.jsonl'), 'utf8').trim());
        const { handler, provider } = fixture.snapshot();
        const entry = handler.find(row => row.kind === 'handler-input' && row.workId === null);
        const stages = handler.filter(row => row.kind === 'speaker-stage');
        assert.equal(native.terminalVisible, true);
        assert.equal(ipc.isGroupCall, false);
        assert.deepEqual(stages.map(row => row.stage).filter(stage => stage !== 'role-divider'),
            ['detectors', 'final-context', 'non-stream-loop-input']);
        assert.equal(provider.length, 1);
        const report = {
            surface: 'native-desktop-single-chat', terminalVisible: native.terminalVisible,
            historyMessageId: 'ctx-retained-user', replyId: native.replyId, electron: native.renderer.version,
            ipc: project(ipc.messages), handler: project(entry.messages),
            toolbox: stages.map(({ stage, source, messages }) => ({ stage, source, message: project(messages) })),
            provider: { route: provider[0].route, ...project(provider[0].messages) },
        };
        assert.deepEqual(report.ipc, { role: 'user', text: 'CTX_RETAINED_INPUT', name: '留名访客' });
        assert.deepEqual(report.handler, report.ipc);
        assert.deepEqual(report.toolbox[0].message, report.ipc);
        assert.deepEqual(report.toolbox.find(row => row.stage === 'non-stream-loop-input').message, report.ipc);
        assert.deepEqual(report.toolbox.find(row => row.stage === 'final-context').message, { ...report.ipc, name: null });
        assert.deepEqual(report.provider, { route: '/v1/chat/completions', ...report.ipc, name: null });
        fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    } finally {
        await fixture.close();
    }
    for (const name of ['seed', 'data', 'runtime-box', 'empty-diaries', 'backend.log', 'cert.pem']) {
        fs.rmSync(file(name), { recursive: true, force: true });
    }
    console.log(fixture.out);
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });

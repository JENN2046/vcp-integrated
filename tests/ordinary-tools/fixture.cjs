'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const name = 'OrdinaryToolCounter';
const markerPattern = /^ORDINARY_TOOL_(?:APPROVE|DENY|CANCEL|CRASH|TIMEOUT|THROW|LOCAL)$/;
const finalText = 'Synthetic ordinary tool turn complete.';
const countFile = out => path.join(out, 'runtime-box/Plugin', name, 'invocations.jsonl');
function counts(out) {
    const file = countFile(out);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}
function stage(box) {
    const dir = path.join(box, 'Plugin', name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'plugin-manifest.json'), JSON.stringify({
        manifestVersion: '1.0.0',
        name,
        version: '1.0.0',
        displayName: 'Synthetic Ordinary Tool Counter',
        description: 'Counts calls within the isolated fixture directory.',
        pluginType: 'hybridservice',
        entryPoint: { type: 'nodejs', script: 'counter.cjs' },
        communication: { protocol: 'direct', timeout: 2500 },
        capabilities: { invocationCommands: [{ commandIdentifier: 'Count', description: 'Count one synthetic invocation.' }] },
    }));
    fs.copyFileSync(path.join(__dirname, 'counter.cjs'), path.join(dir, 'counter.cjs'));
    fs.writeFileSync(path.join(box, 'toolApprovalConfig.json'), JSON.stringify({
        enabled: true, timeoutMinutes: 2, approvalList: [name], whitelist: [name + ':marker:[ORDINARY_TOOL_LOCAL]'],
    }));
}
function seed({ actor, owner, shared }) {
    const desktop = actor('C');
    return Object.fromEntries(['TIMEOUT', 'THROW'].map(label => {
        const agentId = 'ordinary-agent-' + label.toLowerCase();
        const agent = shared.create(desktop, { sharedSpaceId: 'sharedAB', opId: agentId, kind: 'agent',
            localId: agentId, config: { ...owner.config, name: 'Synthetic ordinary tool ' + label } }).object;
        const topicId = 'ordinary-topic-' + label.toLowerCase();
        const topic = shared.create(desktop, { sharedSpaceId: 'sharedAB', opId: topicId, kind: 'topic',
            parentId: agent.id, localId: topicId, localParent: agentId, config: { name: 'Synthetic tool ' + label } }).object;
        return [label, topic];
    }));
}
function reply(body, row, previousCalls) {
    const originalUsers = body.messages.filter(message => message.role === 'user').map(message =>
        Array.isArray(message.content) ? message.content.filter(part => part.type === 'text').map(part => part.text).join('') : message.content);
    const testCase = originalUsers.findLast(value => typeof value === 'string' && markerPattern.test(value.trim()))?.trim();
    if (!testCase) return;
    const followUp = previousCalls.some(call => call.ordinaryCase === testCase);
    row.ordinaryCase = testCase;
    row.ordinaryPhase = followUp ? 'continuation' : 'tool-request';
    row.hasToolResult = JSON.stringify(body.messages).includes('ordinary tool invocation recorded for ' + testCase);
    assert.equal(body.stream, false, 'ordinary fixture config uses non-streaming completion');
    return followUp ? finalText : [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」' + name + '「末」,',
        'command:「始」Count「末」,',
        'marker:「始」' + testCase + '「末」',
        '<<<[END_TOOL_REQUEST]>>>',
    ].join('\n');
}
module.exports = { stage, seed, reply, counts, countFile, name, finalText };

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const [baselinePath, candidatePath] = process.argv.slice(2);
assert.ok(baselinePath && candidatePath, 'Usage: node tests/tool-payload/compare.cjs <baseline.json> <candidate.json>');
const [baseline, candidate] = [baselinePath, candidatePath].map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
const generatedTimestamp = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}/g;
const generatedRecordId = /tcr-\d+-[a-f\d-]{36}/g;
const normalize = value => JSON.stringify(value).replace(generatedTimestamp, '<timestamp>').replace(generatedRecordId, '<record>');
const byteCount = value => Buffer.byteLength(JSON.stringify(value));

assert.deepEqual(baseline.invocations, candidate.invocations);
const measures = {};
for (const label of ['json', 'sse']) {
    const before = baseline.cases[label];
    const after = candidate.cases[label];
    assert.equal(normalize(after.rag), normalize(before.rag), label + ' RAG inputs');
    assert.equal(normalize(after.visible), normalize(before.visible), label + ' client response');
    const withoutAiView = rounds => rounds.map(round => round.map(({ contentForAI, ...result }) => result));
    assert.equal(normalize(withoutAiView(after.executor)), normalize(before.executor), label + ' executor display and raw fields');
    const onlyPayloadChanged = messages => messages.map(message => {
        const content = typeof message.content === 'string' ? message.content : message.content?.[0]?.text;
        return message.role === 'user' && content?.startsWith('<!-- VCP_TOOL_PAYLOAD -->')
            ? { ...message, content: '<payload>' } : message;
    });
    assert.deepEqual(after.providerRequests.map(onlyPayloadChanged), before.providerRequests.map(onlyPayloadChanged));
    for (const [round, count] of before.providerRequests.map(byteCount).entries()) {
        const actual = byteCount(after.providerRequests[round]);
        if (round === 0) assert.equal(actual, count);
        else assert.ok(actual < count);
    }
    measures[label] = { baselineMessagesBytes: before.providerRequests.map(byteCount), candidateMessagesBytes: after.providerRequests.map(byteCount) };
}
console.log(JSON.stringify(measures, null, 2));

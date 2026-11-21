'use strict';

// Compare captures made on separate synthetic Profiles while verifying all derived message hashes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const sha = text => createHash('sha256').update(text).digest('hex');
const textOf = ({content}) => typeof content === 'string' ? content :
    content.filter(part => part.type === 'text').map(part => part.text).join('\n');

function canonical(path, local) {
    const handler = structuredClone(path.handler.body);
    const provider = structuredClone(path.provider.body);
    const ext = handler.vcpchatExtensions;
    assert.equal(handler.requestId, provider.requestId);
    assert.equal(handler.requestId, ext.requestContext.requestId);
    const history = path.persistedHistory || path.persistedJournalMessages;
    const current = history.at(-2);
    assert.equal(current.role, 'user');
    handler.requestId = provider.requestId = ext.requestContext.requestId = '<original request>';
    if (!local) {
        assert.match(ext.requestContext.agentId, /^shared_[0-9a-f]+$/);
        assert.match(ext.requestContext.topicId, /^shared_[0-9a-f]+$/);
        ext.requestContext.agentId = '<shared agent>';
        ext.requestContext.topicId = '<shared topic>';
    }
    if (local) {
        for (const body of [handler, provider]) {
            for (const message of body.messages) {
                if (typeof message.content === 'string') {
                    message.content = message.content.replaceAll(/\/tmp\/vcp-context-native-[a-zA-Z0-9]+\/profile\//g, '/<synthetic-profile>/');
                }
            }
        }
    }
    for (const binding of ext.messageTimestampBindings) {
        const index = binding.sentMessageIndex;
        const row = history.find(message => message.id === binding.messageId);
        assert.ok(row, 'timestamp binding must identify a persisted message');
        assert.equal(binding.timestamp, row.timestamp);
        assert.equal(binding.timestampIso, new Date(row.timestamp).toISOString());
        assert.equal(binding.sentMessageHash, 'sha256:' + sha(textOf(path.handler.body.messages[index])));
        binding.sentMessageHash = 'sha256:' + sha(textOf(handler.messages[index]));
        if (local && row.id === current.id) {
            binding.messageId = '<current input>';
            binding.timestamp = '<click time>';
            binding.timestampIso = '<click ISO>';
        }
    }
    return {handler, provider};
}

function reorderBaselineTavernDepth({ handler, provider }) {
    // Baseline counted a historical system row toward depth and left it in place.
    // This is the only permitted difference when comparing the two shared bodies.
    const oldIndexByNewIndex = [0, 4, 2, 1, 3, 5, 6];
    for (const body of [handler, provider]) {
        assert.equal(body.messages.length, oldIndexByNewIndex.length);
        body.messages = oldIndexByNewIndex.map(index => body.messages[index]);
    }
    const bindings = handler.vcpchatExtensions.messageTimestampBindings;
    for (const binding of bindings) {
        binding.sentMessageIndex = oldIndexByNewIndex.indexOf(binding.sentMessageIndex);
    }
    bindings.sort((a, b) => a.sentMessageIndex - b.sentMessageIndex);
}

const [beforeFile, afterFile] = process.argv.slice(2);
if (!beforeFile || !afterFile) throw Error('Usage: node compare.cjs BEFORE.json AFTER.json');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const before = read(beforeFile), after = read(afterFile);
assert.equal(before.inputSha256, after.inputSha256);
assert.equal(before.scenario, after.scenario);
for (const variant of ['native','shared']) {
    const a = canonical(before.paths[variant], variant === 'native');
    const b = canonical(after.paths[variant], variant === 'native');
    const depthChanged = before.scenario === 'tavern-depth' && variant === 'shared';
    if (depthChanged) {
        assert.notDeepEqual(b, a, 'baseline shared depth divergence was not observed');
        reorderBaselineTavernDepth(a);
    }
    assert.deepEqual(b, a, variant + ' request changed');
    console.log(variant + ': handler and Provider bodies match after canonicalization' +
        (depthChanged ? ' and the expected Tavern depth reorder' : ''));
}

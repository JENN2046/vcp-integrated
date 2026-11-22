'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const spec = require('./input.json');

const [input, output] = process.argv.slice(2);
assert.ok(input && output, 'Usage: node tests/speaker-semantics/report.cjs <evidence.json> <report.json>');
const run = JSON.parse(fs.readFileSync(input, 'utf8'));
const [memberA, memberB] = spec.speakers;
const sameBody = spec.replyA;
const preSigned = spec.history.find(row => row.id === 'gc-history-pre-signed');
const ownTag = `[${preSigned.name}的发言]: `;
const preSignedMarker = preSigned.content.slice(ownTag.length);
const stagesExpected = ['detectors', 'final-context', 'stream-loop-input'];
const preservesInternalNames = run.variant === 'candidate';
const invite = spec.group.invitePrompt.replace('{{VCPChatAgentName}}', memberB.name);
const signed = member => `[${member.name}的发言]: ${sameBody}`;
const plainText = message => Array.isArray(message.content)
    ? message.content.filter(part => part.type === 'text').map(part => part.text).join('') : message.content;

function sameBodySpeakers(messages) {
    return messages.flatMap((message, index) => {
        if (message.role !== 'assistant' || !plainText(message)?.includes(sameBody)) return [];
        const { content, ...fields } = message;
        return [{ index, text: plainText(message), fields }];
    });
}

function summarize(messages) {
    const speakers = sameBodySpeakers(messages);
    const inviteMessage = messages.find(message => plainText(message) === invite);
    assert.ok(inviteMessage, 'invitation control is present');
    const signedMessages = messages.filter(message => plainText(message)?.includes(preSignedMarker));
    assert.equal(signedMessages.length, 1);
    const signedText = plainText(signedMessages[0]);
    return { speakers, invite: { text: invite, name: inviteMessage.name ?? null },
        preSigned: { text: signedText, tagCount: signedText.split(ownTag).length - 1 } };
}

function project(surface) {
    const shared = surface === 'shared';
    const sourceRows = shared ? run.shared.journal.map(row => row.message) : run.native.history;
    const history = sourceRows.filter(row => row.role === 'assistant' && row.content === sameBody)
        .map(({ id, name, agentId, content }) => ({ id, name, agentId, content }));
    const expected = [memberB, memberA].map(member => ({
        name: member.name, agentId: shared ? run.shared.memberIds[member.id] : member.id, content: sameBody,
    }));
    assert.deepEqual(history.map(({ id, ...row }) => row), expected);
    const storedSigned = sourceRows.find(row => row.id === preSigned.id);
    assert.equal(storedSigned.content, preSigned.content);
    assert.equal(storedSigned.name, preSigned.name);
    assert.equal(storedSigned.agentId, shared ? run.shared.memberIds[preSigned.agentId] : preSigned.agentId);
    const workId = shared ? run.shared.work.id : null;
    const handlers = run.handler.filter(row => row.kind === 'handler' && row.workId === workId && row.body.requestId !== run.namedControl.requestId);
    assert.deepEqual(handlers.map(row => row.member), ['A', 'B']);
    const handlerB = handlers[1];
    const stages = run.handler.filter(row => row.kind === 'speaker-stage' && row.member === 'B' && row.workId === workId && row.requestId !== run.namedControl.requestId);
    assert.deepEqual(stages.map(row => row.stage).filter(stage => stage !== 'role-divider'), stagesExpected);
    const providerFor = handler => run.provider.find(row => row.member === handler.member &&
        (handler.body.requestId ? row.body.requestId === handler.body.requestId : row.body.messageId === handler.body.messageId));
    const providerA = providerFor(handlers[0]);
    const providerB = providerFor(handlerB);
    assert.ok(providerA && providerB, 'both calls reached the loopback Provider');
    assert.deepEqual(sameBodySpeakers(providerA.body.messages).map(row => row.text),
        [signed(memberB)]);

    const handler = summarize(handlerB.body.messages);
    const extensions = handlerB.body.vcpchatExtensions;
    assert.deepEqual(handler.speakers.map(({ index }) => extensions.messageTimestampBindings.find(binding => binding.sentMessageIndex === index)?.messageId),
        history.map(row => row.id));
    const toolbox = stages.map(({ stage, source, messages }) => ({ stage, source, ...summarize(messages) }));
    const provider = summarize(providerB.body.messages);
    const repeatsTag = run.variant === 'baseline' && shared;
    for (const { speakers, preSigned: observedSignature } of [handler, ...toolbox, provider]) {
        assert.deepEqual(speakers.map(row => row.text), [signed(memberB), signed(memberA)]);
        assert.deepEqual(observedSignature, { text: repeatsTag ? ownTag + preSigned.content : preSigned.content,
            tagCount: repeatsTag ? 2 : 1 });
    }
    const finalContext = toolbox.find(row => row.stage === 'final-context');
    const streamLoopInput = toolbox.find(row => row.stage === 'stream-loop-input');
    assert.deepEqual(finalContext.speakers, provider.speakers);
    assert.equal(handler.invite.name, '用户');
    assert.equal(toolbox[0].invite.name, '用户');
    assert.equal(finalContext.invite.name, null);
    assert.equal(streamLoopInput.invite.name, preservesInternalNames ? '用户' : null);
    assert.equal(provider.invite.name, null);
    assert.equal(Object.hasOwn(providerB.body, 'vcpchatExtensions'), false);
    for (const { speakers } of [handler, ...toolbox, provider]) {
        assert.deepEqual(speakers.map(row => row.fields), [{ role: 'assistant' }, { role: 'assistant' }]);
    }

    const { requestContext = null, messageTimestampBindings, ...otherExtensions } = extensions;
    if (shared) {
        assert.equal(requestContext.agentId, run.shared.memberIds[memberB.id]);
        assert.equal(requestContext.agentName, memberB.name);
        const aAtB = providerB.committedJournal.find(row => row.id === history[1].id);
        assert.equal(aAtB?.content, sameBody);
    } else {
        assert.equal(requestContext, null);
        const aAtB = run.native.dispatch[2].committed.find(row => row.id === history[1].id);
        assert.equal(aAtB?.content, sameBody);
    }

    return {
        history, preSignedHistory: { id: storedSigned.id, name: storedSigned.name, agentId: storedSigned.agentId, text: storedSigned.content },
        workId, route: handlerB.route,
        memberBRequestId: handlerB.body.requestId || handlerB.body.messageId,
        requestContext, handlerExtensions: otherExtensions, handler, toolbox,
        provider: { route: providerB.route, ...provider },
    };
}

function namedControl() {
    const id = run.namedControl.requestId;
    const handler = run.handler.find(row => row.kind === 'handler' && row.body.requestId === id);
    const stages = run.handler.filter(row => row.kind === 'speaker-stage' && row.requestId === id);
    const provider = run.provider.find(row => row.body.requestId === id);
    const source = spec.namedControl.slice(1);
    const projectControl = messages => messages.filter(message => source.some(row => row.content === plainText(message)))
        .map(message => ({ role: message.role, text: plainText(message), name: message.name ?? null }));
    const expected = source.map(({ role, content: text, name }) => ({ role, text, name }));
    const cleaned = expected.map(row => ({ ...row, name: null }));
    const internal = stages.map(({ stage, source, messages }) => ({ stage, source, messages: projectControl(messages) }));
    assert.equal(handler.workId, null);
    assert.equal(run.namedControl.status, 200);
    assert.equal(run.namedControl.completed, true);
    assert.deepEqual(internal.map(row => row.stage).filter(stage => stage !== 'role-divider'), stagesExpected);
    assert.deepEqual(projectControl(handler.body.messages), expected);
    assert.deepEqual(internal[0].messages, expected);
    assert.deepEqual(internal.find(row => row.stage === 'final-context').messages, cleaned);
    assert.deepEqual(internal.find(row => row.stage === 'stream-loop-input').messages, preservesInternalNames ? expected : cleaned);
    assert.deepEqual(projectControl(provider.body.messages), cleaned);
    return { ...run.namedControl, handler: projectControl(handler.body.messages), internal,
        provider: { route: provider.route, messages: projectControl(provider.body.messages) } };
}

assert.deepEqual(run.provider.map(row => row.member), ['A', 'B', 'A', 'B', 'B']);
assert.equal(run.shared.mobile.sameLedgerAndPackets, true);
assert.equal(run.native.terminalVisible, true);
assert.equal(run.shared.mobile.terminalVisible, true);
const result = {
    variant: run.variant,
    revision: run.revision,
    runtime: { node: run.nodeVersion, electron: run.native.renderer.version, browser: run.shared.mobile.browser },
    fixtureLimits: run.fixtureLimits,
    source: {
        desktop: run.native.sources.main.find(row => row.file.endsWith('/groupchat.js')),
        handler: run.backend.find(row => row.file.endsWith('/chatCompletionHandler.js')),
        projector: run.handler.find(row => row.kind === 'speaker-projector').source,
    },
    sharedReplayKeptLedgerAndPackets: run.shared.mobile.sameLedgerAndPackets,
    native: project('native'),
    shared: project('shared'),
    namedControl: namedControl(),
};
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');

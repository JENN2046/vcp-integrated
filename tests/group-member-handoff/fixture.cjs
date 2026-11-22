'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createFixture } = require('../group-relay/fixture.cjs');
const nextInput = 'GROUP_REVIEW_CLOSEOUT_NEXT_INPUT';
const isNextInput = text => text === nextInput || text === '[用户的发言]: ' + nextInput;
const hasNextInput = body => body.messages.some(({ role, content }) => role === 'user' &&
    (isNextInput(content) || Array.isArray(content) && content.some(part => part.type === 'text' && isNextInput(part.text))));

function create() {
    const mode = process.env.NS_GROUP_HANDOFF_CASE;
    const frames = [];
    const requests = [];
    const fixture = createFixture();
    const closeout = mode === 'review-closeout';
    const isCandidate = mode.startsWith('handoff');
    let loseAck = isCandidate;
    let loseContinueAck = mode === 'handoff';
    let loseCloseoutAck = closeout;
    let secondFinal, secondCut;
    if (isCandidate) fixture.finishFutureRounds();
    function seed(f) {
        const members = ['A', 'B'].map(name => f.shared.create(f.actor('C'), {
            sharedSpaceId: 'sharedAB', opId: 'handoff-agent-' + name, kind: 'agent', localId: 'handoff-agent-' + name,
            config: { ...f.owner.config, name, systemPrompt: 'GROUP_RELAY_MEMBER_' + name, streamOutput: true },
        }).object.id);
        const group = f.shared.create(f.actor('C'), {
            sharedSpaceId: 'sharedAB', opId: 'handoff-group', kind: 'group', localId: 'handoff-group',
            config: { name: 'Relay fixture A B', mode: 'sequential', members, sequentialSpeakerOrder: members },
        }).object;
        const groupTopic = f.shared.create(f.actor('C'), {
            sharedSpaceId: 'sharedAB', opId: 'handoff-topic', kind: 'topic', localId: 'handoff-topic',
            parentId: group.id, localParent: 'handoff-group', config: { name: 'Relay round' },
        }).object;
        return { groupTopic };
    }
    return {
        frames,
        requests,
        seed,
        observed(out) {
            if (!isCandidate) return undefined;
            return {
                preload: path.join(__dirname, 'server-capture.cjs'),
                handlerLog: path.join(out, 'group-handler.jsonl'), input: 'GROUP_HANDOFF_BASELINE_INPUT',
                seedCount: 0, seed() {},
            };
        },
        proxyHooks: {
            observeRequest(method, route) {
                return method === 'POST' && (/\/shared\/group-(handoff|continue)$/.test(route)
                    || closeout && route.endsWith('/shared/abandon'));
            },
            dropResponse(row) {
                if (row.status < 200 || row.status >= 300) return false;
                if (loseCloseoutAck && row.route.endsWith('/shared/abandon')) {
                    loseCloseoutAck = false;
                    return true;
                }
                if (loseAck && row.route.endsWith('/group-handoff')) {
                    loseAck = false;
                    return true;
                }
                if (loseContinueAck && row.route.endsWith('/group-continue')) {
                    loseContinueAck = false;
                    return true;
                }
                return false;
            },
        },
        finishB() { secondFinal(); },
        cutB() { secondCut(); },
        respond(body, row, response) {
            const member = JSON.stringify(body.messages?.find(message => message.role === 'system'))
                ?.match(/GROUP_RELAY_MEMBER_([ABC])/)?.[1];
            if (!member) return false;
            row.member = member;
            requests.push({ member, packet: body });
            if (closeout) {
                if (!hasNextInput(body)) {
                    row.case = 'fixtureError';
                    response.writeHead(500).end('Unexpected dispatch of original Work');
                    return true;
                }
                const text = 'REVIEW_NEXT_' + member + '_FINAL';
                const reply = (delta, finish_reason) => 'data: ' + JSON.stringify({
                    id: 'synthetic-review-closeout-next', object: 'chat.completion.chunk', model: 'synthetic',
                    choices: [{ index: 0, delta, finish_reason }],
                }) + '\n\n';
                frames.push({ member, text });
                response.writeHead(200, { 'content-type': 'text/event-stream' });
                response.end(reply({ role: 'assistant', content: text }, null) + reply({}, 'stop') + 'data: [DONE]\n\n');
                return true;
            }
            if ((['a-partial', 'handoff-a-partial'].includes(mode) && member === 'A') || member === 'B') {
                response.writeHead(200, { 'content-type': 'text/event-stream' });
                const text = `RELAY_${member}_PARTIAL`;
                frames.push({ member, text });
                response.write('data: ' + JSON.stringify({
                    id: 'synthetic-group-member-handoff', object: 'chat.completion.chunk',
                    model: 'synthetic', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
                }) + '\n\n');
                if (isCandidate && member === 'B') {
                    secondCut = () => response.destroy();
                    secondFinal = () => {
                        const text = ' RELAY_B_FINAL';
                        for (const [delta, finish_reason] of [[{ content: text }, null], [{}, 'stop']]) {
                            response.write('data: ' + JSON.stringify({
                                id: 'synthetic-group-member-handoff', object: 'chat.completion.chunk',
                                model: 'synthetic', choices: [{ index: 0, delta, finish_reason }],
                            }) + '\n\n');
                        }
                        response.end('data: [DONE]\n\n');
                    };
                }
                return true;
            }
            return fixture.respond(body, row, response);
        },
        async cutBeforeDispatch(request, response, route) {
            if (request.method !== 'POST' || !route.endsWith('/native-request')) return false;
            if (mode !== 'a-committed') return false;
            if (requests.filter(row => row.member === 'A').length !== 1) return false;
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks));
            frames.push({ interceptedBeforeToolBox: body.requestId });
            return true;
        },
    };
}

module.exports = { create, nextInput, hasNextInput };

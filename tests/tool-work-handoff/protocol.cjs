'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { start } = require('../integration/service.cjs');
const counter = require('../ordinary-tools/fixture.cjs');
const { stable, sha256 } = require('../../apps/server/Plugin/NativeSync/sync/protocol');

const prefix = '/api/v1/sync/shared/';
const marker = 'ORDINARY_TOOL_LOCAL';
const summary = 'Continue the original Work after the settled counter call.';
const toolCall = [
    '<<<[TOOL_REQUEST]>>>',
    'tool_name:「始」' + counter.name + '「末」,',
    'command:「始」Count「末」,',
    'marker:「始」' + marker + '「末」',
    '<<<[END_TOOL_REQUEST]>>>',
].join('\n');

async function waitUntil(check, label) {
    const end = Date.now() + 15000;
    do {
        const result = await check();
        if (result) return result;
        await delay(40);
    } while (Date.now() < end);
    throw Error('Timed out waiting for ' + label);
}

async function main() {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-tool-work-protocol-'));
    const cert = path.join(out, 'cert.pem');
    const key = path.join(out, 'key.pem');
    let service;
    let passed = false;
    try {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
            '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert], { stdio: 'ignore' });
        service = await start({
            out, candidate: path.resolve(__dirname, '../..'), cert, key, waitUntil, trace() {},
            ordinaryTools: counter,
            toolHandoff: { env: { NativeSyncSharedSafeTools: JSON.stringify([counter.name]) }, observeRequest: () => false },
            streamInterrupt: {
                roleDivider: false,
                stage() {},
                async respond(body, row, res) {
                    const ask = body.messages.findLast(message => message.role === 'user').content;
                    if (ask === 'stream-one-tool') {
                        assert.equal(body.stream, true);
                        const choices = [{ index: 0, delta: { role: 'assistant', content: 'Visible pause.\n' + toolCall }, finish_reason: 'stop' }];
                        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                        res.end('data: ' + JSON.stringify({ id: 'stream-one', choices }) + '\n\ndata: [DONE]\n\n');
                    } else {
                        assert.ok(['nonstream-two-tools', summary].includes(ask));
                        assert.equal(body.stream, false);
                        const content = ask === summary ? toolCall : toolCall + '\n' + toolCall;
                        const choices = [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }];
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ id: 'nonstream-two', choices }));
                    }
                    return true;
                },
            },
        });
        const { spaceId } = JSON.parse(fs.readFileSync(path.join(out, 'seed/desktopA/.native-sync/connection.json')));
        const headers = {
            authorization: 'Bearer synthetic-only', 'content-type': 'application/json',
            'x-nativesync-space': spaceId, 'x-nativesync-device': 'deviceA', 'x-nativesync-source': 'sourceA', 'x-nativesync-protocol': '2',
            'x-nativesync-capabilities': 'shared-space-v1,shared-context-v1,shared-controlled-tools-v1,shared-steering-v1',
        };
        const sharedSpaceId = 'sharedAB';
        const send = (route, body, extra) => fetch(service.wsOrigin + route, {
            method: body ? 'POST' : 'GET', headers: { ...headers, ...extra }, body: body && JSON.stringify(body),
            signal: AbortSignal.timeout(15000),
        });
        const api = async (route, body, extra) => {
            const response = await send(prefix + route, body, extra);
            const value = await response.json();
            assert.ok(response.ok, route + ' ' + JSON.stringify(value));
            return value;
        };
        async function dispatch(topic, content, streaming) {
            const sharedId = service.topics[topic].id;
            const descriptor = service.descriptors.A[topic];
            const context = await api('context?' + new URLSearchParams({ sharedSpaceId, sharedId }));
            const id = randomUUID();
            const work = await api('admit', { sharedSpaceId, sharedId, requestId: id, expectedHead: context.head, configHash: context.hash,
                message: { id, role: 'user', content, timestamp: Date.now() }, controlMode: 'safe-tools-v1' });
            const requestId = 'reply_' + work.id;
            const packet = { requestId, model: 'synthetic', stream: streaming, messages: [{ role: 'user', content }],
                vcpchatExtensions: { requestContext: { ownerType: 'agent', agentId: descriptor.itemId, topicId: descriptor.topicId } } };
            if (streaming) {
                const control = { sharedSpaceId, workId: work.id };
                const expectPending = async (route, body) => {
                    const response = await send(prefix + route, { ...control, opId: randomUUID(), ...body });
                    assert.equal(response.status, 409);
                    assert.equal((await response.json()).error.code, 'WORK_SAFE_BOUNDARY_PENDING');
                };
                await expectPending('steer-checkpoint', { generation: 0, message: {
                    id: requestId, role: 'assistant', content: 'handwritten receipt', timestamp: Date.now(), finishReason: 'interrupted',
                } });
                await expectPending('steer-prepare', { expectedRevision: 0, expectedGeneration: 0,
                    expectedHead: context.head, configHash: context.hash });
            }
            await api('native-request', { sharedSpaceId, admissionId: work.id, requestId, bodyHash: sha256(stable(packet)), generation: 0, consumedInputSeq: 0 });
            const response = await send('/v1/chat/completions', packet, {
                'x-nativesync-admission': work.id, 'x-nativesync-generation': '0', 'x-nativesync-consumed-input-seq': '0',
            });
            const readWork = async () => (await api('work?' + new URLSearchParams({ sharedSpaceId, workId: work.id }))).request;
            return { response, requestId, readWork };
        }

        const multi = await dispatch('preSubmit', 'nonstream-two-tools', false);
        assert.equal(multi.response.status, 500);
        assert.equal((await multi.response.json()).details, 'CONTROLLED_TOOL_CALL_LIMIT');
        const held = await waitUntil(async () => {
            const work = await multi.readWork();
            return work.state === 'review_required' && work;
        }, 'closed multi-tool request');
        assert.deepEqual(held.toolInvocations, []);
        assert.equal(counter.counts(out).length, 0);

        const stream = await dispatch('interrupted', 'stream-one-tool', true);
        assert.equal(stream.response.status, 200);
        assert.match(stream.response.headers.get('content-type'), /text\/event-stream/i);
        const text = await stream.response.text();
        const pause = text.match(/event: nativesync_work_paused\ndata: ([^\n]+)/);
        assert.ok(pause, text);
        assert.deepEqual(JSON.parse(pause[1]), { nativeSync: { state: 'paused', code: 'WORK_SAFE_TOOL_BOUNDARY', requestId: stream.requestId } });
        const settled = await stream.readWork();
        assert.equal(settled.state, 'dispatched');
        assert.equal(settled.steering.applicationState, 'awaiting_compaction');
        assert.equal(settled.toolInvocations.length, 1);
        assert.equal(settled.toolInvocations[0].state, 'returned');
        const sideEffectsBefore = counter.counts(out).length;
        assert.equal(sideEffectsBefore, 1);
        const scope = { sharedSpaceId, sharedId: service.topics.interrupted.id };
        const work = { sharedSpaceId, workId: settled.id };
        const expected = { ...work, expectedRevision: 0, expectedGeneration: 0 };
        const b = { 'x-nativesync-device': 'deviceB', 'x-nativesync-source': 'sourceB' };
        const context = device => api('context?' + new URLSearchParams(scope), undefined, device);
        const compact = await api('compact-prepare', { ...scope, opId: randomUUID(), expectedHead: (await context()).head });
        const plan = await api('compact-input?' + new URLSearchParams({ sharedSpaceId, id: compact.id }));
        assert.ok(plan.history.some(row => row.id.startsWith('native_evidence_') && row.content.includes(settled.toolInvocations[0].invocationId)));
        const checkpoint = { id: compact.messageId, role: 'user', content: summary, timestamp: Date.now(),
            contextCompaction: { kind: 'vchat-context-checkpoint', version: 1, checkpoint: summary } };
        await api('compact-commit', { sharedSpaceId, id: compact.id, opId: randomUUID(), sourceHash: plan.sourceHash, message: checkpoint });
        const handoff = await api('steer-handoff', { ...expected, expectedExecutor: 'desktop:deviceA', opId: randomUUID() }, b);
        assert.equal(handoff.executor, 'desktop:deviceB');
        const current = await context(b);
        const prepare = { ...expected, expectedHead: current.head, configHash: current.hash, opId: randomUUID() };
        const prepared = await waitUntil(async () => {
            const response = await send(prefix + 'steer-prepare', prepare, b);
            const value = await response.json();
            if (value.error?.code === 'WORK_STEERING_COALESCING') return false;
            assert.ok(response.ok, JSON.stringify(value));
            return value;
        }, 'continuation coalescing window');
        assert.equal(prepared.workId, settled.id);
        assert.equal(prepared.generation, 1);
        const descriptor = service.descriptors.B.interrupted;
        const packet = { requestId: prepared.requestId, model: 'synthetic', stream: false, messages: [{ role: 'user', content: summary }],
            vcpchatExtensions: { requestContext: { ownerType: 'agent', agentId: descriptor.itemId, topicId: descriptor.topicId },
                messageTimestampBindings: [{ messageId: checkpoint.id, sentMessageIndex: 0, timestamp: checkpoint.timestamp }] } };
        await api('native-request', { sharedSpaceId, admissionId: settled.id, requestId: prepared.requestId,
            bodyHash: sha256(stable(packet)), generation: 1, consumedInputSeq: 0 }, b);
        const retry = await send('/v1/chat/completions', packet, { ...b, 'x-nativesync-admission': settled.id,
            'x-nativesync-generation': '1', 'x-nativesync-consumed-input-seq': '0' });
        assert.equal(retry.status, 500);
        const rejection = (await retry.json()).details;
        assert.equal(rejection, 'CONTROLLED_TEXT_TOOLS_FORBIDDEN');
        const reviewed = await waitUntil(async () => {
            const value = await stream.readWork();
            return value.state === 'review_required' && value;
        }, 'continuation tool refusal');
        assert.equal(reviewed.id, settled.id);
        assert.deepEqual(reviewed.toolInvocations, settled.toolInvocations);
        assert.equal(counter.counts(out).length, 1);
        assert.equal(service.calls.length, 3);
        if (process.env.VCP_PROTOCOL_EVIDENCE) {
            const evidence = {
                workId: reviewed.id,
                originalNativeRequestId: stream.requestId,
                continuationNativeRequestId: prepared.requestId,
                executor: handoff.executor,
                generation: prepared.generation,
                invocationIdsBefore: settled.toolInvocations.map(call => call.invocationId),
                invocationIdsAfter: reviewed.toolInvocations.map(call => call.invocationId),
                sideEffectsBefore,
                sideEffectsAfter: counter.counts(out).length,
                providerCalls: service.calls.length,
                continuationHttpStatus: retry.status,
                continuationRejection: rejection,
                finalWorkState: reviewed.state,
            };
            fs.writeFileSync(process.env.VCP_PROTOCOL_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
        }
        passed = true;
        console.log('Tool Work transport PASS (stream pause after one returned call, multi-call refused before dispatch, B cannot repeat the tool)');
    } finally {
        await service?.close();
        if (passed) fs.rmSync(out, { recursive: true, force: true });
        else {
            fs.rmSync(key, { force: true });
            console.error('Synthetic logs retained in ' + out);
        }
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

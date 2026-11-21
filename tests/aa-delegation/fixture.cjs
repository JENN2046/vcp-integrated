'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { start } = require('../integration/service.cjs');

const childModel = 'synthetic-aa-child';
const agentName = 'SyntheticDelegate';
const markers = Object.fromEntries(['COMPLETE', 'CANCEL', 'CRASH', 'DESKTOP'].map(label =>
    [label.toLowerCase(), 'AA_DELEGATION_' + label]));
const childReport = 'AA_DELEGATION_CHILD_REPORT';
const parentText = 'AA_DELEGATION_PARENT_REPLY';
const placeholderPattern = /\{\{VCP_ASYNC_RESULT::AgentAssistant::([^{}]+)\}\}/g;

async function waitUntil(fn, label, timeout = 12000) {
    const deadline = Date.now() + timeout;
    do {
        const result = await fn();
        if (result) return result;
        await delay(25);
    } while (Date.now() < deadline);
    throw Error('Timed out waiting for ' + label);
}

function stage(box) {
    const dir = path.join(box, 'Plugin/AgentAssistant');
    fs.copyFileSync(path.join(dir, 'plugin-manifest.json.example'), path.join(dir, 'plugin-manifest.json'));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        delegationMaxRounds: 3,
        delegationTimeout: 60000,
        agents: [{ baseName: 'SYNTHETIC', modelId: childModel, chineseName: agentName, systemPrompt: 'Synthetic child fixture' }],
    }));
}

function writeCompletion(body, res, content) {
    if (res.destroyed) return;
    const common = { id: 'synthetic-fixture', created: 1, model: body.model };
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const [delta, finishReason] of [[{ role: 'assistant', content }, null], [{}, 'stop']]) {
            const payload = { ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finishReason }] };
            res.write('data: ' + JSON.stringify(payload) + '\n\n');
        }
        res.end('data: [DONE]\n\n');
        return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        ...common, object: 'chat.completion', usage,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    }));
}

async function startFixture({
    out, candidate, trace = () => {}, serverRevision, selectParent = () => true,
    singleChildRound = false, beforeParentFinal, ...serviceOptions
}) {
    const cert = path.join(out, 'loopback-cert.pem');
    const key = path.join(out, 'loopback-key.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=Synthetic AgentAssistant fixture', '-addext', 'subjectAltName=IP:127.0.0.1',
        '-keyout', key, '-out', cert], { stdio: 'ignore' });
    const gates = new Map(Object.values(markers).map(marker => {
        let resolve;
        const ready = new Promise(release => { resolve = release; });
        return [marker, { ready, resolve, childRounds: 0, parentRounds: 0 }];
    }));
    const delegation = {
        stage,
        classify(body, row) {
            if (body.model !== childModel && !selectParent(body)) return false;
            const users = body.messages.filter(message => message.role === 'user')
                .map(message => JSON.stringify(message.content));
            const marker = users.map(user => Object.values(markers).find(value => user.includes(value)))
                .findLast(Boolean);
            if (!marker) return false;
            row.marker = marker;
            row.role = body.model === childModel ? 'child' : 'parent';
            row.model = body.model;
            const gate = gates.get(marker);
            row.round = row.role === 'child' ? ++gate.childRounds : ++gate.parentRounds;
            return true;
        },
        async reply(body, row, res) {
            if (row.role === 'child') {
                row.launch = row.round === 1 || !body.messages.some(message => message.role === 'assistant');
                if (row.round === 1) {
                    await Promise.race([gates.get(row.marker).ready, new Promise(resolve => res.once('close', resolve))]);
                    if (singleChildRound) return writeCompletion(body, res, '[[Flowlock::Complete]]\n' + childReport);
                    // The second child round demonstrates a heartbeat on the same launch.
                    return writeCompletion(body, res, '[[Flowlock::Start]][[Flowlock::NextHeartbeat::1]]');
                }
                return writeCompletion(body, res, '[[Flowlock::Complete]]\n' + childReport);
            }
            const toolMessages = body.messages.slice(body.messages.findLastIndex(message =>
                message.role === 'user' && JSON.stringify(message.content).includes(row.marker)) + 1);
            const placeholders = toolMessages.flatMap(message => [...JSON.stringify(message.content).matchAll(placeholderPattern)]);
            if (placeholders.length) {
                await beforeParentFinal?.({
                    waitForChildDispatch: () => waitUntil(() => gates.get(row.marker).childRounds > 0, 'AA child provider dispatch'),
                });
                row.delegationId = placeholders.at(-1)[1];
                return writeCompletion(body, res, parentText + '\n' + placeholders.at(-1)[0]);
            }
            return writeCompletion(body, res, [
                '<<<[TOOL_REQUEST]>>>',
                'tool_name:「始」AgentAssistant「末」,',
                'agent_name:「始」' + agentName + '「末」,',
                'prompt:「始」' + row.marker + '「末」,',
                'task_delegation:「始」true「末」',
                '<<<[END_TOOL_REQUEST]>>>',
            ].join('\n'));
        },
    };

    let service;
    try {
        service = await start({ out, candidate, cert, key, trace, waitUntil, serverRevision, delegation, ...serviceOptions });
    } finally {
        fs.rmSync(key, { force: true });
    }
    const { spaceId } = JSON.parse(fs.readFileSync(path.join(out, 'seed/desktopA/.native-sync/connection.json')));
    function request(route, body, actor = 'A') {
        return new Promise((resolve, reject) => {
            const isAdmin = route.startsWith('/admin_api/');
            const req = https.request(service.origin + (route.startsWith('/') ? route : '/api/v1/sync/shared/' + route), {
                method: body === undefined ? 'GET' : 'POST',
                ca: fs.readFileSync(cert),
                headers: {
                    authorization: isAdmin
                        ? 'Basic ' + Buffer.from('synthetic-admin:synthetic-admin-only').toString('base64')
                        : 'Bearer synthetic-only',
                    'content-type': 'application/json',
                    'x-nativesync-source': 'source' + actor,
                    'x-nativesync-device': 'device' + actor,
                    'x-nativesync-space': spaceId,
                    'x-nativesync-protocol': '2',
                    'x-nativesync-capabilities': 'shared-space-v1,shared-context-v1,shared-session-v1,shared-session-cancel-v1',
                },
            }, async response => {
                try {
                    const chunks = [];
                    for await (const chunk of response) chunks.push(chunk);
                    resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) });
                } catch (error) { reject(error); }
            });
            req.on('error', reject);
            req.setTimeout(5000, () => req.destroy(Error('Timed out requesting ' + route)));
            req.end(body === undefined ? undefined : JSON.stringify(body));
        });
    }
    const calls = marker => service.calls.filter(row => row.marker === marker);
    const release = marker => gates.get(marker).resolve();
    const close = () => {
        for (const gate of gates.values()) gate.resolve();
        return service.close();
    };
    return { service, cert, request, markers, calls, release, close, childReport, parentText };
}
module.exports = { startFixture, waitUntil };

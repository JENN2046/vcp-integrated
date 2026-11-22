'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { start } = require('../integration/service.cjs');
const { waitUntil } = require('../aa-delegation/fixture.cjs');
const { scalar, jsonText, image, object, sameShapeObject } = require('./plugin.cjs');

const name = 'SyntheticPayload';
const header = '<!-- VCP_TOOL_PAYLOAD -->';
const final = 'PAYLOAD_FIXTURE_COMPLETE';
const rounds = [['scalar', 'rawJson'], ['object', 'sameShapeObject'], ['media']];
const candidate = path.resolve(__dirname, '../..');
const evidencePath = process.argv[2];
const serverRevision = process.argv[3];
assert.ok(evidencePath, 'Usage: node tests/tool-payload/run.cjs <evidence.json> [baseline commit]');

function stage(box) {
    const dir = path.join(box, 'Plugin', name);
    fs.mkdirSync(dir);
    fs.copyFileSync(require.resolve('./plugin.cjs'), path.join(dir, 'plugin.cjs'));
    fs.writeFileSync(path.join(dir, 'plugin-manifest.json'), JSON.stringify({
        manifestVersion: '1.0.0', name, version: '1.0.0', displayName: name,
        description: 'Return synthetic tool output and record the invocation.',
        pluginType: 'hybridservice', entryPoint: { type: 'nodejs', script: 'plugin.cjs' },
        communication: { protocol: 'direct', timeout: 2500 },
        capabilities: { invocationCommands: [{ commandIdentifier: 'ReadFixture', description: 'Read synthetic fixture output.' }] },
    }));
}

function toolCall(label, sample) {
    return [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」' + name + '「末」,',
        'command:「始」ReadFixture「末」,',
        'label:「始」' + label + '「末」,',
        'sample:「始」' + sample + '「末」',
        '<<<[END_TOOL_REQUEST]>>>',
    ].join('\n');
}

function sendCompletion(body, res, content) {
    const common = { id: 'synthetic-payload', model: 'synthetic', created: 1 };
    if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const [delta, finish_reason] of [[{ role: 'assistant', content }, null], [{}, 'stop']]) {
            res.write('data: ' + JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
        }
        res.end('data: [DONE]\n\n');
    } else {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
            ...common, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
    }
}

function localRequest(origin, cert, label) {
    return new Promise((resolve, reject) => {
        const request = https.request(origin + '/v1/local-chat/completions', {
            method: 'POST', ca: cert, headers: { authorization: 'Bearer synthetic-only', 'content-type': 'application/json' }
        }, async response => {
            try {
                const body = [];
                for await (const chunk of response) body.push(chunk);
                resolve({ status: response.statusCode, body: Buffer.concat(body).toString(), mediaType: response.headers['content-type'] });
            } catch (error) { reject(error); }
        });
        request.on('error', reject);
        request.setTimeout(15000, () => request.destroy(Error('Timed out completing ' + label)));
        request.end(JSON.stringify({
            model: 'synthetic', stream: label === 'sse', messages: [{ role: 'user', content: 'PAYLOAD_FIXTURE_' + label }],
        }));
    });
}

function readRows(file) {
    return fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
}

function payloads(messages) {
    return messages.filter(({ role, content }) => role === 'user' &&
        (typeof content === 'string' ? content : content?.[0]?.text)?.startsWith(header));
}

function visibleContent(response, stream) {
    if (!stream) return JSON.parse(response.body).choices[0].message.content;
    const data = response.body.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6));
    assert.equal(data.at(-1), '[DONE]');
    return data.slice(0, -1).map(line => JSON.parse(line).choices?.[0]?.delta?.content ?? '').join('');
}

async function main() {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-tool-payload-'));
    const cert = path.join(out, 'cert.pem');
    const key = path.join(out, 'key.pem');
    const observationsFile = path.join(out, 'observations.jsonl');
    const requests = { json: [], sse: [] };
    let service;
    let passed = false;
    try {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
            '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert], { stdio: 'ignore' });
        service = await start({
            out, candidate, cert, key, waitUntil, mode: 'local-only', serverRevision, trace() {},
            toolHandoff: {
                observeRequest: () => false,
                env: { ShowVCP: 'true', RAGMemoRefresh: 'true', NODE_OPTIONS: '--require=' + JSON.stringify(require.resolve('./observe.cjs')),
                    VCP_TEST_PAYLOAD_OBSERVATIONS: observationsFile },
            },
            streamInterrupt: {
                roleDivider: true, stage, observeSummaryRequest() {},
                respond(body, row, res) {
                    const label = body.stream ? 'sse' : 'json';
                    assert.ok(body.messages.some(message => message.content === 'PAYLOAD_FIXTURE_' + label));
                    const requestsForLabel = requests[label];
                    const round = requestsForLabel.push(body.messages) - 1;
                    assert.ok(round <= rounds.length, 'ToolBox duplicated the continuation request');
                    assert.equal(payloads(body.messages).length, round);
                    sendCompletion(body, res, rounds[round]?.map(sample => toolCall(label, sample)).join('\n') ?? final);
                    return true;
                },
            },
        });
        const responseCases = {};
        for (const label of ['json', 'sse']) {
            const response = await localRequest(service.origin, fs.readFileSync(cert), label);
            assert.equal(response.status, 200, response.body);
            assert.match(response.mediaType, label === 'sse' ? /text\/event-stream/ : /application\/json/);
            const visible = visibleContent(response, label === 'sse');
            assert.ok(visible.includes(final), visible);
            responseCases[label] = visible;
        }
        const invocations = readRows(path.join(out, 'runtime-box/Plugin', name, 'invocations.jsonl'));
        const samples = rounds.flat().sort();
        assert.equal(invocations.length, samples.length * 2);
        for (const label of ['json', 'sse']) {
            assert.deepEqual(invocations.filter(row => row.label === label).map(row => row.sample).sort(), samples);
        }
        const observations = readRows(observationsFile);
        assert.deepEqual(observations.map(row => row.kind), Array.from({ length: 6 }, () => ['executor', 'rag']).flat());
        const cases = {};
        for (const [index, label] of ['json', 'sse'].entries()) {
            const providerRequests = requests[label];
            assert.equal(providerRequests.length, 4);
            const actual = payloads(providerRequests.at(-1)).map(message => message.content);
            const trace = observations.slice(index * 6, (index + 1) * 6);
            const executor = trace.filter(row => row.kind === 'executor').map(row => row.value);
            const rag = trace.filter(row => row.kind === 'rag').map(row => row.value);
            assert.deepEqual(executor.map(round => round.length), rounds.map(round => round.length));
            assert.deepEqual(JSON.parse(executor[0][0].content[0].text).original_plugin_output, scalar);
            assert.equal(executor[0][1].content[0].text, jsonText);
            assert.equal(JSON.parse(executor[1][0].content[0].text).original_plugin_output, object.original_plugin_output);
            const collision = executor[1][1];
            const { timestamp, tool_call_record_id, ...collisionBusinessData } = JSON.parse(collision.content[0].text);
            assert.deepEqual(collisionBusinessData, sameShapeObject);
            assert.equal(collision.contentForAI, undefined);
            assert.deepEqual(rag[2][1], { ...image, image_url: { url: '[Omitted]' } });
            assert.deepEqual(actual[2].slice(1), executor[2][0].content);
            assert.equal(actual[2][2].image_url.url, image.image_url.url);
            const visible = responseCases[label];
            assert.ok(visible.includes('VCP_TOOL_BATCH_START') && visible.includes('VCP_TOOL_BATCH_END'));
            assert.ok(visible.includes(scalar) && visible.includes('rawDocument') && visible.includes(object.original_plugin_output), visible);
            assert.ok(visible.includes(sameShapeObject.original_plugin_output));
            assert.ok(visible.includes('图片之前'));
            assert.ok(!visible.includes(header));
            for (let round = 1; round < providerRequests.length; round++) {
                assert.deepEqual(payloads(providerRequests[round]).map(message => message.content), actual.slice(0, round));
            }
            if (serverRevision) {
                assert.equal(executor[0][0].contentForAI, undefined);
                assert.deepEqual(JSON.parse(actual[0].slice(header.length)), rag[0]);
                assert.deepEqual(JSON.parse(actual[1].slice(header.length)), rag[1]);
            } else {
                assert.deepEqual(executor[0][0].contentForAI, [{ type: 'text', text: scalar }]);
                assert.equal(executor[1][0].contentForAI, undefined);
                assert.equal(actual[0], header + '\nResults: ' + scalar + '\n\n' + jsonText);
                assert.equal(actual[1], header + '\nResults: ' + executor[1].map(result => result.content[0].text).join('\n\n'));
            }
            cases[label] = { providerRequests, executor, rag, visible };
        }
        const box = path.join(out, 'runtime-box');
        const files = ['Plugin.js', 'modules/vcpLoop/toolExecutor.js', 'modules/toolResultBatch.js',
            'modules/handlers/nonStreamHandler.js', 'modules/handlers/streamHandler.js'];
        const sourceSha256 = Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(box, file))).digest('hex')]));
        fs.writeFileSync(evidencePath, JSON.stringify({
            revision: serverRevision ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: candidate, encoding: 'utf8' }).trim() + '+working-tree',
            node: process.version, sourceSha256, invocations, cases,
        }, null, 2) + '\n');
        passed = true;
        console.log('ToolBox JSON/SSE synthetic tool payload PASS (' + (serverRevision ?? 'candidate') + ')');
    } finally {
        await service?.close();
        fs.rmSync(key, { force: true });
        if (passed) fs.rmSync(out, { recursive: true, force: true });
        else console.error('Synthetic logs retained in ' + out);
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

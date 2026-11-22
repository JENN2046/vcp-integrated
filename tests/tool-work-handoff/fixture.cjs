'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const compaction = require('../compact-e2e/fixture.cjs');
const tool = require('../ordinary-tools/fixture.cjs');

const secondName = 'OrdinaryToolSecondCounter';
const finalText = 'Synthetic B finished the original tool Work.';
const toolResult = marker => 'ordinary tool invocation recorded for ' + marker;
const initialAnswer = (marker, name = tool.name) => [
    'Synthetic A requested the isolated counter.',
    '<<<[TOOL_REQUEST]>>>',
    'tool_name:「始」' + name + '「末」,',
    'command:「始」Count「末」,',
    'marker:「始」' + marker + '「末」',
    '<<<[END_TOOL_REQUEST]>>>',
].join('\n');

function create(out, {
    duo = false, duoBaseline = false, unknown = false, loseHandoff = false, stream = false, losePublication = false, loseCompactionAck = false,
    readback = false, loseReadback = false, legacyReadback = false, finalMutation, finalReceipt,
} = {}) {
    const marker = !duo && unknown ? 'ORDINARY_TOOL_THROW' : 'ORDINARY_TOOL_LOCAL';
    const secondMarker = 'ORDINARY_TOOL_LOCAL';
    const secondResult = 'second ' + toolResult(secondMarker);
    const pluginDir = name => path.join(out, 'runtime-box', 'Plugin', name);
    const effectReady = name => fs.existsSync(path.join(pluginDir(name), 'held-before-receipt'));
    const releaseFirstReceipt = () => fs.writeFileSync(path.join(pluginDir(tool.name), 'release-receipt'), '');
    const firstEffectReady = () => effectReady(tool.name);
    const secondEffectReady = () => effectReady(secondName);
    const counts = () => duo ? {
        first: tool.counts(out),
        second: readCounter(path.join(pluginDir(secondName), 'invocations.jsonl')),
    } : tool.counts(out);
    const expectedCounts = duo ? { first: [{ marker }], second: [{ marker: secondMarker }] } : [{ marker }];
    const observed = compaction.observe(out);
    let compactionAckBlocked = loseCompactionAck;
    let dropped = false, droppedReadback = false;
    const receipt = {};
    return {
        marker, duo, duoBaseline, unknown, counts, expectedCounts, secondResult,
        firstEffectReady, releaseFirstReceipt, secondEffectReady,
        loseHandoff,
        loseCompactionAck,
        releaseCompactionAck() { compactionAckBlocked = false; },
        losePublication,
        stream,
        readback,
        loseReadback,
        legacyReadback,
        finalMutation,
        finalReceipt,
        receipt,
        observeFinalNativeResponse(response, row) {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                const terminal = { at: Date.now(), status: row.status, bodyComplete: response.complete };
                try {
                    if (stream) {
                        const frames = text.split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => line.slice(6));
                        const choices = frames.filter(frame => frame !== '[DONE]').flatMap(frame => JSON.parse(frame).choices ?? []);
                        terminal.finishReason = choices.findLast(choice => choice.finish_reason)?.finish_reason;
                        terminal.text = choices.map(choice => choice.delta?.content ?? '').join('');
                        terminal.done = frames.at(-1) === '[DONE]';
                    } else {
                        const choice = JSON.parse(text).choices?.[0];
                        terminal.finishReason = choice?.finish_reason;
                        terminal.text = choice?.message?.content;
                    }
                } catch (error) { terminal.decodeError = error.message; }
                receipt.upstream = terminal;
            });
        },
        downstreamClosed(response, row) {
            receipt.downstream = { at: Date.now(), device: row.device, headersSent: response.headersSent };
        },
        agentConfig: { streamOutput: stream },
        observed: {
            ...observed,
            input: marker,
            async respond(body, row, res) {
                if (body.model === compaction.summaryModel) {
                    assert.equal(body.stream, true);
                    row.toolHandoffPhase = 'summary';
                    row.messages = body.messages;
                    const receipts = body.messages.map(message => message.content)
                        .filter(content => typeof content === 'string' && content.includes('[已结清的原生工具结果，不得重复执行]'));
                    const results = receipts.map(receipt => JSON.parse(receipt.slice(receipt.indexOf('\n') + 1)));
                    assert.equal(results.length, duo ? 2 : 1);
                    const [result, second] = results;
                    if (duo) {
                        assert.equal(second.pluginName, secondName);
                        assert.ok(JSON.stringify(second.result).includes(secondResult));
                    }
                    assert.equal(result.pluginName, tool.name);
                    assert.ok(JSON.stringify(result.result).includes(toolResult(marker)));
                    const checkpoint = '<context_checkpoint>\nCOMPACT_DESKTOP_CHECKPOINT. Settled counter invocation ' +
                        results.map(({ invocationId, recordId }) => invocationId + ', record ' + recordId).join('; ') + '. ' + toolResult(marker) +
                        (duo ? '. ' + secondResult : '') +
                        '. Continue the original task without repeating the tool.\n</context_checkpoint>';
                    row.toolReceipt = result;
                    if (duo) row.toolReceipts = results;
                    const frame = JSON.stringify({id:'synthetic-tool-handoff-summary',object:'chat.completion.chunk',
                        created:1,model:compaction.summaryModel,choices:[{index:0,delta:{role:'assistant',content:checkpoint},finish_reason:'stop'}]});
                    res.writeHead(200, {'content-type':'text/event-stream'});
                    res.end('data: ' + frame + '\n\ndata: [DONE]\n\n');
                    return true;
                }
                row.messages = body.messages;
                const context = JSON.stringify(body.messages);
                const resumed = context.includes('COMPACT_DESKTOP_CHECKPOINT');
                const hasResult = context.includes(toolResult(marker));
                row.toolHandoffPhase = resumed ? 'resumed' : hasResult ? 'same-generation-after-tool' : 'initial';
                row.hasToolResult = hasResult;
                const content = resumed || hasResult ? finalText : initialAnswer(marker) +
                    (duo ? '\n' + initialAnswer(secondMarker, secondName) : '');
                if (duo && !resumed && !hasResult) row.toolsRequested = [tool.name, secondName];
                assert.equal(Boolean(body.stream), stream);
                if (resumed && finalReceipt) {
                    const gate = Promise.withResolvers();
                    receipt.releaseProvider = gate.resolve;
                    res.once('close', () => {
                        receipt.providerClosed = { at: Date.now(), responseEnded: res.writableEnded };
                        gate.resolve();
                    });
                    await gate.promise;
                    if (res.destroyed || finalReceipt === 'unknown') return true;
                    receipt.providerReplyAt = Date.now();
                }
                if (stream) {
                    const chunk = (delta, finish_reason) => 'data: ' + JSON.stringify({id:'synthetic-tool-handoff',
                        object:'chat.completion.chunk',created:1,model:'synthetic',choices:[{index:0,delta,finish_reason}]}) + '\n\n';
                    res.writeHead(200, { 'content-type': 'text/event-stream' });
                    res.write(chunk({ role: 'assistant', content }, null));
                    res.end(chunk({}, 'stop') + 'data: [DONE]\n\n');
                    return true;
                }
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({
                    id: 'synthetic-tool-handoff',
                    object: 'chat.completion',
                    created: 1,
                    model: 'synthetic',
                    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
                }));
                return true;
            },
        },
        stage(box) {
            tool.stage(box);
            const file = path.join(box, 'toolApprovalConfig.json');
            const config = JSON.parse(fs.readFileSync(file, 'utf8'));
            config.whitelist.push(tool.name + ':marker:[ORDINARY_TOOL_THROW]');
            if (duo) {
                const first = pluginDir(tool.name);
                const second = pluginDir(secondName);
                fs.mkdirSync(second);
                const manifest = JSON.parse(fs.readFileSync(path.join(first, 'plugin-manifest.json'), 'utf8'));
                fs.copyFileSync(path.join(first, 'counter.cjs'), path.join(second, 'counter.cjs'));
                for (const [name, role] of [[tool.name, 'first'], [secondName, 'second']]) {
                    const directory = pluginDir(name);
                    fs.writeFileSync(path.join(directory, 'plugin-manifest.json'), JSON.stringify({
                        ...manifest, name, displayName: 'Synthetic ' + role + ' ordinary tool counter',
                        entryPoint: { ...manifest.entryPoint, script: 'duo-counter.cjs' },
                        communication: { ...manifest.communication, timeout: 30000 },
                    }));
                    fs.copyFileSync(path.join(__dirname, 'duo-counter.cjs'), path.join(directory, 'duo-counter.cjs'));
                    fs.writeFileSync(path.join(directory, 'scenario.json'), JSON.stringify({ role, hold: unknown && role === 'second' }));
                }
                config.approvalList.push(secondName);
                config.whitelist.push(secondName + ':marker:[' + secondMarker + ']');
            }
            fs.writeFileSync(file, JSON.stringify(config));
        },
        env: { NativeSyncSharedSafeTools: JSON.stringify(duo ? [tool.name, secondName] : [tool.name]) },
        observeRequest(method, route) {
            if (method === 'GET' && route.endsWith('/shared/final-reply')) return true;
            return method === 'POST' && /\/shared\/(?:steer-[\w-]+|compact-[\w-]+|native-request|work-review)$/.test(route);
        },
        observeNativeResponse(response, row) {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                let payload;
                if (response.statusCode === 409) {
                    payload = body;
                    row.pauseTransport = 'HTTP';
                } else if (body.includes('event: nativesync_work_paused')) {
                    const lines = body.split(/\r?\n/);
                    const event = lines.indexOf('event: nativesync_work_paused');
                    const data = event >= 0 ? lines[event + 1] : null;
                    if (data?.startsWith('data: ')) payload = data.slice(6);
                    row.pauseWireTail = Buffer.from(body).subarray(-1200).toString('utf8');
                    row.pauseTransport = 'SSE';
                }
                if (duo && response.statusCode === 500) {
                    try { row.nativeError = JSON.parse(body).details; }
                    catch (error) { row.nativeError = error.message; }
                }
                if (payload) {
                    try { row.nativePause = JSON.parse(payload).nativeSync; }
                    catch (error) { row.pauseParseError = error.message; }
                }
            });
        },
        dropResponse(row) {
            if (compactionAckBlocked && row.route.endsWith('/compact-commit') && row.status === 200) return true;
            if (loseReadback && !droppedReadback && row.device === 'deviceB' && row.route.endsWith('/final-reply') &&
                row.status === 200 && Number(row.query?.generation) === 1 && row.response?.state === 'committed') {
                droppedReadback = true;
                return true;
            }
            if (losePublication && row.device === 'deviceB' && row.route.endsWith('/steer-turn-complete') &&
                row.body?.generation === 1 && row.status === 200 && row.response?.workState === 'completed') return true;
            if (!loseHandoff || dropped || row.device !== 'deviceB' || !row.route.endsWith('/steer-handoff') ||
                row.status < 200 || row.status >= 300) return false;
            assert.ok(row.body.workId);
            dropped = true;
            return true;
        },
    };
}
function readCounter(file) {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}
module.exports = { create, settings: compaction.settings, finalText, toolResult, secondName };

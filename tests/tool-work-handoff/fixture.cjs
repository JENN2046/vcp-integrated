'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const compaction = require('../compact-e2e/fixture.cjs');
const tool = require('../ordinary-tools/fixture.cjs');

const finalText = 'Synthetic B finished the original tool Work.';
const toolResult = marker => 'ordinary tool invocation recorded for ' + marker;
const initialAnswer = marker => [
    'Synthetic A requested the isolated counter.',
    '<<<[TOOL_REQUEST]>>>',
    'tool_name:「始」' + tool.name + '「末」,',
    'command:「始」Count「末」,',
    'marker:「始」' + marker + '「末」',
    '<<<[END_TOOL_REQUEST]>>>',
].join('\n');

function create(out, { unknown = false, loseHandoff = false, stream = false } = {}) {
    const marker = unknown ? 'ORDINARY_TOOL_THROW' : 'ORDINARY_TOOL_LOCAL';
    const observed = compaction.observe(out);
    let dropped = false;
    return {
        marker,
        loseHandoff,
        stream,
        agentConfig: { streamOutput: stream },
        observed: {
            ...observed,
            input: marker,
            async respond(body, row, res) {
                if (body.model === compaction.summaryModel) {
                    assert.equal(body.stream, true);
                    row.toolHandoffPhase = 'summary';
                    row.messages = body.messages;
                    const receipt = body.messages.map(message => message.content)
                        .find(content => typeof content === 'string' && content.includes('[已结清的原生工具结果，不得重复执行]'));
                    assert.ok(receipt, 'the summary model receives the authoritative native tool receipt');
                    const result = JSON.parse(receipt.slice(receipt.indexOf('\n') + 1));
                    assert.equal(result.pluginName, tool.name);
                    assert.ok(JSON.stringify(result.result).includes(toolResult(marker)));
                    const checkpoint = '<context_checkpoint>\nCOMPACT_DESKTOP_CHECKPOINT. Settled counter invocation ' +
                        result.invocationId + ', record ' + result.recordId + '. ' + toolResult(marker) +
                        '. Continue the original task without repeating the tool.\n</context_checkpoint>';
                    row.toolReceipt = result;
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
                const content = resumed || hasResult ? finalText : initialAnswer(marker);
                assert.equal(Boolean(body.stream), stream);
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
            fs.writeFileSync(file, JSON.stringify(config));
        },
        env: { NativeSyncSharedSafeTools: JSON.stringify([tool.name]) },
        observeRequest(method, route) {
            return method === 'POST' && /\/shared\/(?:steer-[\w-]+|compact-[\w-]+|native-request)$/.test(route);
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
                if (payload) {
                    try { row.nativePause = JSON.parse(payload).nativeSync; }
                    catch (error) { row.pauseParseError = error.message; }
                }
            });
        },
        dropResponse(row) {
            if (!loseHandoff || dropped || row.device !== 'deviceB' || !row.route.endsWith('/steer-handoff') ||
                row.status < 200 || row.status >= 300) return false;
            assert.ok(row.body.workId);
            dropped = true;
            return true;
        },
    };
}
module.exports = { create, settings: compaction.settings, finalText, toolResult };

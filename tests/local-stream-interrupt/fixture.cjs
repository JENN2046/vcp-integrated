'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ordinary = require('../ordinary-tools/fixture.cjs');
const marker = 'ORDINARY_TOOL_LOCAL';
const prefix = 'SYNTHETIC PARTIAL BEFORE TOOL. ' + '预算'.repeat(280);
const summaryModel = 'synthetic-summary';
const checkpoint = '<context_checkpoint>LOCAL_STREAM_INTERRUPT_CHECKPOINT</context_checkpoint>';
const resumedText = 'Synthetic resumed reply after checkpoint.';
const historyFile = out => path.join(out, 'profile-A/UserData/local-agent/topics/local-topic/history.json');
const history = out => JSON.parse(fs.readFileSync(historyFile(out), 'utf8'));

function observe(out) {
    const { promise: toolRelease, resolve: releaseTool } = Promise.withResolvers();
    const summarySnapshots = [];
    const summaryRequests = [];
    const roleDivider = process.env.VCP_TEST_STREAM_ROLE_DIVIDER !== '0';

    function stream(body, res) {
        assert.equal(body.stream, true);
        res.writeHead(200, { 'content-type':'text/event-stream' });
        return (content, finishReason = null) => res.write('data: ' + JSON.stringify({
            id:'synthetic-stream', object:'chat.completion.chunk', created:1, model:body.model,
            choices:[{ index:0, delta:{role:'assistant', content}, finish_reason:finishReason }],
        }) + '\n\n');
    }

    async function respond(body, row, res, calls) {
        row.model = body.model;
        const wire = JSON.stringify(body.messages);
        if (body.model === summaryModel) {
            row.phase = 'summary';
            summarySnapshots.push({at:Date.now(),history:history(out)});
            row.includesPartial = wire.includes(prefix);
            stream(body, res)(checkpoint, 'stop');
            res.end('data: [DONE]\n\n');
            return true;
        }
        if (wire.includes('LOCAL_STREAM_INTERRUPT_CHECKPOINT')) {
            row.phase = 'resumed';
            row.includesInterruptedPrefix = wire.includes(prefix);
            stream(body, res)(resumedText, 'stop');
            res.end('data: [DONE]\n\n');
            return true;
        }
        assert.ok(wire.includes(marker), 'only the synthetic local fixture prompt is accepted');
        const send = stream(body, res);
        if (calls.some(call => call.phase === 'tool-request')) {
            row.phase = 'held-continuation';
            row.hasToolResult = wire.includes('ordinary tool invocation recorded for ' + marker);
            res.flushHeaders();
            res.once('close', () => {
                row.closedAt = Date.now();
                row.providerEndedNormally = res.writableEnded;
            });
            return true;
        }
        row.phase = 'tool-request';
        send(prefix);
        await toolRelease;
        const toolRequest = [
            '<<<[TOOL_REQUEST]>>>',
            'tool_name:「始」' + ordinary.name + '「末」,',
            'command:「始」Count「末」,',
            'marker:「始」' + marker + '「末」',
            '<<<[END_TOOL_REQUEST]>>>',
        ].join('\n');
        send('\n' + toolRequest, 'stop');
        res.end('data: [DONE]\n\n');
        return true;
    }

    function inspect(response, row) {
        if (!response.headers['content-type']?.includes('text/event-stream')) return;
        let buffer = '';
        const wire = row.streamWire = { terminal:[], toolResults:0, framesAfterToolReturn:[] };
        const decoder = new TextDecoder();
        response.on('data', bytes => {
            buffer += decoder.decode(bytes, {stream:true});
            let boundary;
            while ((boundary = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, boundary).trimEnd();
                buffer = buffer.slice(boundary + 1);
                if (!line.startsWith('data: ')) continue;
                const body = line.slice(6);
                const returned = wire.toolResults > 0;
                if (body === '[DONE]') {
                    wire.terminal.push(body);
                    if (returned) wire.framesAfterToolReturn.push({type:'done'});
                    continue;
                }
                let packet;
                try { packet = JSON.parse(body); }
                catch {
                    wire.invalidFrame = true;
                    continue;
                }
                const choice = packet.choices?.[0];
                const choiceText = choice?.delta?.content;
                if (choiceText?.includes('<<<[VCP_TOOL_BATCH_END:')) {
                    wire.toolResults++;
                    wire.toolResultIncluded = choiceText.includes('ordinary tool invocation recorded for ' + marker);
                    wire.toolReturnWrapped = choiceText.includes('<<<[END_ROLE_DIVIDE_USER]>>>');
                    wire.toolReturnAt = Date.now();
                }
                if (choice?.finish_reason) wire.terminal.push(choice.finish_reason);
                if (returned) {
                    const { id, object, type } = packet;
                    wire.framesAfterToolReturn.push({id,object,type,choiceFinishReason:choice?.finish_reason,
                        text:choiceText || undefined});
                }
            }
        });
        response.on('end', () => { wire.endedAt = Date.now(); });
        response.on('close', () => { wire.closedAt = Date.now(); });
    }

    function observeSummaryRequest(row) {
        summaryRequests.push({at:row.at, history:history(out)});
    }

    return {respond, inspect, releaseTool, summarySnapshots, summaryRequests, observeSummaryRequest, roleDivider, stage:ordinary.stage};
}

module.exports = {observe, history, marker, prefix, checkpoint, resumedText,
    agent:{streamOutput:true, contextTokenLimit:230},
    settings:{enableVcpToolInjection:true,enableContextCompaction:true,contextCompactionModel:summaryModel},
};

'use strict';
const fs = require('node:fs');
const https = require('node:https');
const assert = require('node:assert/strict');

const cases = {
    A: { prompt: 'SYNTHETIC_DONE_OPEN', text: '合成终稿：收到 DONE 后连接仍打开。' },
    B: { prompt: 'SYNTHETIC_TRANSPORT_CUT', text: '合成可见正文：随后连接断开。' },
    C: { prompt: 'SYNTHETIC_STOP_ACK_LOST', text: '合成可见正文：随后点击停止。' },
};

function create() {
    const streams = {};
    const receipts = [];
    const active = new Map();
    async function handle(req, res, route) {
        if (req.method !== 'POST' || !['/v1/local-chat/completions', '/v1/interrupt'].includes(route)) return false;
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        if (route === '/v1/interrupt') {
            const row = { requestId: body.requestId, at: Date.now(), acceptedStatus: 200, ackTruncated: false };
            receipts.push(row);
            assert.ok(active.has(body.requestId));
            const ack = JSON.stringify({ status: 'success', message: 'Synthetic Stop accepted' });
            res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(ack) });
            res.write(ack.slice(0, 1), () => {
                row.ackTruncated = true;
                res.destroy();
            });
            return true;
        }
        const user = body.messages.findLast(message => message.role === 'user')?.content;
        const promptWire = JSON.stringify(user);
        const role = Object.keys(cases).find(key => promptWire.includes(cases[key].prompt));
        assert.ok(role);
        assert.equal(body.stream, true);
        const existing = streams[role];
        if (existing) {
            existing.attempts++;
            res.writeHead(409).end();
            return true;
        }
        const row = streams[role] = { requestId: body.requestId, attempts: 1, at: Date.now(), frames: [] };
        active.set(body.requestId, res);
        res.on('close', () => {
            row.closedAt = Date.now();
            row.serverEnded = res.writableEnded;
            active.delete(body.requestId);
        });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        row.frames.push({ kind: 'delta', text: cases[role].text });
        const content = {
            id: 'synthetic-stream', object: 'chat.completion.chunk', created: 1, model: 'synthetic',
            choices: [{ index: 0, delta: { role: 'assistant', content: cases[role].text }, finish_reason: null }],
        };
        res.write('data: ' + JSON.stringify(content) + '\n\n');
        return true;
    }
    function done() {
        const row = streams.A;
        row.frames.push({ kind: 'done', at: Date.now() });
        active.get(row.requestId).write('data: [DONE]\n\n');
    }
    function cut() {
        const row = streams.B;
        row.cutAt = Date.now();
        active.get(row.requestId).destroy();
    }
    async function start({cert, key}) {
        const server = https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, async (req, res) => {
            try {
                if (!await handle(req, res, new URL(req.url, 'https://127.0.0.1').pathname)) res.writeHead(404).end();
            } catch (error) {
                errors.push(error.message);
                if (!res.headersSent) res.writeHead(500);
                res.end();
            }
        });
        const errors = [];
        await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
        const origin = 'https://127.0.0.1:' + server.address().port;
        return {
            origin, wsOrigin: origin, errors,
            close() {
                server.closeAllConnections();
                return new Promise(resolve => server.close(resolve));
            },
        };
    }
    return { start, streams, receipts, done, cut };
}

module.exports = { cases, create };

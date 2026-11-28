'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { accessSync, constants, statSync } = require('node:fs');
const { WebSocket, WebSocketServer } = require('ws');

const maxFrame = 6400;
const maxBuffer = 128000;
const maxAudioBytes = 50 * 16000 * 2;
const heartbeatMs = 2000;

function localSpeechConfig(env) {
    if (env.VCP_CORE_LOCAL_SPEECH !== '1') return null;
    const python = env.VCP_CORE_LOCAL_SPEECH_PYTHON;
    const model = env.VCP_CORE_LOCAL_SPEECH_MODEL;
    try {
        if (!path.isAbsolute(python) || !path.isAbsolute(model) || !statSync(python).isFile() || !statSync(model).isDirectory()) return null;
        accessSync(python, constants.X_OK);
        accessSync(model, constants.R_OK | constants.X_OK);
        return { python, model };
    } catch {
        return null;
    }
}

function denySpeechUpgrade(socket, status) {
    if (!socket.destroyed) socket.end('HTTP/1.1 ' + status + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
}

function createLocalSpeech(config, isAuthorized) {
    const connections = new Map();
    const server = new WebSocketServer({ noServer: true, maxPayload: maxFrame, perMessageDeflate: false });
    let closed = false;

    function start(ws, actor) {
        const child = spawn(config.python, ['-I', path.join(__dirname, 'mandarinSpeech.py'), config.model], {
            stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }
        });
        let audioBytes = 0, pendingOutput = '', ready = false, ending = false, stopped = false, pong = true;
        const deadline = setTimeout(() => finish('VOICE_TIMEOUT'), 55000);
        const heartbeat = setInterval(() => {
            if (!isAuthorized(actor)) return finish('VOICE_PAIR_REQUIRED');
            if (!pong) return finish('VOICE_CONNECTION_LOST');
            pong = false;
            ws.ping();
        }, heartbeatMs);
        function closeRecognition() {
            if (stopped) return;
            stopped = true;
            clearInterval(heartbeat);
            clearTimeout(deadline);
            child.stdin.destroy();
            child.stdout.destroy();
            if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }
        function finish(error) {
            if (stopped) return;
            if (ws.readyState === WebSocket.OPEN) {
                if (error && ws.bufferedAmount <= maxBuffer) ws.send(JSON.stringify({ error }));
                ws.close(error ? 1011 : 1000);
                const force = setTimeout(() => ws.terminate(), 500);
                force.unref();
                ws.once('close', () => clearTimeout(force));
            }
            closeRecognition();
        }
        connections.set(actor.deviceId, finish);
        child.on('error', () => finish('VOICE_UNAVAILABLE'));
        child.stdin.on('error', () => finish('VOICE_UNAVAILABLE'));
        child.once('close', () => {
            finish('VOICE_UNAVAILABLE');
            connections.delete(actor.deviceId);
        });
        ws.once('close', closeRecognition);
        ws.on('error', closeRecognition);
        ws.on('pong', () => { pong = true; });
        ws.on('message', (data, binary) => {
            if (stopped) return;
            if (!isAuthorized(actor)) return finish('VOICE_PAIR_REQUIRED');
            if (!ready || ending) return finish('VOICE_PROTOCOL_ERROR');
            if (!binary) {
                if (data.toString() !== 'finish') return finish('VOICE_PROTOCOL_ERROR');
                ending = true;
                child.stdin.end();
                return;
            }
            audioBytes += data.length;
            if (!data.length || data.length % 2 || audioBytes > maxAudioBytes ||
                child.stdin.writableLength + data.length > maxBuffer) return finish('VOICE_LIMIT');
            child.stdin.write(data);
        });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            if (stopped) return;
            pendingOutput += chunk;
            if (pendingOutput.length > maxBuffer) return finish('VOICE_LIMIT');
            const lines = pendingOutput.split('\n');
            pendingOutput = lines.pop();
            for (const line of lines) {
                if (!isAuthorized(actor)) return finish('VOICE_PAIR_REQUIRED');
                if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > maxBuffer) return finish('VOICE_LIMIT');
                let event;
                try { event = JSON.parse(line); } catch { return finish('VOICE_UNAVAILABLE'); }
                if (!ready && event?.ready === true) {
                    ready = true;
                    ws.send('{"ready":true}');
                } else if (ready && typeof event?.text === 'string' && event.text.length <= 12000) {
                    ws.send(JSON.stringify({ text: event.text, final: event.final === true }));
                    if (event.final === true) return finish();
                } else return finish('VOICE_UNAVAILABLE');
            }
        });
    }

    return {
        upgrade(req, socket, head, actor) {
            if (closed) return denySpeechUpgrade(socket, '503 Service Unavailable');
            if (connections.has(actor.deviceId) || connections.size >= 4) {
                return denySpeechUpgrade(socket, '429 Too Many Requests');
            }
            server.handleUpgrade(req, socket, head, ws => start(ws, actor));
        },
        disconnect(deviceId) {
            connections.get(deviceId)?.('VOICE_PAIR_REQUIRED');
        },
        close() {
            if (closed) return;
            closed = true;
            for (const finish of connections.values()) finish('VOICE_UNAVAILABLE');
            server.close();
        }
    };
}

module.exports = { createLocalSpeech, denySpeechUpgrade, localSpeechConfig };

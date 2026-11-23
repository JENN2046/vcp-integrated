'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');

const sha256 = value => createHash('sha256').update(value).digest('hex');
const receipts = { registration: [], ipReports: [], transfers: [], refused: 0 };

if (process.env.NS_URI_DISTRIBUTED_A === '1') {
    const host = process.env.NS_HOST;
    const profile = process.env.VCPCHAT_APP_DATA_DIR;
    const fixture = path.resolve(process.env.NS_ATTACHMENT_FIXTURE_FILE);
    assert.ok(profile && path.isAbsolute(profile) && process.env.VCPCHAT_E2E_TEST === '1');
    assert.ok(fs.lstatSync(fixture).isFile() && fs.realpathSync(fixture) === fixture);
    const original = fs.readFileSync(fixture);
    const expected = { sha256: sha256(original), bytes: original.length };
    const cachedPath = path.join(profile, 'UserData', 'attachments', expected.sha256 + path.extname(fixture));
    const fixtureUrl = pathToFileURL(cachedPath).href;
    const localIPv4 = Object.values(os.networkInterfaces()).flat()
        .filter(entry => entry.family === 'IPv4' && !entry.internal)
        .map(entry => entry.address);
    const sourceIp = process.env.NS_URI_SOURCE_IP || localIPv4[0];
    assert.ok(localIPv4.includes(sourceIp), 'A must bind an actual non-loopback IPv4 interface');
    const hostModule = path.join(host, 'VCPDistributedServer', 'VCPDistributedServer.js');
    const DistributedServer = require(hostModule);
    const native = DistributedServer.prototype;
    const requests = new Map();
    let distributedPort;
    receipts.sourceIp = sourceIp;
    receipts.nativeSourceSha256 = sha256(fs.readFileSync(hostModule));
    receipts.expected = { ...expected, fileUrlSha256: sha256(fixtureUrl) };

    const socketConnect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (...args) {
        // Node's net.connect passes its normalized [options, callback] array.
        const options = Array.isArray(args[0]) ? args[0][0] : args[0];
        if (distributedPort && options?.host === '127.0.0.1' && Number(options.port) === distributedPort) {
            options.localAddress = sourceIp;
        }
        return socketConnect.apply(this, args);
    };

    const connect = native.connect;
    native.connect = function (...args) {
        const target = new URL(this.mainServerUrl);
        assert.ok(['http:', 'https:', 'ws:', 'wss:'].includes(target.protocol) && target.hostname === '127.0.0.1' && target.port);
        distributedPort = Number(target.port);
        return connect.apply(this, args);
    };

    const handleRequest = native.handleToolExecutionRequest;
    native.handleToolExecutionRequest = function (data, ...args) {
        if (data?.toolName === 'internal_request_file') {
            if (data.toolArgs?.fileUrl !== fixtureUrl ||
                !fs.lstatSync(cachedPath, { throwIfNoEntry: false })?.isFile() ||
                fs.realpathSync(cachedPath) !== cachedPath) {
                receipts.refused++;
                return this.sendMessage({ type: 'tool_result', data: {
                    requestId: data.requestId, status: 'error', error: 'FIXTURE_FILE_ONLY',
                } });
            }
            requests.set(data.requestId, sha256(data.toolArgs.fileUrl));
        }
        return handleRequest.call(this, data, ...args);
    };

    const send = native.sendMessage;
    native.sendMessage = function (payload, ...args) {
        const localAddress = this.ws?.readyState === 1 ? this.ws._socket?.localAddress : undefined;
        const result = send.call(this, payload, ...args);
        if (!localAddress) return result;
        const data = payload.data;
        if (payload.type === 'register_tools') {
            receipts.registration.push({ serverName: data.serverName, toolCount: data.tools.length, localAddress });
        }
        if (payload.type === 'report_ip') {
            receipts.ipReports.push({ serverName: data.serverName, localIPs: data.localIPs, localAddress,
                publicIpReported: Boolean(data.publicIP) });
        }
        if (payload.type === 'tool_result' && requests.has(data.requestId)) {
            const bytes = typeof data.result?.fileData === 'string' ? Buffer.from(data.result.fileData, 'base64') : null;
            const digest = bytes && sha256(bytes);
            receipts.transfers.push({ requestId: data.requestId, fileUrlSha256: requests.get(data.requestId), localAddress,
                status: data.status, bytes: bytes?.length, sha256: digest, mimeType: data.result?.mimeType,
                matchesFixture: bytes?.length === expected.bytes && digest === expected.sha256 });
            requests.delete(data.requestId);
        }
        return result;
    };
}

require('../shared-attachment-continuation/electron.cjs');
require('../integration/electron-fixture-hooks.cjs').get().commands['file-uri-receipts'] = () => receipts;

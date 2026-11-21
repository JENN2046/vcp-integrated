'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

module.exports = ({ origin, out, cert }) => {
    const { spaceId } = JSON.parse(fs.readFileSync(path.join(out, 'seed/desktopA/.native-sync/connection.json')));
    return (route, body) => new Promise((resolve, reject) => {
        const req = https.request(origin + route, {
            method: 'POST',
            ca: fs.readFileSync(cert),
            headers: {
                authorization: 'Bearer synthetic-only',
                'content-type': 'application/json',
                'x-nativesync-source': 'sourceA',
                'x-nativesync-device': 'deviceA',
                'x-nativesync-space': spaceId,
                'x-nativesync-protocol': '2',
                'x-nativesync-capabilities': 'shared-space-v1,shared-context-v1,shared-session-v1,shared-session-cancel-v1',
            },
        }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('error', reject);
            response.on('end', () => {
                try {
                    const payload = JSON.parse(Buffer.concat(chunks));
                    assert.equal(response.statusCode, 200, route + ': ' + JSON.stringify(payload));
                    resolve(payload);
                } catch (error) { reject(error); }
            });
        });
        req.on('error', reject);
        req.setTimeout(4500, () => req.destroy(Error('Owner command timed out')));
        req.end(JSON.stringify(body));
    });
};

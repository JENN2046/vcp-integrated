'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { hostname, release } = require('node:os');

const [evidenceDrive, label] = process.argv.slice(2);
assert.equal(process.platform, 'win32');
assert.equal(process.env.USERNAME.toLowerCase(), 'r16limited');
assert.match(evidenceDrive, /^[A-Z]:[\\/]?$/i);
assert.match(label, /^[a-z][a-z-]*$/);
const profile = path.join(process.env.LOCALAPPDATA, 'NativeSync-R4-a2a13b5', 'profile');
const scopes = {
    group: ['ns_72c011434eaa86ceba4fb795', 'ns_31a334800544b15d2e2c9dee'],
    single: ['ns_798fc3206c3ea27dd34d50a5', 'ns_0772af97aff033049d258301']
};
const sha = value => createHash('sha256').update(value).digest('hex');
const histories = Object.fromEntries(Object.entries(scopes).map(([kind, [itemId, topicId]]) => {
    const filename = path.join('UserData', itemId, 'topics', topicId, 'history.json');
    const physical = path.join(profile, filename);
    if (!fs.existsSync(physical)) return [kind, { filename, missing: true, rows: [] }];
    const bytes = fs.readFileSync(physical);
    const history = JSON.parse(bytes);
    assert.ok(Array.isArray(history));
    return [kind, { filename, sha256: sha(bytes), rows: history.map(({ id, role, content }) => ({ id, role, content })) }];
}));
fs.writeFileSync(path.join(evidenceDrive + '\\', 'history-' + label + '.json'), JSON.stringify({
    time: new Date().toISOString(), guest: { hostname: hostname(), release: release(), arch: process.arch, account: process.env.USERNAME },
    histories
}, null, 2) + '\n');

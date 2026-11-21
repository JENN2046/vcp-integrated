'use strict';

const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startFixture, waitUntil } = require('./fixture.cjs');

async function main() {
    const root = path.resolve(__dirname, '../..');
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-local-aa-'));
    const fx = await startFixture({ out, candidate: root, mode: 'local-only' });
    const db = new DatabaseSync(path.join(fx.service.data, 'central.sqlite'), { readOnly: true });
    const admin = '/admin_api/agent-assistant/delegations';
    const cases = [];
    try {
        for (const label of ['complete', 'cancel']) {
            const marker = fx.markers[label];
            const response = await fx.request('/v1/local-chat/completions', {
                model: 'synthetic', stream: false, messages: [{ role: 'user', content: marker }],
            });
            assert.equal(response.status, 200);
            const id = fx.calls(marker).find(row => row.delegationId)?.delegationId;
            assert.ok(id && response.body.choices[0].message.content.includes(id));
            assert.ok((await fx.request(admin)).body.data.active.some(task => task.id === id));
            if (label === 'cancel') assert.equal((await fx.request(admin + '/' + id + '/cancel', {})).body.success, true);
            fx.release(marker);
            const task = await waitUntil(async () => (await fx.request(admin)).body.data.recent.find(row => row.id === id), 'local delegation terminal');
            const child = fx.calls(marker).filter(row => row.role === 'child');
            assert.equal(child.filter(row => row.launch).length, 1);
            assert.equal(child.length, label === 'complete' ? 2 : 1);
            assert.equal(task.status, label === 'complete' ? 'completed' : 'cancelled');
            assert.ok(fs.existsSync(path.join(out, 'runtime-box', task.archivePath)));
            cases.push({ taskId: id, state: task.status, childRounds: child.length, launches: 1 });
        }
        for (const table of ['shared_admissions', 'mobile_native_tasks', 'mobile_native_invocations']) {
            assert.equal(db.prepare('SELECT count(*) AS n FROM ' + table).get().n, 0);
        }
        console.log(JSON.stringify({ cases, sharedWorks: 0, sharedTasks: 0, sharedToolInvocations: 0 }, null, 2));
    } finally {
        db.close();
        await fx.close();
        fs.rmSync(out, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

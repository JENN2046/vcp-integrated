'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { start } = require('./server-fixture.cjs');

const execute = promisify(execFile);

async function main() {
    const [mode, baseline] = process.argv.slice(2);
    assert.ok(!mode || ['tavern-depth', 'request-envelope'].includes(mode), 'unknown context chain scenario');
    assert.ok(!baseline || (mode && baseline === '--baseline'), 'unknown context chain option');
    const contract = mode === 'tavern-depth' ? require('./tavern-depth.cjs') : require('./input.json');
    const fixture = await start({ contract });
    const file = name => path.join(fixture.out, name);
    const snapshot = name => fs.writeFile(file(name), JSON.stringify(fixture.snapshot(), null, 2) + '\n', { mode: 0o600 });
    const run = async (script, ...args) => {
        const { stdout } = await execute(process.execPath, [path.join(__dirname, script), ...args], {
            env: { ...process.env, NODE_EXTRA_CA_CERTS: fixture.cert },
            timeout: 120000,
        });
        return stdout;
    };
    try {
        await fs.writeFile(file('input.json'), JSON.stringify(contract, null, 2) + '\n', { mode: 0o600 });
        await run('native-run.cjs', file('input.json'), fixture.completionUrl, file('native.json'), fixture.cert);
        await run('server-submit.cjs', file('ready.json'));
        await fixture.waitUntil(() => fixture.snapshot().work[0]?.state === 'completed', 'shared terminal');
        await snapshot('before-replay.json');
        await run('server-submit.cjs', file('ready.json'), '--replay');
        await snapshot('snapshot.json');
        const verified = JSON.parse(await run('server-verify.cjs', fixture.out, ...process.argv.slice(2)));
        assert.ok(verified.fullSyntheticBodies && verified.replay?.sameWork);
        await fs.writeFile(file('verified.json'), JSON.stringify(verified, null, 2) + '\n');
    } finally {
        await fixture.close();
    }

    // Only retain observations of this successful, freshly generated synthetic run.
    for (const name of ['seed', 'data', 'runtime-box', 'empty-diaries', 'backend.log']) {
        await fs.rm(file(name), {recursive:true, force:true});
    }
    console.log('PASS ' + file('verified.json'));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });

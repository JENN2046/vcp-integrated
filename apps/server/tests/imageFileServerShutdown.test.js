'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const imageModule = require.resolve('../Plugin/ImageFileServer/image-file-server');
const vtrade = process.env.VCP_TEST_VTRADE_ROOT || path.join(__dirname, '../Plugin/VTrade');
const store = path.join(vtrade, 'core/store.cjs');
const owners = ['listener'];
if (process.env.VCP_TEST_VTRADE_ROOT || fs.existsSync(store)) {
    require.resolve(store);
    owners.push('VTrade');
}

for (const owner of owners) {
    for (const signal of ['SIGINT', 'SIGTERM']) {
        test(`ImageFileServer leaves ${signal} shutdown to the host (${owner})`, t => {
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-shutdown-'));
            t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
            const child = spawnSync(process.execPath, ['-e', `
                const assert = require('node:assert/strict');
                const fs = require('node:fs/promises');
                const net = require('node:net');
                const path = require('node:path');
                const { once } = require('node:events');
                const [imageModule, storeModule, directory, signal, owner] = process.argv.slice(1);

                async function run() {
                    let closeOwner;
                    let verifyRelease;
                    if (owner === 'VTrade') {
                        const { Store } = require(storeModule);
                        const store = new Store(directory);
                        await store.open();
                        const lock = path.join(directory, 'writer.lock');
                        assert.equal(await fs.readFile(lock, 'utf8'), String(process.pid));
                        closeOwner = () => store.close();
                        verifyRelease = async () => {
                            await assert.rejects(fs.access(lock), { code: 'ENOENT' });
                            const reopened = new Store(directory);
                            await reopened.open();
                            await reopened.close();
                        };
                    } else {
                        const listener = net.createServer().listen(0, '127.0.0.1');
                        await once(listener, 'listening');
                        const { address, port } = listener.address();
                        closeOwner = () => new Promise(resolve => listener.close(resolve));
                        verifyRelease = async () => {
                            const reopened = net.createServer().listen(port, address);
                            await once(reopened, 'listening');
                            await new Promise(resolve => reopened.close(resolve));
                        };
                    }
                    let hostShutdown;
                    let image;
                    process.once(signal, () => {
                        hostShutdown = (async () => {
                            await new Promise(resolve => setImmediate(resolve));
                            await image.shutdown();
                            await closeOwner();
                        })();
                    });
                    const signals = ['SIGINT', 'SIGTERM'];
                    const before = signals.map(name => process.listeners(name));
                    image = require(imageModule);
                    assert.deepEqual(signals.map(name => process.listeners(name)), before);
                    assert.equal(image.shutdown, image.stopSecurityManager);
                    process.emit(signal);
                    assert.ok(hostShutdown);
                    await hostShutdown;
                    await verifyRelease();
                    console.log('host shutdown completed');
                }
                run().catch(error => { console.error(error); process.exitCode = 1; });
            `, imageModule, store, directory, signal, owner], { encoding: 'utf8', timeout: 8000 });
            assert.ifError(child.error);
            assert.equal(child.status, 0, child.stderr);
            assert.match(child.stdout, /host shutdown completed/);
        });
    }
}

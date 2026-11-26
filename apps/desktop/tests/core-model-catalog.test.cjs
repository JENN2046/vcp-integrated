'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fetchDesktopModelCatalog } = require('../modules/services/modelCatalog');

async function fixture(t, remote) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-catalog-desktop-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    if (remote) {
        await fs.mkdir(path.join(root, '.vcp-core'));
        await fs.writeFile(path.join(root, '.vcp-core/profile.json'), JSON.stringify({ remote: true, origin: 'https://core.example.invalid' }));
    }
    return { root, env: {}, settings: { vcpServerUrl: 'https://core.example.invalid/v1/chat/completions', vcpApiKey: '' } };
}
test('bound remote desktop fetches through its paired Core client, not legacy Bearer', async t => {
    const args = await fixture(t, true);
    const expected = [{ id: 'public-model' }];
    assert.deepEqual(await fetchDesktopModelCatalog({ ...args, getCoreClient: async () => ({ listModels: async () => expected }),
        fetchImpl: () => assert.fail('legacy route used for remote Core') }), expected);
    await assert.rejects(fetchDesktopModelCatalog({ ...args, getCoreClient: async () => null,
        fetchImpl: () => assert.fail('remote authority must fail closed') }), { code: 'CORE_LOCAL_AUTHORITY_UNAVAILABLE' });
});
test('legacy and local clients retain original model catalog interface', async t => {
    const args = await fixture(t, false);
    const models = await fetchDesktopModelCatalog({ ...args, settings: { ...args.settings, vcpApiKey: 'fixture-key' },
        getCoreClient: () => assert.fail('legacy mode requested Core'),
        fetchImpl: async (url, options) => {
            assert.equal(url.toString(), 'https://core.example.invalid/v1/models');
            assert.equal(options.headers.Authorization, 'Bearer fixture-key');
            return Response.json({ data: [{ id: 'legacy', owned_by: 'fixture' }] });
        }
    });
    assert.deepEqual(models, [{ id: 'legacy', owned_by: 'fixture' }]);
});

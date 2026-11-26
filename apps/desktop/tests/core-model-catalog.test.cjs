'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { fetchDesktopModelCatalog, gameModelChoices } = require('../modules/services/modelCatalog');

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
    const expected = [{ id: 'public-model' }, { id:'hybrid-embedding-chat' }];
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
            assert.equal(url.toString(), 'https://core.example.invalid/v1/models?purpose=chat');
            assert.equal(options.headers.Authorization, 'Bearer fixture-key');
            return Response.json({ data: [{ id:'legacy', owned_by:'fixture' }, { id:'opaque', mode:'embedding' }, { id:'nomic-embed-text' }] });
        }
    });
    assert.deepEqual(models, [{ id: 'legacy', owned_by: 'fixture' }]);
});


test('an unconfigured game catalog keeps chat hints and an authoritative catalog controls its choices', async t => {
    const args = await fixture(t, false);
    const catalog = await fetchDesktopModelCatalog({ ...args, settings:{} });
    assert.equal(catalog, null);
    const hints = { favoriteModels:['favorite-chat','nomic-embed-text','opaque-old-alias'], hotModels:['hot-chat'],
        agentModels:['agent-chat','bge-m3'] };
    assert.deepEqual(gameModelChoices({ catalog, ...hints }), {
        models:['favorite-chat','opaque-old-alias','hot-chat','agent-chat'], favoriteModels:['favorite-chat','opaque-old-alias'], hotModels:['hot-chat']
    });
    assert.deepEqual(gameModelChoices({ catalog:[], ...hints }), { models:[],favoriteModels:[],hotModels:[] });
    assert.deepEqual(gameModelChoices({ catalog:[{id:'hybrid-embedding-chat'},{id:'hot-chat'}], ...hints }),
        { models:['hot-chat','hybrid-embedding-chat'],favoriteModels:[],hotModels:['hot-chat'] });
});

test('workflow model choices filter plain catalogs and keep explicitly classified hybrid chat rows', async () => {
    const root = path.resolve(__dirname,'../VCPHumanToolBox');
    const scripts = ['WorkflowEditormodules/ai/modelCatalog.generated.js','WorkflowEditormodules/ai/HttpAiClient.js'];
    const html = await fs.readFile(path.join(root,'index.html'),'utf8');
    assert.ok(html.indexOf(scripts[0]) >= 0 && html.indexOf(scripts[0]) < html.indexOf(scripts[1]));
    let catalog = {data:[{id:'text-embedding-3-small'},{id:'legacy-chat'},{id:'opaque',mode:'embedding'}]};
    const context = vm.createContext({ window:{}, AbortController, setTimeout, clearTimeout,
        fetch:async url=>{
            assert.equal(url,'https://fixture.invalid/v1/models?purpose=chat');
            return Response.json(catalog);
        } });
    for (const script of scripts) vm.runInContext(await fs.readFile(path.join(root,script),'utf8'),context);
    const client=new context.window.HttpAiClient('https://fixture.invalid');
    assert.deepEqual(Array.from(await client.listModels(), row=>row.id),['legacy-chat']);
    catalog = {purpose:'chat',data:[{id:'hybrid-embedding-chat'}]};
    assert.deepEqual(Array.from(await client.listModels(), row=>row.id),['hybrid-embedding-chat']);
});

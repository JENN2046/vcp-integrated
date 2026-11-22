'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const here = path.resolve('tests/integration');
const replacements = new Map();
function replace(source, needle, substitution) {
    assert.equal(source.split(needle).length, 2, needle);
    return source.replace(needle, substitution);
}
replacements.set('run.cjs', source => {
    source = replace(source, "path.join(here, './electron.cjs')", JSON.stringify(path.join(__dirname, 'config-electron.cjs')));
    return replace(source, ": mode === 'config-only' ? require('./configuration.cjs') : scenario;",
        ": mode === 'config-only' ? require('./configuration.cjs') : mode === 'local-only' ? globalThis.nsConfigProbe.local : scenario;");
});
replacements.set('configuration.cjs', source => {
    source = replace(source, "        const first = 'interrupted';", `
        const probe = globalThis.nsConfigProbe.shared({ A,B,db,service,profile,localConfigFile,result,waitUntil });
        const first = 'interrupted';`);
    for (const [name, text] of [
        ['conflict', 'await picture(A, \'quick-name-conflict\');'],
        ['lostReceipt', 'await picture(A, \'quick-name-recovered\');'],
        ['shared', 'await picture(A, \'native-name-avatar-one-save\');'],
    ]) {
        const ids = { conflict: 'aBase.sharedId', lostReceipt: 'lostBase.sharedId', shared: 'avatarBase.sharedId' };
        const cases = { conflict: 'first', lostReceipt: 'second', shared: 'avatarSubject' };
        source = replace(source, text, text + `\n        await probe.capture(${JSON.stringify(name)},${ids[name]},${cases[name]});`);
    }
    for (const [name, text, id, subject] of [
        ['conflict', 'const beforeVersions = versionRows(aBase.sharedId);', 'aBase.sharedId', 'first'],
        ['lostReceipt', 'const lostVersions = versionRows(lostBase.sharedId);', 'lostBase.sharedId', 'second'],
        ['shared', 'const avatarVersions = versionRows(avatarBase.sharedId);', 'avatarBase.sharedId', 'avatarSubject'],
    ]) source = replace(source, text, text + `\n        await probe.before(${JSON.stringify(name)},${id},${subject});`);
    return replace(source, "        assert.equal(await launcherValue(A), name);",
        "        assert.equal(await launcherValue(A), name);\n        probe.pending(lostBase.sharedId, second);");
});
const compile = Module._extensions['.cjs'] || Module._extensions['.js'];
Module._extensions['.cjs'] = function (module, filename) {
    const transform = path.dirname(filename) === here && replacements.get(path.basename(filename));
    if (!transform) return compile(module, filename);
    return module._compile(transform(fs.readFileSync(filename, 'utf8')), filename);
};
const sha = data => createHash('sha256').update(data).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const runtimeFiles = [
    'nativeConfigSave.js', 'sharedConfigVersion.js', 'sharedRuntime.js', 'sharedConfigReplica.js', 'sharedHost.js',
].map(file => 'apps/desktop/modules/services/nativeSync/' + file);
const sources = A => A.command('loaded-main-sources', { main: runtimeFiles });
const events = (client, start) => client.events.slice(start).filter(event => event.event.startsWith('config-probe-'))
    .map(({event,data})=>({event,...data}));
function diskState(file) {
    const dir = path.dirname(file);
    const files = Object.fromEntries(fs.readdirSync(dir).sort().filter(name => fs.statSync(path.join(dir,name)).isFile()).map(name => {
        const bytes = fs.readFileSync(path.join(dir,name));
        return [name,{bytes:bytes.length,sha256:sha(bytes)}];
    }));
    const config = read(file);
    return { name:config.name, topics:config.topics?.map(x=>x.id), model:config.model, files };
}
function central(db, id) {
    return {
        versions: db.prepare('SELECT version,hash FROM shared_configs WHERE object_id=? ORDER BY version').all(id),
        changes: db.prepare('SELECT seq,kind,version FROM shared_changes WHERE object_id=? ORDER BY seq').all(id),
        receipts: db.prepare('SELECT principal,op_id,request_hash,version FROM shared_model_save_receipts JOIN shared_receipts USING (principal,op_id) WHERE owner_id=? ORDER BY version').all(id),
    };
}
globalThis.nsConfigProbe = {
    shared({ A,B,db,service,profile,localConfigFile,result,waitUntil }) {
        const cases = result.configWriteProbe = {};
        const cursor = {};
        const view = (id,subject) => {
            const disks = {};
            for (const role of ['A','B']) {
                const file = path.join(profile(role),'.native-sync','shared','sharedAB','configs.json');
                const state = read(file);
                const object = state.objects[id];
                const draft = state.drafts[id];
                disks[role] = { ...diskState(localConfigFile(role,subject)), projection: object ? {version:object.version,hash:object.hash} : null,
                    draft: draft ? {opId:draft.opId,expectedVersion:draft.expectedVersion,submitted:draft.submitted,conflict:draft.conflict,name:draft.config?.name} : null };
            }
            return { central: central(db,id), disks };
        };
        return {
            before(name,id,subject) {
                cursor[name] = { A:A.events.length, B:B.events.length };
                cases[name] = { id, before: view(id,subject) };
            },
            pending(id,subject) {
                cases.lostReceipt.pending = view(id,subject);
                assert.equal(cases.lostReceipt.pending.disks.A.draft.submitted,true);
            },
            async capture(name,id,subject) {
                const entry = cases[name];
                const clients = Object.entries({A,B});
                const scoped = (role,client) => events(client,cursor[name][role]);
                await waitUntil(() => clients.every(([role,client]) => {
                    const list = scoped(role,client);
                    return list.filter(row=>row.event==='config-probe-save').every(save =>
                        list.some(row=>row.event==='config-probe-result'&&row.saveId===save.saveId));
                }), 'main save replies captured');
                entry.after = view(id,subject);
                entry.observed = Object.fromEntries(clients.map(([role,client]) => {
                    const owner = service.descriptors[role][subject].itemId;
                    return [role,scoped(role,client).filter(row=>row.event!=='config-probe-host-write'||row.localId===owner)];
                }));
                const baseline = process.env.NS_CONFIG_BASELINE === '1';
                entry.preSaveChecks = Object.fromEntries(clients.map(([role]) => {
                    const own = entry.observed[role];
                    return [role, own.filter(row=>row.event==='config-probe-save').map(save => {
                        const checks = own.filter(row=>row.saveId===save.saveId&&row.event==='config-probe-validate');
                        const observed = checks.filter(row=>row.callSite.some(site=>site.includes('SharedRuntime.observeConfigs')));
                        const repeated = checks.filter(row=>row.callSite.some(site=>site.includes('SharedConfigReplica.validate')) &&
                            row.callSite[2]?.includes('saveShared'));
                        const replay = name === 'lostReceipt' && save.saveId === own.filter(row=>row.event==='config-probe-save').at(-1).saveId;
                        assert.equal(observed.length,replay ? 0 : 1);
                        assert.equal(repeated.length,baseline && !replay ? 1 : 0);
                        if (repeated.length) for (const field of ['ref','id','version','hash']) assert.equal(repeated[0][field],observed[0][field]);
                        return { saveId:save.saveId, observed:observed.length, repeated:repeated.length, other:checks.length-observed.length-repeated.length };
                    })];
                }));
                entry.posts = service.requests.filter(row=>row.route.endsWith('/shared/config') && row.body?.sharedId===id).map(row=>({
                    status:row.status, dropped:row.dropped===true, opId:row.body.opId, expectedVersion:row.body.expectedVersion,
                    name:row.body.config?.name,
                }));
                assert.equal(entry.after.central.versions.length,entry.before.central.versions.length+1);
                assert.equal(entry.after.central.receipts.length,entry.before.central.receipts.length+1);
                assert.equal(entry.after.central.receipts.at(-1).principal, name === 'conflict' ? 'desktop:deviceB' : 'desktop:deviceA');
                if (name === 'lostReceipt') assert.equal(entry.pending.disks.A.draft.opId,entry.posts[0].opId);
                if (name === 'shared') result.configWriteSources = await sources(A);
            },
        };
    },
    async local({ clients:{A},profiles,out,result,service,evalJs,click,waitUntil,picture }) {
        const file = path.join(profiles.A,'Agents','local-agent','config.json');
        const db = new DatabaseSync(path.join(service.data,'central.sqlite'),{readOnly:true});
        const global = () => db.prepare('SELECT (SELECT count(*) FROM shared_configs) AS versions, (SELECT count(*) FROM shared_receipts) AS receipts').get();
        try {
            const prior = global();
            const before = diskState(file);
            const start = A.events.length;
            await click(A,'#agentList > li .agent-name','Synthetic local');
            await waitUntil(()=>evalJs(A,'window.VCPStateChannels.get("conversation.current").get()?.itemId === "local-agent"'),'local Agent selected');
            await evalJs(A,`document.querySelector('.sidebar-tab-button[data-tab="settings"]').click()`);
            await waitUntil(()=>evalJs(A,'document.getElementById("agentNameInput")?.value === "Synthetic local"'),'local settings form ready');
            const name = 'Synthetic local native form rename';
            await evalJs(A,`(() => { const field = document.getElementById('agentNameInput'); field.value = ${JSON.stringify(name)};
                field.dispatchEvent(new Event('input',{bubbles:true})); field.form.requestSubmit(); })()`);
            await waitUntil(()=>read(file).name===name,'local config saved');
            await waitUntil(()=>A.events.slice(start).some(event=>event.event==='config-probe-result'&&event.data.success===true),'local IPC save finished');
            await picture(A,'local-native-config-saved');
            const after = diskState(file);
            assert.deepEqual(after.topics,before.topics);
            assert.deepEqual(global(),prior);
            assert.equal(service.requests.filter(row=>row.route.endsWith('/shared/config')&&row.body).length,0);
            const observed = events(A,start);
            assert.equal(observed.filter(x=>x.event==='config-probe-local-owner').length,1);
            assert.equal(observed.filter(x=>x.event==='config-probe-validate').length,0);
            result.configWriteProbe = { local: { before,after,central:prior,observed } };
            result.configWriteSources = await sources(A);
        } finally { db.close(); }
    },
};

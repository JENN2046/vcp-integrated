'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const readline = require('node:readline');
const { DatabaseSync } = require('node:sqlite');
const { setTimeout: delay } = require('node:timers/promises');

const candidate = path.resolve(process.argv[2]);
const out = path.resolve(process.argv[3]);
const integration = path.join(candidate, 'tests/integration');
const { start } = require(path.join(integration, 'service.cjs'));
const reuse = process.env.NS_R4_RESUME_DB ? {
    database:fs.realpathSync(process.env.NS_R4_RESUME_DB),
    ready:JSON.parse(fs.readFileSync(path.join(out,'ready.json'))),
    seed:path.join(out,'previous-central','seed'),
} : null;
const revision = 'a2a13b53555c55ca79844544d8802d61fc0cf3e0';
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {cwd:candidate, encoding:'utf8'}).trim(), revision);
process.env.NS_GROUP_HANDOFF_CASE = 'plan';
const group = require(path.join(candidate, 'tests/group-member-handoff/fixture.cjs')).create();
const single = require(path.join(candidate, 'tests/shared-single-review/upstream-delete-desktop-scenario.cjs'));
const ca = path.join(out, 'hardware-ca.pem');
const pairRoute = '/__hardware/pair';
const port = 18443;
const singleInputs = ['SYNTHETIC_502_ORIGINAL_INPUT', 'SYNTHETIC_502_NEXT_INPUT'];
const groupInput = 'GROUP_HANDOFF_BASELINE_INPUT';
const write = (name, value) => {
    const file = path.join(out, name + '.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n', {mode:0o600});
    fs.renameSync(file + '.tmp', file);
};
const event = (name, value) => console.log(JSON.stringify({event:name, ...value}));
async function waitUntil(probe, description, timeout = 30000) {
    const deadline = Date.now() + timeout;
    do {
        const value = await probe();
        if (value) return value;
        await delay(45);
    } while (Date.now() < deadline);
    throw Error('Timed out waiting for ' + description);
}
function pairingCode(origin) {
    return new Promise((resolve, reject) => {
        const req = https.request(origin + '/api/plugins/NativeSync/mobile/pairing', {
            method:'POST', ca:fs.readFileSync(ca), timeout:3000,
            headers:{authorization:'Bearer synthetic-only', 'content-type':'application/json'},
        }, async res => {
            try {
                const chunks = [];
                for await (const chunk of res) chunks.push(chunk);
                assert.equal(res.statusCode, 200);
                const { pairingCode } = JSON.parse(Buffer.concat(chunks));
                assert.match(pairingCode, /^[A-Za-z0-9_-]{32}$/);
                resolve(pairingCode);
            } catch (error) { reject(error); }
        });
        req.on('timeout', () => req.destroy(Error('Pairing timed out')));
        req.on('error', reject);
        req.end(JSON.stringify({scopeMode:'shared', sharedSpaceId:'sharedAB', permissions:['read']}));
    });
}
async function main() {
    let service, db, timer;
    let pairUntil = 0;
    try {
        service = await start({
            out, candidate, cert:path.join(out, 'leaf.pem'), key:path.join(out, 'leaf.key'), ca,
            waitUntil, trace(){}, mode:'hardware', httpsPort:port,
            groupRelay:{
                seed:group.seed,
                async respond(body, row, res) {
                    if (group.respond(body, row, res)) return true;
                    const content = body.messages.findLast(message => message.role === 'user')?.content;
                    const input = Array.isArray(content)
                        ? content.filter(part => part.type === 'text').map(part => part.text).join('') : content;
                    if (singleInputs.includes(input)) return single.provider.respond(body, row, res);
                    row.invalid = true;
                    res.writeHead(500).end('Unexpected synthetic test input');
                    return true;
                },
            },
            toolHandoff:{
                ...single.hooks,
                observeRequest(method, route) {
                    return single.hooks.observeRequest(method, route) || group.proxyHooks.observeRequest(method, route);
                },
                dropResponse:group.proxyHooks.dropResponse,
            },
            observedContext:group.observed(out),
            ...(reuse && { restoreSyntheticState({data}) {
                for (const suffix of ['-wal','-shm','-journal']) assert.ok(!fs.existsSync(reuse.database + suffix));
                fs.copyFileSync(reuse.database, path.join(data,'central.sqlite'), fs.constants.COPYFILE_EXCL);
            }}),
            async handleFixtureRequest(req, res, route) {
                if (route !== pairRoute) return false;
                if (req.method !== 'GET' || req.headers.host !== '127.0.0.1:' + port ||
                    req.url !== pairRoute || Date.now() >= pairUntil) {
                    res.writeHead(404).end();
                    return true;
                }
                pairUntil = 0;
                try {
                    const code = await pairingCode(service.origin);
                    res.writeHead(302, {'cache-control':'no-store', 'referrer-policy':'no-referrer',
                        location:'/mobile/#pair=' + code}).end();
                } catch (error) {
                    res.writeHead(502).end();
                    event('pair-failed', {message:error.message});
                }
                return true;
            },
        });
        service.disarmDrop();
        db = new DatabaseSync(path.join(service.data, 'central.sqlite'), {readOnly:true});
        function lookupTopic(id) {
            const row = db.prepare('SELECT id, parent_id, topic_id FROM shared_objects WHERE id=? AND kind=?')
                .get(id,'topic');
            assert.ok(row, 'Retained shared topic is present in the restored database');
            return {id:row.id,parentId:row.parent_id,topic:{topicId:row.topic_id}};
        }
        if (reuse) {
            fs.renameSync(path.join(out,'seed'),path.join(out,'resume-generated-seed'));
            fs.cpSync(reuse.seed,path.join(out,'seed'),{recursive:true});
        }
        const groupTopic = reuse ? lookupTopic(reuse.ready.groupTopicId) : service.topics.groupTopic;
        const singleTopic = reuse ? lookupTopic(reuse.ready.singleTopicId) : service.topics.preSubmit;
        const query = (sql, ...params) => db.prepare(sql).all(...params);
        const snapshot = ({id,topic}) => {
            const admissions = query('SELECT id, request_id, principal, state, dispatched, user_seq, reply_seq FROM shared_admissions WHERE topic_id=? ORDER BY rowid', id);
            return {
                admissions,
                work:query('SELECT id, request_id, state, attempts, error_code, user_message_id, reply_message_id, review_resolved, pending_operation, native_final_operation FROM mobile_executions WHERE topic_key=? ORDER BY rowid', id),
                native:admissions.flatMap(({id}) => query('SELECT id, admission_id, ordinal, principal, member_id, state FROM shared_native_requests WHERE admission_id=? ORDER BY ordinal', id)),
                handoff:admissions.flatMap(({id}) => query('SELECT * FROM shared_group_handoffs WHERE work_id=?', id)),
                slots:admissions.flatMap(({id}) => query('SELECT ordinal,reply_seq FROM shared_group_handoff_replies WHERE work_id=? ORDER BY ordinal', id)),
                journal:query('SELECT seq,msg_id,device_id,action,message_json FROM journal WHERE topic_id=? ORDER BY seq', topic.topicId)
                    .map(({message_json,...row}) => ({ ...row, message:JSON.parse(message_json)})),
            };
        };
        function retainedWork() {
            const scopes = query('SELECT DISTINCT topic_id FROM shared_admissions WHERE topic_id NOT IN (?,?) ORDER BY topic_id',
                groupTopic.id,singleTopic.id);
            return scopes.map(({topic_id}) => ({id:topic_id,...snapshot(lookupTopic(topic_id))}));
        }
        const status = () => ({
            group:snapshot(groupTopic), single:snapshot(singleTopic), calls:service.calls,
            schemaVersion:query('SELECT max(version) AS version FROM shared_schema')[0].version,
            ...(reuse && {retained:retainedWork()}),
            pairings:query('SELECT count(*) AS count FROM mobile_pairings WHERE used=1')[0].count,
            mobileScopes:query('SELECT scopes FROM mobile_sessions ORDER BY rowid').map(row => JSON.parse(row.scopes)),
            wires:service.requests.filter(row => row.method === 'POST' &&
                /\/shared\/(group-continue|group-handoff|abandon|message|session-send)$/.test(row.route)),
        });
        const persist = () => write('status', status());
        const mobile = await service.checkMobile();
        const assets = path.join(service.data, '../runtime-box/Plugin/NativeSync/mobile-dist');
        const assetHashes = Object.fromEntries(['index.html','manifest.webmanifest','sw.js',
            ...fs.readdirSync(path.join(assets,'assets')).map(file => 'assets/' + file)]
            .filter(file => fs.existsSync(path.join(assets,file))).map(file => [file,
                createHash('sha256').update(fs.readFileSync(path.join(assets,file))).digest('hex')]));
        const registry = role => JSON.parse(fs.readFileSync(path.join(out, 'seed', 'desktop' + role, '.native-sync/shared/sharedAB/registry.json')));
        const ready = {
            revision, url:service.origin + '/mobile/', pairUrl:service.origin + pairRoute, mobile,
            publicCa:ca, publicCaDer:path.join(out, 'hardware-ca.der'), publicLeaf:path.join(out,'leaf.pem'),
            windowsSeed:path.join(out, 'seed/desktopB'), linuxSeed:path.join(out, 'seed/desktopA'),
            status:path.join(out, 'status.json'), groupTopicId:groupTopic.id, singleTopicId:singleTopic.id,
            groupName:'Relay fixture A B C', groupTopic:'Relay round', groupInput,
            assetHashes, groupReplies:['RELAY_A_FINAL','RELAY_B_FINAL','RELAY_C_FINAL'],
            singleAgent:'Synthetic shared', singleName:'One history', singleInputs, singleFinal:'SYNTHETIC_502_NEXT_FINAL',
            singleDescriptors:reuse?.ready.singleDescriptors ??
                {A:service.descriptors.A.preSubmit, B:service.descriptors.B.preSubmit},
            ...(reuse && { restoredDbSha256:createHash('sha256').update(fs.readFileSync(reuse.database)).digest('hex') }),
            seedSha256:createHash('sha256').update(fs.readFileSync(path.join(out,'seed/central.sqlite'))).digest('hex'),
            groupBindings:{ A:findBindings(registry('A'), groupTopic), B:findBindings(registry('B'), groupTopic) },
        };
        assert.deepEqual([status().group.journal.length,status().single.journal.length,status().calls.length],[0,0,0]);
        if (reuse) assert.deepEqual(status().mobileScopes,[['shared:sharedAB:read']]);
        persist();
        write('ready', ready);
        timer = setInterval(persist, 250);
        event('ready', ready);
        await new Promise(resolve => {
            const consoleInput = readline.createInterface({input:process.stdin});
            consoleInput.once('close', () => { process.stdin.pause(); resolve(); });
            consoleInput.on('line', line => {
                try {
                    if (line === 'stop') consoleInput.close();
                    else if (line === 'arm-pair') {
                        pairUntil = Date.now() + 90000;
                        event('pair-armed', {expiresInSeconds:90});
                    } else if (/^record [a-z][a-z0-9-]+$/.test(line)) {
                        write(line.slice(7), status());
                        event('recorded', {label:line.slice(7)});
                    } else if (line === 'status') event('status', status());
                } catch (error) { event('command-failed', {message:error.message}); }
            });
            process.once('SIGTERM', () => consoleInput.close());
            process.once('SIGINT', () => consoleInput.close());
        });
        write('final-status', status());
        write('provider-context', group.requests);
    } finally {
        clearInterval(timer);
        db?.close();
        if (service) event('closed', {backend:await service.close()});
    }
}
function findBindings(registry, topic) {
    const find = id => registry.locals[id].localId;
    return {itemType:'group', itemId:find(topic.parentId), topicId:find(topic.id)};
}
main().then(() => process.exit(0), error => {
    console.error(error.stack);
    process.exit(1);
});

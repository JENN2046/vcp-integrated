'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { isDeepStrictEqual } = require('node:util');
const { createRequire } = require('node:module');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { mobileControl } = require('../group-relay/pwa.cjs');
const fixture = require('./fixture.cjs');

const quote = JSON.stringify;
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const digest = value => createHash('sha256').update(value).digest('hex');
const systemText = rows => rows.filter(row => row.role === 'system').flatMap(({content}) =>
    Array.isArray(content) ? content.map(part => part.text ?? '') : [content]).join('\n');
const occurrences = (text, marker) => text.split(marker).length - 1;

module.exports = async ({ clients:{ A, B }, cert, profiles, out, result, service, click, evalJs, waitUntil, picture, sha }) => {
    const topicKey = service.topics.preSubmit.id;
    const db = new DatabaseSync(path.join(service.data, 'central.sqlite'), {readOnly:true});
    const sharedOwnerId = db.prepare('SELECT parent_id FROM shared_objects WHERE id=?').get(topicKey).parent_id;
    const sharedSpaceId = 'sharedAB';
    const source = require('./run.cjs').provenance;
    const evidence = result.configFreeze = { source, sharedSpaceId, sharedOwnerId, topicKey, held:[], turns:[] };
    const sources = {
        main:['apps/desktop/modules/ipc/chatHandlers.js','apps/desktop/modules/services/nativeSync/sharedSessionClient.js'],
        renderer:['apps/desktop/modules/renderer/mainChatSendOwner.js','apps/desktop/modules/event-listeners.js'],
    };
    const works = () => db.prepare(`SELECT id,request_id,state,attempts,request_dispatched,user_message_id,
        reply_message_id,created_at,not_before,config_snapshot FROM mobile_executions WHERE topic_key=? ORDER BY rowid`).all(topicKey);
    const admissions = () => db.prepare(`SELECT id,request_id,principal,state,dispatched,native_terminal,config_json
        FROM shared_admissions WHERE topic_id=? ORDER BY rowid`).all(topicKey);
    const nativeRequests = () => db.prepare(`SELECT r.id,r.admission_id,r.state FROM shared_native_requests r
        JOIN shared_admissions a ON a.id=r.admission_id WHERE a.topic_id=? ORDER BY r.rowid`).all(topicKey);
    const configCount = table => db.prepare('SELECT count(*) AS rows FROM ' + table + ' WHERE object_id=?').get(sharedOwnerId).rows;
    function snapshot({ opId } = {}) {
        const row = db.prepare(`SELECT c.version,c.hash,c.config_json,o.kind,o.parent_id,o.deleted,o.origin_source FROM shared_configs c JOIN shared_objects o
            ON o.id=c.object_id AND o.version=c.version WHERE o.id=?`).get(sharedOwnerId);
        return {
            object:{ id:sharedOwnerId, sharedSpaceId, kind:row.kind, parentId:row.parent_id, deleted:Boolean(row.deleted), originSource:row.origin_source, version:row.version, configHash:row.hash, config:JSON.parse(row.config_json) },
            configRows:configCount('shared_configs'),
            changeRows:configCount('shared_changes'),
            receipts:opId ? db.prepare('SELECT request_hash FROM shared_receipts WHERE op_id=?').all(opId) : [],
        };
    }
    const history = role => {
        const { itemId, topicId } = service.descriptors[role].preSubmit;
        return read(path.join(profiles[role], 'UserData', itemId, 'topics', topicId, 'history.json'));
    };
    const handler = () => fs.existsSync(fixture.capture(out)) ? fs.readFileSync(fixture.capture(out), 'utf8')
        .trim().split('\n').filter(Boolean).map(JSON.parse).filter(row => row.kind === 'handler-input') : [];
    const sendPosts = () => service.requests.filter(row => row.route.endsWith('/session-send') &&
        fixture.prompts.includes(row.body?.message?.content));

    async function select(client, role) {
        const target = service.descriptors[role].preSubmit;
        if (!await evalJs(client, 'document.querySelector("#tabContentAgents").classList.contains("active")')) {
            await click(client, '.sidebar-tab-button[data-tab="agents"]');
        }
        await click(client, '#agentList > li .agent-name', 'Synthetic shared');
        await waitUntil(async () => (await evalJs(client, 'window.VCPStateChannels.get("conversation.current").get()'))?.topicId === target.topicId,
            role + ' selected shared topic');
        const scope = await evalJs(client, 'window.chatAPI.getNativeDeletionContext(' + quote(target) + ')');
        assert.equal(scope.kind, 'shared');
    }

    async function send(client, index) {
        await evalJs(client, `(() => {
            const input = document.querySelector('#messageInput');
            input.focus();
            input.value = ${quote(fixture.prompts[index])};
            input.dispatchEvent(new Event('input', {bubbles:true}));
        })()`);
        await waitUntil(() => evalJs(client, '!document.querySelector("#sendMessageBtn").disabled'), 'native Send enabled');
        await click(client, '#sendMessageBtn');
    }

    let held;
    function assertHeld(checkpoint = 'during mobile save') {
        const currentWorks = works();
        const currentAdmissions = admissions();
        assert.equal(currentWorks.length, 1);
        assert.equal(currentAdmissions.length, 1);
        const [work] = currentWorks;
        const [admission] = currentAdmissions;
        assert.equal(work.id, admission.id);
        assert.equal(work.request_id, admission.request_id);
        assert.equal(work.state, 'queued');
        assert.equal(work.attempts, 0);
        assert.equal(work.request_dispatched ?? 0, 0);
        assert.equal(admission.state, 'accepted');
        assert.equal(admission.dispatched, 0);
        assert.equal(admission.native_terminal, 0);
        assert.equal(work.not_before - work.created_at, 10000);
        assert.equal(nativeRequests().length, 0);
        assert.equal(handler().length, 0);
        assert.equal(service.calls.length, 0);
        assert.ok(work.config_snapshot, 'derived execution snapshot');
        assert.equal(JSON.parse(work.config_snapshot).systemPrompt, fixture.oldPrompt);
        assert.equal(JSON.parse(admission.config_json).owner.config.systemPrompt, fixture.oldPrompt);
        if (held) assert.deepEqual({work, admission}, held);
        else held = {work, admission};
        evidence.held.push({
            checkpoint, at:Date.now(), workId:work.id, requestId:work.request_id,
            workState:work.state, workAttempts:work.attempts, rawRequestDispatched:work.request_dispatched,
            requestDispatched:work.request_dispatched ?? 0, admissionState:admission.state, admissionDispatched:admission.dispatched,
            nativeTerminal:admission.native_terminal, nativeRequestRows:0, handlerCount:0, providerCount:0,
            desktopHistoryCount:{A:history('A').length, B:history('B').length},
            createdAt:work.created_at, notBefore:work.not_before, workConfigSha256:digest(work.config_snapshot),
            admissionConfigSha256:digest(admission.config_json),
        });
    }

    async function terminal(index) {
        const role = index === 0 ? 'A' : 'B';
        const client = index === 0 ? A : B;
        const expected = index === 0 ? fixture.oldPrompt : fixture.updatedPrompt;
        const other = index === 0 ? fixture.updatedPrompt : fixture.oldPrompt;
        const receipt = await waitUntil(() => {
            const work = works()[index];
            const admission = admissions()[index];
            return work?.state === 'completed' && admission?.state === 'completed' && history(role).some(row => row.id === work.reply_message_id)
                && {work, admission};
        }, role + ' terminal Work, admission and projected native History');
        const { work, admission } = receipt;
        assert.equal(work.id, admission.id);
        assert.equal(work.request_id, admission.request_id);
        assert.equal(work.attempts, 1);
        assert.equal(work.request_dispatched, 1);
        assert.equal(admission.dispatched, 1);
        assert.equal(admission.native_terminal, 1);
        const post = sendPosts().find(row => row.body.requestId === work.request_id);
        assert.equal(post?.device, 'device' + role, 'normal UI sends via the named desktop');
        assert.equal(post?.response?.workId, work.id);
        assert.equal(post?.status, 200);
        const frozenWork = JSON.parse(work.config_snapshot);
        const frozenAdmission = JSON.parse(admission.config_json);
        assert.equal(frozenWork.systemPrompt, expected);
        assert.equal(frozenAdmission.owner.config.systemPrompt, expected);
        assert.deepEqual(frozenAdmission.execution, frozenWork);
        const requests = nativeRequests().filter(row => row.admission_id === work.id);
        assert.equal(requests.length, 1);
        const [native] = requests;
        const inputs = handler().filter(row => row.workId === work.id);
        const providers = service.calls.filter(row => row.input === fixture.prompts[index]);
        assert.equal(inputs.length, 1);
        assert.equal(providers.length, 1);
        const [input] = inputs;
        const [provider] = providers;
        assert.equal(native.id, input.requestId);
        assert.equal(native.id, provider.id);
        assert.ok(provider.at >= work.not_before);
        for (const packet of [input, provider]) {
            const promptText = systemText(packet.messages);
            assert.equal(occurrences(promptText, expected), 1);
            assert.equal(occurrences(promptText, other), 0);
            assert.equal(packet.model, frozenWork.model);
            assert.equal(packet.temperature, frozenWork.temperature);
            assert.equal(packet.max_tokens, frozenWork.maxOutputTokens);
            assert.equal(packet.stream, frozenWork.streamOutput);
        }
        assert.deepEqual(history(role).slice(index * 2, index * 2 + 2).map(({id, role, content}) => ({id, role, content})), [
            {id:work.user_message_id, role:'user', content:fixture.prompts[index]},
            {id:work.reply_message_id, role:'assistant', content:fixture.replies[index]},
        ]);
        await waitUntil(() => evalJs(client, 'document.querySelector("#chatMessages").innerText.includes(' + quote(fixture.replies[index]) + ')'),
            role + ' rendered completed reply');
        await picture(client, role + '-reply');
        evidence.turns.push({
            role, requestId:work.request_id, workId:work.id, workState:work.state, workAttempts:work.attempts,
            requestDispatched:work.request_dispatched, admissionState:admission.state, admissionDispatched:admission.dispatched,
            nativeTerminal:admission.native_terminal, sentThrough:post.route, nativeRequestId:native.id, nativeRequestState:native.state,
            userMessageId:work.user_message_id, replyMessageId:work.reply_message_id,
            workConfigSha256:digest(work.config_snapshot), admissionConfigSha256:digest(admission.config_json),
            workPrompt:frozenWork.systemPrompt, ownerConfigVersion:frozenAdmission.owner.version, ownerConfigHash:frozenAdmission.owner.configHash,
            executionConfig:frozenWork,
            handler:{count:inputs.length, route:input.route, systemText:systemText(input.messages), oppositeMarkerCount:0},
            provider:{count:providers.length, at:provider.at, systemText:systemText(provider.messages), oppositeMarkerCount:0},
        });
        return {frozenWork, frozenAdmission};
    }

    try {
        assert.notEqual(result.A.profileDigest, result.B.profileDigest);
        evidence.loadedDesktopSources = Object.fromEntries(await Promise.all(Object.entries({A, B}).map(async ([role, client]) => {
            const loaded = await client.command('loaded-sources', sources);
            for (const [section, files] of Object.entries(sources)) {
                assert.deepEqual(loaded[section].map(source => source.file).sort(), [...files].sort());
                for (const source of loaded[section]) assert.equal(source.sha256, sha(path.join(result.candidate, source.file)));
            }
            return [role, loaded];
        })));
        const before = snapshot();
        evidence.before = before;
        assert.equal(before.object.config.systemPrompt, fixture.oldPrompt);
        assert.deepEqual(works(), []);
        assert.deepEqual(admissions(), []);
        await Promise.all([select(A, 'A'), select(B, 'B')]);
        assert.deepEqual(history('A'), []);
        assert.deepEqual(history('B'), []);
        await send(A, 0);
        await waitUntil(() => works().length === 1 && sendPosts().some(row => row.response?.workId === works()[0].id),
            'desktop A atomically accepted');
        assertHeld('A accepted before mobile save');
        const requireServer = createRequire(path.join(result.candidate, 'apps/server/package.json'));
        evidence.mobile = await require('./mobile.cjs')({
            service, out, cert, sharedSpaceId, sharedOwnerId, topicKey, updatedPrompt:fixture.updatedPrompt, snapshot, assertHeld,
            request:mobileControl(service, cert, out), puppet:requireServer('puppeteer'),
        });
        for (const { path:route, sha256 } of Object.values(evidence.mobile.loadedBundles)) {
            assert.match(route, /^\/mobile\/assets\/index-[A-Za-z0-9_-]+\.js$/);
            const stagedPath = path.join(out, 'runtime-box', 'Plugin', 'NativeSync', 'mobile-dist', 'assets', path.basename(route));
            assert.equal(sha(stagedPath), sha256, 'served PWA JavaScript matches staged build');
            if (source.candidate) assert.notEqual(sha256, source.baselineBundleSha256, 'PWA candidate build is fresh');
            if (source.archivedBaseline) assert.equal(sha256, source.baselineBundleSha256);
        }
        const afterCommit = snapshot({opId:evidence.mobile.opId});
        assert.deepEqual(afterCommit.receipts.map(row => row.request_hash), [evidence.mobile.bodyHash]);
        evidence.after = afterCommit;
        evidence.promptOnly = isDeepStrictEqual(evidence.after.object.config, {...before.object.config, systemPrompt:fixture.updatedPrompt});
        assert.equal(evidence.after.object.version, before.object.version + 1);
        assert.notEqual(evidence.after.object.configHash, before.object.configHash);
        assert.equal(evidence.after.configRows, before.configRows + 1);
        assert.equal(evidence.after.changeRows, before.changeRows + 1);
        assertHeld('after mobile checks before dispatch release');
        assert.ok(Date.now() < held.work.not_before, 'PWA checks fit inside the native 10-second start delay');
        const first = await terminal(0);
        assert.equal(evidence.turns[0].workConfigSha256, evidence.held[0].workConfigSha256);
        assert.equal(evidence.turns[0].admissionConfigSha256, evidence.held[0].admissionConfigSha256);
        await waitUntil(() => {
            const row = db.prepare('SELECT config_json FROM owner_execution_configs WHERE topic_key=? ORDER BY version DESC LIMIT 1').get(topicKey);
            return row && JSON.parse(row.config_json).systemPrompt === fixture.updatedPrompt && history('B').length === 2;
        }, 'new derived configuration and A History available to desktop B');
        await send(B, 1);
        const second = await terminal(1);
        const fields = [...new Set([...Object.keys(first.frozenWork), ...Object.keys(second.frozenWork)])];
        const changed = fields.filter(key => !isDeepStrictEqual(first.frozenWork[key], second.frozenWork[key]));
        evidence.changedExecutionFields = changed.sort();
        const compare = ({ systemPrompt, version, hash, sharedTemplateHash, ...config }) => config;
        assert.deepEqual(compare(second.frozenWork), compare(first.frozenWork));
        assert.equal(first.frozenAdmission.owner.configHash, before.object.configHash);
        assert.equal(second.frozenAdmission.owner.configHash, evidence.after.object.configHash);
        await waitUntil(() => history('A').length === 4 && history('B').length === 4, 'all four native History lines on A and B');
        evidence.finalHistory = Object.fromEntries(['A','B'].map(role => [role, history(role).map(({id, role, content}) => ({id, role, content}))]));
        assert.deepEqual(evidence.finalHistory.A, evidence.finalHistory.B);
        assert.equal(sendPosts().length, 2);
        assert.equal(handler().length, 2);
        assert.equal(service.calls.length, 2);
        assert.equal(nativeRequests().length, 2);
        assert.ok(evidence.promptOnly, 'Mobile save must change only systemPrompt on the shared object');
    } finally {
        db.close();
    }
};

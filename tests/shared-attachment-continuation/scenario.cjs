'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const fixture = require('./fixture.cjs');

const quote = JSON.stringify;
const fileMarker = 'SYNTHETIC_FILE_SENTINEL_73';
const digest = createHash('sha256').update(fixture.content).digest('hex');
const baseline = process.env.NS_ATTACHMENT_PATH_BASELINE === '1';
const textParts = messages => messages.flatMap(({ content }) => Array.isArray(content)
    ? content.filter(part => part.type === 'text').map(part => part.text)
    : [content]).filter(value => typeof value === 'string');

module.exports = async ({ clients:{ A, B, L }, cert, out, result, service, picture, click, evalJs, waitUntil, start, stop, profiles }) => {
    const topic = service.topics.preSubmit.id;
    const db = new DatabaseSync(path.join(service.data, 'central.sqlite'), { readOnly:true });
    const evidence = result.attachmentContinuation = {
        revision:execFileSync('git', ['rev-parse', 'HEAD'], {cwd:result.candidate,encoding:'utf8'}).trim(),
        topic, file:{ name:fixture.filename, digest, bytes:Buffer.byteLength(fixture.content) },
        chooser:'fixture-selected synthetic file via real desktop attachment IPC',
        BDownloadCacheEnabled:false, toolsForbidden:fixture.toolsForbidden, turns:[],
    };
    const works = () => db.prepare(`SELECT id,request_id,state,attempts,request_dispatched,user_message_id,reply_message_id
        FROM mobile_executions WHERE topic_key=? ORDER BY rowid`).all(topic);
    const admissions = () => db.prepare(`SELECT id,request_id,principal,state,dispatched,native_terminal
        FROM shared_admissions WHERE topic_id=? ORDER BY rowid`).all(topic);
    const history = role => {
        const { itemId, topicId } = service.descriptors[role].preSubmit;
        return JSON.parse(fs.readFileSync(path.join(profiles[role], 'UserData', itemId, 'topics', topicId, 'history.json')));
    };
    const transcript = client => evalJs(client, "document.querySelector('#chatMessages').innerText");
    const preview = client => evalJs(client,
        "[...document.querySelectorAll('#attachmentPreviewArea .attachment-preview-item')].map(row => row.innerText)");

    const handlerInputs = () => fs.existsSync(fixture.capture(out)) ? fs.readFileSync(fixture.capture(out), 'utf8')
        .trim().split('\n').filter(Boolean).map(JSON.parse).filter(row => row.kind === 'handler-input') : [];
    const requestStages = async (client, handler, provider, desktopDispatched) => {
        const { renderer, ipc } = await client.command('read-request-output');
        assert.equal(renderer.length, Number(desktopDispatched));
        assert.deepEqual(renderer, ipc, 'renderer packets match sendToVCP IPC input');
        return [
            ...(desktopDispatched ? [['renderer output', renderer[0]], ['sendToVCP IPC', ipc[0]]] : []),
            ['ToolBox handler', handler], ['loopback provider', provider],
        ].map(([stage, packet]) => {
            assert.ok(Array.isArray(packet?.messages), 'captured messages at ' + stage);
            const userText = textParts(packet.messages.filter(row => row.role === 'user')).join('\n');
            const systemText = textParts(packet.messages.filter(row => row.role === 'system')).join('\n');
            return { stage, requestId:packet.messageId || packet.requestId || packet.id,
                markerCount:userText.split(fileMarker).length - 1,
                fileTextCount:userText.split(fixture.content.trimEnd()).length - 1,
                localPathPresent:userText.includes('file://') || userText.includes(out) || userText.includes('internalPath'),
                systemLocalPathPresent:systemText.includes(out),
                forbiddenDirectivePresent:systemText.includes(fixture.forbiddenDirective),
                attachmentHeader:userText.match(/^\[附加文件: .+\]$/m)?.[0].replaceAll(out, '<isolated-run>'),
                userText:userText.replaceAll(out, '<isolated-run>'),
            };
        });
    };
    function assertStages(stages, attachmentPath, historyPath) {
        assert.ok(stages[0].requestId);
        for (const row of stages) {
            assert.equal(row.requestId, stages[0].requestId, row.stage);
            assert.equal(row.markerCount, 1, row.stage);
            assert.equal(row.fileTextCount, 1, row.stage);
            assert.equal(row.localPathPresent, attachmentPath, row.stage);
            assert.equal(row.systemLocalPathPresent, historyPath, row.stage);
            assert.equal(row.forbiddenDirectivePresent, fixture.toolsForbidden && row.stage !== 'loopback provider', row.stage);
            assert.equal(row.userText, stages[0].userText, row.stage);
            if (attachmentPath) {
                assert.match(row.attachmentHeader, /^\[附加文件: file:\/\//, row.stage);
                assert.ok(row.attachmentHeader.endsWith('/' + digest + '.txt]'), row.stage);
            } else {
                assert.equal(row.attachmentHeader, '[附加文件: ' + fixture.filename + ']', row.stage);
            }
        }
    }
    async function attach(client) {
        await click(client, '#attachFileBtn');
        await waitUntil(async () => (await preview(client)).some(text => text.includes(fixture.filename.slice(0, 17))),
            'composer shows synthetic text attachment');
    }
    async function submit(client, prompt) {
        await click(client, '#messageInput');
        await client.command('type-composer', prompt);
        await click(client, '#sendMessageBtn');
    }
    async function localControl() {
        await click(L, '#agentList > li .agent-name', 'Synthetic local control');
        await waitUntil(async () => (await evalJs(L, 'window.VCPStateChannels.get("conversation.current").get()')).topicId === 'local-topic',
            'selected ordinary local topic');
        const target = { itemType:'agent', itemId:'local-agent', topicId:'local-topic' };
        const ownership = await evalJs(L, `window.chatAPI.getNativeDeletionContext(${quote(target)})`);
        assert.equal(ownership.kind, 'local');
        await attach(L);
        await submit(L, fixture.prompts[0]);
        const nativeHistory = path.join(profiles.L, 'UserData', 'local-agent', 'topics', 'local-topic', 'history.json');
        const rows = await waitUntil(() => {
            const saved = JSON.parse(fs.readFileSync(nativeHistory, 'utf8'));
            return saved.find(row => row.role === 'assistant' && row.content === fixture.replies[0]) && saved;
        }, 'local ordinary native History terminal');
        await waitUntil(async () => (await transcript(L)).includes(fixture.replies[0]), 'local renderer terminal');
        assert.equal(rows.find(row => row.role === 'user').attachments[0]._fileManagerData.hash, digest);
        assert.deepEqual(admissions(), []);
        assert.deepEqual(works(), []);
        assert.equal(service.calls.length, 1);
        assert.equal(handlerInputs().length, 1);
        const [handler] = handlerInputs();
        assert.equal(handler.workId, null);
        evidence.localControl = { ownership:ownership.kind,
            stages:await requestStages(L, handler, service.calls[0], true),
            nativeHistory:rows.map(({ role, id }) => ({ role, id })),
        };
        assertStages(evidence.localControl.stages, true, true);
        await picture(L, 'local-reply');
    }
    async function select(client, role) {
        const target = service.descriptors[role].preSubmit;
        if (!await evalJs(client, "document.querySelector('#tabContentAgents').classList.contains('active')")) {
            await click(client, '.sidebar-tab-button[data-tab="agents"]');
        }
        await click(client, '#agentList > li .agent-name', 'Synthetic shared');
        await waitUntil(async () => (await evalJs(client, 'window.VCPStateChannels.get("conversation.current").get()')).topicId === target.topicId,
            'selected shared topic on desktop ' + role);
        await waitUntil(async () => {
            try {
                return (await evalJs(client, `window.chatAPI.getNativeDeletionContext(${quote(target)})`))?.kind === 'shared';
            } catch (error) {
                if (!error.message.includes('No handler registered')) throw error;
                return false;
            }
        }, 'shared topic ownership on desktop ' + role);
    }

    async function send(client, role, index) {
        const prompt = fixture.prompts[index];
        const eventOffset = client.events.length;
        await submit(client, prompt);
        const terminal = await waitUntil(() => {
            const current = admissions()[index];
            if (current?.state !== 'completed') return false;
            const execution = works().find(row => row.id === current.id);
            const rows = history(role);
            const user = rows.find(row => row.content === prompt);
            const reply = user && rows[rows.findIndex(row => row.id === user.id) + 1];
            return reply?.role === 'assistant' && { current, execution, rows, user, reply };
        }, role + ' durable admission and native History terminal');
        const { current, execution, rows:saved, user, reply } = terminal;
        const work = { ...current, ...execution, user_message_id:user.id, reply_message_id:reply.id };
        const endpoint = index === 0 ? '/admit' : '/session-send';
        const receipt = service.requests.find(row => row.route.endsWith(endpoint) && row.body?.requestId === work.request_id);
        const handler = handlerInputs().find(row => row.workId === work.id);
        const provider = service.calls[index + 1];
        const ipc = client.events.slice(eventOffset).filter(row => row.event === 'ipc').map(row => row.data.channel);
        const turn = { role, work, receipt, desktopIpc:{
            chooser:client.events.filter(row => row.event === 'ipc' && row.data.channel === 'select-files-to-send').length,
            nativeProvider:ipc.filter(channel => channel === 'send-to-vcp').length,
        }, handler:handler && { route:handler.route, workId:handler.workId, requestId:handler.requestId,
            messages:handler.messages }, provider };
        evidence.turns.push(turn);
        turn.stages = await requestStages(client, handler, provider, index === 0);
        assertStages(turn.stages, index === 0 && (baseline || !fixture.toolsForbidden), baseline && index === 0);
        assert.equal(work.state, 'completed');
        assert.equal(work.dispatched, 1);
        assert.equal(work.native_terminal, 1);
        assert.equal(receipt?.device, 'device' + role);
        assert.ok(receipt.status >= 200 && receipt.status < 300);
        if (execution) {
            assert.equal(index, 1);
            assert.equal(execution.attempts, 1);
            assert.equal(execution.request_dispatched, 1);
            assert.equal(receipt.response.workId, work.id);
            assert.equal(execution.user_message_id, user.id);
            assert.equal(execution.reply_message_id, reply.id);
        } else {
            assert.equal(index, 0);
        }
        turn.projected = saved.map(({ id, role, content, attachments }) => ({
            id, role, content, attachments:attachments?.map(({ id, name, hash, blobHash, size, type, internalPath }) =>
                ({ id, name, hash, blobHash, size, type, localPathPresent:Boolean(internalPath) })),
        }));
        await waitUntil(async () => (await transcript(client)).includes(saved.find(row => row.id === work.reply_message_id).content),
            role + ' renderer terminal');
        await picture(client, role + '-reply');
        return saved;
    }

    async function observeRenderer(client) {
        const modules = [
            'apps/desktop/modules/chat/chatContextPipeline.js',
            'apps/desktop/modules/chat/singleChatRequestOrchestrator.js',
            'apps/desktop/modules/chatManager.js',
        ];
        const { renderer } = await client.command('loaded-sources', { main:[], renderer:modules });
        const loaded = renderer.sort((a, b) => a.file.localeCompare(b.file));
        assert.deepEqual(loaded.map(row => row.file), modules);
        for (const row of loaded) {
            assert.equal(row.sha256, createHash('sha256').update(fs.readFileSync(path.join(result.candidate, row.file))).digest('hex'));
        }
        return { loaded, observer:await client.command('observe-request-output') };
    }

    try {
        assert.notEqual(result.A.profileDigest, result.B.profileDigest);
        await select(B, 'B');
        assert.deepEqual(history('B'), []);
        await stop('B');
        const observed = await observeRenderer(A);
        evidence.rendererSources = observed.loaded;
        evidence.rendererObserver = observed.observer;
        await select(A, 'A');
        assert.deepEqual(await observeRenderer(L), observed);
        await localControl();
        await stop('L');
        await select(A, 'A');
        await attach(A);
        await picture(A, 'A-attached');
        const aHistory = await send(A, 'A', 0);
        const first = evidence.turns[0].work;
        const attached = aHistory.find(row => row.id === first.user_message_id)?.attachments?.[0];
        evidence.initialAttachment = evidence.turns[0].projected.find(row => row.id === first.user_message_id)?.attachments;
        assert.equal(attached.name, fixture.filename);
        assert.equal(attached.hash, digest);
        evidence.uploadBeforeB = db.prepare(`SELECT id,principal,expected_hash,hash,state,size,offset,msg_id,
            attachment_id,execution_id,actual_type FROM attachment_uploads WHERE hash=?`).all(digest);
        await stop('A');
        fs.renameSync(fixture.file(out), path.join(out, 'retired-synthetic-source.txt'));
        evidence.originalPathUnavailable = !fs.existsSync(fixture.file(out));
        assert.ok(evidence.originalPathUnavailable);
        const aCache = attached.internalPath ? fileURLToPath(attached.internalPath)
            : path.join(profiles.A, 'UserData', 'attachments', digest + '.txt');
        assert.ok(aCache.startsWith(profiles.A + path.sep));
        if (fs.existsSync(aCache)) fs.renameSync(aCache, path.join(out, 'retired-synthetic-A-cache.txt'));
        evidence.ACachedPathUnavailable = !fs.existsSync(aCache);
        evidence.ARuntimeClosedBeforeBRestart = A.events.some(row => row.event === 'runtime-close-end') && result.exits.A.code === 0;
        assert.ok(evidence.ARuntimeClosedBeforeBRestart);
        assert.ok(evidence.ACachedPathUnavailable);
        const reopened = await start('B-reopened', 'B');
        assert.equal(result.B.profileDigest, result['B-reopened'].profileDigest);
        assert.deepEqual(await observeRenderer(reopened), observed);
        await select(reopened, 'B');
        await waitUntil(() => history('B').some(row => row.id === first.reply_message_id), 'B has A reply in physical native History');
        await waitUntil(async () => (await transcript(reopened)).includes(fixture.replies[0]), 'B sees A reply');
        assert.deepEqual(await preview(reopened), []);
        const projected = history('B').find(row => row.id === first.user_message_id)?.attachments?.[0];
        assert.equal(projected.id, attached.id);
        assert.equal(projected.hash, digest);
        assert.equal(projected.internalPath, undefined);
        await picture(reopened, 'B-reopened');
        const bHistory = await send(reopened, 'B', 1);
        const second = evidence.turns[1].work;
        assert.equal(bHistory.find(row => row.id === second.user_message_id)?.attachments?.length ?? 0, 0);

        evidence.uploads = db.prepare(`SELECT id,principal,expected_hash,hash,state,size,offset,msg_id,attachment_id,execution_id,actual_type
            FROM attachment_uploads WHERE hash=?`).all(digest);
        evidence.links = db.prepare('SELECT msg_id,attachment_id,hash FROM attachment_links WHERE hash=?').all(digest).map(row => ({...row}));
        evidence.blobs = db.prepare('SELECT hash,size,type,state FROM attachment_blobs WHERE hash=?').all(digest);
        const file = fs.readFileSync(path.join(service.data, 'attachments', digest.slice(0, 2), digest));
        evidence.casDigest = createHash('sha256').update(file).digest('hex');
        assert.equal(evidence.casDigest, digest);
        const source = db.prepare('SELECT message_json FROM journal WHERE topic_id=? AND msg_id=? ORDER BY seq DESC LIMIT 1')
            .get(topic, first.user_message_id);
        const savedAttachment = JSON.parse(source.message_json).attachments[0];
        evidence.canonicalAttachment = { id:savedAttachment.id, hash:savedAttachment.hash,
            extractedTextDigest:createHash('sha256').update(savedAttachment.extractedText).digest('hex'),
            localPathPresent:Object.hasOwn(savedAttachment, 'internalPath') };
        assert.deepEqual(evidence.canonicalAttachment, { id:attached.id, hash:digest, extractedTextDigest:digest, localPathPresent:false });
        evidence.journal = db.prepare('SELECT seq,msg_id,action,hash FROM journal WHERE topic_id=? ORDER BY seq').all(topic);
        evidence.admissions = admissions();
        evidence.nativeRequests = db.prepare(`SELECT id,admission_id,state FROM shared_native_requests
            WHERE admission_id IN (?,?) ORDER BY rowid`).all(first.id, second.id);
        evidence.attachmentRequests = service.requests.filter(row => row.route.includes('/shared-attachments/'))
            .map(({ route, method, status, device }) => ({ route, method, status, device }));

        assert.equal(evidence.uploads.length, 1);
        assert.deepEqual(evidence.uploadBeforeB, evidence.uploads);
        assert.equal(evidence.uploads[0].principal, 'desktop:deviceA');
        assert.equal(evidence.uploads[0].state, 'ready');
        assert.deepEqual(evidence.links, [{ msg_id:first.user_message_id, attachment_id:attached.id, hash:digest }]);
        assert.equal(evidence.blobs.length, 1);
        assert.deepEqual(evidence.attachmentRequests.filter(row => row.method === 'POST').map(row => [
            row.device, row.status, row.route.split('/').at(-1),
        ]), [['deviceA',201,'uploads'],['deviceA',200,'chunks'],['deviceA',200,'finish']]);
        assert.equal(evidence.attachmentRequests.filter(row => row.device === 'deviceB' && row.method === 'POST').length, 0);
        assert.equal(service.calls.length, 3);
        assert.equal(service.requests.filter(row => row.route.endsWith('/session-send')).length, 1);
        assert.equal(service.requests.filter(row => row.route.endsWith('/admit')).length, 1);
        assert.equal(works().length, 1);
        assert.deepEqual(evidence.journal.map(row => [row.msg_id,row.action]),
            [first.user_message_id, first.reply_message_id, second.user_message_id, second.reply_message_id].map(id => [id,'upsert']));
        assert.deepEqual(evidence.admissions.map(row => [row.principal,row.dispatched,row.native_terminal]),
            [['desktop:deviceA',1,1],['desktop:deviceB',1,1]]);
        assert.equal(evidence.nativeRequests.length, 2);
        assert.deepEqual(evidence.turns.map(turn => turn.desktopIpc), [
            { chooser:1, nativeProvider:1 }, { chooser:0, nativeProvider:0 },
        ]);
        for (const [index, turn] of evidence.turns.entries()) {
            const request = evidence.nativeRequests.find(row => row.admission_id === turn.work.id);
            assert.ok(request);
            assert.equal(turn.handler?.requestId, request.id);
            assert.equal(turn.provider.id, request.id);
            assert.equal(request.state, 'model_terminal');
            const current = index === 0 ? aHistory : bHistory;
            assert.equal(current.find(row => row.id === turn.work.reply_message_id)?.content, fixture.replies[index]);
            turn.bodyChecks = [];
            for (const [stage, packet] of [['native handler',turn.handler],['loopback provider',turn.provider]]) {
                const raw = JSON.stringify(packet.messages);
                const parts = textParts(packet.messages);
                const markerCount = parts.join('\n').split(fileMarker).length - 1;
                const fileTextCount = parts.join('\n').split(fixture.content.trimEnd()).length - 1;
                const localPathPresent = raw.includes('file://') || raw.includes(out) || raw.includes('internalPath');
                turn.bodyChecks.push({ stage, markerCount, fileTextCount, localPathPresent });
                assert.equal(markerCount, 1);
                assert.equal(fileTextCount, 1);
                assert.ok(parts.some(text => text.includes(fixture.prompts[index])));
                if (index === 1) {
                    assert.equal(localPathPresent, false);
                    const source = textParts(packet.messages.filter(row => row.role === 'user')).find(part => part.includes(fileMarker));
                    assert.ok(source.startsWith(fixture.prompts[0]));
                    assert.ok(source.includes('[附加文件: ' + fixture.filename + ']'));
                }
            }
        }
        evidence.toolDirectiveProbe = await fixture.verifyToolDirective({ service, out, cert });
    } finally {
        db.close();
    }
};

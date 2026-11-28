'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { coreFixture, wait, BOX, CHAT, localProvider, host } = require('./fixtures/coreSingleHarness.cjs');

const fixtureConfig = { name: 'Fixture Agent', model: 'synthetic', systemPrompt: 'Isolated fixture.' };

test('Core single chat uses native execution without Resident and separates observation from Work', async t => {
    const provider = await localProvider(t);
    const { chat, events } = host(provider);
    const f = await coreFixture(t, chat);
    const { core } = f;
    f.core.local.imageModels.push('synthetic');
    const { route, descriptor } = await f.define({ config: { ...fixtureConfig, streamOutput: true } });
    let upstream;
    const release = text => upstream.end('data: ' + JSON.stringify({
        choices: [{ delta: { content: text }, finish_reason: 'stop' }]
    }) + '\n\ndata: [DONE]\n\n');
    provider.setReply((_body, res) => {
        upstream = res;
        res.setHeader('Content-Type', 'text/event-stream');
        res.write('data: {"choices":[{"delta":{"content":"prefix "}}]}\n\n');
    });
    const observer = new AbortController();
    let observedDone;
    try {
        const desktop = await f.desktop('A');
        const phone = await f.mobile();
        const readOnly = await f.mobile(['read']);
        const png = await require(BOX + '/node_modules/sharp')({
            create: { width: 16, height: 16, channels: 3, background: '#00aa44' }
        }).png().toBuffer();
        const file = path.join(desktop.data, 'UserData', 'attachments', 'image.png');
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, png);
        const accepted = await desktop.runtime.prepareSharedSend({
            descriptor, serverSession: true,
            message: { id: 'desktop-core-request', role: 'user', content: 'What is in the image?',
                attachments: [{ id: 'core-image', name: 'image.png', type: 'image/png', size: png.length, internalPath: file }] }
        });
        assert.equal(accepted.core, true);
        const workId = accepted.serverSession.executionId;
        await desktop.close();
        await wait(() => {
            const work = core.store.work(workId);
            if (work.error_code) throw Error('Core stopped before provider: ' + work.error_code);
            return upstream;
        }, 'native provider started');
        assert.ok(provider.calls[0].messages.some(m => Array.isArray(m.content) &&
            m.content.some(part => part.type === 'image_url' && part.image_url.url.startsWith('data:image/jpeg;base64,'))));
        const { consumeSharedEvents } = await import(CHAT + '/modules/services/nativeSync/sharedEventClient.mjs');
        const observed = [];
        const response = await phone.observe(route + '/observe', observer.signal);
        observedDone = consumeSharedEvents(response, (data, type) => observed.push({ type, ...data }),
            { signal: observer.signal, envelope: true }).catch(error => { if (!observer.signal.aborted) throw error; });
        await wait(() => observed.some(event => event.type === 'work_preview' && event.text === 'prefix '), 'live remote preview');
        await readOnly.call(route + '/send', { requestId: 'read-only-send', text: 'denied' }, 403);
        await phone.call(route.replace('/personal/', '/foreign/') + '/messages', undefined, 403);
        const steering = { requestId: 'steering-from-mobile', text: 'Please be concise' };
        const steered = await phone.call(route + '/works/' + workId + '/steer', steering, 202);
        assert.deepEqual(await phone.call(route + '/works/' + workId + '/steer', steering, 202), steered);
        const receiptPath = '/steering-receipt?requestId=' + steering.requestId;
        const receipt = { receipt: { ...steered, requestId: steering.requestId } };
        const readSteering = route + '/works/' + workId + receiptPath;
        assert.deepEqual(await phone.call(readSteering), receipt);
        assert.deepEqual(await readOnly.call(readSteering), { receipt: null }, 'same workspace, different principal');
        await phone.call(readSteering.replace('/personal/', '/foreign/'), undefined, 403);
        assert.deepEqual(await phone.call(route + '/works/wrong-work' + receiptPath), { receipt: null });
        assert.deepEqual(await phone.call(readSteering + '-unsent'), { receipt: null });
        assert.deepEqual(await phone.call(route + '/receipt?requestId=' + steering.requestId), { executions: [] });
        release('intermediate');
        await wait(() => provider.calls.length === 2, 'next native turn includes steering');
        assert.match(JSON.stringify(provider.calls[1].messages), /Please be concise/);
        release('final');
        await wait(() => core.store.work(workId).status === 'completed', 'formal Core completion');
        assert.deepEqual(await phone.call(readSteering), receipt);
        await wait(() => observed.some(event => event.type === 'work_state' && event.status === 'completed'), 'remote terminal event');
        observer.abort();
        const snapshot = await phone.call(route + '/messages');
        assert.deepEqual(snapshot.messages.map(m => m.content), ['What is in the image?', 'Please be concise', 'prefix final']);
        const image = snapshot.messages[0].attachments[0];
        assert.deepEqual(await phone.download(route + '/blob/' + image.hash), png);
        const reopen = await f.desktop('B');
        const readback = await reopen.runtime.coreSingle.history(descriptor);
        assert.deepEqual(readback.history.map(m => m.id), snapshot.messages.map(m => m.id));
        assert.ok(readback.history[0].attachments[0].src.startsWith('file:'));
        assert.deepEqual(await reopen.queue.read(reopen.descriptor).catch(() => []), []);
        assert.deepEqual(events.slice(-2), [['one-ring', 'prefix final'], ['tavern']]);

        provider.setReply((_body, res) => { res.statusCode = 502; res.end('fixture-upstream-error'); });
        const failed = await phone.call(route + '/send', { requestId: 'known-upstream-error', text: 'another turn' }, 202);
        await wait(() => core.store.work(failed.id).status === 'failed', 'known upstream error');
        assert.equal(core.store.work(failed.id).error_code, 'UPSTREAM_ERROR');
        assert.equal((await phone.call(route + '/messages')).messages.filter(m => m.role === 'assistant').length, 1);
        assert.deepEqual(events.at(-1), ['aborted']);
    } finally {
        observer.abort();
        await observedDone;
    }
});

test('Core only requeues undispatched Work and commits a matching pending final after process death', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'core-crash-'));
    const filename = path.join(root, 'core.sqlite');
    const storePath = BOX + '/core/store';
    try {
        const result = spawnSync(process.execPath, ['-e', `
    const { CoreStore } = require(process.argv[1]);
    const store = new CoreStore(process.argv[2]);
    const { db } = store;
        const principal = 'desktop:fixture';
        const topic = { workspace: 'development', key: 'core-recovery', ownerId: 'agent' };
        const admit = requestId => store.admit(topic, principal, requestId, { text: requestId }, () => ({ attachments: [], config: {} }));
        const [undispatched, pending, inFlight, cancelled, invalid] = [
            'undispatched', 'final-pending', 'tool-dispatched', 'cancelled', 'rejected-final'
        ].map(admit);
        for (const item of [undispatched, pending, inFlight, invalid]) store.setState(item.workId, 'running');
        for (const item of [pending, inFlight, invalid]) db.prepare('UPDATE works SET dispatched=1 WHERE id=?').run(item.workId);
        store.saveFinal(store.work(pending.workId), 'recovered final');
        store.saveFinal(store.work(invalid.workId), 'must not publish');
        db.prepare("INSERT INTO work_invocations (id,work_id,plugin_name,status) VALUES('fixture-tool',?,'Example','dispatched')").run(inFlight.workId);
        store.control(topic.key, principal, 'cancel-intent', cancelled.workId, 'cancel');
    process.stdout.write(JSON.stringify({ topic, undispatched, pending, inFlight, cancelled, invalid }),
        () => process.kill(process.pid, 'SIGKILL'));
`, storePath, filename], { encoding: 'utf8', timeout: 5000 });
        assert.equal(result.signal, 'SIGKILL', result.stderr);
        const { topic, undispatched, pending, inFlight, cancelled, invalid } = JSON.parse(result.stdout);
        const { CoreStore } = require(storePath);
        const store = new CoreStore(filename);
        const { db } = store;
        store.recover(work => work.id !== invalid.workId);
        assert.equal(store.work(undispatched.workId).status, 'queued');
        assert.equal(store.work(pending.workId).status, 'completed');
        assert.equal(store.work(inFlight.workId).status, 'review_required');
        assert.equal(store.work(cancelled.workId).status, 'cancelled');
        assert.equal(store.work(invalid.workId).status, 'review_required');
        assert.equal(db.prepare("SELECT status FROM work_invocations WHERE id='fixture-tool'").get().status, 'unknown');
        assert.deepEqual(store.snapshot(topic.key, Number.MAX_SAFE_INTEGER, 20).filter(m => m.role === 'assistant').map(m => m.content), ['recovered final']);
        const workCount = db.prepare('SELECT count(*) AS n FROM works').get().n;
        store.transaction(() => store.insertMessage({ id: 'independent-message', key: topic.key, role: 'assistant', content: 'Independent message.' }));
        assert.equal(db.prepare("SELECT source_work_id FROM messages WHERE id='independent-message'").get().source_work_id, null);
        assert.equal(db.prepare('SELECT count(*) AS n FROM works').get().n, workCount);
        db.close();
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('Core retains external HTTP chat compatibility for JSON and SSE', async t => {
    const provider = await localProvider(t);
    const { chat } = host(provider);
    const f = await coreFixture(t, chat);
    provider.setReply((body, res) => {
        if (!body.stream) return res.end(JSON.stringify({
            choices: [{ message: { content: 'legacy JSON' }, finish_reason: 'stop' }]
        }));
        res.setHeader('Content-Type', 'text/event-stream');
        res.end('data: {"choices":[{"delta":{"content":"legacy SSE"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    const run = stream => f.request('/v1/chat/completions', {
        body: { model: 'synthetic', stream, messages: [{ role: 'user', content: 'hi' }] }
    });
    const json = await run(false);
    assert.equal(json.status, 200);
    assert.equal((await json.json()).choices[0].message.content, 'legacy JSON');
    const streamed = await run(true);
    assert.equal(streamed.status, 200);
    assert.match(streamed.headers.get('content-type'), /text\/event-stream/);
    const body = await streamed.text();
    assert.match(body, /legacy SSE/);
    assert.match(body, /data: \[DONE\]/);
});

test('Core leaves a lost provider outcome for review without repeating the call', async t => {
    const provider = await localProvider(t);
    const { chat } = host(provider);
    chat.config.apiRetries = 3;
    provider.setReply((_body, res) => res.destroy());
    const f = await coreFixture(t, chat);
    const { core } = f;
    const { route, descriptor } = await f.define({ config: fixtureConfig });
    const phone = await f.mobile();
    const accepted = await phone.call(route + '/send', { requestId: 'lost-provider-core', text: 'Only one provider attempt' }, 202);
    await wait(() => core.store.work(accepted.id).status === 'review_required', 'unknown network outcome');
    assert.equal(provider.calls.length, 1);
    assert.equal(core.store.work(accepted.id).error_code, 'CORE_PROVIDER_OUTCOME_UNKNOWN');
    assert.equal((await phone.call(route + '/messages')).messages.length, 1);
});

test('Core commits the streaming follow-up after one ephemeral Resident proposal', async t => {
    const provider = await localProvider(t);
    const { chat, pluginManager } = host(provider);
    const { CoreTurnSink } = require(BOX + '/core/turnSink');
    const name = 'AGENTSOSResident';
    const presentation = Object.freeze({
        schema: 'agents-os-resident.host-presentation.v1',
        kind: 'OWNER_CONSENT_CHALLENGE',
        title: 'AGENTSOSResident · Owner Consent',
        mutationType: 'CREATE_GOAL_BUNDLE',
        expiresInSeconds: 30,
        challenge: '确认创建，测试甲、测试乙、测试丙'
    });
    pluginManager.plugins.set(name, { name, pluginType: 'hybridservice', communication: { protocol: 'direct' } });
    pluginManager.serviceModules.set(name, { module: {
        async processToolCall(_args, context) {
            await context.emitEphemeralPresentation(presentation);
            return Object.freeze({ data: { content: [{ type: 'text', text: 'Proposal prepared' }] } });
        }
    } });
    const request = [
        '<<<[TOOL_REQUEST]>>>', 'tool_name:「始」AGENTSOSResident「末」,',
        'operation:「始」PROPOSE_GOAL_MUTATION「末」', '<<<[END_TOOL_REQUEST]>>>'
    ].join('\n');
    provider.setReply((_body, response) => {
        response.setHeader('Content-Type', 'text/event-stream');
        const content = provider.calls.length === 1 ? request : 'Ready for review.';
        response.end('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    });
    const { signal } = new AbortController();
    const transient = [], messages = [];
    const sink = new CoreTurnSink({ signal, observe: () => {},
        present: (event, card) => transient.push({ event, card }), commit: content => messages.push(content) });
    try {
        const outcome = await chat.executeTurn({ signal, clientIp: null, body: {
            model: 'synthetic', requestId: 'core-resident-proposal', stream: true,
            messages: [{ role: 'system', content: 'AGENTSOSResident is available.' }, { role: 'user', content: 'Prepare a proposal.' }]
        } }, sink);
        assert.equal(outcome.completed, true);
        assert.equal(provider.calls.length, 2);
        assert.deepEqual(transient, [{ event: 'resident_presentation', card: presentation }]);
        assert.deepEqual(messages, ['Ready for review.']);
        assert.doesNotMatch(JSON.stringify(provider.calls), /测试甲/);
    } finally {
        pluginManager.plugins.delete(name);
        pluginManager.serviceModules.delete(name);
    }
});

function textPdf(text) {
    const commands = 'BT /F1 16 Tf 20 50 Td (' + text + ') Tj ET';
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 250 90] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        '<< /Length ' + commands.length + ' >>\nstream\n' + commands + '\nendstream'
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = objects.map((value, index) => {
        const offset = pdf.length;
        pdf += (index + 1) + ' 0 obj\n' + value + '\nendobj\n';
        return offset;
    });
    const xref = pdf.length;
    pdf += 'xref\n0 6\n0000000000 65535 f \n' + offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
    return Buffer.from(pdf + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
}

test('Core single chat sends existing text and PDF attachments through one native history context', async t => {
    const provider = await localProvider(t);
    const f = await coreFixture(t, host(provider).chat);
    const { core } = f;
    const { route, descriptor } = await f.define({ config: fixtureConfig });
    const text = Buffer.from('CORE_TEXT_FIXTURE');
    const pdf = textPdf('CORE_PDF_FIXTURE');
    const desktop = await f.desktop('A');
    const phone = await f.mobile();
    const directory = path.join(desktop.data, 'UserData', 'attachments');
    await fs.mkdir(directory, { recursive: true });
    const attachments = await Promise.all([['notes.txt', text, 'text/plain'], ['source.pdf', pdf, 'application/pdf']]
        .map(async ([name, data, type]) => {
            const internalPath = path.join(directory, name);
            await fs.writeFile(internalPath, data);
            return { name, type, internalPath, size: data.length };
        }));
    const accepted = await desktop.runtime.prepareSharedSend({
        descriptor, serverSession: true,
        message: { id: 'core-documents', role: 'user', content: 'Read the supplied files.', attachments }
    });
    await desktop.close();
    await wait(() => core.store.work(accepted.serverSession.executionId)?.status === 'completed', 'document turn completion');

    const { messages } = await phone.call(route + '/messages');
    const [attachedText, attachedPdf] = messages[0].attachments;
    assert.deepEqual(messages[0].attachments.map(file => file.name), ['notes.txt', 'source.pdf']);
    assert.equal(Object.hasOwn(attachedPdf, 'extractedText'), false);
    assert.deepEqual(await phone.download(route + '/blob/' + attachedText.hash), text);
    assert.deepEqual(await phone.download(route + '/blob/' + attachedPdf.hash), pdf);
    await phone.call(route.replace('/personal/', '/foreign/') + '/blob/' + attachedPdf.hash, undefined, 403);

    // The original message and blob link outlive the temporary upload proof.
    core.store.db.prepare('UPDATE attachment_uploads SET expires=0').run();
    core.attachments.expire();
    assert.equal(core.store.db.prepare('SELECT count(*) AS count FROM attachment_uploads').get().count, 0);
    const body = { requestId: 'core-document-followup', text: 'Use both attachments again.' };
    const next = await phone.call(route + '/send', body, 202);
    assert.equal((await phone.call(route + '/send', body, 202)).id, next.id);
    await wait(() => core.store.work(next.id)?.status === 'completed', 'document follow-up completion');
    assert.equal(provider.calls.length, 2);
    for (const call of provider.calls) {
        const user = call.messages.filter(message => message.role === 'user');
        const content = JSON.stringify(user[0].content);
        assert.equal(content.match(/CORE_TEXT_FIXTURE/g)?.length, 1);
        assert.equal(content.match(/CORE_PDF_FIXTURE/g)?.length, 1);
        assert.doesNotMatch(JSON.stringify(call.messages), /image_url|file:\/\//);
    }

    const empty = Buffer.from('  \n');
    const upload = await phone.call(route + '/attachments/uploads', {
        requestId: 'core-empty-text-upload', name: 'empty.txt', size: empty.length, type: 'text/plain'
    }, 201);
    const uploadRoute = route + '/attachments/uploads/' + upload.uploadId;
    await phone.call(uploadRoute + '/chunks', { offset: 0, data: empty.toString('base64') });
    await phone.call(uploadRoute + '/finish', {});
    const rejected = await phone.call(route + '/send', {
        requestId: 'core-empty-text-message', text: '', attachments: [upload.uploadId]
    }, 422);
    assert.equal(rejected.error.code, 'ATTACHMENT_TEXT_UNAVAILABLE');
    assert.equal((await phone.call(route + '/messages')).messages.length, 4);
    assert.equal(provider.calls.length, 2);
});

test('Core executes manual compression in-process and reconciles a lost command receipt', async t => {
    const provider = await localProvider(t);
    const f = await coreFixture(t, host(provider).chat);
    const { core } = f;
    const { route, descriptor } = await f.define({ config: fixtureConfig });
    const summaryModel = 'fixture-summary';
    let pending;
    const complete = (res, content) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    };
    provider.setReply((body, response) => {
        if (body.model === summaryModel) { pending = response; return; }
        response.end(JSON.stringify({ choices: [{ message: { content: 'core reply' }, finish_reason: 'stop' }] }));
    });
    const desktop = await f.desktop('A'), phone = await f.mobile(), { runtime } = desktop;
    const input = await phone.call(route + '/send', { requestId: 'checkpoint-source', text: 'ORIGINAL_FIXTURE_BODY' }, 202);
    await wait(() => core.store.work(input.id)?.status === 'completed', 'checkpoint source');
    const settings = { enableContextCompaction: true, contextCompactionModel: summaryModel };
    const stale = runtime.coreSingle.compact(descriptor, settings, 'core-compact-stale');
    const rejection = assert.rejects(stale, { code: 'SHARED_COMPACTION_SOURCE_CHANGED' });
    await wait(() => pending, 'manual native model reached');
    await phone.call(route + '/messages/' + input.messageId, { requestId: 'checkpoint-source-edit', revision: 1, text: 'EDITED_FIXTURE_BODY' });
    complete(pending, 'STALE_CHECKPOINT');
    await rejection;
    await phone.call(route + '/compact', { requestId: 'mobile-manual-compact', model: summaryModel }, 403);

    const send = runtime.send;
    runtime.send = async (url, options) => {
        const result = await send(url, options);
        if (url.endsWith('/compact')) throw Object.assign(Error('Receipt lost'), { code: 'NETWORK_UNAVAILABLE' });
        return result;
    };
    pending = null;
    const { createContextCompactionService } = await import(CHAT + '/modules/chat/contextCompactionService.js');
    const nativeUi = createContextCompactionService({
        historyMutationAuthority: { mutate() { assert.fail('Desktop History writer must not receive a Core checkpoint'); } },
        request() { assert.fail('Desktop must not execute the summary model'); },
        getExecutionAuthority: () => ({ success: true, kind: 'shared', core: true }),
        sharedCompaction: { coreCompact: ({ descriptor, settings, requestId }) => runtime.coreSingle.compact(descriptor, settings, requestId) }
    });
    const original = await runtime.coreSingle.history(descriptor);
    const disputed = assert.rejects(nativeUi.compact({ scope: descriptor, history: original.history, settings }), { code: 'NETWORK_UNAVAILABLE' });
    await wait(() => pending, 'Core summary started through native UI');
    assert.match(JSON.stringify(provider.calls.at(-1).messages), /EDITED_FIXTURE_BODY/);
    complete(pending, '<context_checkpoint>CORE_CHECKPOINT_FIXTURE</context_checkpoint>');
    await disputed;
    await desktop.close();
    const reopened = await f.desktop('A');
    const recovered = await reopened.runtime.coreSingle.compact(descriptor, settings, 'core-compact-retry');
    assert.equal(recovered.history.filter(message => message.contextCompaction).length, 1);
    assert.equal(provider.calls.filter(call => call.model === summaryModel).length, 2);
    assert.equal(recovered.history[0].content, 'EDITED_FIXTURE_BODY');
    const next = await phone.call(route + '/send', { requestId: 'checkpoint-follow-up', text: 'Use the checkpoint.' }, 202);
    await wait(() => core.store.work(next.id)?.status === 'completed', 'follow-up uses checkpoint');
    assert.match(JSON.stringify(provider.calls.at(-1).messages), /CORE_CHECKPOINT_FIXTURE/);
    assert.doesNotMatch(JSON.stringify(provider.calls.at(-1).messages), /EDITED_FIXTURE_BODY/);
    nativeUi.dispose();
});

test('Core automatic compression uses the same native summary before the pending input', async t => {
    const provider = await localProvider(t);
    const f = await coreFixture(t, host(provider).chat);
    const { core } = f;
    const { route, descriptor } = await f.define({ config: fixtureConfig });
    const phone = await f.mobile();
    const previous = await phone.call(route + '/send', {
        requestId: 'auto-compact-source', text: 'Original-past-marker. '.repeat(200)
    }, 202);
    await wait(() => core.store.work(previous.id)?.status === 'completed', 'automatic compaction source');
    await f.define({ config: { ...fixtureConfig, contextTokenLimit: 800,
        executionPolicy: { enableContextCompaction: true, contextCompactionModel: 'fixture-auto-summary' } } });
    provider.setReply((body, res) => {
        if (body.model === 'fixture-auto-summary') {
            res.setHeader('Content-Type', 'text/event-stream');
            res.end('data: {"choices":[{"delta":{"content":"AUTOMATIC_CHECKPOINT_FIXTURE"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
        } else res.end(JSON.stringify({ choices: [{ message: { content: 'Next reply.' }, finish_reason: 'stop' }] }));
    });
    const followup = await phone.call(route + '/send', { requestId: 'auto-compact-followup', text: 'New input.' }, 202);
    await wait(() => {
        const work = core.store.work(followup.id);
        if (work.error_code) throw Error(work.error_code);
        return work.status === 'completed';
    }, 'automatic summary and message');
    assert.deepEqual(provider.calls.map(call => call.model), ['synthetic', 'fixture-auto-summary', 'synthetic']);
    const messageText = JSON.stringify(provider.calls.at(-1).messages);
    assert.match(messageText, /AUTOMATIC_CHECKPOINT_FIXTURE/);
    assert.match(messageText, /New input/);
    assert.doesNotMatch(messageText, /Original-past-marker/);
    const { messages } = await phone.call(route + '/messages');
    assert.equal(messages[2].contextCompaction.checkpoint, 'AUTOMATIC_CHECKPOINT_FIXTURE');
    assert.equal(messages[3].content, 'New input.');
    assert.equal((await phone.call(route + '/messages?before=' + messages[2].ordinal)).messages.length, 2);
});

test('Core reads Canvas, Workspace, and live files through the enrolled native resource node', async t => {
    const provider = await localProvider(t);
    const { chat, pluginManager } = host(provider);
    const webSockets = require(BOX + '/WebSocketServer');
    const WebSocket = require(BOX + '/node_modules/ws');
    const wsServer = require('node:http').createServer();
    webSockets.setPluginManager(pluginManager);
    webSockets.initialize(wsServer, { vcpKey: 'core-node-fixture' });
    await new Promise(resolve => wsServer.listen(0, '127.0.0.1', resolve));
    chat.config.webSocketServer = webSockets;
    const f = await coreFixture(t, chat);
    const { core } = f;
    const agent = { ...fixtureConfig, systemPrompt: '{{VCPChatCanvas}} {{VCPChatWorkSpace:fixture}}' };
    const enrollment = await f.pair('desktop', ['read','execute','config']);
    const actor = core.remote.live('desktop:' + enrollment.deviceId, 'execute');
    const { route, descriptor } = await f.define({ actor, config: agent });
    const group = await f.define({ actor, ownerType: 'group', ownerId: 'resourceGroup', name: 'Resources', config: {
        group: { name: 'Resource group', mode: 'sequential', members: [descriptor.itemId] },
        agents: [{ id: descriptor.itemId, ...agent }]
    } });
    let node;
    try {
        const desktop = await f.desktop('A', enrollment);
        const phone = await f.mobile();
        let selected = descriptor;
        const resources = path.join(f.root, 'workspace-fixture');
        await fs.mkdir(resources);
        const file = path.join(resources, 'notes.txt');
        await fs.writeFile(file, 'actual workspace revision one');
        const { readCoreContext } = require(CHAT + '/modules/services/nativeSync/coreContextNode');
        const { nativeSyncRouteId } = require(CHAT + '/modules/services/topicSponsorDelivery');
        const url = 'ws://127.0.0.1:' + wsServer.address().port + '/vcp-distributed-server/VCP_Key=core-node-fixture';
        node = new WebSocket(url);
        await new Promise((resolve, reject) => { node.once('open', resolve); node.once('error', reject); });
        node.send(JSON.stringify({ type: 'register_tools', data: { nativeSyncRouteId, tools: [{ name: 'internal_core_context' }] } }));
        node.on('message', async raw => {
            const frame = JSON.parse(raw);
            if (frame.type !== 'execute_tool') return;
            const { requestId, toolName, toolArgs } = frame.data;
            assert.equal(toolName, 'internal_core_context');
            try {
                const result = await readCoreContext(toolArgs, {
                    workspace: {
                        expandPlaceholders: async () => '[VCPChat 工作区: fixture]\nnotes.txt',
                        list: () => [{ id: 'fixture-workspace', enabled: true, path: resources }]
                    },
                    selection: async () => selected,
                    canvas: async () => ({ content: 'active CANVAS FIXTURE' })
                });
                node.send(JSON.stringify({ type: 'tool_result', data: { requestId, status: 'success', result } }));
            } catch (error) {
                t.diagnostic(error.code || error.name);
                node.send(JSON.stringify({ type: 'tool_result', data: { requestId, status: 'error', error: 'CORE_RESOURCE_UNAVAILABLE' } }));
            }
        });
        const routeHash = require('node:crypto').createHash('sha256').update(nativeSyncRouteId).digest('hex');
        await wait(() => webSockets.bindDistributedTool('internal_core_context', routeHash), 'native resource node registered');
        assert.equal(pluginManager.getPlugin('internal_core_context'), undefined);
        await phone.call('/core/personal/resource-node', { routeHash }, 403);
        const accepted = await desktop.runtime.prepareSharedSend({
            descriptor, serverSession: true,
            message: { id: 'node-resources', role: 'user', content: 'Read the live context.', attachments: [{
                id: 'node-file', name: 'notes.txt', type: 'text/plain',
                _fileManagerData: { isLiveReference: true, workspaceRef: { workspaceId: 'fixture-workspace', alias: 'fixture', relPath: 'notes.txt' } }
            }] }
        });
        await wait(() => {
            const work = core.store.work(accepted.serverSession.executionId);
            if (work?.error_code) throw Error('Core resource turn failed: ' + work.error_code);
            return work?.status === 'completed';
        }, 'desktop resource turn');
        assert.match(JSON.stringify(provider.calls[0].messages), /active CANVAS FIXTURE/);
        assert.match(JSON.stringify(provider.calls[0].messages), /VCPChat 工作区: fixture/);
        assert.match(JSON.stringify(provider.calls[0].messages), /actual workspace revision one/);
        await fs.writeFile(file, 'actual workspace revision two');
        const next = await phone.call(route + '/send', { requestId: 'resource-phone', text: 'Read the new version.' }, 202);
        await wait(() => core.store.work(next.id)?.status === 'completed', 'shared resource turn');
        assert.match(JSON.stringify(provider.calls[1].messages), /actual workspace revision two/);
        assert.doesNotMatch(JSON.stringify(provider.calls[1].messages), /revision one/);
        const { messages } = await phone.call(route + '/messages');
        assert.equal(messages[0].desktopReferences[0].name, 'notes.txt');
        assert.equal(messages[0].desktopReferences[0].sourceId, undefined);
        assert.doesNotMatch(JSON.stringify(messages), /actual workspace revision/);

        selected = group.descriptor;
        const groupWork = await desktop.runtime.coreSingle.send(selected, { id: 'group-node-resources', role: 'user',
            content: 'Use the group room resources.', attachments: [{
                id: 'group-node-file', name: 'notes.txt', type: 'text/plain',
                _fileManagerData: { isLiveReference: true, workspaceRef: { workspaceId: 'fixture-workspace', alias: 'fixture', relPath: 'notes.txt' } }
            }] });
        await wait(() => {
            const work = core.store.work(groupWork.serverSession.executionId);
            if (work?.error_code) throw Error('Core group resources: ' + work.error_code);
            return work?.status === 'completed';
        }, 'group resource turn');
        assert.match(JSON.stringify(provider.calls[2].messages), /active CANVAS FIXTURE/);
        assert.match(JSON.stringify(provider.calls[2].messages), /VCPChat 工作区: fixture/);
        assert.match(JSON.stringify(provider.calls[2].messages), /actual workspace revision two/);

        node.terminate();
        await wait(() => !webSockets.bindDistributedTool('internal_core_context', routeHash), 'node offline');
        const offline = await phone.call(route + '/send', { requestId: 'resource-offline', text: 'Read after disconnect.' }, 202);
        await wait(() => core.store.work(offline.id)?.status === 'failed', 'resource offline result');
        assert.equal(core.store.work(offline.id).error_code, 'CORE_RESOURCE_NODE_OFFLINE');
        assert.equal(provider.calls.length, 3);
    } finally {
        node?.terminate();
        await webSockets.shutdown();
        await new Promise(resolve => wsServer.close(resolve));
    }
});

test('Core associates the actual AgentAssistant child and reads its verified native archive', async t => {
    assert.ok(process.env.VCP_TEST_SERVER, 'Run through the isolated native suite');
    const provider = await localProvider(t);
    const { chat, pluginManager } = host(provider);
    const name = 'CoreFixtureDelegate', childModel = 'core-fixture-child';
    const aaDir = path.join(BOX, 'Plugin', 'AgentAssistant');
    await fs.writeFile(path.join(aaDir, 'config.json'), JSON.stringify({
        delegationMaxRounds: 2, delegationTimeout: 60000,
        agents: [{ baseName: 'COREFIXTURE', modelId: childModel, chineseName: name, systemPrompt: 'Isolated AA fixture.' }]
    }));
    const assistant = require(aaDir + '/AgentAssistant');

    pluginManager.plugins.set('AgentAssistant', { name: 'AgentAssistant', pluginType: 'hybridservice', communication: { protocol: 'direct' } });
    pluginManager.serviceModules.set('AgentAssistant', { module: assistant });
    const childTool = 'CoreFixtureChildTool';
    pluginManager.plugins.set(childTool, { name: childTool, pluginType: 'hybridservice', communication: { protocol: 'direct' } });
    pluginManager.serviceModules.set(childTool, { module: { processToolCall: async () => 'callback from child tool' } });
    const f = await coreFixture(t, chat);
    const { core } = f;
    const { route, descriptor } = await f.define({ config: fixtureConfig });
    assistant.initialize({ PORT: new URL(f.endpoint).port, Key: 'fixture-only' }, {});
    core.local.delegationAgents.add(name);
    t.after(() => fs.rm(path.join(aaDir, 'config.json'), { force: true }));
    const block = ['<<<[TOOL_REQUEST]>>>', 'tool_name:「始」AgentAssistant「末」,',
        'agent_name:「始」' + name + '「末」,', 'task_delegation:「始」true「末」,',
        'prompt:「始」Prepare the bounded report.「末」', '<<<[END_TOOL_REQUEST]>>>'].join('\n');
    const pattern = /\{\{VCP_ASYNC_RESULT::AgentAssistant::(aa-delegation-[a-zA-Z0-9-]+)\}\}/;
    provider.setReply((body, res) => {
        const content = JSON.stringify(body.messages);
        const result = body.model === childModel
            ? (content.includes('callback from child tool') ? '[[Flowlock::Complete]]\nVerified child report.' :
                ['<<<[TOOL_REQUEST]>>>', 'tool_name:「始」' + childTool + '「末」', '<<<[END_TOOL_REQUEST]>>>'].join('\n')) :
            content.includes('Use the report') ? 'Report received.' : content.match(pattern)?.[0] || block;
        res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: result }, finish_reason: 'stop' }] }));
    });
    try {
        const phone = await f.mobile();
        const accepted = await phone.call(route + '/send', { requestId: 'core-native-aa-parent', text: 'Ask the delegate.' }, 202);
        await wait(() => core.store.work(accepted.id)?.status === 'completed', 'parent Core Work completed');
        let task;
        await wait(async () => {
            const { tasks } = await phone.call(route + '/works/' + accepted.id + '/tasks');
            task = tasks[0];
            return task?.state === 'completed';
        }, 'native archive proved');
        const archive = await phone.call(route + '/works/' + accepted.id + '/tasks/' + task.id);
        assert.equal(archive.content, 'Verified child report.');
        assert.equal(provider.calls.filter(call => call.model === childModel).length, 2);
        assert.equal(core.store.db.prepare("SELECT count(*) AS n FROM work_invocations WHERE plugin_name=?").get(childTool).n, 0);
        assert.equal(core.store.db.prepare("SELECT count(*) AS n FROM core_aa_attempts WHERE task_id=? AND state='settled'").get(task.id).n, 2);
        const next = await phone.call(route + '/send', { requestId: 'core-native-aa-follow-up', text: 'Use the report.' }, 202);
        await wait(() => core.store.work(next.id)?.status === 'completed', 'report in subsequent Core context');
        assert.match(JSON.stringify(provider.calls.at(-1).messages), /Verified child report/);
        await phone.call(route + '/works/' + next.id + '/tasks/' + task.id, undefined, 404);

        let parentResponse;
        let childResponse;
        let childRounds = 0;
        const complete = (body, res, content) => res.end(JSON.stringify({
            model: body.model, choices: [{ message: { content }, finish_reason: 'stop' }]
        }));
        provider.setReply((body, res) => {
            if (body.model === childModel) {
                if (++childRounds === 1) childResponse = { body, res };
                else complete(body, res, '[[Flowlock::Complete]]\nChild finished after parent cancellation.');
            } else if (pattern.test(JSON.stringify(body.messages))) parentResponse = res;
            else complete(body, res, block);
        });
        const interrupted = await phone.call(route + '/send', {
            requestId: 'core-native-aa-interrupted', text: 'Delegate, then cancel the parent reply.'
        }, 202);
        await wait(() => parentResponse && childResponse, 'parent and AA child both dispatched');
        const interruptedTasks = route + '/works/' + interrupted.id + '/tasks';
        const { tasks: running } = await phone.call(interruptedTasks);
        assert.equal(running[0].state, 'running');
        await phone.call(route + '/works/' + interrupted.id + '/cancel', { requestId: 'cancel-aa-parent-only' });
        await wait(() => core.store.work(interrupted.id)?.status === 'cancelled', 'only the parent was cancelled');
        assert.equal(childResponse.res.destroyed, false);
        complete(childResponse.body, childResponse.res, '[[Flowlock::Start]]\n[[Flowlock::NextHeartbeat::1]]');
        await wait(async () => (await phone.call(interruptedTasks)).tasks[0]?.state === 'completed',
            'child continues into another round and archives after parent cancellation');
        const finishedChild = await phone.call(interruptedTasks + '/' + running[0].id);
        assert.equal(finishedChild.content, 'Child finished after parent cancellation.');
        assert.equal(childRounds, 2);
        assert.equal(core.store.work(interrupted.id).reply_message_id, null);

        let activeChild;
        const beforeRevoke = provider.calls.filter(call => call.model === childModel).length;
        provider.setReply((body, res) => {
            if (body.model === childModel) activeChild = { body, res };
            else complete(body, res, body.messages.some(message => String(message.content).includes('VCP_TOOL_PAYLOAD'))
                ? 'Parent reply settled.' : block);
        });
        const revoking = await phone.call(route + '/send', {
            requestId: 'core-native-aa-revoked', text: 'Start a revocable delegation.'
        }, 202);
        await wait(() => activeChild, 'authorized child round reached the provider');
        core.local.delegationAgents.delete(name);
        complete(activeChild.body, activeChild.res, '[[Flowlock::Start]]\n[[Flowlock::NextHeartbeat::1]]');
        await wait(async () => {
            const { tasks } = await phone.call(route + '/works/' + revoking.id + '/tasks');
            return tasks[0] && ['failed','unknown','stopped'].includes(tasks[0].state);
        }, 'revocation fences the accepted child before another model round');
        assert.equal(provider.calls.filter(call => call.model === childModel).length, beforeRevoke + 1);
    } finally {
        assistant.shutdown();
        pluginManager.plugins.delete('AgentAssistant');
        pluginManager.serviceModules.delete('AgentAssistant');
        pluginManager.plugins.delete(childTool);
        pluginManager.serviceModules.delete(childTool);
    }
});

test('Core TopicSponsor delivers a canonical peer message without a desktop recipient', async t => {
    const provider = await localProvider(t);
    const { chat, pluginManager } = host(provider);
    const f = await coreFixture(t, chat);
    const { core } = f;
    const { descriptor } = await f.define({ config: fixtureConfig });
    const peer = await f.define({ ownerId: 'peer-agent', topicId: 'peer-topic', name: 'Peer destination',
        config: { name: 'Peer Agent', model: 'peer-model', systemPrompt: 'Peer context' } });
    pluginManager.plugins.set('TopicSponsor', { name: 'TopicSponsor', pluginType: 'distributed' });
    t.after(() => pluginManager.plugins.delete('TopicSponsor'));
    const desktop = await f.desktop('A');
    const phone = await f.mobile();
    const block = ['<<<[TOOL_REQUEST]>>>', 'tool_name:「始」TopicSponsor「末」,',
        'command:「始」ReplyToTopic「末」,', 'topic_id:「始」' + peer.descriptor.topicId + '「末」,',
        'source_topic_id:「始」' + descriptor.topicId + '「末」,',
        'message:「始」Peer delivery fixture.「末」', '<<<[END_TOOL_REQUEST]>>>'].join('\n');
    provider.setReply((body, response) => {
        const text = body.model === 'peer-model' ? 'Peer reply.' : body.messages.some(row => JSON.stringify(row.content).includes('targetSharedId'))
            ? 'Sent to peer.' : block;
        response.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }));
    });
    const accepted = await desktop.runtime.prepareSharedSend({ descriptor, serverSession: true,
        message: { id: 'core-sponsor-user', role: 'user', content: 'Send the peer message.', attachments: [] } });
    await desktop.close();
    await wait(() => {
        const work = core.store.work(accepted.serverSession.executionId);
        if (work.error_code) throw Error(work.error_code);
        return work.status === 'completed';
    }, 'Sponsor source completed');
    await wait(() => core.store.db.prepare("SELECT 1 FROM works WHERE conversation_id=? AND status='completed'").get(peer.key), 'Sponsor destination completed');
    const { messages } = await phone.call(peer.route + '/messages');
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'assistant');
    assert.equal(messages[0].name, 'Fixture Agent');
    assert.match(messages[0].content, /Peer delivery fixture/);
    assert.equal(messages[1].content, 'Peer reply.');
    assert.equal(provider.calls.length, 3);

    provider.setReply((_body, response) => response.end(JSON.stringify({
        choices: [{ message: { role: 'assistant',
            content: block.replace(descriptor.topicId, 'other-source-topic') }, finish_reason: 'stop' }]
    })));
    const reopened = await f.desktop('A');
    const rejected = await reopened.runtime.prepareSharedSend({ descriptor, serverSession: true,
        message: { id: 'core-sponsor-spoof', role: 'user', content: 'Attempt delivery with an unrelated source.', attachments: [] } });
    await wait(() => ['failed', 'review_required'].includes(core.store.work(rejected.serverSession.executionId)?.status),
        'mismatched source cannot deliver');
    assert.equal(core.store.db.prepare('SELECT count(*) AS n FROM works WHERE conversation_id=?').get(peer.key).n, 1);
    await reopened.close();
});

test('Core Flowlock schedules one native continuation after the initiating desktop closes', async t => {
    const provider = await localProvider(t);
    const f = await coreFixture(t, host(provider).chat);
    const { core } = f;
    const { route, descriptor } = await f.define({ config: fixtureConfig });
    let inputCount = 0;
    provider.setReply((body, response) => {
        inputCount++;
        const output = inputCount === 1
            ? 'Initial reply.\n[[Flowlock::Start]]\n[[Flowlock::NextHeartbeat::1]]\n[[Flowlock::NextPrompt]]CORE_HEARTBEAT[[/Flowlock::NextPrompt]]'
            : 'Final reply.\n[[Flowlock::Stop]]';
        response.end(JSON.stringify({ choices: [{ message: { content: output }, finish_reason: 'stop' }] }));
    });
    const desktop = await f.desktop('A');
    const phone = await f.mobile();
    const first = await desktop.runtime.prepareSharedSend({ descriptor, serverSession: true,
        message: { id: 'core-flowlock-parent', role: 'user', content: 'Start the bounded fixture.', attachments: [] } });
    await desktop.close();
    await wait(() => core.store.work(first.serverSession.executionId)?.status === 'completed', 'initial Flowlock turn');
    const state = await phone.call(route + '/works');
    assert.equal(state.flowlock.active, true);
    await phone.call(route + '/flowlock', { action: 'stop', requestId: 'unowned-flowlock-stop' }, 403);
    await wait(() => core.store.db.prepare("SELECT count(*) AS n FROM works WHERE status='completed'").get().n === 2, 'headless Flowlock continuation');
    assert.equal((await phone.call(route + '/works')).flowlock.active, false);
    assert.equal(provider.calls.length, 2);
    assert.match(JSON.stringify(provider.calls[1].messages.at(-1)), /CORE_HEARTBEAT/);
    assert.equal((await phone.call(route + '/messages')).messages.length, 4);
});

test('Core never commits a client-owned FC response as its Work final', async t => {
    const provider = await localProvider(t);
    const { chat } = host(provider);
    const f = await coreFixture(t, chat);
    const phone = await f.mobile();
    const call = { id: 'fixture_client_call', type: 'function',
        function: { name: 'fixture_client_only', arguments: '{}' } };
    provider.setReply((body, res) => {
        const content = 'unfinished assistant prefix';
        if (body.stream) {
            const delta = { content, tool_calls: [{ index: 0, ...call }] };
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n');
        } else {
            res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content, tool_calls: [call] }, finish_reason: 'tool_calls' }] }));
        }
    });
    for (const streamOutput of [true, false]) {
        const { key, route } = await f.define({ topicId: 'fc-' + streamOutput, config: { ...fixtureConfig, streamOutput } });
        const { workId } = await phone.call(route + '/send', { requestId: 'client-fc-' + streamOutput, text: 'fixture input' }, 202);
        await wait(() => f.core.store.work(workId).status === 'review_required', 'unsettled client FC');
        assert.equal(f.core.store.work(workId).reply_message_id, null);
        assert.equal(f.core.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id=? AND role='assistant'").get(key).n, 0);
        assert.equal(f.core.store.db.prepare('SELECT COUNT(*) AS n FROM work_invocations WHERE work_id=?').get(workId).n, 0);
    }
    assert.equal(provider.calls.length, 2);
});

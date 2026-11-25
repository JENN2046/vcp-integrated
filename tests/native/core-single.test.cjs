'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { fixture, wait, BOX, CHAT, ctx } = require('./fixtures/sharedSingleHarness.cjs');

const { localProvider, host, mountCore, setStream } = require('./fixtures/coreSingleHarness.cjs');

test('Core single chat uses native execution without Resident and separates observation from Work', async t => {
    const f = await fixture(t, { attachments: true });
    const provider = await localProvider(t);
    const { chat, events } = host(provider);
    setStream(f, true);
    const { core, route } = await mountCore(f, chat);
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
        const phone = await f.phone();
        const readOnly = await f.phone({ permissions: ['read'] });
        const foreign = await f.phone({ space: 'foreignSpace' });
        const png = await require(BOX + '/node_modules/sharp')({
            create: { width: 16, height: 16, channels: 3, background: '#00aa44' }
        }).png().toBuffer();
        const file = path.join(desktop.data, 'UserData', 'attachments', 'image.png');
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, png);
        const accepted = await desktop.runtime.prepareSharedSend({
            descriptor: desktop.descriptor, serverSession: true,
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
        await foreign.call(route + '/messages', undefined, 403);
        const steering = { requestId: 'steering-from-mobile', text: 'Please be concise' };
        const steered = await phone.call(route + '/works/' + workId + '/steer', steering, 202);
        assert.deepEqual(await phone.call(route + '/works/' + workId + '/steer', steering, 202), steered);
        release('intermediate');
        await wait(() => provider.calls.length === 2, 'next native turn includes steering');
        assert.match(JSON.stringify(provider.calls[1].messages), /Please be concise/);
        release('final');
        await wait(() => core.store.work(workId).status === 'completed', 'formal Core completion');
        await wait(() => observed.some(event => event.type === 'work_state' && event.status === 'completed'), 'remote terminal event');
        observer.abort();
        const snapshot = await phone.call(route + '/messages');
        assert.deepEqual(snapshot.messages.map(m => m.content), ['What is in the image?', 'Please be concise', 'prefix final']);
        const image = snapshot.messages[0].attachments[0];
        assert.deepEqual(await phone.download(route + '/blob/' + image.hash), png);
        assert.equal(f.store.db.prepare('SELECT count(*) n FROM journal').get().n, 0);
        assert.equal(f.store.db.prepare('SELECT count(*) n FROM shared_admissions').get().n, 0);
        assert.equal(f.store.db.prepare('SELECT count(*) n FROM mobile_executions').get().n, 0);
        await phone.call('/conversations/' + f.topic.id + '/messages', { requestId: 'legacy-request', text: 'do not dispatch' }, 409);
        assert.equal(f.calls(), 0);
        const reopen = await f.desktop('B');
        const readback = await reopen.runtime.coreSingle.history(reopen.descriptor);
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
        await core.close();
        await fs.rm(f.root + '-core', { recursive: true, force: true });
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
        db.close();
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('Core uses the native approval queue and cancels before tool dispatch', async t => {
    const f = await fixture(t);
    const provider = await localProvider(t);
    const { chat, pluginManager } = host(provider);
    const name = 'CoreFixtureTool';
    let toolRuns = 0;
    const plugin = { name, pluginType: 'hybridservice', communication: { protocol: 'direct' } };
    pluginManager.plugins.set(name, plugin);
    pluginManager.serviceModules.set(name, { module: {
        processToolCall: async () => { toolRuns++; return Object.freeze({ status: 'success', result: 'fixture tool returned' }); }
    } });
    const previousApprovalConfig = pluginManager.toolApprovalManager.config;
    pluginManager.toolApprovalManager.config = { ...previousApprovalConfig, enabled: true, approveAll: true };
    t.after(() => { pluginManager.toolApprovalManager.config = previousApprovalConfig; });
    pluginManager.webSocketServer = { broadcast() {}, cancelVcpLogApprovalCache() {} };
    const { core, route } = await mountCore(f, chat);
    const completion = content => JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
    provider.setReply((body, res) => {
        const hasResult = JSON.stringify(body.messages).includes('fixture tool returned');
        res.end(completion(hasResult ? 'tool completed' :
            `<<<[TOOL_REQUEST]>>>\ntool_name:「始」${name}「末」,\ncommand:「始」Fixture「末」\n<<<[END_TOOL_REQUEST]>>>`));
    });
    const observed = [];
    const stop = core.runner.observe(f.topic.id, (type, event) => observed.push({ type, ...event }));
    try {
        const phone = await f.phone();
        const getApproval = id => observed.find(event => event.type === 'approval_requested' && event.workId === id);
        const first = await phone.call(route + '/send', { requestId: 'tool-cancel-core', text: 'cancel the pending tool' }, 202);
        await wait(() => getApproval(first.id), 'native approval');
        const request = getApproval(first.id);
        assert.equal(core.store.work(first.id).status, 'waiting_approval');
        assert.equal(pluginManager.pendingApprovals.has(request.hostApprovalRequestId), true);
        await phone.call(route + '/works/' + first.id + '/cancel', { requestId: 'cancel-native-approval' });
        await wait(() => core.store.work(first.id).status === 'cancelled', 'Core cancellation');
        assert.equal(pluginManager.pendingApprovals.has(request.hostApprovalRequestId), false);
        assert.equal(await pluginManager.handleApprovalResponse(request.hostApprovalRequestId, true, ''), false);
        assert.equal(toolRuns, 0);
        assert.equal(provider.calls.length, 1);
        assert.equal(core.store.db.prepare('SELECT count(*) n FROM work_invocations').get().n, 0);

        const second = await phone.call(route + '/send', { requestId: 'tool-approve-core', text: 'run the ordinary tool' }, 202);
        await wait(() => getApproval(second.id), 'second native approval');
        const ordinary = getApproval(second.id);
        await phone.call(route + '/works/' + second.id + '/approve', { requestId: 'mobile-approval-rejected' }, 409);
        assert.equal(await pluginManager.handleApprovalResponse(ordinary.hostApprovalRequestId, true, ''), true);
        await wait(() => core.store.work(second.id).status === 'completed', 'Core tool settlement');
        assert.equal(toolRuns, 1);
        const saved = core.store.db.prepare('SELECT * FROM work_invocations WHERE work_id=?').get(second.id);
        assert.equal(saved.status, 'returned');
        assert.match(saved.result_json, /fixture tool returned/);
    } finally {
        stop();
        await core.close();
        await fs.rm(f.root + '-core', { recursive: true, force: true });
    }
});

test('Core retains external HTTP chat compatibility for JSON and SSE', async t => {
    const f = await fixture(t);
    const provider = await localProvider(t);
    const { chat } = host(provider);
    f.control.nativeResponder = (req, res) => ctx.runNativeHandler(() => chat.handle(req, res));
    provider.setReply((body, res) => {
        if (!body.stream) return res.end(JSON.stringify({
            choices: [{ message: { content: 'legacy JSON' }, finish_reason: 'stop' }]
        }));
        res.setHeader('Content-Type', 'text/event-stream');
        res.end('data: {"choices":[{"delta":{"content":"legacy SSE"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    const run = stream => fetch(f.url + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'synthetic', stream, messages: [{ role: 'user', content: 'hi' }] }) });
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
    const f = await fixture(t);
    const provider = await localProvider(t);
    const { chat } = host(provider);
    chat.config.apiRetries = 3;
    provider.setReply((_body, res) => res.destroy());
    const { core, route } = await mountCore(f, chat);
    try {
        const phone = await f.phone();
        const accepted = await phone.call(route + '/send', { requestId: 'lost-provider-core', text: 'Only one provider attempt' }, 202);
        await wait(() => core.store.work(accepted.id).status === 'review_required', 'unknown network outcome');
        assert.equal(provider.calls.length, 1);
        assert.equal(core.store.work(accepted.id).error_code, 'CORE_PROVIDER_OUTCOME_UNKNOWN');
        assert.equal((await phone.call(route + '/messages')).messages.length, 1);
    } finally {
        await core.close();
        await fs.rm(f.root + '-core', { recursive: true, force: true });
    }
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
    const f = await fixture(t, { attachments: true, imageModels: [] });
    const provider = await localProvider(t);
    const { core, route } = await mountCore(f, host(provider).chat);
    const text = Buffer.from('CORE_TEXT_FIXTURE');
    const pdf = textPdf('CORE_PDF_FIXTURE');
    try {
        const desktop = await f.desktop('A');
        const phone = await f.phone();
        const foreign = await f.phone({ space: 'foreignSpace' });
        const directory = path.join(desktop.data, 'UserData', 'attachments');
        await fs.mkdir(directory, { recursive: true });
        const attachments = await Promise.all([['notes.txt', text, 'text/plain'], ['source.pdf', pdf, 'application/pdf']]
            .map(async ([name, data, type]) => {
                const internalPath = path.join(directory, name);
                await fs.writeFile(internalPath, data);
                return { name, type, internalPath, size: data.length };
            }));
        const accepted = await desktop.runtime.prepareSharedSend({
            descriptor: desktop.descriptor, serverSession: true,
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
        await foreign.call(route + '/blob/' + attachedPdf.hash, undefined, 403);

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
        assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM journal').get().count, 0);
        assert.equal(f.calls(), 0);

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
    } finally {
        await core.close();
        await fs.rm(f.root + '-core', { recursive: true, force: true });
    }
});

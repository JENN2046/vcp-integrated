'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID, createHash } = require('node:crypto');
const { administer } = require('../../apps/server/core/pairDevice');
const coreInput = 'What color is the attached image? Answer in one short sentence.';

exports.create = async (out, cert) => {
    const provider = process.env.VCP_TEST_CORE_MODEL_URL;
    if (provider && !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(provider)) throw Error('Expected isolated local model origin');
    const model = process.env.VCP_TEST_CORE_MODEL || 'synthetic';
    const risk = process.env.VCP_TEST_CORE_RISK === '1';
    const physical = process.env.VCP_TEST_CORE_PHONE === '1';
    const browser = process.env.VCP_TEST_CORE_BROWSER === '1';
    const interactive = physical || browser;
    const expectedWorks = physical && browser ? 3 : 2;
    const image = path.join(out, 'red.png');
    await require('../../apps/server/node_modules/sharp')({ create: { width: 224, height: 224, channels: 3, background: '#ff0000' } }).png().toFile(image);
    const tokens = {};
    let armed;
    const context = {
        image, model, tokens,
        serviceOptions: {
            coreRemote: { model, provider, input: coreInput, risk },
            httpsPort: Number(process.env.VCP_TEST_CORE_PORT || 0),
            handleFixtureRequest(req, res, route) {
                if (route !== '/__hardware/pair') return false;
                if (!armed || req.method !== 'GET') res.writeHead(404).end();
                else {
                    const code = armed();
                    armed = null;
                    res.writeHead(302, { Location: '/mobile/#pair=' + code, 'Cache-Control': 'no-store' }).end();
                }
                return true;
            }
        }
    };
    const call = (target, options = {}) => new Promise((resolve, reject) => {
        const { token, cookie, origin, body, headers = {}, method = body ? 'POST' : 'GET', binary } = options;
        const wire = body ? JSON.stringify(body) : undefined;
        const req = https.request(context.origin + target, { method, ca: fs.readFileSync(cert), timeout: 15000, headers: {
            ...(token && { Authorization: 'Bearer ' + token }), ...(cookie && { Cookie: cookie }),
            ...(origin && { Origin: origin }), ...(wire && { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(wire) }),
            ...headers
        } }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                try {
                    const bytes = Buffer.concat(chunks);
                    resolve({ status: res.statusCode, cookie: res.headers['set-cookie']?.[0]?.split(';')[0],
                        data: binary ? bytes : JSON.parse(bytes) });
                } catch (error) { reject(error); }
            });
            res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(Error('Core request timed out')));
        req.end(wire);
    });
    const observe = (target, cookie, match) => {
        const ready = Promise.withResolvers();
        const completed = Promise.withResolvers();
        const reject = error => { ready.reject(error); completed.reject(error); };
        const req = https.get(context.origin + target, {
            ca: fs.readFileSync(cert), headers: { Cookie: cookie }, timeout: 90000
        }, res => {
            if (res.statusCode !== 200) { res.resume(); reject(Error('Core SSE failed with ' + res.statusCode)); return; }
            ready.resolve();
            res.setEncoding('utf8');
            let buffer = '';
            res.on('data', chunk => {
                buffer += chunk;
                if (match(buffer)) { completed.resolve(true); req.destroy(); }
            });
            res.on('end', () => reject(Error('Core SSE closed before the expected event')));
        });
        req.on('timeout', () => req.destroy(Error('Core SSE timed out')));
        req.on('error', reject);
        completed.promise.catch(() => {});
        return { ready: ready.promise, completed: completed.promise };
    };
    const pair = async (role, mode) => {
        const { pairingCode } = administer(context.env, ['pair', mode]);
        const mobile = mode.startsWith('mobile');
        const target = mobile ? '/mobile/api/pair' : '/core/api/pair';
        const result = await call(target, { body: { code: pairingCode }, ...(mobile && { origin: context.origin }) });
        assert.equal(result.status, 200);
        assert.equal((await call(target, { body: { code: pairingCode }, ...(mobile && { origin: context.origin }) })).status, 401);
        if (!mobile) tokens[role] = result.data.token;
        return result;
    };
    context.pairDesktops = async service => {
        context.origin = service.origin;
        context.env = { VCP_CORE_DATA_DIR: path.join(out, 'core'), VCP_CORE_REMOTE_ORIGIN: service.origin };
        await pair('A', 'desktop');
        await pair('B', 'desktop-reader');
    };
    context.run = async ({ clients: { A }, service, result, click, evalJs, waitUntil, start, stop, picture }) => {
        const descriptor = service.descriptors.A.preSubmit;
        const key = service.topics.preSubmit.id;
        const desktop = '/core/api/personal/' + key;
        const mobile = '/mobile/api/core/personal/' + key;
        await click(A, '#agentList > li .agent-name', 'Synthetic local');
        await waitUntil(() => evalJs(A, "window.VCPStateChannels.get('conversation.current').get()?.topicId === 'local-topic'"), 'desktop configured native topic');
        await waitUntil(async () => (await call(desktop + '/works', { token: tokens.A })).status === 200, 'official Core topic');
        const checkPage = await service.checkMobile();
        const missing = [await call(desktop + '/messages'), await call(mobile + '/messages'),
            await call(desktop + '/messages', { token: 'synthetic-only' })];
        assert.deepEqual(missing.map(value => value.status), [401, 401, 401]);
        const reader = await pair(null, 'mobile-reader');
        assert.equal((await call(mobile + '/send', { cookie: reader.cookie, origin: context.origin, body: { requestId: randomUUID(), text: 'must fail' } })).status, 403);
        assert.equal((await call(mobile + '/send', { cookie: reader.cookie, origin: 'https://other.invalid', body: { requestId: randomUUID(), text: 'must fail' } })).status, 403);
        assert.equal((await call('/core/api/other/' + key + '/messages', { token: tokens.B })).status, 403);
        assert.equal((await call(desktop + '/definition', { token: tokens.B, method: 'PUT', body: {} })).status, 403);
        let phone;
        if (interactive) {
            armed = () => administer(context.env, ['pair', 'mobile']).pairingCode;
            fs.writeFileSync(path.join(out, 'phone-prepare.json'), JSON.stringify({ origin: context.origin, cert, topic: key }));
            await waitUntil(() => fs.existsSync(path.join(out, 'phone-ready')), 'interactive PWA paired', 600000);
        } else phone = await pair(null, 'mobile');

        await click(A, '#attachFileBtn');
        await waitUntil(() => evalJs(A, "document.body.innerText.includes('red.png')"), 'desktop image selected');
        await evalJs(A, `(() => {
            const input = document.querySelector('#messageInput');
            input.value = ${JSON.stringify(coreInput)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await click(A, '#sendMessageBtn');
        await waitUntil(() => service.calls.length === 1, 'ToolBox dispatched remote Core Work');
        const work = (await call(desktop + '/works', { token: tokens.A })).data.works[0];
        assert.equal(work.status, 'running');
        await waitUntil(() => A.events.some(({ event, data }) => event === 'ipc-result' &&
            data?.channel === 'native-sync:prepare-send' && data.success === true),
            'desktop admission receipt returned');
        await stop('A');
        await stop('B');
        const stream = observe(mobile + '/observe', reader.cookie, body =>
            body.includes('event: work_state') && body.includes(work.id) && body.includes('"completed"'));
        await stream.ready;
        if (interactive) {
            fs.writeFileSync(path.join(out, 'desktop-exited.json'), JSON.stringify({ workId: work.id }));
            await waitUntil(() => fs.existsSync(path.join(out, 'phone-observed')), 'interactive PWA observation of the accepted Work', 75000);
        } else {
            const observed = (await call(mobile + '/works', { cookie: phone.cookie })).data;
            assert.equal(observed.works[0].id, work.id);
            assert.equal(observed.works[0].status, 'running');
        }
        service.releaseLost();
        const read = () => call(desktop + '/messages', { token: tokens.B }).then(response => response.data.messages);
        const first = await waitUntil(async () => {
            const messages = await read();
            return messages.length === 2 && messages;
        }, 'Core settled after both desktop exits', 90000);
        assert.equal(await stream.completed, true);
        if (interactive) {
            fs.writeFileSync(path.join(out, 'first-completed'), '');
        } else {
            const scope = (await call('/mobile/api/session', { cookie: phone.cookie })).data.recovery;
            const response = await call(mobile + '/send', { cookie: phone.cookie, origin: context.origin,
                headers: { 'X-NativeSync-Entry-Id': scope.entryId, 'X-NativeSync-Session-Marker': scope.sessionMarker },
                body: { requestId: randomUUID(), text: 'What color was the image?' } });
            assert.equal(response.status, 202);
        }
        const before = await waitUntil(async () => {
            const messages = await read();
            return messages.length === expectedWorks * 2 && messages;
        }, 'mobile followup formally completed', 90000);
        if (browser) await waitUntil(() => fs.existsSync(path.join(out, 'pwa-proof.json')), 'PWA rendered the formal followup', 30000);
        assert.deepEqual(before.slice(0, 2), first);
        const imageHash = before[0].attachments[0].hash;
        const download = () => call(desktop + '/blob/' + imageHash, { token: tokens.B, binary: true });
        const attachment = await download();
        assert.equal(attachment.status, 200);
        assert.equal(createHash('sha256').update(attachment.data).digest('hex'), imageHash);
        assert.equal((await call(mobile + '/blob/' + imageHash, { binary: true })).status, 401);
        const restart = await service.restartWithUpgrade();
        assert.deepEqual(restart, { code: 0, signal: null });
        assert.deepEqual(await read(), before);
        assert.deepEqual((await download()).data, attachment.data);
        const B = await start('B');
        await click(B, '#agentList > li .agent-name', 'Synthetic local');
        await waitUntil(async () => (await evalJs(B, "document.querySelector('#chatMessages')?.innerText || ''")).includes(before[2].content),
            'new desktop loaded server directory and shared history');
        await picture(B, 'core-remote-cold');
        const readyEvents = () => B.events.filter(event => event.event === 'renderer-ready').length;
        const previousReady = readyEvents();
        await evalJs(B, 'setTimeout(() => location.reload(), 0); true');
        await waitUntil(() => readyEvents() > previousReady, 'same Electron window reloaded');
        await click(B, '#agentList > li .agent-name', 'Synthetic local');
        await waitUntil(async () => (await evalJs(B, "document.querySelector('#chatMessages')?.innerText || ''")).includes(before[2].content),
            'reloaded renderer reads the same Core conversation');
        assert.deepEqual(await read(), before);
        // A began with an empty native History; B began without a native topic.
        // Remote submission, restart and cold read must leave both local histories empty.
        const desktopNativeHistoryRows = {};
        for (const role of ['A', 'B']) {
            const history = path.join(out, 'profile-' + role, 'UserData', descriptor.itemId,
                'topics', descriptor.topicId, 'history.json');
            if (role === 'A') assert.ok(fs.existsSync(history), 'original native History must survive');
            const rows = fs.existsSync(history) ? JSON.parse(fs.readFileSync(history, 'utf8')) : [];
            assert.deepEqual(rows, [], 'unexpected local History in profile ' + role);
            desktopNativeHistoryRows[role] = rows.length;
        }
        const db = new DatabaseSync(path.join(out,'core/core.sqlite'), { readOnly: true });
        try {
            const works = db.prepare('SELECT principal,status FROM works ORDER BY rowid').all();
            assert.equal(works.length, expectedWorks);
            assert.ok(works[0].principal.startsWith('desktop:'));
            assert.ok(works.slice(1).every(work => work.principal.startsWith('mobile:')));
            assert.equal(new Set(works.map(work => work.principal)).size, expectedWorks);
            assert.ok(works.every(item => item.status === 'completed'));
        } finally { db.close(); }
        assert.equal(fs.existsSync(path.join(out, 'data/central.sqlite')), false);
        assert.equal(fs.existsSync(path.join(out, 'runtime-box/Plugin/NativeSync/plugin-manifest.json')), false);
        assert.equal(service.calls.length, expectedWorks);
        if (provider) {
            assert.ok(service.calls.every(row => row.imageParts === 1 && row.status === 200));
            assert.ok(before.filter(row => row.role === 'assistant').every(row => /red/i.test(row.content)));
        }
        if (risk) {
            result.risk = await require('./core-risk.cjs')({ out, service, call, tokens, evalJs, start, stop, picture, click, waitUntil,
                descriptor, key, before, priorAttachment: attachment.data, imageHash, model, mobileCookie: reader.cookie, browser });
        } else {
            const update = await call('/core/api/personal/agents/' + descriptor.itemId, { token: tokens.A, method: 'PUT',
                body: { version: 0, config: { name: 'Renamed synthetic agent', model, systemPrompt: 'Reply in one short sentence.' } } });
            assert.equal(update.status, 200);
            const directory = await call('/core/api/personal/desktop-directory', { token: tokens.B });
            assert.equal(directory.data.agents[0].config.name, 'Renamed synthetic agent');
            assert.equal(Object.hasOwn(directory.data.agents[0].config, 'systemPrompt'), false);
            const remove = { requestId: randomUUID(), kind: 'agent', id: descriptor.itemId, topicId: descriptor.topicId };
            assert.equal((await call('/core/api/personal/remove-definition', { token: tokens.A, body: remove })).status, 200);
            assert.equal((await call('/core/api/personal/remove-definition', { token: tokens.A, body: remove })).status, 200);
            assert.equal((await call(desktop + '/messages', { token: tokens.B })).status, 404);
            assert.equal((await call(desktop + '/blob/' + imageHash, { token: tokens.B, binary: true })).status, 404);
            assert.equal((await call(desktop + '/definition', { token: tokens.A, method: 'PUT',
                body: { ownerType: 'agent', ownerId: descriptor.itemId, topicId: descriptor.topicId, name: 'Old topic',
                    config: { name: 'Renamed synthetic agent', model, systemPrompt: '' } } })).status, 404);
            const removeOwner = { ...remove, requestId: randomUUID(), topicId: undefined };
            assert.equal((await call('/core/api/personal/remove-definition', { token: tokens.A, body: removeOwner })).status, 200);
            assert.equal((await call('/core/api/personal/agents/' + descriptor.itemId, { token: tokens.A, method: 'PUT',
                body: { version: update.data.version, config: { name: 'Cannot restore', model, systemPrompt: '' } } })).status, 404);
        }
        const sessionB = await call('/core/api/session', { token: tokens.B });
        assert.equal(administer(context.env, ['revoke', sessionB.data.deviceId]).revoked, true);
        assert.equal((await call('/core/api/session', { token: tokens.B })).status, 401);
        result.core = { provider: provider ? model : 'synthetic', physicalAndroid: physical, browserPwa: browser, desktopExitedDuringWork: true,
            mobileContinuation: true, mobileSseTerminal: true, deviceRevocation: true, attachmentHash: imageHash, formalMessages: before.length, authenticatedDesktopColdReadback: true, rendererReloadReadback: true, desktopNativeHistoryRows,
            historyAndAttachmentUnchangedAfterRestart: true, unauthenticatedRejected: true, readOnlyMutationRejected: true,
            definitionTombstoneAndReplay: true, restart, webBundle: checkPage };
    };
    return context;
};

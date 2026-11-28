import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pairedDevices from '../../apps/server/core/pairDevice.js';

const [mode, runDirectory] = process.argv.slice(2);
if (!['browser', 'browser-phone'].includes(mode) || !runDirectory || process.argv.length !== 4) {
    throw Error('Usage: node tests/hardware/core-pwa-clients.mjs browser|browser-phone /path/to/vcp-integration-RUN/core-remote');
}
const out = await fs.realpath(runDirectory);
assert.equal(path.basename(out), 'core-remote');
assert.match(path.basename(path.dirname(out)), /^vcp-integration-[\w-]+$/);
const withPhone = mode === 'browser-phone';
const apkBuilder = fileURLToPath(new URL('android-send/build-apk.sh', import.meta.url));
const packageName = 'dev.nativesync.qa.send';
const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8', timeout: 15000 }).trim();

async function poll(read, description, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = await read();
        if (value) return value;
        await delay(150);
    }
    throw Error('Timed out waiting for ' + description);
}

async function readWhenReady(filename) {
    try {
        return await fs.readFile(filename, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

async function marker(name, timeout) {
    return poll(async () => (await readWhenReady(path.join(out, name))) !== null, name, timeout);
}

async function connectPage(port, origin) {
    const target = await poll(async () => {
        try {
            const response = await fetch('http://127.0.0.1:' + port + '/json/list');
            const tabs = await response.json();
            return tabs.find(tab => tab.type === 'page' && tab.url.startsWith(origin + '/mobile/'));
        } catch {
            return null; // Android WebView can start before the DevTools endpoint.
        }
    }, 'fixture PWA');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await once(ws, 'open', { signal: AbortSignal.timeout(10000) });
    const pending = new Map();
    let sequence = 0;
    ws.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        pending.get(message.id)?.(message);
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(Error('Chromium request timed out: ' + method));
        }, 8000);
        pending.set(id, message => {
            clearTimeout(timer);
            pending.delete(id);
            if (message.error) reject(Error('Chromium request failed: ' + method));
            else resolve(message.result);
        });
        ws.send(JSON.stringify({ id, method, params }));
    });
    return {
        async run(fn, ...args) {
            const expression = 'location.origin === ' + JSON.stringify(origin) +
                ' && (' + fn + ')(' + args.map(arg => JSON.stringify(arg)).join(',') + ')';
            const evaluation = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
            if (evaluation.exceptionDetails) throw Error('Fixture page evaluation failed');
            return evaluation.result.value;
        },
        async loadedAssets() {
            await call('Page.enable');
            const { frameTree } = await call('Page.getResourceTree');
            assert.equal(new URL(frameTree.frame.url).origin, origin);
            const resources = frameTree.resources.filter(resource => {
                const url = new URL(resource.url);
                return url.origin === origin && /^\/mobile\/assets\/[\w.-]+\.(?:js|css)$/.test(url.pathname);
            });
            const assets = [];
            for (const { url } of resources) {
                const { content, base64Encoded } = await call('Page.getResourceContent', { frameId: frameTree.frame.id, url });
                const bytes = Buffer.from(content, base64Encoded ? 'base64' : 'utf8');
                const name = path.basename(new URL(url).pathname);
                const built = fileURLToPath(new URL('../../apps/server/Plugin/NativeSync/mobile-dist/assets/' + name, import.meta.url));
                const digest = createHash('sha256').update(bytes).digest('hex');
                assert.equal(digest, createHash('sha256').update(await fs.readFile(built)).digest('hex'), name);
                assets.push({ path: new URL(url).pathname, sha256: digest });
            }
            assert(assets.some(asset => asset.path.endsWith('.js')));
            assert(assets.some(asset => asset.path.endsWith('.css')));
            return assets.sort((a, b) => a.path.localeCompare(b.path));
        },
        close: () => ws.close()
    };
}

async function openConversation(client, fixture, issueCode) {
    await poll(() => client.run(() => document.readyState === 'complete' &&
        !!document.querySelector('#pair-code') && document.querySelector('#pair-submit')?.disabled === false), 'pair form');
    await client.run(code => {
        const field = document.querySelector('#pair-code');
        field.value = code;
        field.dispatchEvent(new Event('input', { bubbles: true }));
    }, issueCode());
    await poll(() => client.run(() => {
        const submit = document.querySelector('#pair-submit');
        if (!submit || submit.disabled || !document.querySelector('#pair-code')?.value) return false;
        submit.click();
        return true;
    }), 'pair submission');
    await poll(() => client.run(key => Array.from(document.querySelector('#topic-select')?.options || [])
        .some(option => option.value === key), fixture.topic), 'paired topic directory');
    await client.run(key => {
        const topic = document.querySelector('#topic-select');
        topic.value = key;
        topic.dispatchEvent(new Event('change', { bubbles: true }));
    }, fixture.topic);
    await poll(() => client.run(key => document.querySelector('#topic-select')?.value === key &&
        !!document.querySelector('#message-text') && !document.querySelector('.history-progress'), fixture.topic), 'topic history');
}

async function state(client, topic) {
    return client.run(async key => {
        const response = await fetch('/mobile/api/core/personal/' + key + '/works', { cache: 'no-store' });
        if (!response.ok) return null;
        const works = (await response.json()).works.map(({ id, status }) => ({ id, status }));
        const messages = Array.from(document.querySelectorAll('#history [data-message-id]'), node =>
            ({ id: node.dataset.messageId, text: node.textContent.trim() }));
        return { works, messages, topic: document.querySelector('#topic-select')?.value,
            secure: isSecureContext, origin: location.origin, agent: navigator.userAgent };
    }, topic);
}

async function send(client, text) {
    await client.run(text => {
        const input = document.querySelector('#message-text');
        if (!input || input.disabled || input.value) throw Error('Composer unavailable');
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    await poll(() => client.run(() => {
        const button = document.querySelector('#send');
        if (!button || button.disabled) return false;
        button.click();
        return true;
    }), 'PWA submit');
}

await marker('phone-prepare.json', 120000);
const fixture = JSON.parse(await fs.readFile(path.join(out, 'phone-prepare.json'), 'utf8'));
const origin = new URL(fixture.origin);
assert.equal(origin.protocol, 'https:');
assert.equal(origin.hostname, '127.0.0.1');
assert.match(origin.port, /^\d{4,5}$/);
assert.equal(fixture.cert, path.join(out, 'loopback-cert.pem'));
const certificate = new X509Certificate(await fs.readFile(fixture.cert));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pwa-clients-'));
const cleanup = [];
const clients = [];
try {
    const profile = path.join(temporary, 'chrome');
    await fs.mkdir(profile);
    const keyHash = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    const chrome = spawn(process.env.CHROME_BIN || '/opt/google/chrome/chrome', [
        '--headless=new', '--no-first-run', '--disable-sync', '--disable-background-networking', '--disable-gpu',
        '--disable-dev-shm-usage', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--ignore-certificate-errors-spki-list=' + keyHash,
        '--user-data-dir=' + profile, origin.origin + '/mobile/'
    ], { env: { ...process.env, HOME: temporary, TMPDIR: '/tmp' }, stdio: 'ignore' });
    const chromeExit = once(chrome, 'exit');
    chromeExit.catch(() => {});
    cleanup.push(async () => {
        if (chrome.exitCode === null && chrome.signalCode === null) {
            chrome.kill();
            await Promise.race([chromeExit, delay(3000)]);
        }
    });
    const port = await poll(async () => (await readWhenReady(path.join(profile, 'DevToolsActivePort')))?.split('\n')[0], 'Chrome DevTools');
    clients.push(await connectPage(port, origin.origin));
    if (withPhone) {
        assert.equal(adb('shell', 'pm', 'list', 'packages', packageName), '', 'Test APK already installed');
        const endpoint = 'tcp:' + origin.port;
        assert(!adb('reverse', '--list').split('\n').some(line => line.split(/\s+/).includes(endpoint)), 'ADB reverse port already in use');
        const ca = path.join(temporary, 'public.der');
        const apk = path.join(temporary, 'apk');
        await fs.writeFile(ca, certificate.raw);
        execFileSync(apkBuilder, [ca, origin.port, apk], { stdio: 'ignore', timeout: 60000 });
        execFileSync('adb', ['install', '--no-incremental', path.join(apk, 'android-send.apk')], { timeout: 90000 });
        cleanup.push(() => adb('uninstall', packageName));
        adb('reverse', '--no-rebind', endpoint, endpoint);
        cleanup.push(() => adb('reverse', '--remove', endpoint));
        adb('shell', 'am', 'start', '-n', packageName + '/.TestWindow');
        const pid = await poll(() => adb('shell', 'pidof', packageName), 'test WebView process');
        assert.match(pid, /^\d+$/);
        const forward = adb('forward', 'tcp:0', 'localabstract:webview_devtools_remote_' + pid);
        cleanup.push(() => adb('forward', '--remove', 'tcp:' + forward));
        clients.push(await connectPage(forward, origin.origin));
    }
    const env = { VCP_CORE_DATA_DIR: path.join(out, 'core'), VCP_CORE_REMOTE_ORIGIN: origin.origin };
    for (const client of clients) {
        await openConversation(client, fixture, () => pairedDevices.administer(env, ['pair', 'mobile']).pairingCode);
    }
    await fs.writeFile(path.join(out, 'phone-ready'), '');
    await marker('desktop-exited.json', 100000);
    const { workId } = JSON.parse(await fs.readFile(path.join(out, 'desktop-exited.json')));
    const ongoing = await Promise.all(clients.map(client => poll(async () => {
        const value = await state(client, fixture.topic);
        return value?.secure && value.messages.length && value.works.some(work => work.id === workId && work.status === 'running') && value;
    }, 'same in-flight desktop Work')));
    await fs.writeFile(path.join(out, 'phone-observed'), '');
    await marker('first-completed');
    const followups = ['Chromium follow-up for the same synthetic image'];
    if (withPhone) followups.push('Phone follow-up for the same synthetic image');
    for (const [index, client] of clients.entries()) {
        await poll(async () => {
            const value = await state(client, fixture.topic);
            return value?.messages.length === 2 * (index + 1) && value.works.every(work => work.status === 'completed');
        }, 'formal messages before next submission');
        await send(client, followups[index]);
    }
    const final = await Promise.all(clients.map(client => poll(async () => {
        const value = await state(client, fixture.topic);
        const expected = clients.length + 1;
        return value?.works.length === expected && value.works.every(work => work.status === 'completed') &&
            value.messages.length === expected * 2 && followups.every(text => value.messages.some(message => message.text.includes(text))) && value;
    }, 'final PWA history')));
    if (withPhone) {
        assert.deepEqual(final[0].works, final[1].works);
        assert.deepEqual(final[0].messages.map(m => m.id), final[1].messages.map(m => m.id));
    }
    const loadedAssets = await Promise.all(clients.map(client => client.loadedAssets()));
    await fs.writeFile(path.join(out, 'pwa-proof.json'), JSON.stringify({ mode, ongoing, final, loadedAssets }, null, 2));
    console.log('PWA observations verified in ' + path.join(out, 'pwa-proof.json'));
} finally {
    for (const client of clients) client.close();
    const errors = [];
    for (const action of cleanup.reverse()) {
        try { await action(); } catch (error) { errors.push(error); }
    }
    await fs.rm(temporary, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, 'PWA fixture cleanup failed');
}

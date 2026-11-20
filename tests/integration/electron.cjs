'use strict';
const {app, ipcMain, BrowserWindow} = require('electron');
const { isLoopback, restrictNodeNetwork } = require('./restrict-network.cjs');
restrictNodeNetwork();
if (process.env.NS_METER_PREFIX) require('./meter.cjs');
const restrictSession = session => {
    session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, ({ url }, done) => {
        const target = new URL(url);
        const network = /^(?:https?|wss?|ftp):$/.test(target.protocol);
        done({ cancel: network && !isLoopback(target.hostname) });
    });
};
app.on('session-created', restrictSession);
const readline = require('node:readline');
const crypto = require('node:crypto');
const log = (event, data) => console.log('NS_MEASURE', JSON.stringify({event,t:Date.now(),data}));
let detailed = false;
const fs = require('node:fs');
const path = require('node:path');
app.setAppPath(process.env.NS_HOST);
const Module = require('node:module');
const load = Module._load;
const instrumented = new WeakSet();
Module._load = function (request, parent, ...rest) {
    const module = load.call(this, request, parent, ...rest);
    if (!module || typeof module !== 'object' || instrumented.has(module)) return module;
    if (typeof module.createNativeSyncRuntime === 'function') {
        instrumented.add(module);
        const factory = module.createNativeSyncRuntime;
        module.createNativeSyncRuntime = async function (...args) {
            log('runtime-factory-start');
            const result = await factory.apply(this, args);
            log('runtime-factory-end', { ready:result?.ready, startupError:result?.startupError, readOnly:result?.readOnly });
            if (result?.close) {
                const close = result.close.bind(result);
                result.close = function (...closeArgs) {
                    let admissionCode;
                    if (process.env.NS_CHECK_QUIT_ADMISSION === '1') {
                        try { require(path.join(process.env.NS_HOST, 'modules/services/quitAdmission.cjs')).assertOpen(); }
                        catch (error) { admissionCode = error.code; }
                    }
                    log('runtime-close-start', { admissionCode });
                    const pending = close(...closeArgs);
                    Promise.resolve(pending).then(() => log('runtime-close-end'), error => log('runtime-close-error',{code:error?.code}));
                    return pending;
                };
            }
            return result;
        };
    }
    if (typeof module.SharedRuntime?.open === 'function') {
        instrumented.add(module);
        const open = module.SharedRuntime.open;
        module.SharedRuntime.open = async function (...args) {
            try { return await open.apply(this, args); }
            catch (error) { log('runtime-open-failure', { code:error.code, stack:error.stack }); throw error; }
        };
    }
    return module;
};
app.on('certificate-error', (event, _contents, raw, _error, certificate, callback) => {
    const origin = new URL(raw);
    const fingerprint = new crypto.X509Certificate(certificate.data).fingerprint256;
    const allowed = origin.hostname === '127.0.0.1' && fingerprint === process.env.NS_CERT_FINGERPRINT;
    if (allowed) event.preventDefault();
    callback(allowed);
});
app.on('ready', () => log('electron-ready', { pid: process.pid, version:process.versions.electron, sandbox: !app.commandLine.hasSwitch('no-sandbox') }));
app.on('before-quit', () => log('before-quit'));
app.on('will-quit', () => log('will-quit'));
app.on('quit', () => log('electron-quit'));
ipcMain.on('lifecycle:renderer-ready', event => log('renderer-ready', { sender: event.sender.id }));
const handler = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, fn) => {
    return handler(channel, function (event, ...args) {
        if (detailed) log('ipc', { channel, sender: event.sender.id });
        if (detailed && channel === 'native-sync:prepare-send') {
            log('desktop-input', {id:args[0]?.message?.id,localOnly:args[0]?.localOnly===true,serverSession:args[0]?.serverSession===true});
        }
        const result = fn.call(this, event, ...args);
        if (detailed && /^(native-sync:|topic-execution:authority|save-avatar$|save-agent-config$|save-agent-group-avatar$|save-agent-group-config$)/.test(channel)) {
            return Promise.resolve(result).then(value => {
                log('ipc-result', {channel, code:value?.code, error:value?.error, handled:value?.handled,
                    success:value?.success, refreshError:value?.refreshError, extrasError:value?.extrasError, sharedVersion:value?.sharedVersion, avatarResult:value?.avatarResult, kind:value?.kind, ready:value?.shared?.ready, replyId:value?.replyId });
                return value;
            });
        }
        return result;
    });
};


app.on('web-contents-created', (_event, contents) => {
    contents.on('console-message', (_event, details, legacyMessage) => {
        const level = details?.level ?? details;
        const message = details?.message ?? legacyMessage;
        if (detailed && message && (level === 'error' || level === 3)) log('renderer-console', {message,level});
    });
    const send = contents.send.bind(contents);
    contents.send = (channel, ...args) => {
        if (detailed) {
            const payload = args[0];
            const session = payload?.serverSession;
            log('renderer-event', { channel, sender:contents.id,
                type:channel === 'vcp-stream-event' ? payload?.type : undefined,
                textLength:typeof session?.text === 'string' ? session.text.length : undefined,
                executionId:session?.executionId,
            });
        }
        return send(channel, ...args);
    };
});
function window() {
    return BrowserWindow.getAllWindows().find(candidate => /\/main\.html(?:\?|$)/.test(candidate.webContents.getURL()));
}
const input = readline.createInterface({ input: process.stdin, terminal: false });
input.on('line', async line => {
    const { id, action, script } = JSON.parse(line);
    try {
        let result;
        const win = window();
        if (action === 'quit') app.quit();
        if (action === 'quit-busy') {
            const gate = require(path.join(process.env.NS_HOST, 'modules/services/quitAdmission.cjs'));
            const hold = Promise.withResolvers();
            const work = gate.run(() => hold.promise);
            try {
                app.quit();
                await new Promise(resolve => setImmediate(resolve));
                gate.assertOpen();
                result = { alive: !win.isDestroyed(), admissionResumed: true };
            } finally {
                hold.resolve();
                await work;
            }
        }
        if (action === 'mobile') {
            const target = new URL(script);
            if (target.protocol !== 'https:' || target.hostname !== '127.0.0.1' || target.pathname !== '/mobile/') {
                throw Error('Invalid mobile fixture URL');
            }
            const mobile = new BrowserWindow({ width: 390, height: 844, show: false,
                webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
            try {
                await mobile.loadURL(target.href);
                result = await mobile.webContents.executeJavaScript(`new Promise((resolve, reject) => {
                    const start = performance.now();
                    function check() {
                        if (window.isSecureContext && document.querySelector('#pair-code') &&
                            document.querySelector('header .connection')?.textContent === '服务可达') {
                            resolve({ title: document.title, secureContext: true, connectionReady: true });
                        } else if (performance.now() - start > 4000) {
                            reject(new Error('Mobile did not render the reachable pairing screen'));
                        } else setTimeout(check, 50);
                    }
                    check();
                })`);
            } finally {
                mobile.destroy();
            }
        }
        if (action === 'eval') {
            if (!win) throw Error('Main window unavailable');
            result = await win.webContents.executeJavaScript(script, true);
        }
        if (['picture','mouse'].includes(action)) {
            const debuggerApi = win.webContents.debugger;
            if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');
            const cdp = (method, params) => debuggerApi.sendCommand(method,params);
            if (action === 'picture') {
                const shot = await cdp('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:true});
                require('node:fs').writeFileSync(script, Buffer.from(shot.data,'base64'));
            }
            if (action === 'mouse') {
                win.show(); win.focus(); win.webContents.focus();
                await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',...script});
                await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...script});
                await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...script});
            }
        }
        if (action === 'loaded-sources') {
            const { fileURLToPath } = require('node:url');
            const sourceRoot = path.resolve(process.env.NS_HOST, "../..");
            const main = Object.keys(require.cache).filter(file => file.startsWith(sourceRoot + '/') &&
                script.main.some(name => file.endsWith('/' + name))).map(file => ({
                    file: path.relative(sourceRoot, file),
                    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
                }));
            const debuggerApi = win.webContents.debugger;
            if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');
            const parsed = [];
            const report = (_event, name, details) => {
                if (name !== 'Debugger.scriptParsed' || !details.url.startsWith('file://')) return;
                const file = fileURLToPath(details.url);
                if (file.startsWith(sourceRoot + '/') && script.renderer.some(name => file.endsWith('/' + name))) {
                    parsed.push({file, id:details.scriptId, length:details.length});
                }
            };
            debuggerApi.on('message', report);
            await debuggerApi.sendCommand('Debugger.enable');
            const renderer = [];
            try {
                for (const {file,id} of parsed) {
                    const {scriptSource} = await debuggerApi.sendCommand('Debugger.getScriptSource',{scriptId:id});
                    renderer.push({file:path.relative(sourceRoot,file), bytes:Buffer.byteLength(scriptSource),
                        sha256:crypto.createHash('sha256').update(scriptSource).digest('hex')});
                }
            } finally {
                debuggerApi.off('message', report);
                await debuggerApi.sendCommand('Debugger.disable');
            }
            result = {url: win.webContents.getURL(), main, renderer};
        }
        if (action === 'trace') detailed = true;
        log('answer', { id, result });
    } catch (error) {
        log('answer', { id, error: error.message });
    }
});
require(process.env.NS_HOST + '/main.js');

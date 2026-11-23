'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { fileURLToPath } = require('node:url');

const controlVariable = 'NS_FILE_URI_ROUNDTRIP_ISOLATION_CONTROL';
const controls = new Map();

function spawnIsolatedToolbox(command, args, { privateCacheDir, spawnOptions = {} }) {
    assert.ok(path.isAbsolute(privateCacheDir), 'A cache directory must be absolute');
    fs.mkdirSync(privateCacheDir, { recursive: true, mode: 0o700 });
    assert.equal(fs.realpathSync(privateCacheDir), privateCacheDir, 'A cache must have no symlink alias');
    assert.ok(!controls.has(privateCacheDir), 'Only one ToolBox may use this isolation fixture');

    const control = fs.mkdtempSync(path.join(path.dirname(privateCacheDir), '.uri-isolation-'));
    const child = spawn('bwrap', [
        '--die-with-parent',
        '--bind', '/', '/',
        '--tmpfs', privateCacheDir,
        '--', command, '--require', __filename, ...args,
    ], {
        ...spawnOptions,
        detached: true,
        env: { ...(spawnOptions.env ?? process.env), [controlVariable]: control },
    });

    // Bubblewrap supervises the command and does not forward SIGTERM.
    child.kill = (signal = 'SIGTERM') => {
        if (child.exitCode !== null || child.signalCode !== null || !child.pid) return false;
        try {
            const pidFile = path.join(control, 'node-pid');
            const target = signal !== 'SIGKILL' && fs.existsSync(pidFile)
                ? Number(fs.readFileSync(pidFile, 'utf8'))
                : -child.pid;
            return process.kill(target, signal);
        } catch (error) {
            if (error.code !== 'ESRCH') throw error;
            return false;
        }
    };
    controls.set(privateCacheDir, { control, child });
    child.once('close', () => {
        controls.delete(privateCacheDir);
        fs.rmSync(control, { recursive: true, force: true });
    });
    return child;
}

async function tryOperation(operation) {
    try {
        return { ok: true, ...await operation() };
    } catch (error) {
        return { ok: false, code: error.code };
    }
}

async function probe(fileUri) {
    const file = fileURLToPath(fileUri);
    return {
        pid: process.pid,
        mountNamespace: await fsp.readlink('/proc/self/ns/mnt'),
        access: await tryOperation(() => fsp.access(file, fs.constants.R_OK)),
        readFile: await tryOperation(async () => {
            const bytes = await fsp.readFile(file);
            return { byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
        }),
    };
}

async function verifyFileUriIsolation({ fileUri, privateCacheDir, desktopPid }) {
    const state = controls.get(privateCacheDir);
    assert.ok(state, 'No isolated ToolBox for A cache');
    const file = fileURLToPath(fileUri);
    const realFile = await fsp.realpath(file);
    assert.equal(realFile, file, 'A file URI must have no symlink alias');
    const relative = path.relative(privateCacheDir, file);
    assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative),
        'A must have materialized the file under the masked cache directory');

    const desktop = await probe(fileUri);
    if (desktopPid) {
        const desktopMount = await fsp.readlink('/proc/' + desktopPid + '/ns/mnt');
        assert.equal(desktopMount, desktop.mountNamespace, 'Probe must use Electron A’s mount namespace');
        desktop.electronPid = desktopPid;
    }
    assert.equal(desktop.access.ok, true, 'Desktop namespace can access A’s file');
    assert.equal(desktop.readFile.ok, true, 'Desktop namespace can read A’s file');

    const id = randomUUID();
    const request = path.join(state.control, 'request.json');
    fs.writeFileSync(request + '.tmp', JSON.stringify({ id, fileUri }), { flag: 'wx', mode: 0o600 });
    fs.renameSync(request + '.tmp', request);

    for (let attempt = 0; attempt < 100; attempt++) {
        assert.equal(state.child.exitCode, null, 'Isolated ToolBox exited before its file URI probe');
        assert.equal(state.child.signalCode, null, 'Isolated ToolBox terminated before its file URI probe');
        let response;
        try {
            response = JSON.parse(fs.readFileSync(path.join(state.control, id + '.json'), 'utf8'));
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            await delay(50);
            continue;
        }
        assert.equal(response.fileUri, fileUri);
        assert.equal(response.error, undefined);
        const toolbox = response.result;
        assert.match(toolbox.mountNamespace, /^mnt:\[\d+\]$/);
        assert.notEqual(toolbox.mountNamespace, desktop.mountNamespace);
        assert.deepEqual(toolbox.access, { ok: false, code: 'ENOENT' });
        assert.deepEqual(toolbox.readFile, { ok: false, code: 'ENOENT' });
        return { fileUri, privateCacheDir, desktop, toolbox };
    }
    throw Error('Isolated ToolBox did not answer the file URI probe');
}

function installProbe(control) {
    const request = path.join(control, 'request.json');
    fs.writeFileSync(path.join(control, 'node-pid.tmp'), String(process.pid), { flag: 'wx', mode: 0o600 });
    fs.renameSync(path.join(control, 'node-pid.tmp'), path.join(control, 'node-pid'));
    setInterval(() => {
        if (!fs.existsSync(request)) return;
        const { id, fileUri } = JSON.parse(fs.readFileSync(request, 'utf8'));
        fs.unlinkSync(request);
        const reply = path.join(control, id + '.json');
        const respond = payload => {
            fs.writeFileSync(reply + '.tmp', JSON.stringify({ fileUri, ...payload }), { flag: 'wx', mode: 0o600 });
            fs.renameSync(reply + '.tmp', reply);
        };
        void probe(fileUri).then(result => respond({ result }), error => respond({ error: String(error) }));
    }, 50).unref();
}

// The real staged Node entry point uses this preload only to publish filesystem evidence.
// Bubblewrap applies the cache mask before Node starts.
if (process.env[controlVariable]) {
    const control = process.env[controlVariable];
    delete process.env[controlVariable];
    installProbe(control);
}

module.exports = { spawnIsolatedToolbox, verifyFileUriIsolation };

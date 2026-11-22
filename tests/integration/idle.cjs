'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setTimeout: wait } = require('node:timers/promises');
const { audit } = require('./idle-audit.cjs');

const interval = 60000;
const warmedUpMs = 15000;

function processCounters(pid) {
    const proc = '/proc/' + pid;
    const stat = fs.readFileSync(proc + '/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(' ');
    const io = Object.fromEntries(fs.readFileSync(proc + '/io', 'utf8').trim().split('\n').map(line => {
        const [key, value] = line.split(': ');
        return [key, Number(value)];
    }));
    return { userTicks: Number(fields[11]), systemTicks: Number(fields[12]), ...io };
}

async function measure({ out, waitUntil, pids, stateAudit, n, scale, background, missing }) {
    const roles = Object.keys(pids);
    const meterFile = (role, name) => path.join(out, role + '-' + (role === 'backend' ? 'backend' : 'main') + '-' + name + '.json');
    const meter = process.env.NS_IDLE_METER !== 'off';
    if (meter) {
        for (const role of roles) {
            await waitUntil(() => fs.existsSync(meterFile(role, 'ready')), role + ' idle meter');
        }
    }

    const start = Math.ceil((Date.now() + warmedUpMs) / 1000) * 1000;
    const ticksPerSecond = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }));
    if (meter) {
        for (const role of roles) {
            fs.writeFileSync(path.join(out, role + '-schedule.json'), JSON.stringify({ start, n }));
        }
    }

    console.log('Idle sampling for ' + n + ' complete minutes after a 15-second warmup');
    const snapshots = [];
    let before;
    for (let i = 0; i <= n; i++) {
        await wait(Math.max(0, start + i * interval - Date.now()));
        if (i === 0) before = stateAudit();
        const snapshot = {
            at: Date.now(),
            counters: Object.fromEntries(roles.map(role => [role, processCounters(pids[role])])),
        };
        snapshots.push(snapshot);
        fs.writeFileSync(path.join(out, 'process-snapshot-' + i + '.json'), JSON.stringify(snapshot));
    }

    const after = stateAudit();
    assert.deepEqual(after, before);
    const delta = (a, b) => Object.fromEntries(Object.keys(a).map(key => [key, b[key] - a[key]]));
    const windows = [];
    for (let i = 0; i < n; i++) {
        const processes = {};
        for (const role of roles) {
            const file = meterFile(role, 'w' + (i + 1));
            if (meter) await waitUntil(() => fs.existsSync(file), role + ' minute ' + (i + 1));
            const total = delta(snapshots[i].counters[role], snapshots[i + 1].counters[role]);
            processes[role] = {
                total,
                cpuMs: (total.userTicks + total.systemTicks) * 1000 / ticksPerSecond,
                ...(meter && { tagged: JSON.parse(fs.readFileSync(file, 'utf8')) }),
            };
        }
        windows.push({ from: snapshots[i].at, to: snapshots[i + 1].at, processes });
    }
    return { start, interval, ticksPerSecond, meter, scale, background, missing, before, after, windows };
}

async function run({ out, candidate, profiles, desktops, service, cert, result, start, stop, click, evalJs, waitUntil, sha }) {
    if (process.env.NS_IDLE_SCENARIOS === 'attachment') {
        result.attachment = await require('./idle-attachment.cjs').scenario({
            B: desktops.B, out, service, cert, click, evalJs, waitUntil,
        });
        return;
    }

    // Leave the original three-minute idle check available. Comparative runs
    // select 10 or 31 real minutes with the same fixture and clock.
    const n = Number(process.env.NS_IDLE_N ?? 3);
    const scale = process.env.NS_IDLE_SCALE || 'small';
    const background = process.env.NS_IDLE_BACKGROUND !== 'off';
    const missing = process.env.NS_IDLE_MISSING === 'yes';
    assert.ok(Number.isSafeInteger(n) && n > 0, 'NS_IDLE_N must be a positive number of minutes');
    assert.ok(scale === 'small' || scale === 'large', 'NS_IDLE_SCALE must be small or large');
    assert.ok(!missing || scale === 'large', 'NS_IDLE_MISSING=yes requires the large fixture');

    for (const [role, desktop] of Object.entries(desktops)) {
        await waitUntil(() => {
            const end = desktop.events.find(event => event.event === 'runtime-factory-end');
            if (end && !end.data.ready) throw Error(role + ' NativeSync startup ' + JSON.stringify(end.data));
            return end?.data.ready;
        }, role + ' ready NativeSync runtime');
    }
    const stateAudit = () => audit(out, scale === 'large');
    let lastAuditError;
    let enabled;
    try {
        enabled = await waitUntil(() => {
            try {
                return stateAudit();
            } catch (error) {
                lastAuditError = error;
                return false;
            }
        }, 'idle fixture caught up');
    } catch (error) {
        throw lastAuditError ?? error;
    }

    const roles = Object.keys(desktops);
    if (!background) {
        await Promise.all(roles.map(role => stop(role)));
        for (const role of roles) {
            const file = path.join(profiles[role], '.native-sync/connection.json');
            const connection = JSON.parse(fs.readFileSync(file, 'utf8'));
            fs.writeFileSync(file, JSON.stringify({ ...connection, enabled: false }));
        }
        result.disabledBeforeMeasurement = true;
        desktops = Object.fromEntries(await Promise.all(roles.map(async role => [role, await start(role)])));
        assert.deepEqual(stateAudit(), enabled);
        for (const desktop of Object.values(desktops)) {
            assert.ok(!desktop.events.some(event => event.event === 'runtime-factory-end' && event.data.ready));
        }
    } else {
        const prefix = 'apps/desktop/modules/services/nativeSync/';
        const main = ['runtime.js', 'sharedRuntime.js', 'sharedWaitClient.js', 'attachmentWork.js', 'sharedDirectory.js', 'adapter.js']
            .map(file => prefix + file);
        result.desktopSources = {};
        for (const [role, desktop] of Object.entries(desktops)) {
            const loaded = await desktop.command('loaded-main-sources', { main });
            assert.equal(loaded.main.length, main.length, role + ' verified loaded sync source count');
            for (const file of loaded.main) assert.equal(file.sha256, sha(path.join(candidate, file.file)), file.file);
            result.desktopSources[role] = loaded.main;
        }
    }

    const topicObservation = process.env.NS_IDLE_OBSERVE_TOPIC === 'yes';
    if (topicObservation) {
        const desktop = desktops.B;
        const selection = () => evalJs(desktop, 'window.VCPStateChannels.get("conversation.current").get()');
        if (!await evalJs(desktop, "document.querySelector('#tabContentAgents').classList.contains('active')")) {
            await click(desktop, '.sidebar-tab-button[data-tab="agents"]');
        }
        await click(desktop, '#agentList > li .agent-name', 'Synthetic shared');
        const target = service.descriptors.B.preSubmit;
        await waitUntil(async () => (await selection()).topicId === target.topicId, 'selected idle observation topic');
        const args = [target.itemId, 'agent', target.topicId, false].map(value => JSON.stringify(value)).join(',');
        const status = await evalJs(desktop, 'window.chatAPI.getNativeExecutionStatus(' + args + ')');
        assert.equal(status.configurationError ?? null, null);
        result.topicObservation = await waitUntil(() => service.requests.find(row =>
            row.scope === 'topic' && row.device === 'deviceB' && row.status === 200), 'B authorized topic SSE');
    }

    const pids = { A: desktops.A.proc.pid, B: desktops.B.proc.pid, backend: service.backendPid };
    result.idle = await measure({ out, waitUntil, pids, stateAudit, n, scale, background, missing });
    assert.equal(service.calls.length, 0, 'idle provider calls');
}

module.exports = { run };

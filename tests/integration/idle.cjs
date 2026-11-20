'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setTimeout: wait } = require('node:timers/promises');

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

async function measure({ out, waitUntil, pids }) {
    const roles = Object.keys(pids);
    const meterRole = role => role === 'backend' ? 'backend' : 'main';
    const meterFile = (role, name) => path.join(out, role + '-' + meterRole(role) + '-' + name + '.json');
    for (const role of roles) await waitUntil(() => fs.existsSync(meterFile(role, 'ready')), role + ' idle meter');

    const time = Date.now();
    const start = Math.ceil((time + 15000) / 1000) * 1000;
    const n = 3;
    const interval = 60000;
    const ticksPerSecond = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }));
    for (const role of roles) fs.writeFileSync(path.join(out, role + '-schedule.json'), JSON.stringify({ start, n }));
    console.log('Idle sampling for three complete minutes after a 15-second warmup');
    const snapshots = [];
    for (let i = 0; i <= n; i++) {
        await wait(Math.max(0, start + i * interval - Date.now()));
        snapshots.push({ at: Date.now(), counters: Object.fromEntries(roles.map(role => [role, processCounters(pids[role])])) });
    }
    const delta = (a, b) => Object.fromEntries(Object.keys(a).map(key => [key, b[key] - a[key]]));
    const windows = [];
    for (let i = 0; i < n; i++) {
        const processes = {};
        for (const role of roles) {
            const file = meterFile(role, 'w' + (i + 1));
            await waitUntil(() => fs.existsSync(file), role + ' minute ' + (i + 1));
            const total = delta(snapshots[i].counters[role], snapshots[i + 1].counters[role]);
            processes[role] = { total, cpuMs: (total.userTicks + total.systemTicks) * 1000 / ticksPerSecond,
                tagged: JSON.parse(fs.readFileSync(file, 'utf8')) };
        }
        windows.push({ from: snapshots[i].at, to: snapshots[i + 1].at, processes });
    }
    return { start, interval, ticksPerSecond, windows };
}
module.exports = { measure };

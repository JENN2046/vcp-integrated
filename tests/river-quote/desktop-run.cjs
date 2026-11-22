'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const readline = require('node:readline');
const { setTimeout: delay } = require('node:timers/promises');

const [variant, hostArg, outputArg, traceArg, traceKeyArg, authorDesktopArg] = process.argv.slice(2);
assert.ok(['author', 'baseline', 'candidate'].includes(variant) && hostArg && outputArg && traceArg,
    'Usage: node desktop-run.cjs author|baseline|candidate <desktop source> <evidence dir> <tool trace> [trace key] [author desktop evidence]');
const host = path.resolve(hostArg);
const toolbox = process.env.RIVER_TOOLBOX_ROOT && path.resolve(process.env.RIVER_TOOLBOX_ROOT);
const evidencePrefix = variant + (toolbox ? '-chain-desktop' : '-desktop');
if (toolbox) assert.ok(!authorDesktopArg, 'use the independent cold import test for the author V2 fixture');
const output = path.resolve(outputArg);
const trace = JSON.parse(fs.readFileSync(traceArg, 'utf8'));
const defaultTraceKeys = { author: 'authorShortSemantic', baseline: 'integratedShortSemantic', candidate: 'candidateShortSemantic' };
const traceKey = traceKeyArg || defaultTraceKeys[variant];
const toolArguments = trace[traceKey]?.dispatchedArgs;
assert.ok(Array.isArray(toolArguments?.river_context), 'use the captured ToolBox dispatch arguments');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-river-quote-desktop-'));
const data = path.join(profile, 'data');
const home = path.join(profile, 'home');
const inputId = toolArguments.sender_id;
const groupId = 'fixture-river-group';
const topicId = toolArguments.topic_id;
const legacyId = 'fixture-legacy-v1';
const deliveryText = toolArguments.message;
const legacyText = '旧版留言 · 仅含角色和正文';
const legacy = {
    id: legacyId, role: 'assistant', name: '隔离来信人', agentId: inputId, groupId, topicId,
    isGroupMessage: true, isThinking: false, finishReason: 'completed', timestamp: Date.now() - 10000,
    content: legacyText + '\n\n[VCP_TOPIC_RIVER_V1]\n{"role":"assistant","content":"旧格式正文"}\n[/VCP_TOPIC_RIVER_V1]',
};
const authorV2 = authorDesktopArg && JSON.parse(fs.readFileSync(authorDesktopArg, 'utf8')).history.at(-1);
assert.ok(!authorV2 || (variant === 'candidate' && /\n\n\[VCP_TOPIC_RIVER_V2\]/.test(authorV2.content)));
const relative = 'UserData/' + groupId + '/topics/' + topicId + '/history.json';
const historyFile = path.join(data, relative);
const J = JSON.stringify;
function write(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, J(value, null, 2) + '\n');
}
function seed() {
    write(path.join(data, 'settings.json'), {
        ChatDataServiceEnabled: false, disableAsana: true, disableUpdateCheck: true,
        enableVcpLog: false, enableDistributedServer: false, userName: '隔离用户',
        vcpServerUrl: 'http://127.0.0.1:65432/v1/chat/completions', vcpApiKey: 'synthetic-only',
    });
    write(path.join(data, 'Agents', inputId, 'config.json'), {
        id: inputId, name: '隔离来信人',
        topics: [{ id: toolArguments.source_topic_id, name: '引文来源', createdAt: Date.now() }],
    });
    write(path.join(data, 'AgentGroups', groupId, 'config.json'), {
        id: groupId, name: 'River Quote 隔离群聊', members: [inputId], mode: 'inviteOnly',
        topics: [{ id: topicId, name: '引文验收', createdAt: Date.now(), isTitleLocked: true }],
    });
    write(path.join(data, 'UserData', inputId, 'topics', toolArguments.source_topic_id, 'history.json'), []);
    write(historyFile, [legacy]);
    fs.mkdirSync(output, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
}
async function until(fn, description) {
    const end = Date.now() + 20000;
    do {
        const found = await fn();
        if (found) return found;
        await delay(50);
    } while (Date.now() < end);
    throw Error('Timed out waiting for ' + description);
}
const quitTimeout = () => delay(5000, null, { ref: false });
function launch(display) {
    const electron = process.env.ELECTRON_BIN || createRequire(path.join(host, 'package.json'))('electron');
    const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', DISPLAY: display, HOME: home,
        XDG_CONFIG_HOME: path.join(home, 'config'), NS_HOST: host,
        VCPCHAT_E2E_TEST: '1', VCPCHAT_APP_DATA_DIR: data };
    const client = spawn(electron, ['--ozone-platform=x11', '--disable-background-networking',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
        path.join(__dirname, 'desktop-electron.cjs')], { cwd: host, env, stdio: ['pipe', 'pipe', 'inherit'] });
    const exited = once(client, 'exit');
    const pending = new Map();
    let id = 0;
    let ready;
    let version;
    client.stdin.on('error', () => {});
    readline.createInterface({ input: client.stdout }).on('line', line => {
        if (!line.startsWith('NS_MEASURE ')) {
            if (process.env.RIVER_VERBOSE) console.error(line);
            return;
        }
        const entry = JSON.parse(line.slice(11));
        if (entry.event === 'answer') pending.get(entry.data.id)?.(entry.data);
        if (entry.event === 'renderer-ready') ready = true;
        if (entry.event === 'electron-ready') version = entry.data.version;
    });
    async function command(action, script) {
        const seq = ++id;
        const reply = new Promise(resolve => pending.set(seq, resolve));
        client.stdin.write(J({ id: seq, action, script }) + '\n');
        const value = await Promise.race([reply, quitTimeout(), exited.then(() => null)]);
        pending.delete(seq);
        if (!value || value.error) throw Error(value?.error || 'Command unavailable: ' + action);
        return value.result;
    }
    async function click(selector) {
        const point = await until(() => command('eval', `(() => {
            const node = document.querySelector(${J(selector)});
            if (!node?.checkVisibility()) return null;
            node.scrollIntoView({ block: 'center', behavior: 'instant' });
            const rect = node.getBoundingClientRect();
            const x = Math.round(rect.left + rect.width / 2);
            const y = Math.round(rect.top + rect.height / 2);
            return node.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
        })()`), selector);
        await command('mouse', point);
    }
    return {
        command, click, get version() { return version; },
        ready: () => until(() => {
            assert.equal(client.exitCode, null, 'Electron exited before renderer-ready');
            return ready;
        }, 'desktop renderer-ready'),
        async close() {
            if (client.exitCode !== null || client.signalCode !== null) return;
            await command('quit').catch(() => {});
            if (!await Promise.race([exited, quitTimeout()])) client.kill('SIGTERM');
            assert.deepEqual(await exited, [0, null]);
        },
    };
}
async function readCard(client, id) {
    const selector = `.message-item[data-message-id="${id}"]`;
    const get = expression => client.command('eval', `(() => {
        const item = document.querySelector(${J(selector)});
        if (!item?.checkVisibility() || !item.innerText.trim()) return null;
        const card = item.querySelector('.vcp-topic-river');
        return ${expression};
    })()`);
    const initial = await until(() => get(`({
        domId: item.dataset.messageId,
        text: item.innerText,
        collapsed: card ? !card.open : null,
        summaries: [...(card?.querySelectorAll('.vcp-topic-river-row-summary') ?? [])].map(node => node.textContent),
        content: [...(card?.querySelectorAll('.vcp-topic-river-text') ?? [])].map(node => node.textContent),
    })`), 'native message ' + id);
    if (initial.collapsed !== null) {
        assert.equal(initial.collapsed, true);
        await client.click(selector + ' .vcp-topic-river-summary');
        assert.equal(await get('card.open'), true);
        await client.click(selector + ' .vcp-topic-river-row-summary');
        assert.equal(await get('card.querySelector(".vcp-topic-river-row").open'), true);
    }
    return initial;
}
async function main() {
    seed();
    const screen = spawn(process.env.XVFB_BIN || 'Xvfb', [
        '-displayfd', '1', '-screen', '0', '1500x1000x24', '-nolisten', 'tcp',
    ], { stdio: ['ignore', 'pipe', 'inherit'] });
    const screenExit = once(screen, 'exit');
    let client;
    try {
        const outputLines = readline.createInterface({ input: screen.stdout });
        const display = ':' + (await Promise.race([once(outputLines, 'line'),
            screenExit.then(() => { throw Error('Xvfb exited before selecting a display'); })]))[0];
        async function openGroup() {
            client = launch(display);
            await client.ready();
            await client.click(`#agentList li[data-item-id="${groupId}"][data-item-type="group"]`);
        }
        await openGroup();
        const deliver = args => client.command('topic-sponsor-deliver', args);
        let chain;
        let accepted;
        if (toolbox) {
            require('../integration/restrict-network.cjs').restrictNodeNetwork();
            const { run } = require('./tool-trace.cjs');
            const toolboxVariant = variant === 'baseline' ? 'integrated' : variant;
            const { traces, sources } = await run(toolbox, null, trace[traceKey].revision, toolboxVariant,
                { desktop: host, deliver, scenario: 'shortSemantic' });
            const execution = traces.shortSemantic;
            assert.deepEqual(execution.dispatchedArgs, toolArguments, 'live dispatch matches the independent ToolBox trace');
            accepted = execution.desktopReturn;
            const rawId = execution.toolReturn.raw.message_id;
            const textId = JSON.parse(execution.toolReturn.content[0].text).message_id;
            assert.ok(accepted.message_id, J(accepted));
            assert.equal(rawId, accepted.message_id);
            assert.equal(textId, rawId);
            chain = { execution, sources };
        } else {
            accepted = await deliver(toolArguments);
        }
        assert.ok(accepted.message_id, J(accepted));
        const history = await until(() => {
            const found = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
            return found.length === 2 && found;
        }, 'native durable History');
        assert.equal(history[0].content, legacy.content);
        assert.equal(history[1].id, accepted.message_id);
        assert.equal(history[1].agentId, inputId);
        assert.ok(history[1].content.includes(deliveryText));
        assert.ok(history[1].content.endsWith(`[该发言发送自${toolArguments.source_topic_id}话题]`));
        assert.ok(history[1].content.includes(variant === 'author' ? '[VCP_TOPIC_RIVER_V2]' : '[VCP_TOPIC_RIVER_V1]'));
        const live = await readCard(client, accepted.message_id);
        assert.deepEqual(live.content, toolArguments.river_context.map(row => row.content));
        const summaries = toolArguments.river_context.map(row => {
            const role = row.role === 'user' ? '用户' : '助手';
            const label = variant !== 'baseline' && row.name ? `${row.name}（${role}）` : role;
            return `${label}：${row.content}`;
        });
        assert.deepEqual(live.summaries, summaries);
        if (!chain) await client.command('picture', path.join(output, evidencePrefix + '-live.png'));
        await client.close();
        const saved = fs.readFileSync(historyFile, 'utf8');
        await openGroup();
        const reopenedLegacy = await readCard(client, legacyId);
        const reopened = await readCard(client, accepted.message_id);
        if (!chain) await client.command('picture', path.join(output, evidencePrefix + '-reopened.png'));
        assert.deepEqual(reopened, live);
        assert.equal(reopened.domId, history[1].id);
        assert.equal(fs.readFileSync(historyFile, 'utf8'), saved);
        assert.deepEqual(reopenedLegacy.summaries, ['助手：旧格式正文']);
        await client.close();
        let importedAuthorV2;
        if (authorV2) {
            write(historyFile, [...history, { ...authorV2, id: 'imported-author-v2' }]);
            const importedHistoryBytes = fs.readFileSync(historyFile, 'utf8');
            await openGroup();
            importedAuthorV2 = await readCard(client, 'imported-author-v2');
            assert.deepEqual(importedAuthorV2.summaries, ['青岚（助手）：蓝色样本按原计划保留，等下一轮确认。', '用户：收到。', '白露（助手）：蓝色样本按原计划保留，等下一轮确认。']);
            await client.command('picture', path.join(output, 'candidate-desktop-author-v2.png'));
            await client.close();
            assert.equal(fs.readFileSync(historyFile, 'utf8'), importedHistoryBytes);
        }
        const result = { variant, traceKey, electron: client.version, accepted, history,
            live, reopened, reopenedLegacy, ...(chain && { chain }), ...(importedAuthorV2 && { importedAuthorV2 }) };

        write(path.join(output, evidencePrefix + '.json'), result);
        console.log(J({ variant, electron: client.version, live: live.summaries, legacy: reopenedLegacy.summaries }));
    } finally {
        try { await client?.close(); }
        finally {
            if (screen.exitCode === null && screen.signalCode === null) screen.kill();
            await screenExit;
            fs.rmSync(profile, { recursive: true, force: true });
        }
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

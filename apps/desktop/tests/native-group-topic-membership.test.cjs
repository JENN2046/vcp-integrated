const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const filename = fs.realpathSync(path.join(__dirname, '../Groupmodules/groupchat.js'));
const source = fs.readFileSync(filename, 'utf8');
const localRequire = createRequire(filename);

function fixture(t, { topics = [{ id: 'topic' }], deleting = false, exists = true } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-topic-membership-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const paths = {
        APP_DATA_ROOT_IN_PROJECT: root,
        USER_DATA_DIR: path.join(root, 'UserData'),
        AGENT_DIR: path.join(root, 'Agents'),
    };
    const configPath = path.join(root, 'AgentGroups', 'owned', 'config.json');
    const historyPath = path.join(paths.USER_DATA_DIR, 'owned', 'topics', 'topic', 'history.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
        mode: 'sequential',
        members: [],
        topics,
        _historyDeleting: deleting,
    }));
    if (exists) {
        fs.mkdirSync(path.dirname(historyPath), { recursive: true });
        fs.writeFileSync(historyPath, '[]');
    }

    const realFs = localRequire('fs-extra');
    // Stop at the first History read, before prompt or generation work.
    const reachedHistory = new Error('Reached generation History read');
    const reads = [];
    const module = { exports: {} };
    vm.runInNewContext(source, {
        module,
        console: { log() {}, error() {}, warn() {} },
        require(name) {
            if (name === 'fs-extra') return {
                ...realFs,
                async readJson(file) {
                    reads.push(file);
                    if (file === historyPath) throw reachedHistory;
                    return realFs.readJson(file);
                },
            };
            if (name === 'electron') return { ipcMain: {} };
            if ([
                '../modules/modelTrajectory',
                '../modules/contextSanitizer',
                '../modules/fileManager',
                '../modules/ipc/canvasHandlers',
                '../modules/ipc/tavernHandlers',
                '../modules/tavernRulesEngine',
                './topicTitleManager',
                './jevGroupSessionOrchestrator',
            ].includes(name)) return {};
            return localRequire(name);
        },
    }, { filename });

    const group = module.exports;
    group.initializePaths(paths);
    const member = { id: 'member', name: 'Fixture member' };
    const failAtErrorEvent = event => { throw new Error(event.error); };
    const lookups = [];
    const load = async id => {
        lookups.push(id);
        assert.equal(id, member.id);
        return { name: 'Local member' };
    };
    return {
        reads,
        configPath,
        historyPath,
        reachedHistory,
        lookups,
        send: () => group.handleGroupChatMessage(
            'owned', 'topic', { id: 'user-message', content: { text: 'hello' } }, failAtErrorEvent, load),
        invite: () => group.handleInviteAgentToSpeak('owned', 'topic', member.id, failAtErrorEvent, load),
    };
}

const entries = ['send', 'invite'];

for (const [name, options] of [
    ['deleted topic', { topics: [] }],
    ['deleting owner', { deleting: true }],
    ['deleted History', { exists: false }],
]) {
    test(name + ' remains refused before generation', async t => {
        for (const entry of entries) {
            const f = fixture(t, options);
            const message = options.deleting ? '未找到群组配置: owned' : '目标群聊话题或历史已不存在';
            await assert.rejects(f[entry](), { message }, entry);
            assert.deepEqual(f.reads, [f.configPath], entry);
        }
    });
}

test('ordinary local Group preserves its original config and History membership check', async t => {
    for (const entry of entries) {
        const f = fixture(t);
        await assert.rejects(f[entry](), error => error === f.reachedHistory, entry);
        assert.deepEqual(f.reads, [f.configPath, f.historyPath], entry);
    }
});

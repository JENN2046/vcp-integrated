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

function fixture(t, { shared = true, topics = [{ id: 'topic' }], deleting = false, exists = true } = {}) {
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
        // A shared run must take its mode and members from the frozen config.
        mode: shared ? 'game' : 'sequential',
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
    const config = { mode: 'sequential', members: ['member'] };
    const member = { id: 'member', name: 'Frozen member' };
    const failAtErrorEvent = event => assert.fail(JSON.stringify(event));
    const lookups = [];
    const load = async id => {
        lookups.push(id);
        assert.equal(id, member.id);
        return { name: 'Local member' };
    };
    if (shared) {
        group.initializeRuntimeServices({
            historyMutationQueue: {
                syncPolicy: {
                    sharedExecution: {
                        runtime: {
                            nativeObject: (type, id) => type === 'group' && id === 'owned',
                            state: { objects: { member: { kind: 'agent' } } },
                            localFor: id => ({ localId: id }),
                        },
                        async prepare() {
                            return {
                                config,
                                members: [member],
                                record: {
                                    config: { rules: [], owner: { config: {} } },
                                    accepted: { id: 'turn', turn: { plan: [member.id] } },
                                },
                            };
                        },
                        mapping: () => ({}),
                        liveGroups: new Set(),
                    },
                },
            },
        });
    }

    return {
        config,
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

test('Shared frozen execution config stays unchanged while native topic membership admits the existing topic', async t => {
    for (const entry of entries) {
        const f = fixture(t);
        await assert.rejects(f[entry](), error => error === f.reachedHistory, entry);
        assert.deepEqual(f.reads, [f.configPath, f.historyPath], entry);
        assert.equal(f.config.topics, undefined, entry);
        assert.equal(f.config.mode, 'sequential', entry);
        assert.deepEqual(f.config.members, ['member'], entry);
        assert.deepEqual(f.lookups, entry === 'invite' ? ['member'] : [], entry);
    }
});

for (const [name, options] of [
    ['deleted topic', { topics: [] }],
    ['deleting owner', { deleting: true }],
    ['deleted History', { exists: false }],
]) {
    test(name + ' remains refused before generation', async t => {
        for (const entry of entries) {
            const f = fixture(t, options);
            await assert.rejects(f[entry](), { message: '目标群聊话题或历史已不存在' }, entry);
            assert.deepEqual(f.reads, [f.configPath], entry);
        }
    });
}

test('ordinary local Group preserves its original config and History membership check', async t => {
    for (const entry of entries) {
        const f = fixture(t, { shared: false });
        await assert.rejects(f[entry](), error => error === f.reachedHistory, entry);
        assert.deepEqual(f.reads, [f.configPath, f.historyPath], entry);
    }
});

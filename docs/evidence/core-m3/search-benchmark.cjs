'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { ChatDataServiceLifecycle } = require('../../../apps/desktop/modules/services/chatDataService/lifecycle');

const corpus = [
    '我在南京市长江大桥附近遇见了小周。',
    '小周喜欢长江大桥的晚霞和轮渡。',
    '研究生正在研究光学仪器与红外光谱。',
    '孩子在北京故宫参观了青铜器展。',
    '我们讨论了机器学习和自然语言处理。',
    '她研究生命起源，记录野外调查。'
];
const queries = [
    ['南京市', [0]], ['长江大桥', [0, 1]], ['红外光谱', [2]], ['青铜器', [3]],
    ['自然语言处理', [4]], ['研究生', [2]], ['生命起源', [5]]
];
const options = { ownerType: 'agent', ownerId: 'bench', limit: 50 };
const { env } = process;
const repo = path.join(__dirname, '..', '..', '..');
const binaryPath = env.M3_CDS_BINARY || path.join(repo, 'apps/desktop/modules/services/chatDataService/bin/linux-x64/vcp_chat_data_service');

async function size(directory) {
    let bytes = 0;
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
        const name = path.join(directory, item.name);
        bytes += item.isDirectory() ? await size(name) : (await fs.stat(name)).size;
    }
    return bytes;
}

async function run() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-m3-search-'));
    const owner = path.join(root, 'Agents', 'bench');
    const folder = topic => path.join(root, 'UserData', 'bench', 'topics', topic);
    await fs.mkdir(owner, { recursive: true });
    const topicIds = ['archive', 'current'];
    await fs.writeFile(path.join(owner, 'config.json'), JSON.stringify({
        id: 'bench', name: 'Synthetic', topics: topicIds.map(id => ({ id, name: id, createdAt: 1700000000000 }))
    }));
    const role = i => i % 2 ? 'assistant' : 'user';
    const history = [
        ...corpus.map((content, i) => ({ id: 'relevant_' + i, content, role: role(i), timestamp: 1700000000000 + i })),
        ...Array.from({ length: 3000 }, (_, i) => ({ id: 'noise_' + i, content: '午饭菜谱 菜市场 番茄 豆腐 食谱编号 ' + i,
            role: role(i), timestamp: 1700000000006 + i }))
    ];
    for (const topic of topicIds) {
        await fs.mkdir(folder(topic), { recursive: true });
        await fs.writeFile(path.join(folder(topic), 'history.json'), JSON.stringify(topic === 'archive' ? history : [history[0]]));
    }
    const lifecycle = new ChatDataServiceLifecycle({
        appDataPath: root, binaryPath, notifyEnabled: false, tantivyEnabled: true,
        logger: { info() {}, warn() {}, error() {} }
    });
    try {
        const before = performance.now();
        await lifecycle.start();
        const startMs = performance.now() - before;
        const client = lifecycle.client;
        for (const topic of topicIds) await client.ingestHistoryPath(path.join(folder(topic), 'history.json'));
        const rebuild = performance.now();
        await client.rebuildSearchIndex();
        const rebuildMs = performance.now() - rebuild;
        const search = async query => await client.searchMessages({ ...options, query, excludeTopicId: 'current' });
        const getIds = payload => (payload.hits || payload.results || payload).map(hit => hit.message.id || hit.message.msgId);
        const hits = [];
        for (const [query, expected] of queries) {
            const at = performance.now();
            hits.push({ query, expected, ids: getIds(await search(query)), ms: performance.now() - at });
        }
        const legacyQuery = '{长江大桥|红外光谱:2},[晚霞]';
        const legacyIds = getIds(await search(legacyQuery));
        const memories = await client.searchMemories({ ...options, query: '红外光谱', currentTopicId: 'current',
            excludeCurrentTopic: true, windowBefore: 1, windowAfter: 1, resultLimit: 2, maxChars: 1000 });
        const pid = lifecycle.process.pid;
        const memory = await fs.readFile('/proc/' + pid + '/status', 'utf8');
        const sqlite = spawnSync(env.M3_SEARCH_PYTHON || 'python', [path.join(__dirname, 'search-benchmark.py')], {
            input: JSON.stringify({ history, queries }), encoding: 'utf8'
        });
        if (sqlite.status !== 0) throw new Error(sqlite.stderr);
        return { documents: history.length, cds: { startMs, rebuildMs, hits, legacyQuery, legacyIds,
            windowCount: memories.windows.length, windowSize: memories.windows[0]?.messages.length,
            rssKiB: Number(memory.match(/VmRSS:\s+(\d+)/)?.[1]), indexBytes: await size(path.join(root, 'databases', 'chat_search_index')) },
        sqlite: JSON.parse(sqlite.stdout) };
    } finally {
        await lifecycle.stop();
        await fs.rm(root, { recursive: true, force: true });
    }
}

run().then(data => console.log(JSON.stringify(data, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });

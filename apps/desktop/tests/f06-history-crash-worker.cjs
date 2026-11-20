'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { HistoryMutationQueue } = require('../modules/services/historyMutationQueue');
const AgentConfigManager = require('../modules/utils/agentConfigManager');
const [root, crashPoint, mode, topicId = 'topic_a'] = process.argv.slice(2);
const queue = new HistoryMutationQueue({
    userDataDir: path.join(root, 'UserData'),
    commitFault(point) { if (point === crashPoint) process.exit(72); },
});
const descriptor = { itemId: 'agent_a', itemType: 'agent', topicId };
const task = (async () => {
    if (mode === 'create-config' || mode === 'delete-config') {
        // Use the same real manager persistence API that backs the native
        // handlers, then exit after the configuration transaction has released
        // its own lock, before any History initialization or physical deletion.
        // F01 separately tests exit while holding a lock and the required busy
        // result. A resolved write promise does not prove its finally finished.
        const manager = new AgentConfigManager(path.join(root, 'Agents'));
        const config = await manager.readAgentConfig('agent_a');
        const next = mode === 'create-config'
            ? { ...config, topics: [...config.topics, { id: topicId, name: 'Published before process exit' }] }
            : { ...config, topics: config.topics.filter(topic => topic.id !== topicId),
                _historyDeletedTopics: [...new Set([...(config._historyDeletedTopics || []), topicId])] };
        await manager.writeAgentConfig('agent_a', next);
        if (crashPoint === 'config-published') {
            const lock = path.join(root, 'Agents', 'agent_a', 'config.json.lock');
            const deadline = performance.now() + 2000;
            for (;;) {
                try { await fs.lstat(lock); }
                catch (error) { if (error.code === 'ENOENT') process.exit(72); throw error; }
                if (performance.now() >= deadline) throw new Error('configuration transaction did not release its lock within 2 seconds');
                // Observe metadata only. Never read a lock token, unlink a lock,
                // steal ownership, or turn an unknown/busy result into success.
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }
        throw new Error('config fault point not reached');
    }
    return mode === 'delete'
        ? queue.deleteHistory(descriptor, async () => { throw new Error('must exit before operation'); })
        : queue.initializeIfMissing(descriptor);
})();
task.then(() => { process.stderr.write('fault point not reached\n'); process.exitCode = 2; }, error => {
    process.stderr.write(`${error.code || error.name}: ${error.message}\n`); process.exitCode = 3;
});

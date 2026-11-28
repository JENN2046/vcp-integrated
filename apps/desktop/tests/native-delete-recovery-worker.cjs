'use strict';

const fs = require('node:fs/promises');
const fse = require('fs-extra');
const path = require('node:path');
const { openFixture } = require('./f06-host-fixture.cjs');

async function run() {
    const [root, stage, ownerType = 'agent', ownerId = 'agent_a', topicId = 'old_topic'] = process.argv.slice(2);
    const f = openFixture(root);
    const configPath = ownerType === 'agent' ? path.join(f.agentDir, ownerId, 'config.json')
        : path.join(root, 'AgentGroups', ownerId, 'config.json');
    const topicDir = path.dirname(f.queue.getHistoryPath(ownerId, topicId));

    function checkpoint(name) {
        const release = new Promise(resolve => process.once('message', resolve));
        process.send({ checkpoint: name });
        return release;
    }

    if (stage === 'marker-published') {
        // After the actual primary rename but before the manager releases its lock.
        const rename = fs.rename;
        fs.rename = async (...args) => {
            const result = await rename(...args);
            if (args[1] === configPath) {
                const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
                if (config._historyDeletedTopics?.includes(topicId)) await checkpoint(stage);
            }
            return result;
        };
    }

    if (stage === 'config-committed' || stage === 'partial-directory') {
        const remove = fse.remove;
        fse.remove = async file => {
            if (file === topicDir) {
                const deadline = Date.now() + 3000;
                while (await fse.pathExists(configPath + '.lock')) {
                    if (Date.now() > deadline) throw Error('config writer did not release its lock');
                    await new Promise(resolve => setTimeout(resolve, 5));
                }
                await checkpoint(stage);
            }
            return remove(file);
        };
    }

    if (stage === 'clean-before-reply') {
        const deleteHistory = f.queue.deleteHistory.bind(f.queue);
        f.queue.deleteHistory = async (...args) => {
            const result = await deleteHistory(...args);
            if (args[0].topicId === topicId) await checkpoint(stage);
            return result;
        };
    }

    const result = ownerType === 'agent' ? await f.call('delete-topic', ownerId, topicId)
        : await f.group.deleteGroupTopic(ownerId, topicId);
    await f.queue.dispose();
    process.send({ result });
}
run().then(() => process.disconnect()).catch(error => {
    process.send({ error: error.stack });
    process.exitCode = 1;
    process.disconnect();
});

// 删除辅助对话（单独关掉，或随父话题一起删）时，它的调用轨迹文件也要删掉，不能在磁盘上越积越多
import trustedSenderFixture from './helpers/trusted-main-sender.cjs';
import modelTrajectory from '../modules/modelTrajectory.js';
import sideChatHandlers from '../modules/ipc/sideChatHandlers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import historyQueue from '../modules/services/historyMutationQueue.js';

const exists = file => fs.access(file).then(() => true, () => false);

async function setup(t) {
    const taskRoot = await fs.mkdtemp(path.join(fileURLToPath(new URL('.', import.meta.url)), '.f06-sidechat-traj-'));
    const userData = path.join(taskRoot, 'UserData'); await fs.mkdir(userData);
    await fs.mkdir(path.join(taskRoot, 'Agents', 'agent_a'), { recursive: true });
    await fs.writeFile(path.join(taskRoot, 'Agents', 'agent_a', 'config.json'), JSON.stringify({ id: 'agent_a', topics: [{ id: 'topic_p' }, { id: 'topic_other' }] }));
    const queue = new historyQueue.HistoryMutationQueue({ userDataDir: userData });
    const trajectories = path.join(userData, 'ModelTrajectory');
    t.after(async () => { await queue.dispose(); await fs.rm(taskRoot, { recursive: true, force: true }); });
    const recorder = modelTrajectory.configureSharedRecorder({ rootDir: trajectories });
    const writeTrajectory = async (sessionKey) => {
        const call = recorder.begin({ sessionKey, requestId: 'r1', source: { kind: 'side-chat' }, model: 'm', params: {}, messages: [{ role: 'user', content: 'hi' }] });
        call.finish({ status: 'success', body: { choices: [{ message: { role: 'assistant', content: 'ok' } }] } });
        await recorder.list(sessionKey);
        return recorder.fileOf(sessionKey);
    };
    const makeChild = async (agentId, topicId, parentTopicId) => {
        const dir = path.join(userData, agentId, 'topics', topicId);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'history.json'), '[]');
        await fs.writeFile(path.join(dir, 'sidechat-child.json'), JSON.stringify({ schemaVersion: 1, ephemeral: true, agentId, topicId, parentTopicId }));
    };
    const handlers = new Map();
    const trusted = trustedSenderFixture.createTrustedMainSender();
    sideChatHandlers.initialize({ USER_DATA_DIR: userData, historyMutationQueue: queue, mainWindow: trusted.mainWindow, ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler() {} } });
    return { userData, queue, writeTrajectory, makeChild, invoke: (channel, ...args) => handlers.get(channel)(trusted.event, ...args) };
}

test('deleting a side chat also deletes its model trajectory file', async (t) => {
    const { writeTrajectory, makeChild, invoke } = await setup(t);
    await makeChild('agent_a', 'sidechat_1', 'topic_p');
    const childFile = await writeTrajectory('agent_a__sidechat_1');
    const parentFile = await writeTrajectory('agent_a__topic_p');
    assert.equal(await exists(childFile), true);

    const result = await invoke('side-chat:delete-child', 'agent_a', 'sidechat_1');
    assert.equal(result.success, true);
    assert.equal(await exists(childFile), false);
    assert.equal(await exists(parentFile), true, 'other conversations keep their trajectories');
});

test('side chats removed with their parent topic take their trajectory files with them', async (t) => {
    const { userData, queue, writeTrajectory, makeChild } = await setup(t);
    await makeChild('agent_a', 'sidechat_1', 'topic_p');
    await makeChild('agent_a', 'sidechat_2', 'topic_other');
    const removedFile = await writeTrajectory('agent_a__sidechat_1');
    const keptFile = await writeTrajectory('agent_a__sidechat_2');

    const removed = await sideChatHandlers.removeSideChatChildrenOfParent({ USER_DATA_DIR: userData, agentId: 'agent_a', parentTopicId: 'topic_p', historyMutationQueue: queue });
    assert.equal(removed, 1);
    assert.equal(await exists(removedFile), false);
    assert.equal(await exists(keptFile), true);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const AgentConfigManager = require('../modules/utils/agentConfigManager');
const { ownedJson } = require('../modules/services/nativeSync/sharedLocal');

async function profile(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-source-path-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const manager = new AgentConfigManager(path.join(root, 'Agents'));
    const { agentPath, configPath } = manager.getAgentPaths('synthetic');
    await fs.mkdir(agentPath, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ topics: [{ id: 'chat', unread: true }] }));
    return { root, manager, file: configPath };
}

test('shared config inspection rereads the path when native replacement unlinks the observed inode', {
    skip: process.platform === 'win32'
}, async t => {
    const { root, manager, file } = await profile(t);
    const handle = await fs.open(file);
    try {
        const lstat = fs.lstat;
        let replacement;
        t.mock.method(fs, 'lstat', async (candidate, ...args) => {
            if (candidate !== file || replacement) return lstat(candidate, ...args);
            replacement = manager.updateAgentConfig('synthetic', config => ({
                ...config, topics: config.topics.map(topic => ({ ...topic, unread: false }))
            }));
            await replacement;
            // Capture the old inode's real metadata at the lookup/rename race boundary.
            const unlinked = await handle.stat();
            assert.equal(unlinked.nlink, 0);
            return unlinked;
        });
        assert.deepEqual(await ownedJson(root, file), { topics: [{ id: 'chat', unread: false }] });
    } finally {
        await handle.close();
    }
});

test('shared config inspection rejects a real hard link, including when found on recheck', async t => {
    const { root, file } = await profile(t);
    await fs.link(file, path.join(root, 'alias.json'));
    await assert.rejects(ownedJson(root, file), { code: 'SOURCE_PATH_ALIAS' });
    const lstat = fs.lstat;
    let checks = 0;
    t.mock.method(fs, 'lstat', async (candidate, ...args) => {
        const stat = await lstat(candidate, ...args);
        if (candidate === file && ++checks === 1) stat.nlink = 0;
        return stat;
    });
    await assert.rejects(ownedJson(root, file), { code: 'SOURCE_PATH_ALIAS' });
    assert.equal(checks, 2);
});

test('shared config inspection rejects a symlink or directory occupying the config path', {
    skip: process.platform === 'win32'
}, async t => {
    const { root, file } = await profile(t);
    const original = path.join(root, 'original.json');
    await fs.rename(file, original);
    await fs.symlink(original, file);
    await assert.rejects(ownedJson(root, file), { code: 'SOURCE_PATH_ALIAS' });

    await fs.unlink(file);
    await fs.mkdir(file);
    await assert.rejects(ownedJson(root, file), { code: 'SOURCE_PATH_ALIAS' });
});

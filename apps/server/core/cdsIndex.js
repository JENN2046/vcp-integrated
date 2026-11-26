'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash, randomUUID } = require('node:crypto');
const { failure } = require('./store');

const hash = data => createHash('sha256').update(data).digest('hex');

async function writeProjection(filename, value) {
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const staging = filename + '.' + randomUUID();
    try {
        await fs.writeFile(staging, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
        await fs.rename(staging, filename);
    } finally {
        await fs.rm(staging, { force: true });
    }
}

class CoreCdsIndex {
    constructor(directory, binaryPath) {
        this.root = path.join(directory, 'cds-index-input');
        this.binaryPath = binaryPath;
        this.applied = new Map();
        this.tail = Promise.resolve();
    }

    async client() {
        if (!this.binaryPath) throw failure('CORE_CDS_UNAVAILABLE', 503);
        if (!this.lifecycle) {
            const desktop = path.resolve(path.dirname(require.resolve('@vcp/native-history-window')), '../../..');
            const { ChatDataServiceLifecycle } = await import(pathToFileURL(path.join(desktop,
                'modules/services/chatDataService/lifecycle.js')).href);
            this.lifecycle = new ChatDataServiceLifecycle({
                appDataPath: this.root, binaryPath: this.binaryPath, notifyEnabled: false, tantivyEnabled: true
            });
        }
        await this.lifecycle.start();
        if (!this.lifecycle.client) throw failure('CORE_CDS_UNAVAILABLE', 503);
        return this.lifecycle.client;
    }

    search(topic, rows, request) {
        if (this.closing) throw failure('HOST_DRAINING', 503);
        const task = this.tail.then(async () => {
            const client = await this.client();
            const owner = topic.ownerId;
            const ownerDir = topic.ownerType === 'agent' ? 'Agents' : 'AgentGroups';
            const current = hash(JSON.stringify(rows));
            if (this.applied.get(owner) !== current) {
                // CDS expects native input files. This separate root contains
                // disposable search inputs, never desktop History or Core storage.
                const configPath = path.join(this.root, ownerDir, owner, 'config.json');
                await writeProjection(configPath, { id: owner, name: owner, topics: rows.map(({ id, name }) => ({ id, name })) });
                for (const { id, messages } of rows) {
                    await writeProjection(path.join(this.root, 'UserData', owner, 'topics', id, 'history.json'), messages);
                }
                const directory = path.join(this.root, 'UserData', owner, 'topics');
                const active = new Set(rows.map(row => row.id));
                for (const item of await fs.readdir(directory, { withFileTypes: true }).catch(error => {
                    if (error.code === 'ENOENT') return [];
                    throw error;
                })) {
                    if (item.isDirectory() && !active.has(item.name)) await fs.rm(path.join(directory, item.name), { recursive: true });
                }
                await client.reconcile({ timeoutMs: 300000 });
                this.applied.set(owner, current);
            }
            return client.searchMemories({ ...request, ownerType: topic.ownerType, ownerId: owner, currentTopicId: topic.key });
        });
        this.tail = task.catch(() => {});
        return task;
    }

    async close() {
        this.closing = true;
        await this.tail;
        await this.lifecycle?.stop();
    }
}

module.exports = { CoreCdsIndex };

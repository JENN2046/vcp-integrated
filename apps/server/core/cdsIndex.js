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

    search(topic, readTopics, request) {
        if (this.closing) throw failure('HOST_DRAINING', 503);
        const task = this.tail.then(async () => {
            const client = await this.client();
            if (this.indexedBy !== client) {
                this.applied.clear();
                this.indexedBy = client;
            }
            const owner = topic.ownerId;
            const ownerDir = topic.ownerType === 'agent' ? 'Agents' : 'AgentGroups';
            const configPath = path.join(this.root, ownerDir, owner, 'config.json');
            const directory = path.join(this.root, 'UserData', owner, 'topics');
            const rows = readTopics();
            const topics = rows.map(({ id, name }) => ({ id, name }));
            const config = hash(JSON.stringify(topics));
            const previous = this.applied.get(owner);
            const changed = rows.filter(row => previous?.ownerType !== topic.ownerType || previous.sequences.get(row.id) !== row.sequence);
            const layoutChanged = previous?.ownerType !== topic.ownerType || previous.config !== config;
            if (changed.length || layoutChanged) {
                // Read all affected topics before yielding to filesystem work. Their sequences
                // and messages come from the same synchronous pass over Core's authority.
                const histories = changed.map(row => ({ id: row.id, messages: row.readMessages() }));
                try {
                    if (layoutChanged) await writeProjection(configPath, { id: owner, name: owner, topics });
                    for (const { id, messages } of histories) {
                        const filename = path.join(directory, id, 'history.json');
                        await writeProjection(filename, messages);
                        if (!layoutChanged) {
                            const result = await client.ingestHistoryPath(filename, 'core', { timeoutMs: 300000 });
                            if (!result.accepted) throw failure('CORE_CDS_INGEST_INCOMPLETE', 503);
                        }
                    }
                    if (layoutChanged) {
                        const active = new Set(topics.map(row => row.id));
                        const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
                            if (error.code === 'ENOENT') return [];
                            throw error;
                        });
                        for (const item of entries) {
                            if (item.isDirectory() && !active.has(item.name)) await fs.rm(path.join(directory, item.name), { recursive: true });
                        }
                        await client.reconcile({ timeoutMs: 300000 });
                    }
                    this.applied.set(owner, { ownerType: topic.ownerType, config, sequences: new Map(rows.map(row => [row.id, row.sequence])) });
                } catch (error) {
                    // Retry from the current authoritative snapshot after any partial ingest.
                    this.applied.delete(owner);
                    throw error;
                }
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

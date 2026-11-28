// modules/utils/agentConfigManager.js
const fs = require('fs-extra');
const path = require('path');
const { protectHistoryConfiguration } = require('./historyConfiguration');
const { EventEmitter } = require('events');
const { randomUUID } = require('node:crypto');
const { replaceFile } = require('./atomicReplace');

class AgentConfigManager extends EventEmitter {
    // Explicit no-write result for a decision made under the current configuration lock.
    static KEEP_CURRENT = Symbol('keep-current-agent-config');

    static validateId(agentId) {
        if (typeof agentId !== 'string' || !agentId || agentId === '.' || agentId === '..'
            || agentId.includes('\0') || agentId !== path.basename(agentId)
            || (process.platform === 'win32' && (/[<>:"/\\|?*\x00-\x1f]/.test(agentId)
                || /[. ]$/.test(agentId) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(agentId)))) {
            throw Object.assign(new Error('INVALID_AGENT_ID'), { code: 'INVALID_AGENT_ID' });
        }
        return agentId;
    }

    constructor(agentDir) {
        super();
        this.agentDir = agentDir;
        this.queues = new Map(); // 每个agent一个队列
        this.processing = new Map(); // 每个agent的处理状态
        this.locks = new Map(); // Only tokens actually acquired by this manager.
        this.caches = new Map(); // 每个agent的缓存
        this.cacheTimestamps = new Map(); // 每个agent的缓存时间戳
    }

    normalizeId(agentId) {
        AgentConfigManager.validateId(agentId);
        // 在 Linux 等大小写敏感的系统上，必须保持原始大小写以匹配目录名。
        // 在 Windows 上，原本强制转小写是为了避免同一目录因大小写差异产生多个锁/缓存。
        // 为了兼容多系统，我们仅在 Windows 系统上保持强制转换。
        if (process.platform === 'win32') {
            return agentId.toLowerCase();
        }
        return agentId;
    }

    getAgentPaths(agentId) {
        const id = this.normalizeId(agentId);
        const agentPath = path.join(this.agentDir, id);
        const configPath = path.join(agentPath, 'config.json');
        const lockFile = configPath + '.lock';
        return { agentPath, configPath, lockFile };
    }

    async acquireLock(agentId, timeout = 5000) {
        const id = this.normalizeId(agentId);
        const { lockFile } = this.getAgentPaths(id);
        if (!Number.isFinite(timeout) || timeout < 0) throw new TypeError('Invalid Agent lock timeout');
        const startTime = Date.now();
        const token = `${process.pid}-${Date.now()}-${randomUUID()}`;
        for (;;) {
            try {
                await fs.writeFile(lockFile, token, { flag: 'wx', encoding: 'utf8' });
                this.locks.set(id, token);
                return token;
            } catch (error) {
                if (error.code !== 'EEXIST') throw error;
                // Age, a dead PID, or a malformed record cannot authorize a
                // check-then-unlink of a path that may already have a new owner.
                // Preserve legacy/abandoned locks for explicit offline recovery.
                if (Date.now() - startTime >= timeout) {
                    throw Object.assign(new Error('Agent configuration lock is busy'), { code: 'AGENT_CONFIG_LOCK_BUSY' });
                }
                await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, timeout - (Date.now() - startTime)))));
            }
        }
    }

    async releaseLock(agentId, token) {
        const id = this.normalizeId(agentId);
        if (!token || this.locks.get(id) !== token) return;
        // Consume ownership before the first await. Two concurrent releases
        // must never both pass the read check and unlink a later owner's lock.
        this.locks.delete(id);
        const { lockFile } = this.getAgentPaths(id);
        let current;
        try { current = await fs.readFile(lockFile, 'utf8'); }
        catch (error) {
            if (error.code !== 'ENOENT') console.warn('[AgentConfigManager] Lock release deferred:', error.code || 'LOCK_IO_ERROR');
            return;
        }
        if (current === token) {
            try { await fs.remove(lockFile); }
            catch (error) { console.warn('[AgentConfigManager] Lock release deferred:', error.code || 'LOCK_IO_ERROR'); }
        }
    }

    async readAgentConfig(agentId, { allowDefault = false, retryCount = 0 } = {}) {
        const id = this.normalizeId(agentId);
        const { configPath } = this.getAgentPaths(id);

        try {
            // 使用缓存机制减少文件读取
            const stats = await fs.stat(configPath).catch(() => null);
            const cacheKey = id;
            const cachedConfig = this.caches.get(cacheKey);
            const cacheTimestamp = this.cacheTimestamps.get(cacheKey) || 0;

            if (stats && cachedConfig && stats.mtimeMs <= cacheTimestamp) {
                return { ...cachedConfig };
            }

            const content = await fs.readFile(configPath, 'utf8');
            if (!content.trim()) {
                throw new Error('CONFIG_EMPTY');
            }
            const config = JSON.parse(content);

            // 更新缓存
            this.caches.set(cacheKey, config);
            this.cacheTimestamps.set(cacheKey, stats ? stats.mtimeMs : Date.now());

            return { ...config };
        } catch (error) {
            const isTransient = error.code === 'ENOENT' || error instanceof SyntaxError || error.message === 'CONFIG_EMPTY';
            if (isTransient && retryCount < 3) {
                // 文件可能正处于原子性替换（fs.move）或 非原子写入（fs.writeFile）过程中的瞬间
                const retryDelays = [100, 200, 500];
                const delay = retryDelays[retryCount];
                
                await new Promise(resolve => setTimeout(resolve, delay));
                console.warn(`Agent ${id} config read failed (${error.message || error.code}), retrying (${retryCount + 1}/3)...`);
                return await this.readAgentConfig(id, { allowDefault, retryCount: retryCount + 1 });
            }

            // 如果读取失败，按优先级尝试恢复：缓存 > 备份 > 默认配置（如果允许）
            const cachedConfig = this.caches.get(id);

            // 1. 尝试从缓存恢复
            if (cachedConfig) {
                console.warn(`Agent ${id} config read failed, using cached data`);
                return { ...cachedConfig };
            }

            // 2. 尝试从备份恢复
            const backupPath = configPath + '.backup';
            if (await fs.pathExists(backupPath)) {
                try {
                    const backupContent = await fs.readFile(backupPath, 'utf8');
                    const backupConfig = JSON.parse(backupContent);

                    // 只要备份有效且看起来不是完全空的（ID匹配即可视为有效）
                    if (backupConfig && (backupConfig.id === id || backupConfig.name)) {
                        console.log(`Recovered agent ${id} config from backup`);
                        // 恢复后存入缓存
                        this.caches.set(id, backupConfig);
                        return { ...backupConfig };
                    }
                } catch (backupError) {
                    console.error(`Agent ${id} backup recovery failed:`, backupError);
                }
            }

            // 3. 仅在缺失文件且允许时返回默认配置
            if (error.code === 'ENOENT' && allowDefault) {
                const defaultConfig = {
                    name: id,
                    systemPrompt: `你是 ${id}。`,
                    model: 'gemini-2.0-flash-exp',
                    temperature: 0.7,
                    contextTokenLimit: 1000000,
                    maxOutputTokens: 60000,
                    topics: [{ id: "default", name: "主要对话", createdAt: Date.now() }]
                };
                console.warn(`Agent ${id} config not found, returning default config (allowDefault=true)`);
                return { ...defaultConfig };
            }

            // 4. 全部失败，抛出错误
            const errorMessage = error.code === 'ENOENT' 
                ? `Agent config for ${id} not found and no cache/backup available`
                : `Agent config for ${id} corrupted and recovery failed: ${error.message}`;
            
            console.error(`[AgentConfigManager] ${errorMessage}`);
            throw new Error(errorMessage);
        }
    }

    async writeAgentConfig(agentId, config) {
        // Direct writes use the same owner as read-modify-write updates. The
        // queued snapshot cannot be changed by the caller while it is waiting.
        const snapshot = JSON.parse(JSON.stringify(config));
        return this.enqueue(agentId, { config: snapshot, direct: true, admission: () => require('../services/historyAuthority').assertConfigurationAdmission(this.getAgentPaths(this.normalizeId(agentId)).configPath, snapshot) });
    }

    async writeAgentConfigLocked(agentId, config, token) {
        const id = this.normalizeId(agentId);
        if (!token || this.locks.get(id) !== token) throw new Error('AGENT_CONFIG_LOCK_OWNER_REQUIRED');
        const { configPath } = this.getAgentPaths(id);
        config = await protectHistoryConfiguration(configPath, config);
        const serialized = JSON.stringify(config, null, 2);
        const persisted = JSON.parse(serialized);
        let previous, previousMode;
        try { previous = await fs.readFile(configPath); previousMode = (await fs.stat(configPath)).mode & 0o777; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        // Preserve the exact previous bytes as the backup. Both replacements
        // leave their original target intact if rename fails.
        if (previous !== undefined) await replaceFile(configPath + '.backup', previous, { mode: previousMode });
        await replaceFile(configPath, serialized, { mode: previousMode });
        const stats = await fs.stat(configPath).catch(() => null);
        this.caches.set(id, { ...persisted });
        this.cacheTimestamps.set(id, stats ? stats.mtimeMs : Date.now());
        this.emit('agent-config-updated', id, persisted);
        return persisted;
    }

    async updateAgentConfig(agentId, updater) {
        const authority = require('../services/historyAuthority').authorityForConfig(this.getAgentPaths(this.normalizeId(agentId)).configPath);
        if (authority && !authority.inChange) return authority.withChange(() => this.updateAgentConfig(agentId, updater));
        return this.enqueue(agentId, { updater });
    }

    enqueue(agentId, operation) {
        const id = this.normalizeId(agentId);
        return new Promise((resolve, reject) => {
            if (!this.queues.has(id)) this.queues.set(id, []);
            this.queues.get(id).push({ ...operation, resolve, reject });
            this.processQueue(id);
        });
    }

    async processQueue(agentId) {
        const queue = this.queues.get(agentId);
        if (!queue || this.processing.get(agentId) || queue.length === 0) return;
        this.processing.set(agentId, true);
        const { updater, config, direct, admission, resolve, reject } = queue.shift();
        let token;
        try {
            await admission?.();
            await fs.ensureDir(this.getAgentPaths(agentId).agentPath);
            token = await this.acquireLock(agentId);
            // A mutation must use current protected disk bytes, not a stale
            // manager cache or a fallback backup after a corrupt primary read.
            const current = direct ? null : await fs.readJson(this.getAgentPaths(agentId).configPath);
            const next = direct ? config : typeof updater === 'function'
                ? await updater(current) : { ...current, ...updater };
            const persisted = !direct && next === AgentConfigManager.KEEP_CURRENT
                ? current : await this.writeAgentConfigLocked(agentId, next, token);
            resolve(direct ? true : { success: true, config: persisted });
        } catch (error) {
            reject(error);
        } finally {
            await this.releaseLock(agentId, token);
            this.processing.set(agentId, false);
            if (queue.length > 0) setImmediate(() => this.processQueue(agentId));
        }
    }

    startCleanupTimer() {
        // Retain the native caller API. No periodic actor may delete a lock
        // based on age/PID; owned locks are released by their exact token above.
        // Dead/unknown legacy locks fail busy and require explicit offline review.
    }

    // 清理指定agent的缓存
    clearCache(agentId) {
        const id = this.normalizeId(agentId);
        this.caches.delete(id);
        this.cacheTimestamps.delete(id);
    }

    // 清理所有缓存
    clearAllCaches() {
        this.caches.clear();
        this.cacheTimestamps.clear();
    }
}

module.exports = AgentConfigManager;
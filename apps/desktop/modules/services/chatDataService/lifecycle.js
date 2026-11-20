'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const readline = require('readline');
const EventEmitter = require('events');
const { verifyAuthorityBinary, AuthorityControl } = require('./authorityControl');

const { ChatDataServiceClient, ChatDataServiceError } = require('./client');

const PROTOCOL_VERSION = 3;
const SCHEMA_VERSION = 3;

class ChatDataServiceLifecycle extends EventEmitter {
    constructor(options = {}) {
        super();
        this.appDataPath = options.appDataPath;
        this.authorityManifestPath = options.authorityManifestPath;
        this.onAuthorityReady = options.onAuthorityReady;
        this.onAuthorityFault = options.onAuthorityFault || (() => {});
        this.authorityControl = null;
        this.binaryPath = options.binaryPath || resolveDefaultBinaryPath();
        this.enabled = options.enabled !== false;
        this.notifyEnabled = options.notifyEnabled !== false;
        this.tantivyEnabled = options.tantivyEnabled !== false;
        this.startupTimeoutMs = options.startupTimeoutMs || 30_000;
        this.maxRestarts = options.maxRestarts || 5;
        this.logger = options.logger || console;

        this.process = null;
        this.client = null;
        this.handshake = null;
        this.startPromise = null;
        this.stopPromise = null;
        this.restartTimer = null;
        this.stabilityTimer = null;
        this.restartAttempts = 0;
        this.stopping = false;
        this.circuitOpen = false;
        // 最近一次 start() 的失败原因；用于区分瞬态故障（重启有意义）与
        // 确定性失败（retryable=false，如版本不匹配——重启必然复现）。
        this.lastStartError = null;
    }

    get isReady() {
        return Boolean(this.client && this.process && !this.process.killed);
    }

    async start() {
        if (!this.enabled) return null;
        if (this.client) return this.client;
        if (this.startPromise) return this.startPromise;
        if (this.circuitOpen) {
            const error = new ChatDataServiceError('VCP-CDS restart circuit is open.', {
                code: 'CIRCUIT_OPEN',
                retryable: false
            });
            if (!this.lastStartError) this.lastStartError = error;
            throw error;
        }
        if (!this.appDataPath) {
            const error = new ChatDataServiceError('Missing AppData path for VCP-CDS.', {
                code: 'INVALID_CONFIGURATION'
            });
            this.lastStartError = error;
            throw error;
        }
        if (!fs.existsSync(this.binaryPath)) {
            const error = new ChatDataServiceError(
                `VCP-CDS binary was not found at ${this.binaryPath}.`,
                { code: 'BINARY_NOT_FOUND', retryable: false }
            );
            this.lastStartError = error;
            throw error;
        }

        await verifyAuthorityBinary(this.binaryPath, this.authorityManifestPath);
        // stop() can complete while verification awaits, before a child exists.
        // Never create a new writer after the host has already stopped CDS.
        if (!this.enabled || this.stopping) return null;
        if (this.process) throw new ChatDataServiceError('Previous CDS exit is unconfirmed.', { code: 'HISTORY_AUTHORITY_OLD_CHILD_PENDING', retryable: false });
        this.stopping = false;
        this.startPromise = this._spawnAndWaitForReady();
        const child = this.process;
        const stillStarting = () => this.enabled && !this.stopping && child && this.process === child && !child.killed;
        try {
            const client = await this.startPromise;
            if (!stillStarting()) return null;
            this.client = client;
            await this.onAuthorityReady?.(this);
            if (!stillStarting()) return null;
            this.lastStartError = null;
            this._scheduleStabilityReset();
            this.emit('ready', this.handshake);
            return this.client;
        } catch (error) {
            this.lastStartError = error;
            throw error;
        } finally {
            this.startPromise = null;
        }
    }

    async _spawnAndWaitForReady() {
        return new Promise((resolve, reject) => {
            let settled = false;
            let handshakeReceived = false;
            const args = [
                '--app-data', this.appDataPath,
                '--port', '0',
                '--notify-enabled', String(this.notifyEnabled),
                '--tantivy-enabled', String(this.tantivyEnabled)
            ];

            const child = spawn(this.binaryPath, args, {
                cwd: path.dirname(this.binaryPath),
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            this.process = child;

            const timeout = setTimeout(() => {
                if (settled) return;
                settled = true;
                child.kill();
                reject(new ChatDataServiceError('VCP-CDS startup timed out.', {
                    code: 'STARTUP_TIMEOUT',
                    retryable: true
                }));
            }, this.startupTimeoutMs);

            const stdout = readline.createInterface({ input: child.stdout });
            stdout.on('line', async line => {
                if (!line.trim()) return;
                if (this.authorityControl?.receive(line)) return;
                if (handshakeReceived || settled) return;
                let handshake;
                try {
                    handshake = JSON.parse(line);
                } catch (error) {
                    settled = true;
                    clearTimeout(timeout);
                    child.kill();
                    reject(new ChatDataServiceError('VCP-CDS emitted an invalid handshake.', {
                        code: 'INVALID_HANDSHAKE',
                        retryable: true,
                        cause: error
                    }));
                    return;
                }

                try {
                    validateHandshake(handshake);
                    this.authorityControl = new AuthorityControl(child, handshake, this.onAuthorityFault);
                    const client = new ChatDataServiceClient({
                        port: handshake.port,
                        authToken: handshake.authToken,
                        protocolVersion: PROTOCOL_VERSION
                    });
                    await client.health();
                    handshakeReceived = true;
                    this.handshake = handshake;
                    if (!settled) {
                        settled = true;
                        clearTimeout(timeout);
                        resolve(client);
                    }
                } catch (error) {
                    if (!settled) {
                        settled = true;
                        clearTimeout(timeout);
                        child.kill();
                        reject(error);
                    }
                }
            });

            child.stderr.on('data', data => {
                const line = data.toString().trim();
                if (line) this.logger.info?.(`[VCP-CDS] ${line}`);
            });

            child.once('error', error => {
                clearTimeout(timeout);
                if (!settled) {
                    settled = true;
                    reject(new ChatDataServiceError('Failed to launch VCP-CDS.', {
                        code: 'SPAWN_FAILED',
                        retryable: true,
                        cause: error
                    }));
                }
            });

            child.stdin.on('error', () => this.authorityControl?.disconnect());
            child.once('exit', (code, signal) => {
                this.authorityControl?.disconnect();
                this.authorityControl = null;
                clearTimeout(timeout);
                if (this.stabilityTimer) {
                    clearTimeout(this.stabilityTimer);
                    this.stabilityTimer = null;
                }
                stdout.close();
                const wasReady = handshakeReceived;
                this.process = null;
                this.client = null;
                this.handshake = null;

                if (!settled) {
                    settled = true;
                    reject(new ChatDataServiceError(
                        `VCP-CDS exited before ready (code=${code}, signal=${signal}).`,
                        { code: 'EARLY_EXIT', retryable: true }
                    ));
                }

                this.emit('exit', { code, signal, wasReady, stopping: this.stopping });
                if (!this.stopping && this.enabled) {
                    // 确定性失败（retryable=false：版本/schema 不匹配、二进制缺失、
                    // 配置错误）重启必然复现——直接熔断并给出可操作指引，
                    // 不再杀-起循环 maxRestarts 次。
                    if (this._blockNonRetryableRestart(this.lastStartError)) return;
                    this._scheduleRestart();
                }
            });
        });
    }

    _scheduleStabilityReset() {
        if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
        this.stabilityTimer = setTimeout(() => {
            this.stabilityTimer = null;
            if (this.isReady) {
                this.restartAttempts = 0;
            }
        }, 60_000);
    }

    _blockNonRetryableRestart(error) {
        if (!error || error.retryable !== false) return false;
        this.circuitOpen = true;
        const code = error.code || 'UNKNOWN';
        const hint = code === 'PROTOCOL_MISMATCH' || code === 'SCHEMA_MISMATCH'
            ? 'CDS 二进制与插件协议版本不匹配——请重建（cargo build --release）并替换 bin 目录内的 CDS 可执行文件。'
            : '请修复上述启动错误后重启应用。';
        this.logger.error?.(`[VCP-CDS] 启动失败且不可重试（${code}），本会话不再自动重启。${hint}`);
        this.emit('circuit-open', { attempts: this.restartAttempts, reason: code });
        return true;
    }

    _scheduleRestart() {
        if (this.restartTimer || this.circuitOpen) return;
        this.restartAttempts += 1;
        if (this.restartAttempts > this.maxRestarts) {
            this.circuitOpen = true;
            this.emit('circuit-open', { attempts: this.restartAttempts - 1 });
            this.logger.error?.('[VCP-CDS] Restart limit reached; shadow service disabled for this session.');
            return;
        }

        const delayMs = Math.min(30_000, 1000 * (2 ** (this.restartAttempts - 1)));
        this.emit('restart-scheduled', { attempt: this.restartAttempts, delayMs });
        this.restartTimer = setTimeout(async () => {
            this.restartTimer = null;
            try {
                await this.start();
            } catch (error) {
                this.logger.error?.('[VCP-CDS] Restart failed:', error);
                // start() 在 spawn 之前抛出的确定性失败（如 BINARY_NOT_FOUND）
                // 没有进程、不会触发 exit 事件，必须在这里同样熔断。
                if (this._blockNonRetryableRestart(error)) return;
                this._scheduleRestart();
            }
        }, delayMs);
    }

    async stop() {
        this.stopping = true;
        this.enabled = false;
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        if (this.stabilityTimer) {
            clearTimeout(this.stabilityTimer);
            this.stabilityTimer = null;
        }
        if (this.stopPromise) return this.stopPromise;

        this.stopPromise = (async () => {
            const child = this.process;
            if (!child) return;

            if (this.client) {
                try {
                    await this.client.shutdown();
                } catch (error) {
                    this.logger.warn?.('[VCP-CDS] Graceful shutdown request failed:', error.message);
                }
            }

            child.stdin.end();
            await Promise.race([
                new Promise(resolve => child.once('exit', resolve)),
                new Promise(resolve => setTimeout(resolve, 3500))
            ]);

            if (this.process === child && !child.killed) {
                child.kill();
            }
            if (this.process === child) {
                await Promise.race([
                    new Promise(resolve => child.once('exit', resolve)),
                    new Promise((_, reject) => setTimeout(() => reject(new ChatDataServiceError('CDS exit remains unconfirmed.', { code: 'HISTORY_AUTHORITY_OLD_CHILD_PENDING' })), 3500))
                ]);
            }
        })();

        try {
            await this.stopPromise;
        } finally {
            this.stopPromise = null;
        }
    }

    prepareHistoryAdmission(descriptor) {
        if (!this.authorityControl) throw new ChatDataServiceError('CDS authority unavailable.', { code: 'HISTORY_AUTHORITY_PENDING' });
        return this.authorityControl.prepare(descriptor);
    }
    activateHistoryAdmission(descriptor) {
        if (!this.authorityControl) throw new ChatDataServiceError('CDS authority unavailable.', { code: 'HISTORY_AUTHORITY_PENDING' });
        return this.authorityControl.activate(descriptor);
    }
    inspectHistoryAdmission() { return this.authorityControl?.inspect(); }
    resetCircuit() {
        this.circuitOpen = false;
        this.restartAttempts = 0;
        this.enabled = true;
    }
}


// For a disabled CDS, only this trusted host path may attest the absence of a
// previous guarded writer. The app's single-instance lock must already be held.
async function verifyStoppedHistoryAuthority({ appDataPath, binaryPath = resolveDefaultBinaryPath(), authorityManifestPath }) {
    await verifyAuthorityBinary(binaryPath, authorityManifestPath);
    const root = path.resolve(appDataPath);
    if (await fs.promises.realpath(root) !== root) throw new ChatDataServiceError('History root alias.', { code: 'HISTORY_AUTHORITY_PENDING' });
    // Rust canonicalize returns the extended-length spelling on Windows.
    // Compare the exact canonical spelling; keep the alias and identity gates.
    const identityPath = process.platform === 'win32' ? path.toNamespacedPath(root) : root;
    const lock = path.join(root, 'databases', 'chat_data_service.lock');
    try {
        const directory = await fs.promises.lstat(path.dirname(lock));
        if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('unsafe lock directory');
        const stat = await fs.promises.lstat(lock);
        if (!directory.isDirectory() || directory.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('unsafe lock');
    } catch (error) {
        // Guarded CDS obtains this never-deleted lock before reading the parent
        // pipe or accepting any grant. No lock therefore means no prior guard.
        if (error.code === 'ENOENT') return { noPriorGuard: true };
        throw new ChatDataServiceError('CDS ownership is unverified.', { code: 'HISTORY_AUTHORITY_PENDING' });
    }
    return new Promise((resolve, reject) => {
        const child = spawn(binaryPath, ['--app-data', root, '--history-authority-probe'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        let output = '', expired = false;
        const timer = setTimeout(() => { expired = true; child.kill(); }, 10000);
        child.stdout.on('data', b => { output += b; if (output.length > 16384) { expired = true; child.kill(); } });
        child.once('error', () => { clearTimeout(timer); reject(new ChatDataServiceError('CDS ownership probe failed.', { code: 'HISTORY_AUTHORITY_PENDING' })); });
        child.once('exit', code => {
            clearTimeout(timer);
            let proof; try { proof = JSON.parse(output); } catch {}
            if (expired || code !== 0 || proof?.type !== 'historyAuthorityProbe' || proof.authorityProtocol !== 1 || proof.settled !== true || proof.rootIdentity?.realpath !== identityPath) {
                reject(new ChatDataServiceError('Previous CDS remains unverified.', { code: 'HISTORY_AUTHORITY_PENDING' }));
            } else resolve(proof);
        });
    });
}

function validateHandshake(handshake) {
    if (!handshake || handshake.type !== 'ready') {
        throw new ChatDataServiceError('Unexpected VCP-CDS handshake type.', {
            code: 'INVALID_HANDSHAKE'
        });
    }
    if (handshake.protocolVersion !== PROTOCOL_VERSION) {
        throw new ChatDataServiceError(
            `VCP-CDS protocol mismatch: expected ${PROTOCOL_VERSION}, received ${handshake.protocolVersion}.`,
            { code: 'PROTOCOL_MISMATCH', retryable: false }
        );
    }
    if (handshake.schemaVersion !== SCHEMA_VERSION) {
        throw new ChatDataServiceError(
            `VCP-CDS schema mismatch: expected ${SCHEMA_VERSION}, received ${handshake.schemaVersion}.`,
            { code: 'SCHEMA_MISMATCH', retryable: false }
        );
    }
    if (!Number.isInteger(handshake.port) || !handshake.authToken || !handshake.instanceId) {
        throw new ChatDataServiceError('VCP-CDS handshake is incomplete.', {
            code: 'INVALID_HANDSHAKE'
        });
    }
}

function resolveRuntimeTarget(platform = process.platform, architecture = process.arch) {
    const supportedPlatforms = new Set(['win32', 'darwin', 'linux']);
    const supportedArchitectures = new Set(['x64', 'arm64']);
    if (!supportedPlatforms.has(platform)) {
        throw new ChatDataServiceError(
            `VCP-CDS does not provide a runtime for platform '${platform}'.`,
            { code: 'UNSUPPORTED_PLATFORM', retryable: false }
        );
    }
    if (!supportedArchitectures.has(architecture)) {
        throw new ChatDataServiceError(
            `VCP-CDS does not provide a runtime for architecture '${architecture}'.`,
            { code: 'UNSUPPORTED_ARCHITECTURE', retryable: false }
        );
    }

    return {
        directoryName: `${platform}-${architecture}`,
        binaryName: platform === 'win32'
            ? 'vcp_chat_data_service.exe'
            : 'vcp_chat_data_service'
    };
}

function resolveDefaultBinaryPath(platform = process.platform, architecture = process.arch) {
    const target = resolveRuntimeTarget(platform, architecture);
    const relativeParts = [
        'modules',
        'services',
        'chatDataService',
        'bin',
        target.directoryName,
        target.binaryName
    ];

    const asarMarker = `${path.sep}app.asar${path.sep}`;
    const markerIndex = __dirname.indexOf(asarMarker);
    if (markerIndex !== -1) {
        const resourcesPath = __dirname.slice(0, markerIndex);
        return path.join(resourcesPath, 'app.asar.unpacked', ...relativeParts);
    }

    return path.join(__dirname, 'bin', target.directoryName, target.binaryName);
}

module.exports = {
    verifyStoppedHistoryAuthority,
    ChatDataServiceLifecycle,
    PROTOCOL_VERSION,
    SCHEMA_VERSION,
    validateHandshake,
    resolveRuntimeTarget,
    resolveDefaultBinaryPath
};

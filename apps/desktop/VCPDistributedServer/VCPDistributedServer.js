const quitAdmission = require('../modules/services/quitAdmission.cjs');
// VCPDistributedServer.js
const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const dotenv = require('dotenv');
const os = require('os');
const { isIP } = require('node:net');
const mime = require('mime-types');
const chokidar = require('chokidar');
 // const { ipcMain } = require('electron'); // This was incorrect. ipcMain should be injected.
 const pluginManager = require('./Plugin.js');
const GENERATED_LISTS_CONFIG_PATH = path.join(__dirname, '..', 'AppData', 'generated_lists', 'config.env');
const MUSIC_PLAYLIST_FILE_PATH = path.join(__dirname, '..', 'AppData', 'songlist.json');

// Routing label within the existing authenticated VCP connection, not a credential.
function validateNodeId(value) {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
        const error = new Error('DIST_NODE_ID_INVALID');
        error.code = 'DIST_NODE_ID_INVALID';
        throw error;
    }
    return value;
}

// DEBUG_MODE is now passed in config
// const DEBUG_MODE = (process.env.DebugMode || "False").toLowerCase() === "true";

function loadGeneratedListsConfig() {
    try {
        if (!fsSync.existsSync(GENERATED_LISTS_CONFIG_PATH)) {
            return {};
        }
        return dotenv.parse(fsSync.readFileSync(GENERATED_LISTS_CONFIG_PATH));
    } catch (error) {
        console.error('[DistributedServer] Failed to read generated_lists/config.env:', error.message);
        return {};
    }
}

function getRequestRemoteAddress(req) {
    return req.socket?.remoteAddress || req.ip || '';
}

function isLoopbackAddress(address) {
    if (!address) return false;

    const normalized = String(address).trim().toLowerCase();
    return normalized === '127.0.0.1'
        || normalized === '::1'
        || normalized === '::ffff:127.0.0.1';
}

// Private observation only. No observer exists until a registered task installs one.
// Pending receiver facts carry no authority and become queryable only after Native
// verifies the signed Crown payload and its exact registered grant.
function createCrownEvidenceService() {
    const crypto = require('node:crypto');
    const canonical = value => {
        if (value === null || typeof value !== 'object') return JSON.stringify(value);
        if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
        return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    };
    const hash = value => crypto.createHash('sha256').update(value).digest('hex');
    const hex = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
    const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
    const exactKeys = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) &&
        Object.keys(v).sort().join(',') === keys.slice().sort().join(',');
    const queryCheck = q => exactKeys(q,['request_id','payload_sha256','request_sha256','target_sha256','native_epoch']) &&
        uuid(q.request_id) && uuid(q.native_epoch) && ['payload_sha256','request_sha256','target_sha256'].every(k => hex(q[k]));
    const freeze = v => JSON.parse(JSON.stringify(v));
    let observer = null;
    const managerSourceSha = (() => { try { return hash(fsSync.readFileSync(require.resolve('./Plugin.js'))); } catch { return null; } })();
    function installCrownEvidenceObserver(options = {}) {
        const {enabled = false,task_sha256,bootstrap_id,identity,native_epoch,expires_at,now = Date.now,max_entries = 4096} = options;
        if (enabled !== true) return Object.freeze({attestCall:()=>false,evidence:()=>{throw Error('EVIDENCE_UNAVAILABLE');},revoke(){}});
        if (!hex(task_sha256) || !uuid(bootstrap_id) || !uuid(native_epoch) || !identity ||
            typeof now !== 'function' || !Number.isSafeInteger(expires_at) || expires_at <= now() ||
            !Number.isSafeInteger(max_entries) || max_entries < 1 || max_entries > 4096) throw Error('EVIDENCE_UNAVAILABLE');
        if (observer) observer.revoke();
        const pending = new Map(), records = new Map(), rpcRecords = new Map();
        let revoked = false, sequence = 0, failed = false;
        const valid = () => !revoked && observer === internal && Number.isSafeInteger(now()) && now() < expires_at;
        const fail = () => { failed = true; };
        const event = (boundary,source,kind,phase,rpc_id,frame_sha256,at) => {
            const metadata = {event_id:crypto.randomUUID(),boundary,source,kind,phase,sequence:++sequence,observed_at:at ?? now()};
            if (rpc_id !== undefined) metadata.rpc_id = rpc_id;
            if (frame_sha256 !== undefined) metadata.frame_sha256 = frame_sha256;
            return {...metadata,observed_sha256:hash(canonical(metadata))};
        };
        function receive(data, frameSha) {
            if (!valid() || data?.toolName !== 'ProjectForge' || data.toolArgs?.command !== 'CrownCall') return;
            const rpc = data.requestId, encoded = data.toolArgs.proof?.payload_b64;
            if (typeof rpc !== 'string' || !rpc.length || rpc.length > 256 || typeof encoded !== 'string' || encoded.length > 16*1024*1024) { fail(); return; }
            if (pending.has(rpc) || rpcRecords.has(rpc) || pending.size >= max_entries) { fail(); return; }
            const payloadSha = hash(Buffer.from(encoded,'base64'));
            pending.set(rpc,{payloadSha,events:frameSha ? [event('DISTRIBUTED_RECEIVER','DISTRIBUTED_RECEIVER','receiver','receive',rpc,frameSha.sha,frameSha.observed_at)] : [],incomplete:!frameSha});
        }
        function dispatch(data) {
            if (!valid()) return;
            const record = pending.get(data?.requestId);
            if (!record) return;
            record.events.push(event('DISTRIBUTED_RECEIVER','DISTRIBUTED_RECEIVER','receiver','dispatch',data.requestId));
            record.events.push(event('DISTRIBUTED_MANAGER','DISTRIBUTED_MANAGER_CALL','caller','call',data.requestId));
            if (managerSourceSha) record.events.push(event('DISTRIBUTED_MANAGER','DISTRIBUTED_MANAGER_CALL','source-attestation','source_sha256:'+managerSourceSha,data.requestId));
            else record.incomplete = true;
        }
        const internal = {
            receive,dispatch,now,
            result(rpc) {
                if (!valid()) return;
                const record = rpcRecords.get(rpc);
                if (record && record.events.length < 16) record.events.push(event('DISTRIBUTED_RECEIVER','DISTRIBUTED_RECEIVER','receiver','result',rpc));
                else if (record) record.incomplete = true;
                pending.delete(rpc);
            },
            fail,
            revoke() { revoked = true; pending.clear();records.clear();rpcRecords.clear();if(observer===internal)observer=null; }
        };
        observer = internal;
        return Object.freeze({
            attestCall(metadata) {
                try {
                    if (!valid() || !exactKeys(metadata,['query','mode','rpc_id','identity']) || !queryCheck(metadata.query) ||
                        metadata.query.native_epoch !== native_epoch || canonical(metadata.identity) !== canonical(identity) ||
                        !['execute','preflight','reconcile'].includes(metadata.mode) || records.has(metadata.query.request_id) || records.size >= max_entries) { fail(); return false; }
                    const rpc = metadata.rpc_id, received = typeof rpc === 'string' ? pending.get(rpc) : null;
                    if (received && received.payloadSha !== metadata.query.payload_sha256) { fail(); return false; }
                    const record = {query:freeze(metadata.query),mode:metadata.mode,events:received?.events.slice() ?? [],incomplete:!received || received.incomplete};
                    record.events.push(event('NATIVE_SERVICE','NATIVE_SERVICE_RECEIVE','endpoint','receive',typeof rpc==='string'?rpc:undefined));
                    records.set(metadata.query.request_id,record);
                    if (received) { rpcRecords.set(rpc,record);pending.delete(rpc); }
                    return true;
                } catch { fail(); return false; }
            },
            evidence(query) {
                if (!valid() || !queryCheck(query)) throw Error('EVIDENCE_UNAVAILABLE');
                const record = records.get(query.request_id);
                if (!record || canonical(query) !== canonical(record.query)) throw Error('EVIDENCE_UNAVAILABLE');
                return freeze({schema:1,task_sha256,bootstrap_id,...record.query,mode:record.mode,identity,
                    incomplete:failed || record.incomplete || !record.events.some(e=>e.boundary==='DISTRIBUTED_RECEIVER'&&e.phase==='result'),events:record.events});
            },
            revoke:internal.revoke
        });
    }
    const safe = fn => { try { if (observer) fn(observer); } catch { try {observer?.fail();} catch {} } };
    return Object.freeze({installCrownEvidenceObserver,
        captureFrame(message) { if (!observer) return null; try {const raw=Buffer.isBuffer(message)?message:Buffer.from(message);return raw.length<=16*1024*1024?{sha:hash(raw),observed_at:observer.now()}:null;}catch{safe(o=>o.fail());return null;} },
        receive:(data,frameSha)=>safe(o=>o.receive(data,frameSha)),dispatch:data=>safe(o=>o.dispatch(data)),
        result:rpc=>safe(o=>o.result(rpc)),revoke:()=>safe(o=>o.revoke())});
}

class DistributedServer {
    constructor(config = {}) {
        this.mainServerUrl = config.mainServerUrl;
        this.nativeSyncRouteId = config.nativeSyncRouteId || null;
        this.nativeConversationWebSocket = config.nativeConversationWebSocket === true;
        this.vcpKey = config.vcpKey;
        this.serverName = config.serverName || 'Unnamed-Distributed-Server';
        this.nodeId = validateNodeId(config.nodeId !== undefined ? config.nodeId : process.env.DIST_NODE_ID);
        // A fresh install must not expose plugin HTTP routes on every network.
        // Existing explicit DIST_SERVER_BIND_ADDRESS settings still opt in to
        // the selected LAN/interface, including the matching port fallback.
        this.bindAddress = '127.0.0.1';
        this.configPath = config.configPath || path.join(__dirname, 'config.env');
        this.port = config.port || 0; // 0 表示随机选择一个可用端口
        this.debugMode = config.debugMode || false;
        this.rendererProcess = config.rendererProcess; // To communicate with the renderer
        this.handleMusicControl = config.handleMusicControl; // Inject the music control handler
        this.handleDiceControl = config.handleDiceControl; // Inject the dice control handler
        this.handleCanvasControl = config.handleCanvasControl; // Inject the canvas control handler
        this.handleFlowlockControl = config.handleFlowlockControl; // Inject the flowlock control handler
        this.handleDesktopRemoteControl = config.handleDesktopRemoteControl; // Inject the desktop remote control handler
        this.chatDataService = config.chatDataService || null; // Shared VCP-CDS facade owned by Electron.
        this.loomManager = config.loomManager || null; // Shared VCP Loom manager owned by Electron.
        this.scriptoriumAgentControl = config.scriptoriumAgentControl || null;
        this.pluginAgentOperationService = config.pluginAgentOperationService || null;
        this.chartService = config.chartService || null;
        this.gameService = config.gameService || null;
        this.readCoreContext = config.readCoreContext;
        this.workspaceService = config.workspaceService || null; // 工作区只读门面（白名单来源）
        this.crownEvidenceService = createCrownEvidenceService();
        this.onToolResult = typeof config.onToolResult === 'function' ? config.onToolResult : null; // 工具调用成功后的旁路通知，不影响返回结果
        this.ws = null;
        this.app = express(); // 创建 Express 应用
        this.server = http.createServer(this.app); // 创建 HTTP 服务器
        this.reconnectInterval = 5000;
        const defaultJsonParser = express.json({ limit: '2mb' });
        const defaultUrlencodedParser = express.urlencoded({ extended: false, limit: '2mb' });
        const isMobileSyncPath = req => req.path === '/api/mobile-sync'
            || req.path.startsWith('/api/mobile-sync/');
        // MobileSync owns strict per-route parsers and NDJSON/raw streaming
        // budgets. Bypassing the generic parser here prevents it from
        // buffering or rejecting the sync body before the plugin can apply
        // those limits; every other Chat route keeps the existing 2 MiB cap.
        this.app.use((req, res, next) => isMobileSyncPath(req)
            ? next()
            : defaultJsonParser(req, res, next));
        this.app.use((req, res, next) => isMobileSyncPath(req)
            ? next()
            : defaultUrlencodedParser(req, res, next));
        this.maxReconnectInterval = 60000;
        this.reconnectTimeoutId = null; // To keep track of the reconnect timeout
        this.stopped = false; // Flag to prevent reconnection when stopped manually
        this.stopPromise = null;
        this.initializePromise = null;
        this.initialConnection = true; // Flag to handle one-time actions on first connect
        this.staticPlaceholderUpdateInterval = null; // 新增：静态占位符更新定时器
        this.musicPlaylistWatcher = null;
        this.musicPlaylistUpdateTimeout = null;
        this.lastMusicPlaylistSignature = null;
    }

    loadServerConfig() {
        let configuredBindAddress;
        let configuredNodeId;
        // Load server-specific config
        const serverConfigPath = this.configPath;
        try {
            {
                const serverEnv = dotenv.parse(fsSync.readFileSync(serverConfigPath));
                configuredBindAddress = serverEnv.DIST_SERVER_BIND_ADDRESS;
                configuredNodeId = serverEnv.DIST_NODE_ID;
                if (serverEnv.DIST_SERVER_PORT) {
                    const newPort = parseInt(serverEnv.DIST_SERVER_PORT, 10);
                    if (!isNaN(newPort)) {
                        this.port = newPort;
                        console.log(`[${this.serverName}] Port loaded from config.env: ${this.port}`);
                    }
                }
            }
        } catch (e) {
            if (e.code !== 'ENOENT') throw new Error('DIST_SERVER_CONFIG_READ_FAILED');
        }

        if (this.nodeId === undefined) this.nodeId = validateNodeId(configuredNodeId);

        if (configuredBindAddress !== undefined) {
            if (!isIP(configuredBindAddress) || configuredBindAddress.includes('%')) {
                throw new Error('DIST_SERVER_BIND_ADDRESS must be an IPv4 or IPv6 literal');
            }
            this.bindAddress = configuredBindAddress;
        }
    }

    async bindHttpServer(preferredPort) {
        const tryListen = (port) => new Promise((resolve, reject) => {
            const onError = (error) => {
                this.server.off('listening', onListening);
                reject(error);
            };
            const onListening = () => {
                this.server.off('error', onError);
                resolve(this.server.address());
            };

            this.server.once('error', onError);
            this.server.once('listening', onListening);
            this.server.listen(port, this.bindAddress);
        });

        try {
            return await tryListen(preferredPort);
        } catch (error) {
            if (error && error.code === 'EADDRINUSE' && preferredPort !== 0) {
                console.warn(`[${this.serverName}] Port ${preferredPort} is already in use. Falling back to a random available port.`);
                return tryListen(0);
            }
            throw error;
        }
    }

    initialize() {
        if (!this.initializePromise) {
            this.initializePromise = this.initializeInBackground();
        }
        return this.initializePromise;
    }

    async initializeInBackground() {
        if (this.stopped) return;
        console.log(`[${this.serverName}] Initializing...`);

        this.loadServerConfig();

        // The base path should be relative to this file's location.
        const basePath = path.dirname(require.resolve('./VCPDistributedServer.js'));
        pluginManager.setProjectBasePath(basePath);
        const startupOptions = { shouldStop: () => this.stopped };
        await pluginManager.loadPlugins(startupOptions);
        if (this.stopped) return;

        // 初始化服务类插件，并将主进程持有的共享服务依赖注入 direct 模块。
        await pluginManager.initializeServices(this.app, null, basePath, {
            chatDataService: this.chatDataService,
            loomManager: this.loomManager,
            scriptoriumAgentControl: this.scriptoriumAgentControl,
            pluginAgentOperationService: this.pluginAgentOperationService,
            chartService: this.chartService,
            gameService: this.gameService,
            workspaceService: this.workspaceService,
            crownEvidenceReceiver: this.crownEvidenceService,
        }, startupOptions);
        if (this.stopped) return;
        this.registerDiagnosticRoutes();

        await this.bindHttpServer(this.port);
        if (this.stopped) return;
            this.port = this.server.address().port; // 获取实际监听的端口
            console.log(`[${this.serverName}] HTTP server listening on ${this.bindAddress}:${this.port}`);

            // 注入端口到插件管理器，用于构造回调 URL
            pluginManager.setServerPort(this.port, this.server.address().address);

            // 注册异步插件回调接口
            this.app.post('/plugin/callback', (req, res) => {
                const callbackData = req.body;
                if (this.debugMode) console.log(`[${this.serverName}] Received plugin callback:`, callbackData);
                
                // 通过 WebSocket 隧道转发回调数据到主服务器
                const payload = {
                    type: 'plugin_callback_forward',
                    data: {
                        serverName: this.serverName,
                        callbackData: callbackData
                    }
                };
                this.sendMessage(payload);
                res.status(200).json({ status: 'success', message: 'Callback forwarded to main server.' });
            });

            // 由分布式服务器自身监听本地音乐列表，无需 IPC。
            this.setupMusicPlaylistWatcher();

            // 在 HTTP 服务器启动后，再连接到主服务器
            this.connect();
    }

    registerDiagnosticRoutes() {
        const generatedConfig = loadGeneratedListsConfig();
        const fileKey = generatedConfig.file_key;

        if (!fileKey) {
            console.error(`[${this.serverName}] DesktopRemote test route disabled: missing file_key in AppData/generated_lists/config.env.`);
            return;
        }

        this.app.post(/\/pw=([^\/]+)\/desktop-remote-test/, async (req, res) => {
            const requestKey = req.params[0];
            const remoteAddress = getRequestRemoteAddress(req);

            if (!isLoopbackAddress(remoteAddress)) {
                return res.status(403).json({
                    success: false,
                    error: `Loopback only. Remote address: ${remoteAddress || 'unknown'}`,
                    stage: 'auth',
                });
            }

            if (requestKey !== fileKey) {
                return res.status(401).json({
                    success: false,
                    error: 'Unauthorized',
                    stage: 'auth',
                });
            }

            let commandPayload;
            try {
                const normalized = await pluginManager.processToolCall('DesktopRemote', req.body || {});
                commandPayload = typeof normalized === 'string' ? JSON.parse(normalized) : normalized;
            } catch (error) {
                return res.status(400).json({
                    success: false,
                    error: error.message || 'Failed to normalize DesktopRemote request.',
                    stage: 'normalize',
                });
            }

            try {
                if (typeof this.handleDesktopRemoteControl !== 'function') {
                    throw new Error('Desktop remote control handler is not configured.');
                }

                const result = await this.handleDesktopRemoteControl(commandPayload);
                if (!result || result.status !== 'success') {
                    const message = result?.message || result?.error || 'DesktopRemote handler failed.';
                    const stage = /timed out/i.test(message) ? 'renderer-timeout' : 'main-handler';
                    return res.status(stage === 'renderer-timeout' ? 504 : 500).json({
                        success: false,
                        error: message,
                        stage,
                        commandPayload,
                    });
                }

                return res.json({
                    success: true,
                    commandPayload,
                    result,
                });
            } catch (error) {
                const message = error.message || 'DesktopRemote handler failed.';
                const stage = /timed out/i.test(message) ? 'renderer-timeout' : 'main-handler';
                return res.status(stage === 'renderer-timeout' ? 504 : 500).json({
                    success: false,
                    error: message,
                    stage,
                    commandPayload,
                });
            }
        });

        console.log(`[${this.serverName}] DesktopRemote test route enabled: /pw=<file_key>/desktop-remote-test`);
    }

    connect() {
        if (this.stopped) {
            console.log(`[${this.serverName}] Server is stopped, not connecting.`);
            return;
        }
        if (!this.mainServerUrl || !this.vcpKey) {
            console.error(`[${this.serverName}] Error: mainServerUrl or vcpKey is not configured. Cannot connect.`);
            return;
        }

        if (this.nativeConversationWebSocket && !require('../modules/services/trustedConversation/webSocket.cjs').isSecureNativeWebSocketUrl(this.mainServerUrl.replace(/^http/, 'ws'))) {
            console.error('[DistributedServer] NATIVE_SECURE_CHANNEL_REQUIRED');
            return;
        }
        const connectionUrl = `${this.mainServerUrl.replace(/^http/, 'ws')}/vcp-distributed-server/VCP_Key=${this.vcpKey}`;
        console.log('[DistributedServer] Connecting to configured main server.');

        // this.ws 现在是一个纯粹的客户端实例
        this.ws = new WebSocket(connectionUrl);
        this.nativeConversationClient ??= require('../modules/services/trustedConversation/webSocket.cjs').createNativeWebSocketClient();
        const nativeSocket = this.ws;
        this.nativeConversationClient.bind(nativeSocket);

        this.ws.on('open', async () => {
            console.log(`[${this.serverName}] Successfully connected to main server.`);
            this.reconnectInterval = 5000;
            this.registerTools();
            await this.reportIPAddress();
            await this.pushMusicPlaylistUpdate('websocket_open');
            
            // 新增：设置静态占位符定期推送
            this.setupStaticPlaceholderUpdates();
        });

        this.ws.on('message', (message) => {
            this.handleMainServerMessage(message, nativeSocket);
        });
        
        this.ws.on('close', () => {
            console.log(`[${this.serverName}] Disconnected from main server.`);
            // 新增：清理静态占位符更新定时器
            this.clearStaticPlaceholderUpdates();
            this.scheduleReconnect();
        });

        this.ws.on('error', (error) => {
            console.error('[DistributedServer] WEBSOCKET_CLIENT_ERROR');
            // 'close' 事件会自动被触发，所以这里不需要额外的处理
        });
    }

    scheduleReconnect() {
        if (this.stopped) {
            console.log(`[${this.serverName}] Stop called, cancelling reconnection.`);
            return;
        }
        console.log(`[${this.serverName}] Attempting to reconnect in ${this.reconnectInterval / 1000}s...`);
        // 新增：清理静态占位符更新定时器
        this.clearStaticPlaceholderUpdates();
        // Clear any existing timeout to avoid multiple reconnect loops
        if (this.reconnectTimeoutId) {
            clearTimeout(this.reconnectTimeoutId);
        }
        this.reconnectTimeoutId = setTimeout(() => this.connect(), this.reconnectInterval);
        // Exponential backoff
        this.reconnectInterval = Math.min(this.reconnectInterval * 2, this.maxReconnectInterval);
    }

    registerTools() {
        const manifests = pluginManager.getAllPluginManifests();

        // On the very first successful connection, send a notification about loaded plugins.
        if (this.initialConnection && manifests.length > 0) {
            const pluginCount = manifests.length;
            // Directly send a structured message to the renderer process for notification
            if (this.rendererProcess && !this.rendererProcess.isDestroyed()) {
                // Add a delay to give the renderer process time to set up its listeners
                setTimeout(() => {
                    if (this.rendererProcess && !this.rendererProcess.isDestroyed()) {
                        this.rendererProcess.send('vcp-log-message', {
                            type: 'vcp_log',
                            data: {
                                source: 'DistPluginManager',
                                content: `分布式服务器已启动，已推送 ${pluginCount} 个本地插件。`
                            }
                        });
                    }
                }, 1000); // 2-second delay
            }
            this.initialConnection = false; // Ensure this only runs once
        }

        if (manifests.length > 0 || this.readCoreContext) {
            const payload = {
                type: 'register_tools',
                data: {
                    ...(this.nodeId !== undefined ? { nodeId: this.nodeId } : {}),
                    ...(this.nativeSyncRouteId ? { nativeSyncRouteId: this.nativeSyncRouteId } : {}),
                    serverName: this.serverName,
                    tools: this.readCoreContext ? [...manifests, { name: 'internal_core_context' }] : manifests
                }
            };
            this.sendMessage(payload);
            console.log(`[${this.serverName}] Sent registration for ${manifests.length} tools to the main server.`);
        } else {
            if (this.debugMode) console.log(`[${this.serverName}] No local tools found to register.`);
        }
    }

    async reportIPAddress() {
        const { default: fetch } = await import('node-fetch');
        const networkInterfaces = os.networkInterfaces();
        const ipv4Addresses = [];
        let publicIp = null;

        for (const interfaceName in networkInterfaces) {
            const interfaces = networkInterfaces[interfaceName];
            for (const iface of interfaces) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    ipv4Addresses.push(iface.address);
                }
            }
        }

        try {
            const response = await fetch('https://api.ipify.org?format=json');
            if (response.ok) {
                const data = await response.json();
                publicIp = data.ip;
            } else {
                console.error(`[${this.serverName}] Failed to fetch public IP, status: ${response.status}`);
            }
        } catch (e) {
            console.error(`[${this.serverName}] Could not fetch public IP:`, e.message);
        }
        
        const payload = {
            type: 'report_ip',
            data: {
                serverName: this.serverName,
                localIPs: ipv4Addresses,
                publicIP: publicIp
            }
        };
        this.sendMessage(payload);
        console.log(`[${this.serverName}] Reported IP addresses to main server: Local: ${ipv4Addresses.join(', ')}, Public: ${publicIp || 'N/A'}`);
    }

    // 新增：设置静态占位符定期更新
    setupStaticPlaceholderUpdates() {
        // 每30秒推送一次静态占位符值
        this.staticPlaceholderUpdateInterval = setInterval(() => {
            this.pushStaticPlaceholderValues();
        }, 30000); // 30秒
        
        // 立即推送一次
        setTimeout(() => {
            this.pushStaticPlaceholderValues();
        }, 2000); // 2秒后第一次推送
        
        if (this.debugMode) console.log(`[${this.serverName}] Static placeholder updates scheduled every 30 seconds.`);
    }

    // 新增：清理静态占位符更新定时器
    clearStaticPlaceholderUpdates() {
        if (this.staticPlaceholderUpdateInterval) {
            clearInterval(this.staticPlaceholderUpdateInterval);
            this.staticPlaceholderUpdateInterval = null;
            if (this.debugMode) console.log(`[${this.serverName}] Static placeholder update interval cleared.`);
        }
    }

    // 新增：推送静态占位符值到主服务器
    async pushStaticPlaceholderValues() {
        const placeholderValues = pluginManager.getAllPlaceholderValues();
        if (placeholderValues.size === 0) {
            return;
        }

        // 检查是否在settings.json中禁用了静态插件日志
        const logStaticPlugins = await this.shouldLogStaticPlugins();

        const payload = {
            type: 'update_static_placeholders',
            data: {
                serverName: this.serverName,
                placeholders: Object.fromEntries(placeholderValues)
            }
        };
        
        this.sendMessage(payload);
        if (this.debugMode && logStaticPlugins) {
            console.log(`[${this.serverName}] Pushed ${placeholderValues.size} static placeholder values to main server.`);
            for (const [key, value] of placeholderValues) {
                console.log(`  - ${key}: ${value.substring(0, 100)}${value.length > 100 ? '...' : ''}`);
            }
        }
    }

    setupMusicPlaylistWatcher() {
        if (this.musicPlaylistWatcher) {
            return;
        }

        this.musicPlaylistWatcher = chokidar.watch(MUSIC_PLAYLIST_FILE_PATH, {
            persistent: true,
            ignoreInitial: false,
            awaitWriteFinish: {
                stabilityThreshold: 500,
                pollInterval: 100
            }
        });

        const schedulePush = (reason) => {
            if (this.musicPlaylistUpdateTimeout) {
                clearTimeout(this.musicPlaylistUpdateTimeout);
            }
            this.musicPlaylistUpdateTimeout = setTimeout(() => {
                this.musicPlaylistUpdateTimeout = null;
                this.pushMusicPlaylistUpdate(reason).catch(error => {
                    console.error(`[${this.serverName}] Failed to push music playlist update:`, error.message);
                });
            }, 500);
        };

        this.musicPlaylistWatcher
            .on('add', () => schedulePush('file_added'))
            .on('change', () => schedulePush('file_changed'))
            .on('unlink', () => schedulePush('file_removed'))
            .on('error', error => {
                console.error(`[${this.serverName}] Music playlist watcher error:`, error.message);
            });

        console.log(`[${this.serverName}] Watching local music playlist: ${MUSIC_PLAYLIST_FILE_PATH}`);
    }

    async readMusicPlaylistSnapshot() {
        if (!fsSync.existsSync(MUSIC_PLAYLIST_FILE_PATH)) {
            return {
                exists: false,
                tracks: [],
                count: 0,
                updatedAt: new Date().toISOString()
            };
        }

        const rawContent = await fs.readFile(MUSIC_PLAYLIST_FILE_PATH, 'utf8');
        const parsed = JSON.parse(rawContent);
        if (!Array.isArray(parsed)) {
            throw new Error('songlist.json root value must be an array.');
        }

        const tracks = parsed
            .filter(track => track && typeof track === 'object')
            .map(track => ({
                path: typeof track.path === 'string' ? track.path : '',
                title: typeof track.title === 'string' ? track.title : '',
                artist: typeof track.artist === 'string' ? track.artist : '',
                album: typeof track.album === 'string' ? track.album : '',
                albumArt: typeof track.albumArt === 'string' ? track.albumArt : null,
                bitrate: typeof track.bitrate === 'number' ? track.bitrate : null,
                isRemote: track.isRemote === true,
                serverId: typeof track.serverId === 'string' ? track.serverId : undefined
            }));

        return {
            exists: true,
            tracks,
            count: tracks.length,
            updatedAt: new Date().toISOString()
        };
    }

    async pushMusicPlaylistUpdate(reason = 'manual') {
        let snapshot;
        try {
            snapshot = await this.readMusicPlaylistSnapshot();
        } catch (error) {
            console.error(`[${this.serverName}] Failed to read local music playlist:`, error.message);
            snapshot = {
                exists: fsSync.existsSync(MUSIC_PLAYLIST_FILE_PATH),
                tracks: [],
                count: 0,
                updatedAt: new Date().toISOString(),
                error: error.message
            };
        }

        const signature = JSON.stringify({
            exists: snapshot.exists,
            count: snapshot.count,
            tracks: snapshot.tracks,
            error: snapshot.error || null
        });

        if (signature === this.lastMusicPlaylistSignature && reason !== 'websocket_open') {
            if (this.debugMode) console.log(`[${this.serverName}] Music playlist unchanged, skip update.`);
            return;
        }
        this.lastMusicPlaylistSignature = signature;

        const payload = {
            type: 'music_playlist_update',
            data: {
                serverName: this.serverName,
                reason,
                playlistPath: MUSIC_PLAYLIST_FILE_PATH,
                ...snapshot
            }
        };

        this.sendMessage(payload);
        console.log(`[${this.serverName}] Reported local music playlist to main server. Count: ${snapshot.count}, Reason: ${reason}`);
    }

    async closeMusicPlaylistWatcher() {
        if (this.musicPlaylistUpdateTimeout) {
            clearTimeout(this.musicPlaylistUpdateTimeout);
            this.musicPlaylistUpdateTimeout = null;
        }

        if (this.musicPlaylistWatcher) {
            const watcher = this.musicPlaylistWatcher;
            this.musicPlaylistWatcher = null;
            await watcher.close();
            if (this.debugMode) console.log(`[${this.serverName}] Music playlist watcher closed.`);
        }
    }

    // 新增：检查是否应该记录静态插件日志
    async shouldLogStaticPlugins() {
        try {
            const settingsPath = path.join(__dirname, '..', 'AppData', 'settings.json');
            if (!fsSync.existsSync(settingsPath)) {
                return true; // 默认启用日志
            }
            const settings = JSON.parse(fsSync.readFileSync(settingsPath, 'utf8'));
            return settings.enableDistributedServerLogs !== false; // 默认启用，除非明确设置为false
        } catch (error) {
            if (this.debugMode) console.warn(`[${this.serverName}] Error reading settings for log control:`, error.message);
            return true; // 错误时默认启用日志
        }
    }

    async handleMainServerMessage(message, nativeSocket = this.ws) {
        try {
            const parsedMessage = JSON.parse(message);
            // Private native results never enter generic tool dispatch or diagnostics.
            if (this.nativeConversationClient?.receive(nativeSocket, parsedMessage)) return;
            const frameSha = parsedMessage.type === 'execute_tool'
                && parsedMessage.data?.toolName === 'ProjectForge'
                && parsedMessage.data?.toolArgs?.command === 'CrownCall'
                ? this.crownEvidenceService.captureFrame(message) : null;
            if (this.debugMode) console.log(`[${this.serverName}] Received message from main server:`, parsedMessage.type);

            if (parsedMessage.type === 'execute_tool') {
                await this.handleToolExecutionRequest(parsedMessage.data, frameSha);
            }
        } catch (e) {
            console.error('[DistributedServer] MAIN_SERVER_MESSAGE_INVALID');
        }
    }

    async handleToolExecutionRequest(data, frameSha = null) {
        try {
            return await quitAdmission.run(() => this.handleAdmittedToolExecutionRequest(data, frameSha));
        } catch (error) {
            if (error.code !== 'APPLICATION_SHUTTING_DOWN') throw error;
            this.sendMessage({ type: 'tool_result', data: { requestId: data?.requestId,
                status: 'error', error: error.code } });
        }
    }

    async handleAdmittedToolExecutionRequest(data, frameSha = null) {
        const { requestId, toolName, toolArgs, _vcpContext } = data;
        if (!requestId || !toolName) {
            console.error(`[${this.serverName}] Invalid tool execution request received.`);
            return;
        }

        if (this.debugMode) console.log(`[${this.serverName}] Executing tool '${toolName}' for request ID: ${requestId}`);

        this.crownEvidenceService.receive(data, frameSha);
        let responsePayload;
        try {
            if (toolName === 'internal_core_context') {
                try {
                    const result = await this.readCoreContext(toolArgs);
                    this.sendMessage({ type: 'tool_result', data: { requestId, status: 'success', result } });
                } catch {
                    this.sendMessage({ type: 'tool_result', data: { requestId, status: 'error', error: 'CORE_RESOURCE_UNAVAILABLE' } });
                }
                return;
            }
            // --- 新增：处理内部文件请求 ---
            if (toolName === 'internal_request_file') {
                // 关键改进：对接 FileFetcherServer 的新协议
                const { fileUrl } = toolArgs;
                if (!fileUrl || !fileUrl.startsWith('file://')) {
                    throw new Error(`Invalid or missing fileUrl parameter for internal_request_file.`);
                }

                try {
                    // 在分布式服务器自己的环境中，安全地将 URL 转换为本地路径
                    const { fileURLToPath } = require('url');
                    const filePath = fileURLToPath(fileUrl);

                    const fileBuffer = await fs.readFile(filePath);
                    const mimeType = mime.lookup(filePath) || 'application/octet-stream';
                    
                    responsePayload = {
                        type: 'tool_result',
                        data: {
                            requestId,
                            status: 'success',
                            result: {
                                status: 'success',
                                fileData: fileBuffer.toString('base64'),
                                mimeType: mimeType
                            }
                        }
                    };
                } catch (e) {
                    if (e.code === 'ENOENT') {
                        throw new Error(`File not found on distributed server: ${fileUrl}`);
                    } else if (e.code === 'ERR_INVALID_FILE_URL_PATH') {
                        throw new Error(`Invalid file URL path on distributed server: ${fileUrl}`);
                    } else {
                        throw new Error(`Error reading file on distributed server (${fileUrl}): ${e.message}`);
                    }
                }
                this.sendMessage(responsePayload);
                if (this.debugMode) console.log(`[${this.serverName}] Sent file content for request ID: ${requestId}`);
                return; // 处理完毕，直接返回
            }
            // --- 结束：处理内部文件请求 ---

            // _vcpContext 来自受信任的 execute_tool 传输层，与模型生成的 toolArgs 隔离。
            this.crownEvidenceService.dispatch(data);
            const result = await pluginManager.processToolCall(toolName, toolArgs, {
                requestId,
                vcpContext: _vcpContext && typeof _vcpContext === 'object'
                    ? { ..._vcpContext, requestId }
                    : { requestId }
            });
            if (this.onToolResult) {
                try {
                    this.onToolResult(toolName, toolArgs, result);
                } catch (hookError) {
                    console.warn(`[${this.serverName}] onToolResult hook failed:`, hookError?.message || hookError);
                }
            }
            let finalResult;

            // --- Special Handling for MusicController ---
            if (toolName === 'MusicController') {
                const commandPayload = (typeof result === 'string') ? JSON.parse(result) : result;
                if (commandPayload.status === 'error') {
                    throw new Error(commandPayload.error);
                }
                
                if (typeof this.handleMusicControl !== 'function') {
                    throw new Error('Music control handler is not configured for the Distributed Server.');
                }

                // Directly call the injected handler function from main.js
                const resultFromMain = await this.handleMusicControl(commandPayload);

                if (resultFromMain.status === 'error') {
                    throw new Error(resultFromMain.message);
                }
                
                if (commandPayload.command === 'getCurrentLyrics') {
                    // 与 FileOperator 一致，保留标准 result.content 文本块。
                    finalResult = resultFromMain.result;
                } else {
                    // For AI, we want a simple, natural language response.
                    let naturalResponse = `指令 '${commandPayload.command}' 已成功执行。`;
                    if (commandPayload.command === 'play' && commandPayload.target) {
                        naturalResponse = `已为您播放歌曲: ${commandPayload.target}`;
                    } else if (commandPayload.command === 'play') {
                        naturalResponse = `已恢复播放。`;
                    } else if (commandPayload.command === 'pause') {
                        naturalResponse = `已暂停播放。`;
                    } else if (commandPayload.command === 'next') {
                        naturalResponse = `已切换到下一首。`;
                    } else if (commandPayload.command === 'prev') {
                        naturalResponse = `已切换到上一首。`;
                    }
                    finalResult = { message: naturalResponse };
                }

            } else if (toolName === 'SuperDice') {
                if (typeof this.handleDiceControl !== 'function') {
                    throw new Error('Dice control handler is not configured for the Distributed Server.');
                }
                // The toolArgs are already parsed, e.g., { notation: '2d20' }
                const resultFromMain = await this.handleDiceControl(toolArgs);

                if (resultFromMain.status === 'error') {
                    throw new Error(resultFromMain.message);
                }
                
                // The result from the dice roll is already structured, so we can pass it directly.
                finalResult = resultFromMain.data;

            } else if (toolName === 'Flowlock') {
                // --- Special Handling for Flowlock ---
                if (typeof this.handleFlowlockControl !== 'function') {
                    throw new Error('Flowlock control handler is not configured for the Distributed Server.');
                }
                
                // The toolArgs contain the command and parameters
                const resultFromMain = await this.handleFlowlockControl(toolArgs);
                
                if (resultFromMain.status === 'error') {
                    throw new Error(resultFromMain.message);
                }
                
                finalResult = { message: resultFromMain.message };
                
            } else if (toolName === 'DesktopRemote') {
                // --- Special Handling for DesktopRemote ---
                const commandPayload = (typeof result === 'string') ? JSON.parse(result) : result;
                if (commandPayload.status === 'error') {
                    throw new Error(commandPayload.error);
                }
                
                if (typeof this.handleDesktopRemoteControl !== 'function') {
                    throw new Error('Desktop remote control handler is not configured for the Distributed Server.');
                }

                // Directly call the injected handler function from main.js
                const resultFromMain = await this.handleDesktopRemoteControl(commandPayload);

                if (resultFromMain.status === 'error') {
                    throw new Error(resultFromMain.message);
                }
                
                // The handler returns { status, result: { content: [...] } } format
                // Pass through the result directly to preserve the content array structure
                finalResult = resultFromMain.result || { message: resultFromMain.message };

            } else {
                // --- Default Handling for all other plugins ---
                const plugin = pluginManager.getPlugin(toolName);
                const isDirectPlugin = plugin?.pluginType === 'hybridservice'
                    && plugin?.communication?.protocol === 'direct';
                if (isDirectPlugin || (typeof result === 'object' && result !== null)) {
                    // direct 插件的字符串也必须原样返回；回忆正文可能包含 JSON 花括号，
                    // 不能误走旧 stdio 插件的 JSON 提取逻辑。
                    finalResult = result;
                } else {
                    // Result is a string from stdio, needs parsing
                    try {
                        // --- Robust JSON Parsing ---
                        // The plugin might output debug info (like from dotenv) to stdout before the JSON.
                        // We need to find the actual JSON string.
                        const jsonStartIndex = result.indexOf('{');
                        const jsonEndIndex = result.lastIndexOf('}');
                        
                        if (jsonStartIndex === -1 || jsonEndIndex === -1) {
                            // If no JSON object is found, treat it as a raw string.
                            throw new SyntaxError("No JSON object found in plugin output.");
                        }

                        const jsonString = result.substring(jsonStartIndex, jsonEndIndex + 1);
                        const parsedPluginResult = JSON.parse(jsonString);
                        // --- End of Robust JSON Parsing ---

                        if (parsedPluginResult.status === 'success') {
                            finalResult = parsedPluginResult.result;
                            // --- VCP Protocol Enhancement ---
                            // If the plugin response has special action fields (e.g., for canvas),
                            // merge them into the final result object so they can be handled downstream.
                            if (parsedPluginResult._specialAction) {
                                if (typeof finalResult !== 'object' || finalResult === null) {
                                    finalResult = {}; // Ensure finalResult is an object
                                }
                                finalResult._specialAction = parsedPluginResult._specialAction;
                                finalResult.payload = parsedPluginResult.payload;
                            }
                        } else {
                            throw new Error(parsedPluginResult.error || 'Plugin reported an error without a message.');
                        }
                    } catch (e) {
                        if (e instanceof SyntaxError) {
                            finalResult = result; // Legacy plugin returning a raw string
                        } else {
                            throw e; // Other error
                        }
                    }
                }

                // --- Special Handling for Canvas actions (applied to the finalResult) ---
                if (finalResult && finalResult._specialAction === 'create_canvas') {
                    if (typeof this.handleCanvasControl === 'function') {
                        console.log(`[${this.serverName}] Detected create_canvas action. Calling main process handler.`);
                        void this.handleCanvasControl(finalResult.payload.filePath);
                    } else {
                        console.error(`[${this.serverName}] Canvas control handler is not configured for the Distributed Server.`);
                    }
                } else if (finalResult && finalResult._specialAction === 'edit_canvas') {
                    if (typeof this.handleCanvasControl !== 'function') {
                        throw new Error('Canvas control handler is not configured for the Distributed Server.');
                    }
                    console.log(`[${this.serverName}] Detected edit_canvas action. Waiting for user review.`);
                    const canvasResult = await this.handleCanvasControl({
                        action: 'edit',
                        ...finalResult.payload,
                    });
                    if (canvasResult.status === 'error') {
                        const error = new Error(canvasResult.message || 'Canvas edit review failed.');
                        error.code = canvasResult.code;
                        throw error;
                    }
                    finalResult = {
                        content: [{
                            type: 'text',
                            text: canvasResult.result?.approved
                                ? '用户已允许并应用 Canvas 编辑提案。'
                                : `Canvas 编辑提案未应用：${canvasResult.result?.message || '用户拒绝了该提案。'}`,
                        }],
                        details: canvasResult.result,
                    };
                }
                // --- End of special handling ---
            }

            responsePayload = {
                type: 'tool_result',
                data: {
                    requestId,
                    status: 'success',
                    result: finalResult
                }
            };
        } catch (error) {
            console.error(`[${this.serverName}] Error executing tool '${toolName}':`, error.message);
            responsePayload = {
                type: 'tool_result',
                data: {
                    requestId,
                    status: 'error',
                    error: error.message || 'An unknown error occurred.'
                }
            };
        }

        this.crownEvidenceService.result(requestId);
        this.sendMessage(responsePayload);
        if (this.debugMode) console.log(`[${this.serverName}] Sent result for request ID: ${requestId}`);
    }

    sendMessage(payload) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(payload));
        } else {
            console.error(`[${this.serverName}] Cannot send message, WebSocket is not open.`);
        }
    }

    async stop({ beforePluginCleanup } = {}) {
        if (this.stopPromise) {
            return this.stopPromise;
        }

        console.log(`[${this.serverName}] Stopping server...`);
        // Refuse before any teardown when host work is in flight. New GUI/WS
        // calls stay closed while initialization settles and cleanup is attempted.
        const wasClosing = quitAdmission.begin();
        const wasStopped = this.stopped;
        this.stopped = true;
        this.stopPromise = Promise.resolve().then(async () => {
        if (this.initializePromise) {
            await this.initializePromise.catch(error => {
                console.warn(`[${this.serverName}] Initialization ended during shutdown:`, error.message);
            });
        }
        
        if (beforePluginCleanup) await beforePluginCleanup();
        await pluginManager.shutdownAllPlugins();
        this.stopped = true;
        this.crownEvidenceService.revoke();

        // 新增：清理静态占位符更新定时器
        this.clearStaticPlaceholderUpdates();
        await this.closeMusicPlaylistWatcher();
        
        if (this.reconnectTimeoutId) {
            clearTimeout(this.reconnectTimeoutId);
            this.reconnectTimeoutId = null;
        }
        
        if (this.ws) {
            // Remove listeners to prevent reconnection logic from firing on manual close
            this.ws.removeAllListeners('close');
            this.ws.removeAllListeners('error');
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                this.ws.close(1000, 'Client initiated disconnect'); // 1000 is a normal closure
            }
            this.ws = null;
        }
        if (this.server && this.server.listening) {
            await new Promise((resolve) => {
                this.server.close(() => resolve());
            });
        }
        console.log(`[${this.serverName}] Server stopped.`);
        });
        try {
            await this.stopPromise;
            if (!wasClosing) quitAdmission.resume();
        }
        catch (error) {
            this.stopPromise = null;
            if (error.shutdownUnchanged) {
                this.stopped = wasStopped;
                if (!wasClosing) quitAdmission.resume();
            }
            throw error;
        }
    }
}

module.exports = DistributedServer;

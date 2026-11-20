'use strict';

// Workbench/floating UI owns native chart APIs. Programmable chart content uses
// the existing chart sandbox and its bounded, chart-scoped message protocol.
(() => {
    const SANDBOX_URL = 'vcp-chart://app/Chartmodules/chart-sandbox.html';
    const MAX_JSON = 2 * 1024 * 1024;
    let sequence = 0;
    const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    function bounded(value, limit = MAX_JSON) {
        try { return JSON.stringify(value).length <= limit; } catch { return false; }
    }
    const failure = (message, code) => Object.assign(new Error(message), { code });

    class ChartRuntime {
        constructor({ host, api, onStatus, onError, onStable, onEvent }) {
            Object.assign(this, { host, api, onStatus: onStatus || (() => {}), onError: onError || (() => {}), onStable: onStable || (() => {}), onEvent: onEvent || (() => {}) });
            this.snapshot = null;
            this.frame = null;
            this.destroyed = true;
            this.status = 'idle';
            this.diagnostics = null;
            this.saveIntents = new Map();
        }
        setStatus(status, description = '') {
            this.status = status;
            this.onStatus({ status, description: String(description).slice(0, 240), diagnostics: this.diagnostics });
        }
        send(type, payload = {}) {
            if (!this.destroyed && this.frame?.contentWindow && this.ready) this.frame.contentWindow.postMessage({ source: 'vcp-chart-shell', chartId: this.snapshot.manifest.id, generation: this.generation, nonce: this.nonce, type, ...payload }, '*');
        }
        async mount(snapshot) {
            await this.destroy(false);
            this.snapshot = clone(snapshot);
            this.destroyed = false;
            this.generation = ++sequence;
            this.nonce = crypto.randomUUID();
            this.ready = false;
            this.saveIntents.clear();
            const doc = this.host.ownerDocument, win = doc.defaultView;
            this.frame = doc.createElement('iframe');
            this.frame.title = this.snapshot.manifest.name || this.snapshot.manifest.id;
            this.frame.setAttribute('sandbox', 'allow-scripts');
            this.frame.setAttribute('referrerpolicy', 'no-referrer');
            this.frame.setAttribute('data-vcp-chart-workbench-sandbox', '');
            this.frame.style.cssText = 'display:block;width:100%;height:100%;border:0;background:transparent';
            this.frame.allow = "camera 'none'; microphone 'none'; geolocation 'none'; usb 'none'; serial 'none'; hid 'none'; clipboard-read 'none'";
            this.receive = event => { void this.message(event).catch(error => this.reportError(error)); };
            win.addEventListener('message', this.receive);
            this.setStatus('loading', '正在加载隔离图表');
            const mounted = new Promise((resolve, reject) => { this.resolveMount = resolve; this.rejectMount = reject; });
            this.mountTimer = win.setTimeout(() => this.reportError(failure('隔离图表加载超时。', 'CHART_SANDBOX_TIMEOUT')), 15000);
            this.host.replaceChildren(this.frame);
            this.frame.src = SANDBOX_URL;
            return mounted;
        }
        async message(event) {
            const value = event.data;
            if (this.destroyed || event.source !== this.frame?.contentWindow || event.origin !== 'null' || value?.source !== 'vcp-chart-sandbox') return;
            if (value.type === 'sandbox-ready') {
                if (this.ready) return;
                this.ready = true;
                this.send('initialize', { snapshot: { ...this.snapshot, generation: this.generation, capabilities: { persistence: true, cloudSync: true } } });
                return;
            }
            if (value.chartId !== this.snapshot.manifest.id || value.generation !== this.generation || value.nonce !== this.nonce || !bounded(value)) return;
            if (value.type === 'ready') {
                clearTimeout(this.mountTimer);
                this.resolveMount?.(); this.resolveMount = this.rejectMount = null;
                this.setStatus('ready', '图表已挂载');
            } else if (value.type === 'status') {
                if (['loading', 'mounting', 'ready', 'busy', 'stable', 'error', 'destroyed'].includes(value.status)) this.setStatus(value.status, value.description);
            } else if (value.type === 'stable') {
                this.diagnostics = bounded(value.diagnostics, 512 * 1024) ? clone(value.diagnostics) : null;
                this.setStatus('stable', '图表渲染稳定');
                this.onStable({ metadata: clone(value.metadata), diagnostics: this.diagnostics });
            } else if (value.type === 'runtime-event') {
                if (typeof value.name === 'string' && bounded(value.payload, 65536)) this.onEvent({ name: value.name.slice(0, 100), payload: clone(value.payload) });
            } else if (value.type === 'error') this.reportError(failure(String(value.message).slice(0, 500), 'CHART_SANDBOX_ERROR'));
            else if (['data-source-request', 'persistence-request', 'cloud-sync-request'].includes(value.type)) await this.request(value);
        }
        async request(value) {
            if (typeof value.requestId !== 'string' || value.requestId.length > 100) return;
            const generation = this.generation, chartId = this.snapshot.manifest.id;
            const response = value.type.replace('-request', '-response');
            try {
                let result;
                if (value.type === 'data-source-request') {
                    const request = value.request || {};
                    // Native reads resolve this reference against the latest
                    // manifest and reject stale/revoked declarations.
                    result = await this.api.readDataSource({ chartId, sourceId: request.sourceId, type: request.type, sql: request.sql, params: request.params, expectedCodeRevision: this.snapshot.manifest.codeRevision });
                } else if (value.type === 'persistence-request') {
                    if (!value.data || typeof value.data !== 'object' || !bounded(value.data)) throw failure('图表数据超出限制。', 'CHART_DATA_INVALID');
                    const intent = String(value.operationId || '');
                    if (!/^[a-zA-Z0-9._:-]{1,120}$/.test(intent)) throw failure('缺少稳定图表操作ID。', 'CHART_OPERATION_ID_INVALID');
                    const signature = JSON.stringify(value.data), previous = this.saveIntents.get(intent);
                    if (previous && previous.signature !== signature) throw failure('图表操作ID已用于不同数据。', 'CHART_OPERATION_ID_REUSE');
                    if (!previous && this.saveIntents.size >= 128) throw failure('当前图表操作收据数量超限。', 'CHART_OPERATION_LIMIT');
                    if (!previous) {
                        const expectedDataRevision = this.snapshot.manifest.dataRevision;
                        const promise = this.api.replaceData({ chartId, data: value.data, expectedDataRevision, operationId: `renderer:${chartId}:${intent}` });
                        this.saveIntents.set(intent, { signature, promise });
                    }
                    // A repeated intent reuses its settled/unknown promise;
                    // this adapter never retries native writes automatically.
                    result = await this.saveIntents.get(intent).promise;
                    if (generation === this.generation && !this.destroyed) {
                        this.snapshot.manifest.dataRevision = result.dataRevision;
                        this.snapshot.manifest.revision = result.revision;
                    }
                } else {
                    const action = value.action;
                    if (!['status', 'pull', 'push'].includes(action)) throw failure('不支持的同步动作。', 'CHART_CLOUD_ACTION_INVALID');
                    if (action !== 'status') throw failure('隔离图表没有可复用的外部同步动作授权。', 'CHART_CLOUD_ACTION_NOT_AUTHORIZED');
                    if (chartId !== 'jenn-shooting-planner') result = { enabled: false, reason: 'CHART_SCOPE_NOT_AUTHORIZED', actions: [] };
                    else {
                        const status = await this.api.syncShootingPlanner({ chartId, action: 'status' });
                        result = { enabled: Boolean(status?.enabled), reason: status?.enabled ? 'CHART_CLOUD_ACTION_NOT_AUTHORIZED' : 'NOT_CONFIGURED', actions: [] };
                    }
                }
                if (!bounded(result, value.type === 'data-source-request' ? 24 * 1024 * 1024 : MAX_JSON)) throw failure('图表响应超出限制。', 'CHART_RESPONSE_TOO_LARGE');
                if (!this.destroyed && generation === this.generation) this.send(response, { requestId: value.requestId, result });
            } catch (error) {
                if (!this.destroyed && generation === this.generation) this.send(response, { requestId: value.requestId, error: String(error.message || error).slice(0, 240) });
            }
        }
        async update(change) {
            if (this.destroyed) return;
            if (change.dataRevision !== undefined) this.snapshot.manifest.dataRevision = change.dataRevision;
            if (change.revision !== undefined) this.snapshot.manifest.revision = change.revision;
            this.send('data-change', { change: clone(change) });
        }
        async resize(size) { this.send('resize', { size: clone(size) }); }
        async setTheme(theme) { this.send('theme', { theme }); }
        collectDiagnostics() { return this.diagnostics; }
        reportError(error) {
            if (this.destroyed) return;
            clearTimeout(this.mountTimer);
            this.rejectMount?.(error); this.resolveMount = this.rejectMount = null;
            this.setStatus('error', error.message);
            this.onError({ message: String(error.message || error).slice(0, 500), diagnostics: this.diagnostics });
        }
        async destroy(announce = true) {
            if (this.destroyed) return;
            this.send('destroy');
            this.destroyed = true;
            clearTimeout(this.mountTimer);
            this.host.ownerDocument.defaultView.removeEventListener('message', this.receive);
            this.rejectMount?.(failure('图表实例已关闭。', 'CHART_SANDBOX_REMOVED'));
            this.resolveMount = this.rejectMount = null;
            this.frame?.remove(); this.frame = null;
            this.saveIntents.clear();
            if (announce) this.setStatus('destroyed', '运行时已销毁');
        }
    }
    window.VCPChartRuntime = Object.freeze({ ChartRuntime });
})();

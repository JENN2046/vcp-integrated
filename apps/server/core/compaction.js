'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { CoreTurnSink } = require('./turnSink');
const { failure } = require('./store');
const native = require('../modules/requestExecutionContext');
const { effectiveContextHistory } = require('@vcp/native-history-window');
const { fieldsFrom } = require('../Plugin/NativeSync/sync/metadata');

let helpers;
function nativeCompaction() {
    // The integrated native history package is a local dependency of ToolBox.
    // Its adjacent VCPChat modules own the checkpoint parser and prompt.
    const chat = path.resolve(path.dirname(require.resolve('@vcp/native-history-window')), '..');
    return helpers ||= Promise.all(['contextCompactionState', 'contextCompactionPrompts', 'contextCompactionService']
        .map(name => import(pathToFileURL(path.join(chat, name + '.js')).href)))
        .then(parts => Object.assign({}, ...parts));
}

class CoreCompaction {
    constructor({ store, chat, sourceHash, publish, onBusy }) {
        Object.assign(this, { store, chat, sourceHash, publish, onBusy });
        this.running = new Map();
    }

    unsettled(key) {
        return this.store.db.prepare(`SELECT 1 FROM core_aa_tasks t JOIN works w ON w.id=t.work_id
            WHERE w.conversation_id=? AND t.state IN ('accepted','waiting','running','cancelling','unknown') LIMIT 1`).get(key);
    }

    validateManual(key) {
        this.store.requireIdleCompaction(key);
        if (this.unsettled(key)) throw failure('WORK_SAFE_BOUNDARY_PENDING');
    }

    async manual(topic, actor, body, authorize) {
        if (actor.kind !== 'desktop') throw failure('CORE_COMPACTION_DESKTOP_REQUIRED', 403);
        if (typeof body.model !== 'string' || !body.model.trim() || body.model.length > 200 ||
            body.fallbackModel !== undefined && (typeof body.fallbackModel !== 'string' || body.fallbackModel.length > 200)) {
            throw failure('CORE_COMPACTION_MODEL_REQUIRED', 400);
        }
        const templates = ['contextCompactionPrompt', 'contextCompactionSendPrompt', 'contextCompactionMainPrompt'];
        for (const field of templates) {
            if (body[field] !== undefined && (typeof body[field] !== 'string' || body[field].length > 128000)) {
                throw failure('INVALID_COMPACTION_PROMPT', 400);
            }
        }
        const config = { enableContextCompaction: true, contextCompactionModel: body.model,
            contextCompactionFallbackModel: body.fallbackModel,
            ...Object.fromEntries(templates.filter(field => body[field] !== undefined).map(field => [field, body[field]])) };
        const key = topic.key, principal = actor.principal;
        const operation = { op: 'core_compaction', key, config };
        const prior = this.store.replay(principal, body.requestId, operation);
        if (prior) {
            if (prior.pending) {
                const live = this.running.get(key);
                if (live?.requestId === body.requestId && live.principal === principal) return live.done;
                throw failure('CORE_COMPACTION_OUTCOME_UNKNOWN');
            }
            if (prior.error) throw failure(prior.error);
            return prior;
        }
        if (this.draining || this.running.has(key)) throw failure('CORE_COMPACTION_BUSY');
        this.validateManual(key);
        const history = effectiveContextHistory(this.store.compactionHistory(key));
        if (!history.length) throw failure('CORE_COMPACTION_EMPTY');
        if (history.some(message => message.desktopReferences?.length)) throw failure('CORE_COMPACTION_LIVE_REFERENCES');
        const source = this.sourceHash(topic, principal, body.requestId);
        const fence = () => {
            if (this.draining) throw failure('HOST_DRAINING', 503);
            authorize();
            this.validateManual(key);
            if (source !== this.sourceHash(topic, principal, body.requestId)) throw failure('SHARED_COMPACTION_SOURCE_CHANGED');
        };
        const controller = new AbortController();
        const writeReceipt = receipt => this.store.db.prepare('UPDATE idempotency_receipts SET result_json=? WHERE principal=? AND op_id=?')
            .run(JSON.stringify(receipt), principal, body.requestId);
        this.store.command(principal, body.requestId, operation, () => ({ pending: true }));
        const done = this.execute({
            history, config, requestId: 'compact_' + body.requestId, signal: controller.signal,
            fence, phase: () => {}, commit: message => this.store.transaction(() => {
                fence();
                const seq = this.insert(topic.key, message);
                const result = { success: true, messageId: message.id, seq };
                writeReceipt(result);
                return result;
            })
        }).then(receipt => {
            this.publish(key, 'change_seq', { seq: receipt.seq });
            return receipt;
        }).catch(error => {
            const code = controller.signal.aborted ? 'CORE_COMPACTION_CANCELLED' : error.code || 'CORE_COMPACTION_FAILED';
            if (code !== 'CORE_PROVIDER_OUTCOME_UNKNOWN' && code !== 'CORE_COMPACTION_OUTCOME_UNKNOWN') {
                writeReceipt({ error: code });
            }
            throw failure(code);
        }).finally(() => {
            this.running.delete(key);
            this.onBusy();
        });
        this.running.set(key, { requestId: body.requestId, principal, controller, done });
        this.onBusy();
        return done;
    }

    cancel(topic, actor, requestId) {
        const live = this.running.get(topic.key);
        if (!live) return { success: true, cancelRequested: false };
        if (live.principal !== actor.principal || live.requestId !== requestId) throw failure('WORK_CONTROL_FORBIDDEN', 403);
        live.controller.abort();
        return { success: true, cancelRequested: true };
    }

    async automatic(topic, work, frozen, signal, fence) {
        const policy = frozen.executionPolicy;
        if (!policy?.enableContextCompaction || !policy.contextCompactionModel || this.unsettled(topic.key) ||
            this.running.has(topic.key)) return;
        const history = effectiveContextHistory(this.store.history(work));
        const input = history.find(message => message.id === work.user_message_id);
        const previous = history.filter(message => message.ordinal < input?.ordinal);
        if (!input || previous.some(message => message.desktopReferences?.length)) return;
        const { shouldCompactContext } = await nativeCompaction();
        if (!shouldCompactContext(previous, frozen, input.content)) return;
        const requestId = 'auto_compact_' + work.id;
        const source = this.sourceHash(topic, work.principal, requestId);
        const verify = () => {
            fence();
            if (source !== this.sourceHash(topic, work.principal, requestId)) throw failure('SHARED_COMPACTION_SOURCE_CHANGED');
        };
        const receipt = await this.execute({
            history: previous, config: policy, requestId, signal, fence: verify,
            phase: () => this.store.db.prepare('UPDATE works SET dispatched=1 WHERE id=?').run(work.id),
            commit: message => this.store.transaction(() => {
                verify();
                return { seq: this.insert(topic.key, message, { sourceWorkId: work.id, after: input.ordinal - 0.5 }) };
            })
        });
        this.publish(topic.key, 'change_seq', { seq: receipt.seq });
    }

    insert(key, message, options = {}) {
        return this.store.insertMessage({
            ...options, key, id: message.id, role: 'user', content: message.content,
            checkpoint: fieldsFrom(message).contextCompaction
        });
    }

    async execute({ history, config, requestId, signal, fence, phase, commit }) {
        const { prepareCompactionState, buildCompactionMessages, createCheckpointMessage, compactionSettings } = await nativeCompaction();
        const state = prepareCompactionState(history);
        if (!state.sourceCount) throw failure('CORE_COMPACTION_EMPTY');
        const options = compactionSettings(config);
        const models = [...new Set([options.model, options.fallbackModel].filter(Boolean))];
        for (const model of models) {
            fence();
            signal.throwIfAborted();
            const settings = { ...config, contextCompactionModel: model };
            let receipt;
            const sink = new CoreTurnSink({ signal, observe: () => {}, present: () => {}, commit: content => {
                const checkpoint = createCheckpointMessage(state, content, settings, { id: 'checkpoint_' + requestId });
                receipt = commit(checkpoint);
            } });
            const upstream = sink.onUpstreamError.bind(sink);
            sink.onUpstreamError = event => { sink.upstreamStatus = event.status; upstream(event); };
            await native.runCoreTurn({ workId: requestId, signal, fence, phase, textOnly: true, observe: () => {} },
                () => this.chat.executeTurn({ body: { requestId, model, stream: true,
                    messages: buildCompactionMessages(state, settings) }, signal, clientIp: null }, sink));
            if (receipt) return receipt;
            signal.throwIfAborted();
            if (![400, 404, 422, 429].includes(sink.upstreamStatus)) throw failure(sink.errorCode || 'CORE_COMPACTION_OUTCOME_UNKNOWN');
        }
        throw failure('CORE_COMPACTION_UPSTREAM_REJECTED');
    }

    beginDrain() { this.draining = true; }
    async close() {
        this.beginDrain();
        for (const active of this.running.values()) active.controller.abort();
        await Promise.allSettled([...this.running.values()].map(active => active.done));
    }
}

module.exports = { CoreCompaction };

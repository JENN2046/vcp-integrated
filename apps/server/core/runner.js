'use strict';

const native = require('../modules/requestExecutionContext');
const { CoreTurnSink } = require('./turnSink');
const { failure } = require('./store');

class CoreRunner {
    constructor({ store, chat, resolveAcceptedTopic, buildPacket, allowedAgents, sponsor }) {
        this.store = store;
        this.chat = chat;
        this.resolveAcceptedTopic = resolveAcceptedTopic;
        this.buildPacket = buildPacket;
        this.sponsor = sponsor;
        this.running = new Map();
        this.observers = new Map();
        const { CoreAgentAssistant } = require('./agentAssistant');
        this.agentAssistant = new CoreAgentAssistant({ store, chat, resolveAcceptedTopic, allowedAgents,
            publish: (key, type, value) => this.publish(key, type, value) });
    }

    recover() {
        this.store.recover(work => Boolean(this.resolveAcceptedTopic(work)));
        this.wake();
    }

    publish(key, type, data) {
        for (const listener of this.observers.get(key) || []) {
            try { listener(type, data); }
            catch (error) { console.warn('[Core] observation failed', error.code || error.name); }
        }
    }

    observe(key, listener) {
        if (!this.observers.has(key)) this.observers.set(key, new Set());
        const observers = this.observers.get(key);
        observers.add(listener);
        const current = this.running.get(key);
        if (current) {
            listener('work_preview', { workId: current.id, text: current.text });
            for (const approval of current.approvals.values()) listener('approval_requested', approval);
            for (const [type, presentation] of current.presentations) listener(type, presentation);
        }
        return () => {
            observers.delete(listener);
            if (!observers.size) this.observers.delete(key);
        };
    }

    wake() {
        if (this.scheduled || this.draining) return;
        this.scheduled = true;
        setImmediate(() => {
            this.scheduled = false;
            if (this.draining) return;
            try {
                const queue = this.store.db.prepare(`SELECT q.* FROM works q WHERE q.status='queued'
                    AND NOT EXISTS(SELECT 1 FROM works b WHERE b.conversation_id=q.conversation_id
                        AND b.status IN ('running','waiting_approval','cancelling','review_required'))
                    ORDER BY admitted_seq`).all();
                for (const work of queue) {
                    if (this.running.has(work.conversation_id)) continue;
                    const claimed = this.store.db.prepare("UPDATE works SET status='running' WHERE id=? AND status='queued' AND dispatched=0").run(work.id);
                    if (!claimed.changes) continue;
                    const controller = new AbortController();
                    const runtime = { id: work.id, controller, text: '', approvals: new Map(), presentations: new Map() };
                    this.running.set(work.conversation_id, runtime);
                    runtime.done = this.run(work, runtime).catch(error => {
                        console.error('[Core] Work state could not be saved', work.id, error.code || error.name);
                        this.publish(work.conversation_id, 'persistence_error', { workId: work.id });
                    }).finally(() => {
                        this.running.delete(work.conversation_id);
                        this.wake();
                    });
                }
            } catch (error) {
                console.error('[Core] Work queue unavailable', error.code || error.name);
            }
        });
    }

    cancel(key, id) {
        const runtime = this.running.get(key);
        if (runtime?.id === id) runtime.controller.abort();
    }

    async run(work, runtime) {
        const { id, conversation_id: key } = work;
        const { signal } = runtime.controller;
        const observe = (type, data) => {
            const payload = { ...data, workId: id };
            if (type === 'delta') runtime.text = (runtime.text + data.text).slice(-256 * 1024);
            if (type === 'approval_requested') {
                runtime.approvals.set(data.hostApprovalRequestId, payload);
                if (this.store.work(id)?.status === 'running') this.store.setState(id, 'waiting_approval');
            }
            if (type === 'approval_settled') {
                runtime.approvals.delete(data.hostApprovalRequestId);
                if (!runtime.approvals.size && this.store.work(id)?.status === 'waiting_approval') this.store.setState(id, 'running');
            }
            this.publish(key, type, payload);
        };
        const fence = () => {
            signal.throwIfAborted();
            if (!this.resolveAcceptedTopic(work) || !['running', 'waiting_approval'].includes(this.store.work(id)?.status)) throw failure('WORK_FENCED');
        };
        let continuation;
        let previousTurn;
        let includedCount;
        const sink = new CoreTurnSink({
            signal, observe,
            present: (type, presentation) => {
                const payload = { ...presentation, workId: id };
                runtime.presentations.set(type, payload);
                this.publish(key, type, payload);
            },
            commit: content => {
                fence();
                if (typeof content !== 'string' || !content.trim() || this.store.unresolved(id)) throw failure('WORK_FINAL_UNSETTLED');
                if (this.store.work(id).steering_count > includedCount) {
                    continuation = { content, includedCount };
                    return false;
                }
                this.store.saveFinal(work, content);
                const result = this.store.transaction(() => this.store.finish(id));
                this.publish(key, 'change_seq', { seq: result.seq });
                observe('work_state', result);
            }
        });
        observe('work_state', { status: 'running' });
        try {
            const topic = this.resolveAcceptedTopic(work);
            if (!topic) throw failure('WORK_AUTHORITY_REVOKED');
            const config = JSON.parse(work.frozen_config_json);
            await native.runCoreTurn({
                workId: id, signal, fence, observe,
                ...(topic.actor?.kind === 'desktop' && !config.sponsoredByWorkId && { coreSponsor: (invocation, args) => this.sponsor(work, invocation, args) }),
                coreAA: {
                    assertAllowed: (args, indirect) => this.agentAssistant.assertAllowed(work, args, indirect),
                    link: (plugin, taskId) => this.agentAssistant.link(work, plugin, taskId),
                    accept: identity => this.agentAssistant.accept(work, identity)
                },
                agentAlias: config.agentAlias, agentPrompt: config.systemPrompt,
                phase: () => this.store.db.prepare('UPDATE works SET dispatched=1 WHERE id=? AND dispatched=0').run(id),
                bridge: {
                    onToolDispatch: ({ invocationId, pluginName, recordId }) => {
                        fence();
                        this.store.db.prepare("INSERT INTO work_invocations (id,work_id,plugin_name,record_id,status) VALUES(?,?,?,?,'dispatched')")
                            .run(invocationId, id, pluginName, recordId);
                        observe('tool', { invocationId, pluginName, status: 'dispatched' });
                    },
                    onToolSettled: ({ invocationId, pluginName, outcome, value, errorCode }) => {
                        const saved = this.store.db.prepare("UPDATE work_invocations SET status=?,result_json=?,error_code=? WHERE id=? AND work_id=? AND status='dispatched'")
                            .run(outcome, value === undefined ? null : JSON.stringify(value), errorCode, invocationId, id);
                        if (saved.changes !== 1) throw failure('TOOL_SETTLEMENT_FENCED');
                        observe('tool', { invocationId, pluginName, status: outcome });
                    }
                }
            }, async () => {
                do {
                    continuation = null;
                    includedCount = this.store.work(id).steering_count;
                    const packet = await this.buildPacket(topic, work, config, previousTurn);
                    fence();
                    await this.chat.executeTurn({ body: packet, signal, clientIp: null }, sink);
                    if (continuation) {
                        previousTurn = continuation;
                        runtime.text = '';
                        observe('work_preview', { text: '' });
                    }
                } while (continuation);
            });
        } catch (error) {
            sink.errorCode = error.code || 'TURN_FAILED';
        }
        const state = this.store.work(id);
        if (state.status === 'completed') return;
        if (state.pending_final_json && state.status === 'running') {
            this.publish(key, 'persistence_error', { workId: id });
            return;
        }
        const result = this.store.transaction(() => {
            if (this.store.unresolved(id)) return this.store.review(id, 'TOOL_EXECUTION_UNCONFIRMED');
            if (sink.errorCode === 'CORE_PROVIDER_OUTCOME_UNKNOWN') return this.store.review(id, sink.errorCode);
            if (state.status === 'cancelling' || signal.aborted) return this.store.setState(id, 'cancelled');
            if (state.dispatched && !sink.errorCode) return this.store.review(id, 'UPSTREAM_INCOMPLETE');
            return this.store.setState(id, 'failed', sink.errorCode || 'TURN_FAILED');
        });
        observe('work_state', result);
    }

    beginDrain() { this.draining = true; }
    async close() {
        this.beginDrain();
        this.agentAssistant.close();
        for (const runtime of this.running.values()) runtime.controller.abort();
        await Promise.allSettled([...this.running.values()].map(runtime => runtime.done));
    }
}

module.exports = { CoreRunner };

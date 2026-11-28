'use strict';

const { createWorkAuthority } = require('./nativeCapabilityGrants');

const native = require('../modules/requestExecutionContext');
const { CoreTurnSink } = require('./turnSink');
const { failure } = require('./store');
const { planGroup, buildGroupPacket } = require('./group');

class CoreRunner {
    constructor({ store, chat, resolveAcceptedTopic, buildPacket, allowedAgents, sponsor, send, automaticCompaction, isCompacting, attachments, desktopContext, memoryTool, readNativeGrants }) {
        this.store = store;
        this.chat = chat;
        this.attachments = attachments;
        this.desktopContext = desktopContext;
        this.readNativeGrants = readNativeGrants;
        this.memoryTool = memoryTool;
        this.resolveAcceptedTopic = resolveAcceptedTopic;
        this.buildPacket = buildPacket;
        this.sponsor = sponsor;
        this.automaticCompaction = automaticCompaction;
        this.running = new Map();
        this.observers = new Map();
        const { CoreAgentAssistant } = require('./agentAssistant');
        const publish = (key, type, value) => this.publish(key, type, value);
        this.agentAssistant = new CoreAgentAssistant({ store, chat, resolveAcceptedTopic, allowedAgents, publish, readNativeGrants });
        const { CoreFlowlock } = require('./flowlock');
        this.flowlock = new CoreFlowlock({ store, resolveTopic: resolveAcceptedTopic, send, publish, isCompacting });
    }

    recover() {
        this.store.recover(work => Boolean(this.resolveAcceptedTopic(work)),
            (work, content) => this.flowlock.afterFinal(work, content));
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
            listener('work_preview', { workId: current.id, text: current.text, ...current.speaker });
            for (const approval of current.approvals.values()) listener('approval_requested', approval);
            for (const [type, presentation] of current.presentations) listener(type, presentation);
        }
        return () => {
            observers.delete(listener);
            if (!observers.size) this.observers.delete(key);
        };
    }

    wake() {
        this.flowlock.schedule();
        if (this.scheduled || this.draining) return;
        this.scheduled = true;
        setImmediate(() => {
            this.scheduled = false;
            if (this.draining) return;
            try {
                const queue = this.store.db.prepare(`SELECT q.* FROM works q WHERE q.status='queued'
                    AND NOT EXISTS(SELECT 1 FROM works b WHERE b.conversation_id=q.conversation_id
                        AND b.status IN ('running','waiting_approval','cancelling','review_required'))
                    ORDER BY admitted_seq,q.rowid`).all();
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
        const config = JSON.parse(work.frozen_config_json);
        const observe = (type, data) => {
            if (config.game && ['delta','tool_display'].includes(type)) return;
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
        let step = work;
        const group = work.group_ordinal !== null;
        const sink = new CoreTurnSink({
            signal, observe,
            present: (type, presentation) => {
                if (config.game) return;
                const payload = { ...presentation, workId: id };
                runtime.presentations.set(type, payload);
                this.publish(key, type, payload);
            },
            commit: content => {
                fence();
                if ((!config.game && (typeof content !== 'string' || !content.trim())) || this.store.unresolved(id)) throw failure('WORK_FINAL_UNSETTLED');
                if (this.store.work(id).steering_count > includedCount) {
                    continuation = { content, includedCount };
                    return false;
                }
                this.store.saveFinal(step, config.game ? null : content);
                let flowlockChanged;
                const result = this.store.transaction(() => {
                    const receipt = this.store.finish(id);
                    if (!group) flowlockChanged = this.flowlock.afterFinal(work, content);
                    return receipt;
                });
                if (flowlockChanged) this.publish(key, 'flowlock_state', {});
                this.publish(key, 'change_seq', { seq: result.seq });
                observe('work_state', result);
            }
        });
        observe('work_state', { status: 'running' });
        try {
            const topic = this.resolveAcceptedTopic(work);
            if (!topic) throw failure('WORK_AUTHORITY_REVOKED');
            if (config.game) this.desktopContext.gameNode(topic);
            if (!group) await this.automaticCompaction(topic, work, config, signal, fence);
            const execute = (agent, turn) => native.runCoreTurn({
                workId: id, signal, fence, observe,
                coreNativeAuthority: createWorkAuthority(this.readNativeGrants, topic.workspace, group ? agent.id : topic.ownerId, fence),
                ...(this.sponsor && !group && topic.actor?.kind === 'desktop' && !config.sponsoredByWorkId && { coreSponsor: (invocation, args) => this.sponsor(work, invocation, args) }),
                coreMemory: (name, args, pluginConfig) => this.memoryTool(topic, name, args, pluginConfig),
                ...(config.game && { coreGame: args => this.desktopContext.gameTool(topic, config.game, agent.name, args) }),
                coreAA: {
                    assertAllowed: (args, baseName) => this.agentAssistant.assertAllowed(work, args, baseName),
                    link: (plugin, taskId) => this.agentAssistant.link(work, plugin, taskId),
                    accept: identity => this.agentAssistant.accept(work, identity)
                },
                agentAlias: agent.agentAlias, agentPrompt: agent.systemPrompt,
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
            }, turn);
            if (group) {
                let plan = step.group_plan_json && JSON.parse(step.group_plan_json);
                if (!plan) {
                    plan = planGroup(config, this.store.history(work), work.user_message_id, signal);
                    fence();
                    this.store.db.prepare('UPDATE works SET group_plan_json=? WHERE id=?').run(JSON.stringify(plan), id);
                }
                if (!plan.length) {
                    observe('work_state', this.store.setState(id, 'completed'));
                    return;
                }
                for (const memberId of plan.slice(step.group_step)) {
                    step = this.store.work(id);
                    const member = config.agents.find(agent => agent.id === memberId);
                    includedCount = step.steering_count;
                    runtime.text = '';
                    fence();
                    runtime.speaker = { step: step.group_step, speaker: memberId, speakerName: member.name || member.id };
                    observe('work_preview', { text: '', ...runtime.speaker });
                    const packet = await buildGroupPacket(topic, step, config, member, this.store.history(work), this.attachments, this.desktopContext);
                    fence();
                    await execute(member, () => this.chat.executeTurn({ body: packet.body, signal, clientIp: null }, sink));
                    if (this.store.work(id).group_step === step.group_step) break;
                }
            } else await execute(config, async () => {
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
            if (!group) this.flowlock.endWork(work);
            if (this.store.unresolved(id)) return this.store.review(id, 'TOOL_EXECUTION_UNCONFIRMED');
            if (['CORE_PROVIDER_OUTCOME_UNKNOWN', 'CORE_COMPACTION_OUTCOME_UNKNOWN'].includes(sink.errorCode)) return this.store.review(id, sink.errorCode);
            if (state.status === 'cancelling' || signal.aborted) return this.store.setState(id, 'cancelled');
            if (state.dispatched && !sink.errorCode) return this.store.review(id, 'UPSTREAM_INCOMPLETE');
            return this.store.setState(id, 'failed', sink.errorCode || 'TURN_FAILED');
        });
        this.publish(key, 'flowlock_state', {});
        observe('work_state', result);
    }

    beginDrain() { this.draining = true; this.flowlock.beginDrain(); }
    async close() {
        this.beginDrain();
        this.agentAssistant.close();
        await this.flowlock.close();
        for (const runtime of this.running.values()) runtime.controller.abort();
        await Promise.allSettled([...this.running.values()].map(runtime => runtime.done));
    }
}

module.exports = { CoreRunner };

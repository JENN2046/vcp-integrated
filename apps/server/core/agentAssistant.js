'use strict';

const native = require('../modules/requestExecutionContext');
const { CoreTurnSink } = require('./turnSink');
const { failure } = require('./store');

const plugin = 'AgentAssistant';
const active = new Set(['accepted', 'waiting', 'running', 'cancelling']);
const terminal = new Set(['completed', 'failed', 'cancelled', 'stopped']);

class CoreAgentAssistant {
    constructor({ store, chat, allowedAgents, resolveAcceptedTopic, publish }) {
        Object.assign(this, { store, chat, allowedAgents, resolveAcceptedTopic, publish });
        this.attempts = new Map();
        this.closed = false;
        store.db.exec(`
            CREATE TABLE IF NOT EXISTS core_aa_tasks (
                id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id),
                invocation_id TEXT NOT NULL UNIQUE REFERENCES work_invocations(id),
                identity_json TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS core_aa_work ON core_aa_tasks(work_id);
            CREATE TABLE IF NOT EXISTS core_aa_attempts (
                id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES core_aa_tasks(id), state TEXT NOT NULL
            );
        `);
    }

    assertAllowed(work, args, indirect) {
        if (indirect || !args || args.timely_contact !== undefined || args.inject_tools !== undefined ||
            args.cancel_delegation !== undefined || args.temporary_contact !== undefined || args.__vcp_timed_call !== undefined) {
            throw failure('CORE_AA_DELEGATION_REQUIRED');
        }
        if (args.query_delegation) {
            if (!this.link(work, plugin, args.query_delegation)) throw failure('CORE_AA_TASK_SCOPE_REQUIRED', 403);
            return;
        }
        if (String(args.task_delegation).toLowerCase() !== 'true' || !this.allowedAgents.has(args.agent_name) ||
            !native.hasNativeTaskProvider(plugin)) throw failure('CORE_AA_DELEGATION_REQUIRED');
    }

    row(id) {
        return this.store.db.prepare('SELECT * FROM core_aa_tasks WHERE id=?').get(id);
    }

    link(work, pluginName, id) {
        if (pluginName !== plugin) return null;
        const row = this.row(id);
        return row?.work_id === work.id ? { workId: work.id, identity: JSON.parse(row.identity_json) } : null;
    }

    accept(work, identity) {
        if (this.closed || identity.pluginName !== plugin || identity.requestId !== work.id ||
            typeof identity.nativeTaskId !== 'string' || typeof identity.agentBaseName !== 'string') {
            throw failure('CORE_AA_TASK_IDENTITY_INVALID');
        }
        const invocation = this.store.db.prepare("SELECT 1 FROM work_invocations WHERE id=? AND work_id=? AND plugin_name=? AND status='dispatched'")
            .get(identity.invocationId, work.id, plugin);
        if (!invocation) throw failure('CORE_AA_INVOCATION_REQUIRED');
        this.store.db.prepare("INSERT INTO core_aa_tasks(id,work_id,invocation_id,identity_json,state) VALUES(?,?,?,?,'accepted')")
            .run(identity.nativeTaskId, work.id, identity.invocationId, JSON.stringify(identity));
        this.update(work, identity, { state: 'accepted' });
        return {
            identity, core: true, observe: value => this.update(work, identity, value),
            requests: {
                execute: body => this.runRound(work, identity, body),
                confirmFinal: requestId => {
                    const unresolved = this.store.db.prepare("SELECT 1 FROM core_aa_attempts WHERE task_id=? AND state='dispatched'").get(identity.nativeTaskId);
                    if (unresolved || requestId && !this.store.db.prepare('SELECT 1 FROM core_aa_attempts WHERE task_id=? AND id=?')
                        .get(identity.nativeTaskId, requestId)) throw failure('NATIVE_TASK_RESULT_REQUIRES_REVIEW');
                    return 0;
                }
            }
        };
    }

    update(work, identity, observation) {
        const row = this.row(identity.nativeTaskId);
        if (!row || row.work_id !== work.id || terminal.has(row.state)) return;
        let { state } = observation;
        if (!active.has(state) && state !== 'unknown') state = native.verifyNativeTaskArchive(plugin, identity)?.state || 'unknown';
        const revision = terminal.has(state) ? 1 : 0;
        this.store.db.prepare('UPDATE core_aa_tasks SET state=?, revision=? WHERE id=?').run(state, revision, row.id);
        if (row.state !== state) this.publish(work.conversation_id, 'native_task', { workId: work.id, taskId: row.id, state });
    }

    async runRound(work, identity, packet) {
        const taskId = identity.nativeTaskId, id = packet.requestId;
        if (typeof id !== 'string' || !id.startsWith(taskId + '-round-')) throw failure('CORE_AA_REQUEST_IDENTITY_INVALID');
        const controller = new AbortController();
        const { signal } = controller;
        const fence = () => {
            signal.throwIfAborted();
            // Once accepted, the native task has its own lifecycle and stop command.
            if (this.closed || !this.resolveAcceptedTopic(work) || !active.has(this.row(taskId)?.state)) {
                throw failure('CORE_AA_REQUEST_FENCED');
            }
        };
        try {
            fence();
            this.store.db.prepare("INSERT INTO core_aa_attempts VALUES(?,?,'prepared')").run(id, taskId);
        } catch (error) {
            if (error.code === 'CORE_AA_REQUEST_FENCED') throw error;
            throw failure('CORE_AA_REQUEST_UNCONFIRMED');
        }
        this.attempts.set(taskId, controller);
        let committed;
        const sink = new CoreTurnSink({ signal, observe: () => {}, present: () => {}, commit: value => {
            fence();
            this.store.db.prepare("UPDATE core_aa_attempts SET state='settled' WHERE id=? AND state='dispatched'").run(id);
            committed = value;
        } });
        // Keep the native AA loop, prompts and archive, but execute child
        // model rounds in-process with the text-only authority of shared AA.
        const body = structuredClone(packet);
        body.messages[0].content = '[[VCPToolUse=Forbidden]]\n' + body.messages[0].content;
        try {
            await native.runCoreTurn({
                workId: work.id, requestId: id, signal, fence, textOnly: true, observe: () => {},
                phase: () => this.store.db.prepare("UPDATE core_aa_attempts SET state='dispatched' WHERE id=? AND state='prepared'").run(id)
            }, () => this.chat.executeTurn({ body, clientIp: null, signal }, sink));
            if (typeof committed !== 'string') throw failure(sink.errorCode || 'CORE_AA_REQUEST_UNCONFIRMED');
            return { data: { model: packet.model, choices: [{ message: { content: committed } }] } };
        } finally { this.attempts.delete(taskId); }
    }

    async list(work) {
        const rows = this.store.db.prepare('SELECT * FROM core_aa_tasks WHERE work_id=? ORDER BY rowid').all(work.id);
        return Promise.all(rows.map(async row => {
            const identity = JSON.parse(row.identity_json);
            if (!terminal.has(row.state)) {
                let projection;
                try { projection = await native.queryNativeTask(plugin, identity); }
                catch { projection = { state: 'unknown' }; }
                this.update(work, identity, projection);
                row = this.row(row.id);
            }
            return { id: row.id, invocationId: row.invocation_id, agent: identity.agentBaseName,
                state: row.state, revision: row.revision };
        }));
    }

    async stop(work, taskId) {
        const link = this.link(work, plugin, taskId);
        if (!link) throw failure('NATIVE_TASK_NOT_FOUND', 404);
        const state = await native.controlNativeTask(plugin, link.identity, { action: 'stop' });
        this.update(work, link.identity, state);
        return { id: taskId, state: this.row(taskId).state };
    }

    result(work, taskId) {
        const link = this.link(work, plugin, taskId);
        if (!link) throw failure('NATIVE_TASK_NOT_FOUND', 404);
        const archive = native.verifyNativeTaskArchive(plugin, link.identity);
        if (!archive) throw failure('NATIVE_TASK_RESULT_UNCONFIRMED');
        this.update(work, link.identity, archive);
        return { id: taskId, state: archive.state, revision: archive.revision, content: archive.resultContent };
    }

    expandResults(key, messages) {
        for (const message of messages) {
            const expand = text => text.replace(/\{\{VCP_ASYNC_RESULT::AgentAssistant::(aa-delegation-[a-zA-Z0-9-]+)\}\}/g,
                (_placeholder, taskId) => {
                    const task = this.row(taskId);
                    if (!task || this.store.work(task.work_id)?.conversation_id !== key) return '[AgentAssistant 报告不可用]';
                    try {
                        const result = this.result(this.store.work(task.work_id), taskId);
                        return '[AgentAssistant 原生报告]\n' + result.content + '\n[/AgentAssistant 原生报告]';
                    } catch {
                        return '[AgentAssistant 委托 ' + taskId + ' · ' + task.state + ']';
                    }
                });
            if (typeof message.content === 'string') message.content = expand(message.content);
            else if (Array.isArray(message.content)) {
                for (const part of message.content) if (part.type === 'text') part.text = expand(part.text);
            }
        }
    }

    close() {
        this.closed = true;
        for (const controller of this.attempts.values()) controller.abort();
    }
}

module.exports = { CoreAgentAssistant };

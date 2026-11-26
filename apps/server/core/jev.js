'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { failure } = require('./store');

const desktop = () => path.resolve(path.dirname(require.resolve('@vcp/native-history-window')), '../../..');

function configuredJev() {
    const key = process.env.VCP_CORE_JEV_API_KEY;
    if (!key) return null;
    const { GlobalJevService } = require(path.join(desktop(), 'modules/services/globalJevService'));
    return new GlobalJevService({ settingsManager: { readSettings: async () => ({
        jevEnabled: true, jevApiKey: key, jevProvider: process.env.VCP_CORE_JEV_PROVIDER,
        jevApiUrl: process.env.VCP_CORE_JEV_URL, jevModel: process.env.VCP_CORE_JEV_MODEL
    }) } });
}

class CoreJev {
    constructor(service, jevService, snapshot) {
        this.core = service;
        this.snapshot = snapshot;
        this.sessions = new Map();
        this.shutdown = new AbortController();
        const { JevGroupSessionOrchestrator } = require(path.join(desktop(), 'Groupmodules/jevGroupSessionOrchestrator'));
        this.native = new JevGroupSessionOrchestrator({
            jevService,
            loadGroupConfig: async (groupId, topicId) => this.sessions.get(topicId).config.group,
            loadActiveMembers: config => config.__coreMembers,
            readHistory: (_groupId, key) => service.store.compactionHistory(key),
            runAgent: fields => this.speak(fields),
            emitEvent: event => service.runner.publish(event.context.topicId, 'jev_session', event)
        });
    }

    bind(topic, actor, config) {
        if (this.core.runner.draining) throw failure('HOST_DRAINING', 503);
        const current = this.sessions.get(topic.key);
        if (current && this.native.getState(topic.ownerId, topic.key).running) return current;
        const session = { topic, actor, config: { ...config, group: { ...config.group,
            __coreMembers: config.agents.filter(agent => !agent.unavailable) } } };
        this.sessions.set(topic.key, session);
        return session;
    }

    input(topic, actor, config, message) {
        this.bind(topic, actor, config);
        const text = message.content.toLowerCase();
        const mentions = config.agents.filter(agent => agent.name && text.includes('@' + agent.name.toLowerCase())).map(agent => agent.id);
        this.native.notifyHumanMessage(topic.ownerId, topic.key, message, mentions);
        this.native.start(topic.ownerId, topic.key);
    }

    async command(topic, actor, action, agentId) {
        const state = () => this.native.getState(topic.ownerId, topic.key);
        if (action === 'stop') {
            const current = this.sessions.get(topic.key);
            if (current && current.actor.principal !== actor.principal) throw failure('WORK_CONTROL_FORBIDDEN', 403);
            return this.native.interrupt(topic.ownerId, topic.key);
        }
        const config = await this.snapshot(topic);
        if (config?.group?.mode !== 'jev') throw failure('CORE_JEV_TOPIC_REQUIRED');
        this.core.topic(this.core.liveActor(actor.principal), topic.workspace, topic.key, 'execute');
        this.bind(topic, actor, config);
        if (action === 'start') {
            const result = this.native.startRandomOpening(topic.ownerId, topic.key);
            return { success: result.started, state: result.state };
        }
        if (action === 'continue') {
            const result = await this.native.continue(topic.ownerId, topic.key);
            return { success: result.success, state: result.state, error: result.error };
        }
        if (action === 'invite') {
            if (!config.agents.some(agent => agent.id === agentId && !agent.unavailable)) throw failure('GROUP_MEMBER_UNAVAILABLE', 403);
            return { success: true, state: this.native.enqueueAgent(topic.ownerId, topic.key, agentId) };
        }
        return { success: false, state: state() };
    }

    async speak({ topicId: key, agent, signal }) {
        const { topic, actor } = this.sessions.get(key);
        const authorize = () => {
            signal.throwIfAborted();
            return this.core.topic(this.core.liveActor(actor.principal), topic.workspace, key, 'execute');
        };
        authorize();
        const { workId } = await this.core.invite(topic, actor, { requestId: randomUUID(), agentId: agent.id }, authorize,
            null, { internal: true });
        await new Promise((resolve, reject) => {
            let stop;
            const finish = (error) => {
                stop?.();
                this.shutdown.signal.removeEventListener('abort', onClose);
                if (error) reject(error);
                else resolve();
            };
            const onClose = () => finish(failure('HOST_DRAINING'));
            if (this.shutdown.signal.aborted) return onClose();
            this.shutdown.signal.addEventListener('abort', onClose, { once: true });
            const settle = () => {
                const work = this.core.store.work(workId);
                if (['queued','running','waiting_approval','cancelling'].includes(work?.status)) return;
                finish(work?.status === 'completed' ? null : failure(work?.error_code || 'CORE_JEV_MEMBER_UNSETTLED'));
            };
            stop = this.core.runner.observe(key, (type, event) => {
                if (type === 'work_state' && event.workId === workId) settle();
            });
            settle();
        });
    }

    async close() {
        this.shutdown.abort();
        const running = [];
        for (const { topic } of this.sessions.values()) {
            const session = this.native._getOrCreate(topic.ownerId, topic.key);
            if (session.runPromise) running.push(session.runPromise);
            await this.native.interrupt(topic.ownerId, topic.key);
        }
        await Promise.allSettled(running);
    }
}

module.exports = { CoreJev, configuredJev };

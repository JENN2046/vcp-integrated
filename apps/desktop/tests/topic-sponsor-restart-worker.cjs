// Native host services on an isolated Profile. The renderer handoff records an
// actual IPC delivery attempt; the crash case exits before acknowledging it.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { openFixture } = require('./f06-host-fixture.cjs');
const { createTopicConversationResolver } = require('../modules/services/topicConversationResolver');
const { createTopicMessageAdmissionHost } = require('../modules/services/topicMessageAdmissionHost');
const { createTopicSponsorDelivery } = require('../modules/services/topicSponsorDelivery');

const creation = { command: 'CreateFlowlockTopic', maid: 'agent_a', topic_name: 'Isolated request', initial_message: 'One initial message' };
const creationContext = { requestId: 'stable-creation' };
const reply = { command: 'ReplyToTopic', sender_id: 'agent_a', topic_id: 'old_topic', message: 'One admitted reply' };
const replyContext = { requestId: 'stable-reply', topicSponsorReplyPolicy: { enabled: true } };

async function openAdmission(f, onAdvance) {
    const resolver = createTopicConversationResolver({
        agentDir: f.agentDir, groupDir: path.join(f.root, 'AgentGroups'), userDataDir: f.userDataDir,
    });
    const sender = { id: 1, isDestroyed: () => false, send(channel, request) {
        if (channel === 'topic-admission:advance') onAdvance(request);
    } };
    const handlers = new Map();
    const host = await createTopicMessageAdmissionHost({
        appDataRoot: f.root, historyQueue: f.queue, validate: scope => resolver.validate(scope),
        getMainWindow: () => ({ isDestroyed: () => false, webContents: sender }),
        ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) }, logger: { warn() {}, error() {} },
    });
    f.service.topicDelivery = createTopicSponsorDelivery({
        admission: host.service, resolver, findAgent: query => f.service.findAgent(query),
    });
    return { ...host, ipc: (channel, ...args) => handlers.get(channel)({ sender }, ...args) };
}

async function run(root, phase) {
    const f = openFixture(root);
    const host = await openAdmission(f, request => {
        fs.appendFileSync(path.join(root, 'sponsor-advance.jsonl'), JSON.stringify(request) + '\n');
        if (phase === 'crash-after-dispatch') process.kill(process.pid, 'SIGKILL');
    });
    try {
        if (phase === 'late-terminal') {
            const [entry] = host.service.snapshot();
            const result = await host.ipc('topic-admission:persist-assistant', entry.scope, {
                role: 'assistant', id: 'admission_' + entry.leaseToken, admissionToken: entry.leaseToken,
                content: 'Late terminal must not repopulate History', finishReason: 'completed',
            });
            return { result, entries: host.service.snapshot() };
        }
        const creating = phase === 'replay-creation';
        const input = phase === 'conflict-reply' ? { ...reply, message: 'A different request' } : reply;
        const receipt = await f.service.processTopicCommand(creating ? creation : input,
            creating ? creationContext : phase === 'silent-reply' ? { ...replyContext, topicSponsorReplyPolicy: { enabled: false } } : replyContext);
        if (phase === 'crash-after-dispatch') {
            // A bounded wait allows the scheduled native admission drain to dispatch.
            await new Promise(resolve => setTimeout(resolve, 2000));
            throw Error('expected real process interruption at renderer handoff');
        }
        await host.service.tail;
        return { receipt, entries: host.service.snapshot() };
    } finally {
        await host.dispose();
        await f.queue.dispose();
    }
}
if (require.main === module) {
    run(process.argv[2], process.argv[3]).then(value => console.log('SPONSOR_PROBE ' + JSON.stringify(value)),
        error => console.log('SPONSOR_PROBE ' + JSON.stringify({ rejected: error.code || error.message })));
}
module.exports = { openAdmission, creation, creationContext, reply, replyContext };

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const nativeDir = path.join(process.env.NS_HOST, 'modules/services/nativeSync');
const log = (event, data) => console.log('NS_MEASURE', JSON.stringify({ event, t: Date.now(), data }));
const sources = ['sharedRuntime.js', 'sharedReplica.js', 'sharedSessionClient.js', 'sharedExecution.js'];
log('first-send-host-digests', Object.fromEntries(sources.map(file => [
    file, createHash('sha256').update(fs.readFileSync(path.join(nativeDir, file))).digest('hex'),
])));

const { install } = require('../../integration/electron-fixture-hooks.cjs');
install({ onIpc(channel, args) {
    if (['native-sync:prepare-send', 'native-sync:stage-input', 'topic-execution:authority'].includes(channel)) {
        const [value] = args;
        log('first-send-ipc', {
            channel, descriptor: value?.descriptor ?? value, id: value?.message?.id,
            localOnly: value?.localOnly, serverSession: value?.serverSession,
        });
    }
} });

function observe(prototype, key, getArgs, getResult) {
    const original = prototype[key];
    prototype[key] = function (...args) {
        const data = getArgs(...args);
        log(`first-send-${key}:start`, data);
        const complete = value => {
            log(`first-send-${key}:end`, { ...data, ...getResult(value) });
            return value;
        };
        const fail = error => {
            log(`first-send-${key}:error`, { ...data, code: error.code, location: error.stack?.split('\n')[2] });
            throw error;
        };
        try {
            const value = original.apply(this, args);
            return value?.then ? value.then(complete, fail) : complete(value);
        } catch (error) {
            return fail(error);
        }
    };
}

const load = Module._load;
const observed = new WeakSet();
Module._load = function (request, parent, ...rest) {
    const value = load.call(this, request, parent, ...rest);
    if (!value || typeof value !== 'object' || observed.has(value)) return value;
    if (value.SharedRuntime) {
        observed.add(value);
        const prototype = value.SharedRuntime.prototype;
        observe(prototype, 'executionMapping', descriptor => ({ descriptor }), mapping => ({ sharedId: mapping.sharedId }));
        observe(prototype, 'refreshForExecution', (descriptor, options) => ({ descriptor, options }),
            context => ({ head: context.head, historyLength: context.executionHistory?.length }));
        observe(prototype, 'syncExecutionTopic', (mapping, options) => ({ sharedId: mapping.sharedId, options }),
            projection => ({ head: projection.head, topicHeadSeq: projection.topicHeadSeq }));
    }
    if (value.SharedSessionClient) {
        observed.add(value);
        observe(value.SharedSessionClient.prototype, 'prepare',
            (descriptor, message) => ({ descriptor, id: message.id }),
            receipt => ({ executionId: receipt?.serverSession?.executionId }));
    }
    if (value.SharedExecution) {
        observed.add(value);
        observe(value.SharedExecution.prototype, 'stageLocal',
            (descriptor, message) => ({ descriptor, id: message.id }),
            receipt => ({ phase: receipt.phase }));
    }
    return value;
};

require(path.join(root, 'tests/integration/electron.cjs'));

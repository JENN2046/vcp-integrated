'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { fixture, wait, ctx } = require('./fixtures/sharedSingleHarness.cjs');

const ids = { stable: 'upgrade-committed-message', interrupted: 'upgrade-interrupted-message' };
const message = id => ({ id, role: 'user', content: 'Synthetic ' + id, timestamp: 1 });

async function main() {
    const [phase, root] = process.argv.slice(2);
    const cleanup = [];
    const f = await fixture({ diagnostic() {}, after: fn => cleanup.push(fn) }, { syntheticRoot: root });
    try {
        if (phase === 'upgrade') {
            f.control.beforeRequest = (req, res, next) => req.path.endsWith('/shared/request') && req.query.requestId === ids.interrupted
                ? res.json({ request: null }) : next();
        }
        const desktop = await f.desktop('A');
        const { runtime, descriptor, queue } = desktop;
        await queue.initializeIfMissing(descriptor, []);
        const engine = f.portal.engine;
        const db = f.store.db;
        const model = () => {
            engine.startDelayMs = 0;
            engine.setEndpoint({ url: f.url + '/v1/chat/completions', key: 'synthetic-only' });
        };
        const ledger = () => runtime.execution.state.requests;
        const rows = () => db.prepare('SELECT request_id, state, attempts, request_dispatched AS dispatched FROM mobile_executions ORDER BY created_at, id').all();
        const native = () => db.prepare('SELECT id, state FROM shared_native_requests ORDER BY id').all();
        const snapshot = async () => {
            const state = JSON.parse(await fs.readFile(runtime.adapter.statePath, 'utf8'));
            return {
                journal: db.prepare('SELECT seq, msg_id, message_json FROM journal ORDER BY seq').all(),
                history: await queue.read(descriptor),
                ack: state.acked,
                cursor: state.cursor,
                topicCursors: state.topicCursors,
                pending: ledger()[ids.interrupted] && {
                    requestId: ledger()[ids.interrupted].body.requestId,
                    inputId: ledger()[ids.interrupted].localMessage.id,
                    acceptedId: ledger()[ids.interrupted].accepted?.id,
                    phase: ledger()[ids.interrupted].phase,
                    admitStarted: ledger()[ids.interrupted].admitStarted,
                },
                jobs: rows(),
                native: native(),
                modelCalls: f.calls(),
            };
        };
        if (phase === 'baseline') {
            model();
            const result = await runtime.sessions.prepare(descriptor, message(ids.stable));
            await wait(() => engine.get(result.admissionId).state === 'completed', 'baseline model completion');
            await runtime.getExecutionStatus(descriptor, { refresh: true });
            await wait(async () => (await queue.read(descriptor)).length === 2, 'baseline History projection');
            await runtime.adapter.flush();
            assert.equal(f.calls(), 1);
        } else if (phase === 'crash') {
            f.control.nativeResponder = (_req, _res) => {
                ctx.assertDispatch();
                // Leave the model in flight. The parent kills the host after
                // the real native fence and the separate local intent are durable.
            };
            f.control.dropSessionAccept = 1;
            model();
            await assert.rejects(runtime.sessions.prepare(descriptor, message(ids.interrupted)), { code: 'NETWORK_UNAVAILABLE' });
            await wait(() => native().some(row => row.state === 'dispatched'), 'native request dispatch');
            const state = await snapshot();
            assert.equal(state.modelCalls, 1);
            assert.equal(state.pending.acceptedId, undefined);
            assert.equal(state.pending.admitStarted, true);
            assert.equal(state.jobs.find(row => row.request_id === ids.interrupted).dispatched, 1);
            process.send({ result: state });
            // The process has an intentionally open HTTP request. Never drain it.
            return await new Promise(() => {});
        } else {
            model();
            const unavailable = phase === 'upgrade';
            assert.equal(rows().find(row => row.request_id === ids.interrupted).state, 'review_required');
            assert.equal(native().filter(row => row.state === 'unknown').length, 1);
            if (unavailable) {
                const pending = (await snapshot()).pending;
                assert.equal(pending.requestId, ids.interrupted);
                assert.equal(pending.acceptedId, undefined);
                assert.equal(pending.admitStarted, true);
                process.send({ intermediate: { ...pending, modelCalls: f.calls() } });
                f.control.beforeRequest = null;
            }
            await runtime.sessions.reconcile();
            await runtime.getExecutionStatus(descriptor, { refresh: true });
            await wait(() => ledger()[ids.interrupted]?.phase === 'review_required', 'reconcile original interrupted work');
            await wait(async () => (await queue.read(descriptor)).length === 3, 'durable interrupted input projection');
            assert.equal(f.calls(), 0, 'neither version may redispatch uncertain work');
        }
        return await snapshot();
    } finally {
        if (phase !== 'crash') for (const fn of cleanup.reverse()) await fn();
    }
}

main().then(result => {
    if (process.connected) {
        process.send({ result });
        process.disconnect();
    }
}, error => {
    if (process.connected) {
        process.send({ failure: error.stack });
        process.disconnect();
    }
    process.exitCode = 1;
});

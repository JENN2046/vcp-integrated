'use strict';

// Load after fault-probe.cjs. Reuses the isolated integration adapter and
// replaces its scenario with three real same-topic renderer mutations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { setTimeout: delay } = require('node:timers/promises');

if (!globalThis.nsWatchFaults) throw Error('Load fault-probe.cjs first');
globalThis.nsWatchFaults.electronFixture = path.join(__dirname, 'visibility-electron.cjs');

globalThis.nsWatchFaultScenario = async ({ A, B, out, result, service, select, click, history, journal, jobs, posts, calls, selection, waitUntil, contract, db }) => {
    const subject = 'lostAck';
    const edited = 'Synthetic shared visibility edit';
    const evalIn = (client, source) => client.command('eval', source);
    const forMessage = id => '#chatMessages .message-item[data-message-id="' + id + '"]';
    const lastSeq = () => journal(subject).at(-1)?.seq ?? 0;
    const rowsAfter = db.prepare('SELECT seq,msg_id,action,message_json FROM journal WHERE topic_id=? AND seq>? ORDER BY seq');
    const bracket = async (read, label) => {
        const deadline = Date.now() + 10000;
        let lastMissing = Date.now();
        while (Date.now() < deadline) {
            const sampledAt = Date.now();
            const value = read();
            const foundAt = Date.now();
            if (value) return { value, time: [lastMissing, foundAt] };
            lastMissing = sampledAt;
            await delay(5);
        }
        throw Error('Expected ' + label + ' not observed');
    };
    const hostCpu = () => fs.readFileSync('/proc/pressure/cpu', 'utf8').trim();
    const install = async ({ id, content, absent = false }) => {
        const scope = { id, content, absent };
        await evalIn(B, `(() => {
            const { id, content, absent } = ${JSON.stringify(scope)};
            const root = document.querySelector('#chatMessages');
            const stamp = () => performance.timeOrigin + performance.now();
            const candidates = () => id ? [...root.querySelectorAll('.message-item[data-message-id="' + CSS.escape(id) + '"]')] :
                [...root.querySelectorAll('.message-item[data-message-id]')].filter(row => row.innerText.includes(content));
            const match = () => {
                const candidatesNow = candidates();
                if (absent) return candidatesNow.length === 0 ? { id } : null;
                const row = candidatesNow.find(item => item.innerText.includes(content));
                if (!row || !row.checkVisibility()) return null;
                const bounds = row.getBoundingClientRect();
                const clip = root.getBoundingClientRect();
                if (bounds.bottom <= Math.max(0,clip.top) || bounds.top >= Math.min(innerHeight,clip.bottom)) return null;
                return { id: row.dataset.messageId };
            };
            if (match()) throw Error('Unexpected target state before mutation');
            if (absent && candidates().length !== 1) throw Error('Deletion target must exist exactly once before mutation');
            window.nsVisibleProbe = null;
            let pending = false;
            const observer = new MutationObserver(() => {
                const first = match();
                if (!first || pending) return;
                pending = true;
                const domAt = stamp();
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    const frame = match();
                    pending = false;
                    if (frame?.id !== first.id) return;
                    observer.disconnect();
                    window.nsVisibleProbe = { messageId: frame.id, domAt, frameAt: stamp(), visibilityState: document.visibilityState, hasFocus: document.hasFocus() };
                }));
            });
            observer.observe(root,{childList:true,subtree:true,characterData:true,attributes:true});
            return true;
        })()`);
    };
    const measure = async (label, target, change, predicate) => {
        const before = lastSeq();
        await install(target);
        const writer = bracket(() => rowsAfter.all(service.topics[subject].id, before).find(predicate), 'journal commit');
        const durable = bracket(() => {
            const rows = history('B', subject);
            if (target.absent) return !rows.some(row => row.id === target.id);
            return rows.find(row => (!target.id || row.id === target.id) && row.content === target.content);
        }, 'B durable History');
        const results = Promise.all([
            writer, durable,
            waitUntil(() => evalIn(B, 'window.nsVisibleProbe'), 'visible ' + label, 10000),
        ]);
        results.catch(() => {});
        await change();
        const [{ value: row, time: commitAt }, { value: local, time: durableAt }, visible] = await results;
        assert.equal(visible.messageId, row.msg_id);
        if (!target.absent) assert.equal(local.id, row.msg_id);
        const between = (later, earlier) => [Math.round(later[0] - earlier[1]), Math.round(later[1] - earlier[0])];
        const domAt = [visible.domAt, visible.domAt];
        const frameAt = [visible.frameAt, visible.frameAt];
        const sample = {
            event: label, messageId: row.msg_id, journalSeq: row.seq,
            writerCommitBracketMs: commitAt[1] - commitAt[0], durableHistoryBracketMs: durableAt[1] - durableAt[0],
            durableHistoryAfterCommitMs: between(durableAt, commitAt), domAfterDurableHistoryMs: between(domAt, durableAt),
            domAfterCommitMs: between(domAt, commitAt), visibleFrameAfterCommitMs: between(frameAt, commitAt),
            visibilityState: visible.visibilityState, hasFocus: visible.hasFocus,
        };
        sample.withinOneSecond = sample.visibleFrameAfterCommitMs[1] <= 1000;
        return sample;
    };
    const bodyIs = (row, content) => row.action === 'upsert' && JSON.parse(row.message_json).content === content;
    const writeSharedMessage = async (id, action, content) => {
        const binding = JSON.parse(fs.readFileSync(path.join(out, 'profile-A', '.native-sync', 'connection.json')));
        const current = db.prepare('SELECT hash,message_json FROM messages WHERE topic_id=? AND msg_id=? AND deleted=0')
            .get(service.topics[subject].id, id);
        assert.ok(current);
        const message = JSON.parse(current.message_json);
        delete message._nativeSyncMetadata;
        const operation = {
            deviceId: 'desktop:' + binding.deviceId, opId: 'visibility-' + action, msgId: id, baseHash: current.hash, action,
            ...(action === 'upsert' && { message: { ...message, content } }),
        };
        const body = JSON.stringify({ sharedSpaceId: 'sharedAB', sharedId: service.topics[subject].id, operation });
        const response = await new Promise((resolve, reject) => {
            const request = https.request(service.origin + '/api/v1/sync/shared/message', {
                method: 'POST', ca: fs.readFileSync(path.join(out, 'loopback-cert.pem')),
                signal: AbortSignal.timeout(7000),
                headers: {
                    authorization: 'Bearer synthetic-only',
                    'x-nativesync-capabilities': 'shared-space-v1',
                    'x-nativesync-source': binding.sourceId,
                    'x-nativesync-device': binding.deviceId,
                    'x-nativesync-space': binding.spaceId,
                    'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
                },
            }, async response => {
                try {
                    const chunks = [];
                    for await (const chunk of response) chunks.push(chunk);
                    resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
                } catch (error) { reject(error); }
            });
            request.on('error', reject);
            request.end(body);
        });
        assert.equal(response.status, 200, JSON.stringify(response.body));
        return response.body;
    };

    service.disarmDrop();
    service.releaseLost();
    await select(A, 'A', subject);
    await select(B, 'B', subject);
    await waitUntil(() => globalThis.nsWatchFaults.open(), 'B live shared watch');
    assert.equal((await selection(B)).topicId, service.descriptors.B[subject].topicId);
    const loaded = await B.command('loaded-sources', {
        main: [
            'apps/desktop/modules/services/nativeSync/sharedRuntime.js',
            'apps/desktop/modules/services/nativeSync/sharedWaitClient.js',
            'apps/desktop/modules/services/nativeSync/queries.js',
            'apps/desktop/modules/ipc/nativeHistoryHandlers.js',
        ],
        renderer: ['apps/desktop/modules/renderer/messageContextMenu.js'],
    });
    assert.equal(loaded.main.length, 4);
    assert.equal(loaded.renderer.length, 1);
    const samples = [];
    result.sharedWatchVisibility = { samples, loaded };
    // Give the observing window foreground presentation. Drive A through
    // the usual renderer controls without activating its overlapping window.
    await click(B, '#chatMessages');
    await waitUntil(() => evalIn(B, 'document.hasFocus()'), 'B foreground renderer');
    result.sharedWatchVisibility.idleRenderer = await B.command('watch-visibility');
    result.sharedWatchVisibility.cpuPressureAtStart = hostCpu();
    assert.equal(result.sharedWatchVisibility.idleRenderer.visible, true);
    samples.push(await measure('new', { content: contract.completeText }, async () => {
        await evalIn(A, `(() => {
            const input = document.querySelector('#messageInput');
            input.value = ${JSON.stringify(contract.cases.lostAck)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        })()`);
        await waitUntil(() => evalIn(A, "!document.querySelector('#sendMessageBtn')?.disabled"), 'A composer enabled');
        await evalIn(A, "document.querySelector('#sendMessageBtn').click()");
    }, row => bodyIs(row, contract.completeText)));
    const id = samples[0].messageId;
    await waitUntil(() => jobs(subject).length === 1 && jobs(subject)[0].state === 'completed', 'A execution settled');
    await waitUntil(() => evalIn(A, `document.querySelector(${JSON.stringify(forMessage(id))})?.checkVisibility()`), 'A original message rendered');
    samples.push(await measure('edit', { id, content: edited },
        () => writeSharedMessage(id, 'upsert', edited), row => row.msg_id === id && bodyIs(row, edited)));
    samples.push(await measure('delete', { id, absent: true },
        () => writeSharedMessage(id, 'delete'), row => row.msg_id === id && row.action === 'delete'));
    assert.equal(posts(subject).length, 1);
    assert.equal(calls(subject).length, 1);
    assert.deepEqual(jobs(subject).map(job => job.attempts), [1]);
    assert.deepEqual(journal(subject).filter(row => row.msg_id === id).map(row => [row.seq, row.action]),
        samples.map(sample => [sample.journalSeq, sample.event === 'delete' ? 'delete' : 'upsert']));
    assert.ok(await evalIn(B, 'document.hasFocus()'), 'B stays foreground throughout sample');
    result.sharedWatchVisibility.finalRenderer = await B.command('watch-visibility');
    result.sharedWatchVisibility.cpuPressureAtEnd = hostCpu();
    Object.assign(result.sharedWatchVisibility, { providerCalls: 1, submitPosts: 1, executionAttempts: [1], observerForeground: true, editDeleteWriter: 'ToolBox shared/message endpoint' });
};

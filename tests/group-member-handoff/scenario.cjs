'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

module.exports = async function run({ clients, out, result, picture, click, evalJs, waitUntil, sha, service, start, stop, profiles, crash, groupRelay }) {
    const mode = process.env.NS_GROUP_HANDOFF_CASE;
    if (mode.startsWith('handoff')) return require('./candidate.cjs')({
        clients, out, result, picture, click, evalJs, waitUntil, sha, service, start, stop, profiles, crash, groupRelay,
    });
    const input = 'GROUP_HANDOFF_BASELINE_INPUT';
    const quote = JSON.stringify;
    const topic = service.topics.groupTopic.id;
    const db = new DatabaseSync(path.join(service.data, 'central.sqlite'), { readOnly: true });
    const evidence = result.groupMemberHandoff = { mode, providerPackets: groupRelay.requests, streamFrames: groupRelay.frames };
    try {
        async function select(client) {
            await click(client, '#agentList > li[data-item-type="group"]');
            return waitUntil(() => evalJs(client, `(() => {
                const current = window.VCPStateChannels.get('conversation.current').get();
                const selected = [...document.querySelectorAll('#agentList li[data-item-type="group"]')]
                    .find(row => row.textContent.includes('Relay fixture A B'));
                return current.topicId && selected?.dataset.itemId && { groupId: selected.dataset.itemId, topicId: current.topicId };
            })()`), 'actual native group selection');
        }
        const { A, B } = clients;
        await select(A);
        await select(B);
        const capture = () => {
            const admission = db.prepare('SELECT id,request_id,principal,state,dispatched FROM shared_admissions WHERE topic_id=? ORDER BY rowid').all(topic);
            if (admission.length !== 1) return { admission };
            const native = db.prepare('SELECT id,ordinal,principal,member_id,state FROM shared_native_requests WHERE admission_id=? ORDER BY ordinal').all(admission[0].id);
            return { admission, native, counts: ['A', 'B'].map(member => groupRelay.requests.filter(row => row.member === member).length) };
        };
        const expected = mode === 'a-partial' ? 'RELAY_A_PARTIAL' : 'RELAY_B_PARTIAL';
        await evalJs(A, `(() => {
            const composer = document.querySelector('#messageInput');
            composer.value = ${quote(input)};
            composer.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        })()`);
        await click(A, '#sendMessageBtn:not(:disabled)');
        const waitFrames = () => mode === 'a-committed' ? groupRelay.frames.some(frame => frame.interceptedBeforeToolBox)
            : groupRelay.frames.some(frame => frame.text === expected);
        try {
            await waitUntil(waitFrames, 'deterministic group member boundary');
        } catch (error) {
            evidence.send = await evalJs(A, 'document.querySelector("#chatMessages").innerText');
            throw error;
        }
        evidence.before = capture();
        assert.equal(evidence.before.admission.length, 1);
        assert.deepEqual(evidence.before.counts, mode === 'b-unknown' ? [1, 1] : [1, 0]);
        if (mode !== 'a-committed') {
            await waitUntil(() => evalJs(A, `document.querySelector('#chatMessages').innerText.includes(${quote(expected)})`), 'A renders member partial');
        }
        evidence.before.renderer = await evalJs(A, "document.querySelector('#chatMessages').innerText");
        await picture(A, 'A-before-disconnect');
        evidence.originalExit = await crash('A');
        if (mode === 'b-unknown') evidence.serverRestart = await service.restartAfterCrash();
        await stop('B');
        const reopened = await start('B');
        const scopeB = await select(reopened);
        const historyFile = path.join(profiles.B, 'UserData', scopeB.groupId, 'topics', scopeB.topicId, 'history.json');
        const history = () => {
            try { return JSON.parse(fs.readFileSync(historyFile, 'utf8')); }
            catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return []; throw error; }
        };
        await waitUntil(() => history().some(row => row.content === input), 'B reads original History');
        if (mode !== 'a-partial') await waitUntil(() => history().some(row => row.content === 'RELAY_A_FINAL'), 'B reads A committed reply');
        if (mode === 'b-unknown') await waitUntil(() => capture().native[1]?.state === 'unknown', 'server marks B native request unknown');
        evidence.after = { ...capture(), history: history().map(({ id, role, agentId, content }) => ({ id, role, agentId, content })),
            renderer: await evalJs(reopened, "document.querySelector('#chatMessages').innerText") };
        assert.equal(evidence.after.admission[0].id, evidence.before.admission[0].id);
        assert.deepEqual(evidence.after.counts, evidence.before.counts);
        assert.deepEqual(evidence.after.history.map(row => row.content), mode === 'a-partial' ? [input] : [input, 'RELAY_A_FINAL']);
        await picture(reopened, 'B-original-work');
    } finally {
        db.close();
    }
};

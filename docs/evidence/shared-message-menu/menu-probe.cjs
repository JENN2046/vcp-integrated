'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ordinaryTool = require(path.resolve('tests/ordinary-tools/fixture.cjs'));

globalThis.nsMenuTool = {
    stage: ordinaryTool.stage,
    reply(body, row, priorCalls) {
        if (row.case !== 'lostAck' && !priorCalls.some(call => call.case === 'lostAck' && call.id === row.id)) return;
        return ordinaryTool.reply({ ...body, messages: [...body.messages, { role: 'user', content: 'ORDINARY_TOOL_LOCAL' }] }, row, priorCalls);
    },
};
const servicePath = path.resolve('tests/integration/service.cjs');
const compile = Module._extensions['.cjs'];
Module._extensions['.cjs'] = function (module, filename) {
    if (filename !== servicePath) return compile(module, filename);
    const finish = module._compile;
    module._compile = function (source, name) {
        const needle = "    const sourceApp = path.join(candidate, 'apps/server');";
        assert.equal(source.split(needle).length, 2);
        return finish.call(this, source.replace(needle, '    ordinaryTools = globalThis.nsMenuTool;\n' + needle), name);
    };
    return compile(module, filename);
};

globalThis.nsWatchFaultScenario = async ({
    A, B, result, out, service, select, enter, click, history, journal, jobs, posts, calls,
    waitUntil, start, stop, contract, db,
}) => {
    const subject = 'lostAck';
    const baseline = process.env.NS_MENU_BASELINE === '1';
    const edited = 'Synthetic shared menu edit';
    const evalIn = (client, source) => client.command('eval', source);
    const picture = (client, name) => client.command('picture', path.join(out, name + '.png'));
    const topic = service.topics[subject].id;
    const messageState = db.prepare('SELECT msg_id,hash,deleted,last_seq,metadata_version FROM messages WHERE topic_id=? ORDER BY last_seq');
    const journalState = db.prepare('SELECT seq,msg_id,action,device_id,hash,metadata_version FROM journal WHERE topic_id=? ORDER BY seq');
    const snapshot = () => ({
        journal: journalState.all(topic), central: messageState.all(topic),
        history: Object.fromEntries(['A','B'].map(role => [role, history(role,subject).map(({ id, role, content, updatedAt }) => ({ id, role, content, updatedAt }))])),
        executions: jobs(subject), providerCalls: service.calls.length, toolCalls: ordinaryTool.counts(out), submitPosts: posts(subject).length,
    });
    const receipt = result.sharedMessageMenu = { baseline };
    const refusal = label => waitUntil(() => A.events.find(event => event.event === 'renderer-console' && event.data?.message?.includes(label))?.data.message, label, 5000);
    const loaded = receipt.loaded = await A.command('loaded-sources', {
        main: [
            'apps/desktop/modules/ipc/nativeHistoryHandlers.js',
            'apps/desktop/modules/services/nativeSync/sharedRuntime.js',
            'apps/desktop/modules/services/nativeSync/sharedExecution.js',
        ],
        renderer: [
            'apps/desktop/modules/renderer/messageContextMenu.js',
            'apps/desktop/modules/messageRenderer.js',
            'apps/desktop/modules/chat/chatHistoryMutationAuthority.js',
        ],
    });
    assert.deepEqual([loaded.main.length, loaded.renderer.length], [3,3]);
    service.disarmDrop();
    service.releaseLost();
    await select(A, 'A', subject);
    await select(B, 'B', subject);
    await enter(A, contract.cases[subject]);
    await waitUntil(() => jobs(subject)[0]?.state === 'completed', 'formal reply completed');
    await waitUntil(() => ['A','B'].every(role => history(role, subject).length === 2), 'initial durable two-row History');
    const initial = receipt.initial = snapshot();
    const [user, reply] = initial.history.A;
    assert.equal(reply.role, 'assistant');
    assert.deepEqual(initial.history.B, initial.history.A);
    assert.ok(reply.content.endsWith(ordinaryTool.finalText));
    assert.equal(initial.journal.length, 2);
    assert.equal(initial.providerCalls, 2);
    assert.equal(initial.toolCalls.length, 1);
    assert.deepEqual(service.calls.map(row => row.ordinaryPhase), ['tool-request', 'continuation']);
    assert.equal(service.calls[1].hasToolResult, true);
    assert.equal(initial.submitPosts, 1);
    assert.equal(initial.executions[0].attempts, 1);
    const { visible, rightClick, edit } = require('./menu-controls.cjs')({ id: reply.id, waitUntil, click });
    await visible(A, ordinaryTool.finalText);
    await visible(B, ordinaryTool.finalText);
    await picture(B, 'B-before');
    await rightClick(A);
    await waitUntil(() => evalIn(A, "document.querySelector('#chatContextMenu')?.checkVisibility()"), 'original menu visible');
    await picture(A, 'A-original-menu');
    await edit(A, edited);
    if (baseline) {
        receipt.editError = await refusal('[EditMode] Save failed:');
        assert.match(receipt.editError, /SHARED_NATIVE_ADMISSION_REQUIRED/);
        await picture(A, 'A-edit-rejected');
        await click(A, '.message-edit-controls button', '取消');
        await visible(A, ordinaryTool.finalText);
        await visible(B, ordinaryTool.finalText);
    } else {
        await visible(A, edited);
        await visible(B, edited);
        await waitUntil(() => ['A','B'].every(role => history(role,subject).some(row => row.id === reply.id && row.content === edited)), 'durable edited reply');
        await picture(B, 'B-edited');
    }
    receipt.afterEdit = snapshot();
    await rightClick(A);
    await click(A, '#chatContextMenu .context-menu-item', '删除消息');
    await picture(A, 'A-delete-confirmation');
    await click(A, '#confirm-dialog-overlay .confirm-dialog-confirm', '删除');
    if (baseline) {
        receipt.deleteError = await refusal('[MessageRenderer] history mutation failed:');
        await picture(A, 'A-delete-rejected');
        await visible(A, null);
        await visible(B, ordinaryTool.finalText);
    } else {
        await visible(A, null);
        await visible(B, null);
        await waitUntil(() => ['A','B'].every(role => history(role,subject).length === 1), 'durable deletion');
        await picture(B, 'B-deleted');
    }
    receipt.afterDelete = snapshot();
    await stop('A');
    const reopened = await start('A-reopened', 'A');
    assert.equal(result.A.profileDigest, result['A-reopened'].profileDigest);
    await select(reopened, 'A', subject);
    await visible(reopened, baseline ? ordinaryTool.finalText : null);
    await picture(reopened, 'A-reopened');
    receipt.afterReopen = snapshot();
    assert.deepEqual(receipt.afterReopen, receipt.afterDelete);
    if (baseline) {
        assert.deepEqual(receipt.afterEdit, initial);
        assert.deepEqual(receipt.afterDelete, initial);
    } else {
        const edit = receipt.afterEdit.journal.at(-1);
        const deleted = receipt.afterDelete.journal.at(-1);
        assert.deepEqual(receipt.afterEdit.journal.slice(0,2), initial.journal);
        assert.deepEqual(receipt.afterDelete.journal.slice(0,3), receipt.afterEdit.journal);
        assert.deepEqual(receipt.afterEdit.journal.map(row=>row.msg_id), [user.id,reply.id,reply.id]);
        assert.deepEqual(receipt.afterDelete.journal.map(row=>row.msg_id), [user.id,reply.id,reply.id,reply.id]);
        assert.deepEqual([edit.seq, deleted.seq], [initial.journal.at(-1).seq+1, initial.journal.at(-1).seq+2]);
        assert.equal(edit.action,'upsert');
        assert.equal(deleted.action,'delete');
        assert.notEqual(edit.hash, initial.journal.at(-1).hash);
        assert.equal(receipt.afterDelete.central.find(row=>row.msg_id===reply.id).deleted,1);
        assert.equal(receipt.afterDelete.central.find(row=>row.msg_id===reply.id).last_seq,deleted.seq);
        for (const role of ['A','B']) {
            assert.deepEqual(receipt.afterEdit.history[role].map(row=>row.id),[user.id,reply.id]);
            assert.deepEqual(receipt.afterDelete.history[role], [user]);
        }
        for (const after of [receipt.afterEdit,receipt.afterDelete,receipt.afterReopen]) {
            assert.deepEqual(after.executions, initial.executions);
            assert.equal(after.providerCalls, initial.providerCalls);
            assert.deepEqual(after.toolCalls, initial.toolCalls);
            assert.equal(after.submitPosts, initial.submitPosts);
        }
    }
};

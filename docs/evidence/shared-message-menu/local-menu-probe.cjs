'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const menuControls = require('./menu-controls.cjs');
const target = path.resolve('tests/integration/scenario.cjs');
const compile = Module._extensions['.cjs'] || Module._extensions['.js'];
Module._extensions['.cjs'] = function (module, filename) {
    if (filename !== target) return compile(module, filename);
    const source = fs.readFileSync(filename, 'utf8');
    const needle = '    assert.equal(result.local.provider,1);';
    assert.equal(source.split(needle).length, 2);
    return module._compile(source.replace(needle,
        '    await globalThis.nsLocalMenu({ A, file, db, result, service, rows, click, waitUntil, start, stop, selection, picture });\n' + needle
    ), filename);
};

globalThis.nsLocalMenu = async ({ A, file, db, result, service, rows, click, waitUntil, start, stop, selection, picture }) => {
    const [user, reply] = rows;
    assert.equal(reply.role, 'assistant');
    const counters = () => ({
        journal: db.prepare('SELECT count(*) n FROM journal').get().n,
        work: db.prepare('SELECT count(*) n FROM mobile_executions').get().n,
        nativeRequests: db.prepare('SELECT count(*) n FROM shared_native_requests').get().n,
        sharedAdmissions: db.prepare('SELECT count(*) n FROM shared_admissions').get().n,
        provider: service.calls.length,
        localPosts: service.requests.filter(req => req.method === 'POST' && req.route === '/v1/local-chat/completions').length,
        sharedPosts: service.requests.filter(req => req.method === 'POST' && req.route.includes('/shared/')).map(req => req.route),
    });
    const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
    const scope = { itemId: 'local-agent', itemType: 'agent', topicId: 'local-topic' };
    const native = await A.command('eval', 'window.chatAPI.getNativeDeletionContext(' + JSON.stringify(scope) + ')');
    assert.equal(native.kind, 'local');
    const loaded = await A.command('loaded-sources', {
        main: ['apps/desktop/modules/ipc/chatHandlers.js', 'apps/desktop/modules/ipc/nativeHistoryHandlers.js'],
        renderer: ['apps/desktop/modules/renderer/messageContextMenu.js', 'apps/desktop/modules/messageRenderer.js',
            'apps/desktop/modules/chat/chatHistoryMutationAuthority.js'],
    });
    assert.equal(loaded.main.length, 2);
    assert.equal(loaded.renderer.length, 3);
    const receipt = result.localMessageMenu = { scope, kind: native.kind, loaded, initial: { rows, counters: counters() } };
    const { visible, rightClick, edit } = menuControls({ id: reply.id, waitUntil, click });
    const edited = 'Synthetic local assistant reply edited from its original menu';
    await visible(A, reply.content);
    await rightClick(A);
    await edit(A, edited);
    await visible(A, edited);
    await waitUntil(() => read().some(row => row.id === reply.id && row.content === edited), 'local edited reply on disk');
    receipt.afterEdit = { rows: read(), counters: counters() };
    assert.deepEqual(receipt.afterEdit.rows.map(row => row.id), [user.id, reply.id]);
    assert.deepEqual(receipt.afterEdit.rows[0], user);
    await picture(A, 'local-menu-edited');
    await rightClick(A);
    await click(A, '#chatContextMenu .context-menu-item', '删除消息');
    await click(A, '#confirm-dialog-overlay .confirm-dialog-confirm', '删除');
    await visible(A, null);
    await waitUntil(() => read().length === 1, 'one row remains on disk after local delete');
    receipt.afterDelete = { rows: read(), counters: counters() };
    assert.deepEqual(receipt.afterDelete.rows, [user]);
    await stop('A');
    const reopened = await start('A-reopened', 'A');
    assert.equal(result.A.profileDigest, result['A-reopened'].profileDigest);
    await click(reopened, '#agentList > li .agent-name', 'Synthetic local');
    await waitUntil(async () => (await selection(reopened)).topicId === scope.topicId, 'reopened original local topic');
    await visible(reopened, null);
    assert.ok(await reopened.command('eval', `document.querySelector('#chatMessages .message-item[data-message-id="${user.id}"]')?.checkVisibility()`));
    await picture(reopened, 'local-menu-reopened');
    receipt.afterReopen = { rows: read(), counters: counters() };
    assert.deepEqual(receipt.afterReopen, receipt.afterDelete);
    for (const phase of ['initial', 'afterEdit', 'afterDelete', 'afterReopen']) {
        assert.deepEqual(receipt[phase].counters, {
            journal:0, work:0, nativeRequests:0, sharedAdmissions:0, provider:1, localPosts:1, sharedPosts:[]
        });
    }
};

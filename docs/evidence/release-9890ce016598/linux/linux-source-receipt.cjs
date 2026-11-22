'use strict';
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const candidate = process.cwd();
const file = path.join(candidate, 'tests/hardware/linux-desktop.cjs');
const source = fs.readFileSync(file, 'utf8');
const existing = "            if(line==='observe') reply('linux-observation',await readView());";
if (source.split(existing).length !== 2) throw new Error('Unexpected Linux fixture source');
const closeProof = "        assert.deepEqual(value,{code:0,signal:null});";
if (source.split(closeProof).length !== 2) throw new Error('Unexpected Linux close invariant');
const instrumented = source.replace(closeProof, `${closeProof}
        reply('linux-exited', {pid:child.pid,...value});`).replace(existing, `${existing}
            if(line==='readback') {
                const snapshot = JSON.parse(fs.readFileSync(path.join(run, 'status.json'), 'utf8'));
                assert.equal(snapshot.work.length, 1);
                assert.equal(snapshot.providerCalls, 1);
                assert.equal(snapshot.totalProviderRequests, 1);
                const work = snapshot.work[0];
                assert.equal(work.state, 'completed');
                assert.equal(work.attempts, 1);
                const expected = [work.user_message_id, work.reply_message_id];
                const descriptor = ready.desktopDescriptor;
                const execution = await evalJs('window.electronAPI.getNativeExecutionStatus(' +
                    j(descriptor.itemId) + ',' + j(descriptor.itemType) + ',' + j(descriptor.topicId) + ',true)');
                assert.equal(execution.success,true);
                const job = execution.executions.find(row=>row.id===work.id);
                assert.ok(job);
                assert.equal(job.requestId,work.request_id);
                assert.equal(job.state,'completed');
                if (job.replyMessageId !== undefined) assert.equal(job.replyMessageId,work.reply_message_id);
                const rendered = await evalJs("Array.from(document.querySelectorAll('#chatMessages .message-item[data-message-id]'), node => ({id:node.dataset.messageId,text:node.querySelector('.md-content')?.textContent}))");
                const view = await readView();
                assert.deepEqual(rendered.map(row=>row.id), expected);
                assert.deepEqual(view.history.map(row=>row.id), expected);
                assert.equal(view.context.topicId,descriptor.topicId);
                const {createHash} = require('node:crypto');
                const hash = value => ({utf8Bytes:Buffer.byteLength(value,'utf8'), sha256:createHash('sha256').update(value,'utf8').digest('hex')});
                const file = path.join(run,'profile-A','UserData',descriptor.itemId,'topics',descriptor.topicId,'history.json');
                const history = JSON.parse(fs.readFileSync(file,'utf8'));
                const messages = rendered.map(({id,text})=>{
                    const saved=history.find(row=>row.id===id);
                    assert.equal(text.trimEnd(),saved.content.trimEnd());
                    return {id,role:saved.role,dom:hash(text),history:hash(saved.content)};
                });
                const workRow=await evalJs("Array.from(document.querySelectorAll('.native-sync-execution-status [data-work-id]'), node=>({id:node.dataset.workId,text:node.textContent,title:node.title,visible:node.checkVisibility()}))");
                reply('linux-readback', {pid:child.pid, scope:execution.topic, connection:execution.connection,
                    freshness:execution.freshness, work:job, workRow, messages, view});
            }
            if(line==='sources') {
                const loaded = await command('loaded-sources', {
                    main: ['apps/desktop/modules/ipc/chatHandlers.js',
                        'apps/desktop/modules/services/nativeSync/sharedSessionClient.js',
                        'apps/desktop/modules/services/topicExecutionAuthority.js'],
                    renderer: ['apps/desktop/modules/renderer/mainChatSendOwner.js',
                        'apps/desktop/modules/renderer/nativeExecutionStatus.js',
                        'apps/desktop/modules/event-listeners.js'],
                });
                assert.equal(loaded.main.length, 3);
                assert.equal(loaded.renderer.length, 3);
                fs.writeFileSync(path.join(run, 'linux-loaded.json'), JSON.stringify(loaded, null, 2) + '\\n');
                reply('linux-sources', loaded);
            }`);
const fixture = new Module(file, module);
fixture.filename = file;
fixture.paths = Module._nodeModulePaths(path.dirname(file));
fixture._compile(instrumented, file);

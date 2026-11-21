'use strict';
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const candidate = process.cwd();
const file = path.join(candidate, 'tests/hardware/linux-desktop.cjs');
const source = fs.readFileSync(file, 'utf8');
const existing = "            if(line==='observe') reply('linux-observation',await readView());";
if (source.split(existing).length !== 2) throw new Error('Unexpected Linux fixture source');
const instrumented = source.replace(existing, `${existing}
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

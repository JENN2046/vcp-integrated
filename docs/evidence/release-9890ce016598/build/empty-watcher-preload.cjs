'use strict';
const childProcess = require('node:child_process');
const path = require('node:path');
const spawn = childProcess.spawn;
childProcess.spawn = function spawnWithEmptyWatcherFixture(command, args, options) {
    if (command === process.execPath && args.includes('server.js') &&
        args.includes(path.resolve('tests/integration/loopback.cjs')) &&
        path.basename(options.cwd) === 'runtime-box') {
        return spawn(command, args, {
            ...options,
            env: {
                ...options.env,
                CHOKIDAR_USEPOLLING: 'true',
                NODE_OPTIONS: '--require=' + path.resolve('tests/mobile-physical/knowledge-watcher.cjs'),
            },
        });
    }
    return spawn(...arguments);
};

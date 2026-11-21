'use strict';

// Loaded only in the isolated test ToolBox. Let the native archive write and
// fsync normally, then kill the process before control returns to publication.
const fs = require('node:fs');
const path = require('node:path');

const marker = process.env.VCP_TEST_FINAL_CRASH_MARKER;
const rename = fs.renameSync;
const fsync = fs.fsyncSync;
let pending;

fs.renameSync = function (source, destination) {
    rename(source, destination);
    if (typeof destination !== 'string' || path.basename(path.dirname(destination)) !== 'native-continuations') return;
    if (fs.existsSync(marker)) return;
    const record = JSON.parse(fs.readFileSync(destination, 'utf8'));
    if (record.identity?.generation === 1 && record.completion) {
        pending = { file: destination, requestId: record.identity.requestId };
    }
};

fs.fsyncSync = function (fd) {
    fsync(fd);
    if (!pending || fs.readlinkSync('/proc/self/fd/' + fd) !== path.dirname(pending.file)) return;
    fs.writeFileSync(marker, JSON.stringify({ ...pending, pid: process.pid }), { flag: 'wx' });
    process.kill(process.pid, 'SIGKILL');
};

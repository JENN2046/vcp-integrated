'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function install(profile, log) {
    const commitScope = new AsyncLocalStorage();
    const open = fsp.open;
    let replaced = false;
    fsp.open = async function (file, flags, ...args) {
        const target = commitScope.getStore();
        if (!replaced && target && file === target.file && typeof flags === 'number' &&
            (flags & fs.constants.O_NOFOLLOW)) {
            const bytes = fs.readFileSync(file);
            if (JSON.parse(bytes).some(row => row.id === target.checkpointId)) {
                // The strict reader has already lstat'ed this path. Atomically publish
                // the same bytes on a new inode to force its real open/fstat guard.
                const before = fs.lstatSync(file);
                const replacement = file + '.fixture-race';
                fs.writeFileSync(replacement, bytes, { mode:before.mode & 0o777, flag:'wx' });
                try { fs.renameSync(replacement, file); }
                finally { if (fs.existsSync(replacement)) fs.unlinkSync(replacement); }
                const after = fs.lstatSync(file);
                replaced = true;
                log('compaction-history-inode-race', { intentId:target.intentId, checkpointId:target.checkpointId,
                    beforeIno:before.ino, afterIno:after.ino, links:after.nlink,
                    historySha256:createHash('sha256').update(bytes).digest('hex') });
            }
        }
        return open.call(this, file, flags, ...args);
    };
    return (channel, args, invoke) => {
        if (channel !== 'native-sync:compact-commit' || replaced) return invoke();
        const {descriptor, id, message} = args[0];
        const file = path.join(profile, 'UserData', descriptor.itemId, 'topics', descriptor.topicId, 'history.json');
        return commitScope.run({ file, intentId:id, checkpointId:message.id }, invoke);
    };
}

module.exports = { install };

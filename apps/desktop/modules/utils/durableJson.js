'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

async function durableJson(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    let handle;
    try {
        handle = await fs.open(temporary, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(value));
        await handle.sync();
        await handle.close(); handle = null;
        // Windows readers/AV can briefly hold a destination without delete
        // sharing. Retry the same atomic replace, never unlink the destination
        // or regenerate the payload/operation identity. Permanent errors still
        // propagate to the existing intent/state recovery boundary.
        for(let attempt=0;;attempt++){
            try { await fs.rename(temporary, file); break; }
            catch(error){
                if(process.platform!=='win32'||attempt>=5||!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;
                await new Promise(resolve=>setTimeout(resolve,10*(attempt+1)));
            }
        }
        // Windows does not expose a portable directory fsync.
        if (process.platform !== 'win32') {
            const directory = await fs.open(path.dirname(file), 'r');
            try { await directory.sync(); } finally { await directory.close(); }
        }
    } finally {
        await handle?.close().catch(() => {});
        await fs.rm(temporary, { force: true });
    }
}
module.exports = { durableJson };

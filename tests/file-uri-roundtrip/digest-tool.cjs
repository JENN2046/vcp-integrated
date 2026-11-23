'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fileURLToPath } = require('node:url');

const box = path.resolve(__dirname, '../..');
function record(row) {
    fs.appendFileSync(path.join(__dirname, 'invocations.jsonl'), JSON.stringify(row) + '\n', {mode:0o600});
}

module.exports = {
    async processToolCall({ command, fileUrl }) {
        assert.equal(command, 'Digest');
        const isUri = fileUrl.startsWith('file://');
        const file = isUri ? fileURLToPath(fileUrl) : path.join(__dirname, fileUrl);
        const relative = path.relative(box, file);
        // The fixture tool may read only its disposable ToolBox or the synthetic A cache.
        assert.ok(!relative.startsWith('..' + path.sep) ||
            file.startsWith(path.join(box, '../profile-A/UserData/attachments') + path.sep));
        if (!isUri) assert.equal(path.basename(fileUrl), fileUrl);
        const argument = isUri ? 'relative-to-runtime:' + relative : fileUrl;
        let buffer;
        try {
            buffer = await fs.promises.readFile(file);
        } catch (error) {
            record({ argument, error:error.code });
            return { content:[{type:'text',text:'Synthetic file read failed: ' + error.code}] };
        }
        const digest = createHash('sha256').update(buffer).digest('hex');
        record({ argument, bytes:buffer.length, digest });
        return { content:[{type:'text',text:'SYNTHETIC_DIGEST_' + digest}] };
    },
};

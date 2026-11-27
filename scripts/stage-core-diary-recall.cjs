'use strict';

const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const pinned = require('../apps/server/core/nativeDiarySource.json');

const source = process.argv[2];
if (!source || process.argv.length !== 3) throw Error('Usage: node scripts/stage-core-diary-recall.cjs LOCAL_VCPTOOLBOX_REPO');
const destination = path.resolve(__dirname, '../apps/server/Plugin/RAGDiaryPluginCore');
const files = Object.entries(pinned.files).map(([name, sha256]) => {
    const contents = execFileSync('git', ['-C', source, 'show', pinned.commit + ':Plugin/RAGDiaryPlugin/' + name]);
    if (createHash('sha256').update(contents).digest('hex') !== sha256) throw Error('Unexpected native diary source: ' + name);
    return { name, contents };
});
fs.mkdirSync(destination);
for (const { name, contents } of files) fs.writeFileSync(path.join(destination, name), contents, { flag: 'wx' });
console.log('Staged native RAGDiaryPlugin ' + pinned.version + ' at ' + pinned.commit);

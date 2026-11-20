'use strict';
const fs = require('node:fs');
const path = require('node:path');

// These entrypoints are also loaded directly by sandboxed browser windows.
const assets = [
    ['tavern', 'tavernRulesEngine.js'],
    ...['toolBatchRegions', 'toolResultRegions', 'markdownCodeDomainScanner'].map(name =>
        ['renderer/' + name, 'renderer/' + name + '.js']),
];
for (const [entry, target] of assets) {
    const source = require.resolve('@vcp/core-rules/' + entry);
    fs.copyFileSync(source, path.resolve(__dirname, '../modules', target));
}

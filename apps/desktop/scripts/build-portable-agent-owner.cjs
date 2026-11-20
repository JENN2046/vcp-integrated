'use strict';
const path = require('node:path');
const webpack = require('webpack');

const root = path.resolve(process.argv[2]);
webpack({
    mode: 'production', devtool: false, target: 'node',
    entry: path.join(root, 'modules/services/nativeSync/agentNameOwner.js'),
    output: { path: path.join(root, 'modules/nativeSyncDesktopRuntime'), filename: 'agentNameOwner.cjs', library: { type: 'commonjs2' } },
    optimization: { minimize: false },
    plugins: [new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 })],
    context: root,
}, (error, stats) => {
    if (error || stats.hasErrors()) {
        console.error(error || stats.toString({ all: false, errors: true }));
        process.exitCode = 1;
    }
});

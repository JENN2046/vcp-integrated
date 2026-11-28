'use strict';
const net = require('node:net');
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function(port, ...args) {
    if (String(port)!==process.env.PORT || !(args[0]==='127.0.0.1' || typeof args[0]==='function')) throw Error('Only the synthetic loopback HTTP listener is enabled');
    return typeof args[0]==='function' ? listen.call(this,Number(port),'127.0.0.1',...args) : listen.call(this,Number(port),...args);
};
require('./restrict-network.cjs').restrictNodeNetwork();
if (process.env.NS_FIXTURE_POLL_WATCHERS === '1') {
    // The isolated fixture never edits RAG parameters. Skip its recursive watcher on hosts near their per-user limit.
    require(require('node:path').resolve('KnowledgeBaseManager.js'))._startRagParamsWatcher = () => {};
}
const report = process.env.NS_LOADED_REPORT;
if (report) process.on('exit',()=>{
    const fs=require('node:fs');
    const path=require('node:path');
    const {createHash}=require('node:crypto');
    const roots = ['core/host.js','core/localWorkspace.js','core/service.js','core/runner.js','core/store.js',
        'server.js','Plugin.js','WebSocketServer.js','modules/requestExecutionContext.js','modules/chatCompletionHandler.js',
        'Plugin/NativeSync/mobile/effectiveContext.js','modules/vcpLoop/toolExecutor.js',
        'modules/handlers/streamHandler.js','modules/handlers/nonStreamHandler.js','modules/pluginBridgeRegistry.js','modules/toolCallRecordStore.js'];
    const ok=roots.filter(rel=>require.cache[path.resolve(rel)]?.loaded).map(file=>({file:'apps/server/'+file,
        sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')}));
    fs.writeFileSync(report,JSON.stringify(ok,null,2)+'\n');
});

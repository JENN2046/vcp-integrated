'use strict';
const net = require('node:net');
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function(port, ...args) {
    if (String(port)!==process.env.PORT || !(args[0]==='127.0.0.1' || typeof args[0]==='function')) throw Error('Only the synthetic loopback HTTP listener is enabled');
    return typeof args[0]==='function' ? listen.call(this,Number(port),'127.0.0.1',...args) : listen.call(this,Number(port),...args);
};
require('./restrict-network.cjs').restrictNodeNetwork();
if (process.env.NS_METER_PREFIX) require('./meter.cjs');
const report = process.env.NS_LOADED_REPORT;
if (report) process.on('exit',()=>{
    const fs=require('node:fs');
    const path=require('node:path');
    const {createHash}=require('node:crypto');
    const roots=['server.js','Plugin.js','WebSocketServer.js','modules/requestExecutionContext.js','modules/chatCompletionHandler.js','Plugin/NativeSync/sync/sharedNative.js','Plugin/NativeSync/sync/sharedSteering.js','Plugin/NativeSync/mobile/sharedSingle.js','Plugin/NativeSync/mobile/nativeTasks.js','Plugin/NativeSync/sync/sharedSession.js',
        'Plugin/NativeSync/sync/sharedHttp.js','Plugin/NativeSync/sync/sharedSpace.js','Plugin/NativeSync/sync/sharedTaskRequests.js','Plugin/NativeSync/sync/sharedTaskControls.js',
        'Plugin/AgentAssistant/AgentAssistant.js','Plugin/AgentAssistant/delegationContinuity.js','Plugin/AgentAssistant/delegationControl.js',
        'modules/vcpLoop/toolExecutor.js','modules/handlers/nonStreamHandler.js','modules/pluginBridgeRegistry.js','modules/toolCallRecordStore.js',
        'Plugin/NativeSync/sync/sharedTopicSponsor.js','Plugin/NativeSync/mobile/execution.js','Plugin/NativeSync/native-sync.js','Plugin/NativeSync/sync/sponsorExecutionBridge.js'];
    const ok=roots.filter(rel=>require.cache[path.resolve(rel)]?.loaded).map(file=>({file:'apps/server/'+file,
        sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')}));
    fs.writeFileSync(report,JSON.stringify(ok,null,2)+'\n');
});

'use strict';

const name = 'nativesync-topic-sponsor';

function isExistingReply(args) {
    return (args.command || args.tool_name) === 'ReplyToTopic' && args.mode !== 'new_topic';
}

function projectRiver(args, river) {
    const extracted = ['full','text'].includes(river) || /^(last|semantic):\d+$/.test(river || '');
    const rows = extracted && args.river_context;
    delete args.river_context;
    delete args.vref_files;
    if (!Array.isArray(rows)) return;
    const { projectRiverRow } = require('./topicRiverQuote');
    const projected = rows.map(projectRiverRow).filter(Boolean);
    if (projected.length) args.river_context = projected;
}

// Configuration-only installations can run on stock ToolBox, which has no
// NativeSync execution context. A scoped execution requires the integrated host.
function executionContext() {
    let filename;
    try { filename = require.resolve('../../../modules/requestExecutionContext'); }
    catch (error) {
        if (error.code === 'MODULE_NOT_FOUND') return null;
        throw error;
    }
    return require(filename);
}

async function execute(host, prepared, plugin, toolArgs, context) {
    const toolHost = context.webSocketServer;
    if (!toolHost) throw new Error('[PluginManager] WebSocketServer is not initialized. Cannot call distributed tool.');
    const { _nativeSyncTopicSponsor: ignored, ...args } = toolArgs;
    const options = context.executionOptions;
    const call = prepared.get(options);
    prepared.delete(options);
    const sharedReply = isExistingReply(args) && host?.currentTopicSponsorCall?.();
    if ((call && !call.isCurrent()) || (sharedReply && !call)) {
        throw Object.assign(new Error('TOPIC_SPONSOR_AUTHORITY_REQUIRED'), {code: 'TOPIC_SPONSOR_AUTHORITY_REQUIRED'});
    }
    if (!sharedReply) {
        return { result: await toolHost.executeDistributedTool(plugin.serverId, context.toolName, args) };
    }

    const shared = call.requireOwner();
    const sponsor = require('./sharedTopicSponsor');
    const wireArgs = JSON.parse(JSON.stringify(args));
    const resolved = sponsor.resolve(shared, call.authority, wireArgs);
    const send = sponsor.bindRecipient(toolHost, call.authority);
    const code = 'TOPIC_SPONSOR_DELIVERY_UNCONFIRMED';
    const unconfirmedError = Object.assign(new Error(code), { code });
    const result = await host.runToolInvocation({
        pluginName: 'TopicSponsor', recordId: context.executionOptions?.toolCallRecordHandle?.id, unconfirmedError,
    }, async invocation => {
        call.requireOwner(); // Dispatch bookkeeping can yield across a shutdown or reload.
        const envelope = sponsor.grant(shared, call.authority, resolved, invocation, wireArgs);
        try { await send({ ...wireArgs, [sponsor.ENVELOPE]: envelope }); }
        catch { /* The receiver may already have committed. Consult the original ledger. */ }
        let receipt;
        try { receipt = sponsor.committed(shared, envelope.operationId); }
        catch { throw unconfirmedError; }
        if (!receipt) throw unconfirmedError;
        return { status: 'success', result: receipt };
    });
    return { result };
}

function register(registry) {
    // The author keeps this registry across plugin reloads. The descriptor
    // owns no database or session and resolves the authority anew for each call.
    if (registry.list().some(bridge => bridge.name === name)) return;
    const host = executionContext();
    const prepared = new WeakMap();
    let releasePreparation;
    if (host?.currentTopicSponsorCall) {
        const ToolExecutor = require('../../../modules/vcpLoop/toolExecutor');
        if (typeof ToolExecutor.registerToolPreparation !== 'function') throw new Error('SHARED_TOOL_PREPARATION_REQUIRED');
        releasePreparation = ToolExecutor.registerToolPreparation(registry, 'TopicSponsor', ({ args, river, executionOptions }) => {
            delete args._nativeSyncTopicSponsor;
            const call = host.currentTopicSponsorCall();
            if (!call || !isExistingReply(args)) return;
            projectRiver(args, river);
            prepared.set(executionOptions, call);
        });
    }
    try {
        registry.register({
            name,
            priority: 401, // Immediately before the author's distributed transport at 400.
            canHandle: (plugin, context) => plugin.isDistributed === true && context.toolName === 'TopicSponsor',
            execute: (plugin, args, context) => execute(host, prepared, plugin, args, context),
        });
    } catch (error) {
        releasePreparation?.();
        throw error;
    }
}

module.exports = { register };

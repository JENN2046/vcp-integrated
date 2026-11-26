'use strict';

function startCoreHost({ app, chat, listenHost, serverKey, legacy, env = process.env }) {
    const directory = env.VCP_CORE_DATA_DIR, configuredWorkspace = env.VCP_CORE_WORKSPACE;
    if (!directory && !configuredWorkspace) return null;
    if (!directory || env.VCP_CORE_MODE && !['local', 'shared'].includes(env.VCP_CORE_MODE)) {
        throw new Error('CORE_DEVELOPMENT_CONFIGURATION_REQUIRED');
    }
    const local = env.VCP_CORE_MODE !== 'shared';
    if (local && (!['127.0.0.1', '::1'].includes(listenHost) || typeof serverKey !== 'string' || !serverKey.trim())) {
        throw new Error('CORE_LOCAL_REQUIRES_AUTHENTICATED_LOOPBACK');
    }
    const adapter = local ? null : legacy?.coreBinding?.();
    if (!local && (!configuredWorkspace || !adapter)) throw new Error('CORE_SHARED_AUTHORITY_UNAVAILABLE');
    const { CoreService } = require('./service');
    const core = new CoreService({ directory, workspace: configuredWorkspace || 'personal', chat, ...adapter?.options });
    if (adapter) adapter.attach(core);
    if (local) app.use('/api/core', core.router(req => {
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) ||
            req.headers.authorization !== 'Bearer ' + serverKey) {
            throw Object.assign(new Error('CORE_LOCAL_ACCESS_REQUIRED'), { code: 'CORE_LOCAL_ACCESS_REQUIRED', status: 403 });
        }
        return core.local.actor;
    }));
    return core;
}

module.exports = { startCoreHost };

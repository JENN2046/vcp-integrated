'use strict';

function startCoreHost({ app, chat, listenHost, serverKey, modelCatalog, nativeStickers, env = process.env }) {
    const directory = env.VCP_CORE_DATA_DIR, configuredWorkspace = env.VCP_CORE_WORKSPACE;
    if (!directory && !configuredWorkspace && !env.VCP_CORE_MODE) return null;
    if (!directory || env.VCP_CORE_MODE && !['local', 'remote'].includes(env.VCP_CORE_MODE)) {
        throw new Error('CORE_DEVELOPMENT_CONFIGURATION_REQUIRED');
    }
    const remote = env.VCP_CORE_MODE === 'remote';
    if (remote && (!['127.0.0.1', '::1'].includes(listenHost) ||
        !/^[a-zA-Z0-9_-]{1,96}$/.test(configuredWorkspace || 'personal'))) {
        throw new Error('CORE_REMOTE_REQUIRES_LOOPBACK_PROXY');
    }
    const remoteOrigin = remote && require('./remoteAccess').remoteOrigin(env.VCP_CORE_REMOTE_ORIGIN).origin;
    const hours = Number(env.VCP_CORE_REMOTE_SESSION_HOURS || 8);
    if (remote && (!Number.isInteger(hours) || hours < 1 || hours > 720)) throw new Error('INVALID_MOBILE_SESSION_DURATION');
    if (!['127.0.0.1', '::1'].includes(listenHost) || typeof serverKey !== 'string' || !serverKey.trim()) {
        throw new Error('CORE_LOCAL_REQUIRES_AUTHENTICATED_LOOPBACK');
    }
    const { CoreService } = require('./service');
    const speech = remote ? require('../modules/speech/localSpeech').localSpeechConfig(env) : null;
    const core = new CoreService({ directory, workspace: configuredWorkspace || 'personal', chat, modelCatalog,
        defaultAgentModel: env.VCP_CORE_DEFAULT_AGENT_MODEL,
        ...(remote && { remoteConfig: { origin: remoteOrigin, hours, speech }, nativeStickers }) });
    if (remote) {
        core.remoteDesktopRouter = core.remote.router('desktop');
        core.remoteMobileRouter = core.remote.router('mobile');
    }
    if (!remote) app.use('/api/core', core.router(req => {
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) ||
            req.headers.authorization !== 'Bearer ' + serverKey) {
            throw Object.assign(new Error('CORE_LOCAL_ACCESS_REQUIRED'), { code: 'CORE_LOCAL_ACCESS_REQUIRED', status: 403 });
        }
        core.checkStorage(req);
        return core.local.actor;
    }));
    return core;
}

module.exports = { startCoreHost };

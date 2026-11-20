const path = require('path');

const PRELOAD_ROLES = Object.freeze({
    CHAT: 'chat',
    AUXILIARY_CHAT: 'auxiliary-chat',
    DESKTOP: 'desktop',
    UTILITY: 'utility',
    DOCX: 'docx',
    CHART: 'chart',
});

function resolvePreloadPathFromBase(basePath, role) {
    if (!Object.values(PRELOAD_ROLES).includes(role)) throw new TypeError('Unknown preload role');
    if (['chat', 'auxiliary-chat', 'utility', 'desktop'].includes(role)) {
        return path.join(basePath, 'preloads', 'bundled', 'dist', `${role}.cjs`);
    }
    // Dedicated preloads only require Electron, which the sandbox provides.
    return path.join(basePath, 'preloads', `${role}.js`);
}

function resolveProjectPreload(projectRoot, role) {
    return resolvePreloadPathFromBase(projectRoot, role);
}

function resolveAppPreload(appRoot, role) {
    return resolvePreloadPathFromBase(appRoot, role);
}

// Child windows only accept preloads whose sandbox contract is maintained here.
function resolveChildPreload(appRoot, override) {
    const fallback = resolveAppPreload(appRoot, PRELOAD_ROLES.UTILITY);
    if (override == null || override === '') return fallback;
    const allowed = [PRELOAD_ROLES.UTILITY, PRELOAD_ROLES.DESKTOP, PRELOAD_ROLES.DOCX, PRELOAD_ROLES.CHART]
        .map(role => resolveAppPreload(appRoot, role));
    if (typeof override !== 'string' || !allowed.includes(override)) throw new TypeError('Unsupported child preload override');
    return override;
}

module.exports = {
    PRELOAD_ROLES,
    resolveChildPreload,
    resolveProjectPreload,
    resolveAppPreload,
};

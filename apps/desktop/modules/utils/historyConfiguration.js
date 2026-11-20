'use strict';
const fs = require('fs-extra');

// Keep deletion facts in the existing native configuration authority. A cache,
// backup or a stale settings DTO must never restore History write permission.
async function protectHistoryConfiguration(configPath, next) {
    await require('../services/historyAuthority').assertConfigurationAdmission(configPath, next);
    let previous;
    try {
        const stat = await fs.lstat(configPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('HISTORY_CONFIG_IDENTITY_UNVERIFIED');
        previous = JSON.parse(await fs.readFile(configPath, 'utf8'));
        if (!previous || typeof previous !== 'object' || Array.isArray(previous)) throw new Error('HISTORY_CONFIG_UNVERIFIED');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (await fs.pathExists(configPath + '.backup')) throw new Error('HISTORY_CONFIG_RECOVERY_REQUIRED');
    }
    if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('HISTORY_CONFIG_UNVERIFIED');
    const oldDeleted = previous?._historyDeletedTopics, newDeleted = next._historyDeletedTopics;
    if ([oldDeleted, newDeleted].some(ids => ids !== undefined && (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')))) throw new Error('HISTORY_CONFIG_UNVERIFIED');
    const deleted = [...new Set([...(oldDeleted || []), ...(newDeleted || [])])];
    const canonical = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (Array.isArray(next.topics) && next.topics.some(t => typeof t?.id === 'string' && deleted.some(id => canonical(id) === canonical(t.id)))) throw new Error('HISTORY_TOPIC_DELETED');
    const deleting = Boolean(previous?._historyDeleting || next._historyDeleting);
    if (previous?._historyDeleting && Array.isArray(next.topics) && next.topics.length) throw new Error('HISTORY_OWNER_DELETED');
    return { ...next, ...(deleted.length ? { _historyDeletedTopics: deleted } : {}), ...(deleting ? { _historyDeleting: true } : {}) };
}
module.exports = { protectHistoryConfiguration };

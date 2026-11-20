/** Same-process host capability. Never populated from HTTP, IPC, or plugin config. */
const fs = require('node:fs/promises');
const path = require('node:path');
const { createSyncWriterBoundary } = require('../../../../modules/services/syncWriterBoundary');
let hostQueue = null;
let hostRoot = null;
let nativeConfigServices = {};

function configureHistoryLifecycle(queue, appDataPath, configServices = {}) {
  if (queue && path.resolve(queue.userDataDir) !== path.join(path.resolve(appDataPath), 'UserData')) {
    throw new Error('MobileSync History root differs from the host queue');
  }
  hostQueue = queue || null;
  hostRoot = path.resolve(appDataPath);
  nativeConfigServices = configServices;
}
function requireHistoryQueue(appDataPath, target) {
  if (!hostQueue || !hostRoot || (appDataPath && path.resolve(appDataPath) !== hostRoot)) {
    throw Object.assign(new Error('MobileSync requires the host HistoryMutationQueue'), { code: 'HISTORY_QUEUE_UNAVAILABLE' });
  }
  if (target) createSyncWriterBoundary(hostQueue).assertWrite(target);
  return hostQueue;
}
async function descriptorForHistory(filePath) {
  const queue = requireHistoryQueue();
  const relative = path.relative(path.resolve(queue.userDataDir), path.resolve(filePath));
  const parts = relative.split(path.sep);
  if (parts.length !== 4 || parts[1] !== 'topics' || parts[3] !== 'history.json' || parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error('MobileSync History path is outside the host authority');
  }
  const ownerTypes = [];
  for (const [itemType, folder] of [['agent', 'Agents'], ['group', 'AgentGroups']]) {
    try {
      const stat = await fs.lstat(path.join(hostRoot, folder, parts[0]));
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid History owner directory');
      ownerTypes.push(itemType);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (ownerTypes.length !== 1) throw new Error('History owner identity is missing or ambiguous');
  return { itemId: parts[0], itemType: ownerTypes[0], topicId: parts[2] };
}
async function initializeTopicHistory(appDataPath, ownerType, ownerId, topicId) {
  return requireHistoryQueue(appDataPath, { ownerType, ownerId, topicId }).initializeIfMissing({ itemId: ownerId, itemType: ownerType, topicId }, []);
}
async function mutateOwnerConfig(appDataPath, ownerType, ownerId, mutate) {
  const queue = requireHistoryQueue(appDataPath, { ownerType, ownerId });
  queue.getHistoryPath(ownerId, 'validate-owner-config');
  if (!['agent', 'group'].includes(ownerType)) throw new Error('Invalid native config owner type');
  const ownerPath = path.join(hostRoot, ownerType === 'group' ? 'AgentGroups' : 'Agents', ownerId);
  if (await fs.realpath(ownerPath) !== path.resolve(ownerPath)) throw new Error('Native config owner directory is unverified');
  const configStat = await fs.lstat(path.join(ownerPath, 'config.json'));
  if (!configStat.isFile() || configStat.isSymbolicLink() || configStat.nlink !== 1) throw new Error('Native config file identity is unverified');
  if (ownerType === 'agent') {
    const manager = nativeConfigServices.agentConfigManager;
    if (!manager || path.resolve(manager.agentDir) !== path.join(hostRoot, 'Agents')) throw new Error('HISTORY_NATIVE_CONFIG_MANAGER_REQUIRED');
    const result = await manager.updateAgentConfig(ownerId, async current => {
      if (current._historyDeleting) throw new Error('Owner history deletion is pending');
      return mutate(current);
    });
    return result.config;
  }
  if (ownerType === 'group' && typeof nativeConfigServices.groupConfigMutator === 'function') {
    const result = await nativeConfigServices.groupConfigMutator(ownerId, mutate);
    if (!result.success) throw new Error(result.error || 'Native group config update failed');
    return result.agentGroup;
  }
  throw new Error('HISTORY_NATIVE_CONFIG_MANAGER_REQUIRED');
}
module.exports = { mutateOwnerConfig, configureHistoryLifecycle, requireHistoryQueue, descriptorForHistory, initializeTopicHistory };

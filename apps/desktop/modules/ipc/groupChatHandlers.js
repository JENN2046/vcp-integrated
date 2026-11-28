const { vcpServerEndpoint } = require('../utils/vcpServerRoutes');
// modules/ipc/groupChatHandlers.js
const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const { pathToFileURL } = require('url');
const groupChat = require('../../Groupmodules/groupchat');
const { HistoryMutationQueue } = require('../services/historyMutationQueue');
const { clearTrajectoryOf, clearTrajectoriesOfOwner } = require('../modelTrajectory');

/**
 * Initializes group chat related IPC handlers.
 * @param {BrowserWindow} mainWindow The main window instance.
 * @param {object} context - An object containing necessary context.
 * @param {string} context.AGENT_DIR - The path to the agents directory.
 * @param {string} context.USER_DATA_DIR - The path to the user data directory.
 * @param {function} context.getSelectionListenerStatus - Function to get the current status of the selection listener.
 * @param {function} context.stopSelectionListener - Function to stop the selection listener.
 * @param {function} context.startSelectionListener - Function to start the selection listener.
 */
let ipcHandlersRegistered = false;
let admissionGroupAdvance = null;

function advanceTopicAdmission(request) {
    if (!admissionGroupAdvance) throw new Error('群聊推进运行时尚未初始化，已暂停');
    return admissionGroupAdvance(request);
}
const AVATAR_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

async function findAvatarUrl(agentDir, cacheBust = false) {
    for (const ext of AVATAR_EXTENSIONS) {
        const avatarPath = path.join(agentDir, `avatar${ext}`);
        if (await fs.pathExists(avatarPath)) {
            const url = pathToFileURL(avatarPath).toString();
            // Version by modification time: the URL changes when the avatar
            // does, so lists can reuse the cached image instead of
            // re-downloading every avatar on every refresh.
            const stat = await fs.stat(avatarPath).catch(() => null);
            const version = stat ? Math.round(stat.mtimeMs) : (cacheBust ? Date.now() : null);
            return version === null ? url : `${url}?v=${version}`;
        }
    }
    return null;
}

function initialize(mainWindow, context) {
    const {
        AGENT_DIR,
        USER_DATA_DIR,
        getSelectionListenerStatus,
        stopSelectionListener,
        startSelectionListener,
        fileWatcher,
        historyMutationQueue = new HistoryMutationQueue({ userDataDir: USER_DATA_DIR, fileWatcher }),
        jevService = null,
        gameService = null,
        getModelCatalog = null,
        topicAdmission = null
    } = context;

    if (ipcHandlersRegistered) {
        return;
    }

    // Helper function to get agent config, needed by multiple handlers
    const getAgentConfigById = async (agentId) => {
        const agentDir = path.join(AGENT_DIR, agentId);
        const configPath = path.join(agentDir, 'config.json');
        if (await fs.pathExists(configPath)) {
            const config = await fs.readJson(configPath);
            config.avatarUrl = await findAvatarUrl(agentDir, true);
            config.id = agentId; // Ensure ID is part of the returned config
            return config;
        }
        return { error: `Agent config for ${agentId} not found.` };
    };

    const notifyGroupTopicUpdated = payload => {
        if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('vcp-group-topic-updated', payload);
        }
    };

    groupChat.initializeRuntimeServices({
        historyMutationQueue,
        topicAdmission,
        jevService,
        getAgentConfigById,
        notifyTopicUpdated: notifyGroupTopicUpdated
    });

    if (gameService) {
        let modelCache = { fetchedAt: 0, ids: [] };
        const readAllAgentConfigs = async () => {
            const entries = await fs.readdir(AGENT_DIR, { withFileTypes: true });
            const configs = await Promise.all(entries.filter(entry => entry.isDirectory())
                .map(entry => getAgentConfigById(entry.name)));
            return configs.filter(config => !config.error);
        };
        require('./gameHandlers').configureRuntime({
            gameService, groupChat, loadAgent: getAgentConfigById,
            getCoreGame: ({ groupId, topicId }) => {
                const descriptor = { itemType: 'group', itemId: groupId, topicId };
                const client = historyMutationQueue.coreClient;
                return client?.owns(descriptor) ? { client, descriptor } : null;
            },
            listAgents: async () => {
                const configs = await readAllAgentConfigs();
                return configs.filter(config => config.model)
                    .map(config => ({
                        id: config.id,
                        name: config.name || config.id,
                        avatarUrl: config.avatarUrl,
                        model: typeof config.model === 'string' ? config.model.trim() : '',
                    }));
            },
            listModels: async ({ forceRefresh = false } = {}) => {
                const modelUsageTracker = require('../modelUsageTracker');
                const { fetchDesktopModelCatalog, gameModelChoices } = require('../services/modelCatalog');
                const [favoriteModels, hotModels, agentConfigs] = await Promise.all([
                    modelUsageTracker.getFavoriteModels().catch(() => []),
                    modelUsageTracker.getHotModels(15).catch(() => []),
                    readAllAgentConfigs().catch(() => []),
                ]);
                const now = Date.now();
                if (forceRefresh || !modelCache.fetchedAt || now - modelCache.fetchedAt > 30000) {
                    try {
                        const models = getModelCatalog ? await getModelCatalog() : await (async () => {
                            const root = path.dirname(USER_DATA_DIR);
                            const settingsPath = path.join(root, 'settings.json');
                            const settings = await fs.pathExists(settingsPath) ? await fs.readJson(settingsPath) : {};
                            return fetchDesktopModelCatalog({
                                root, settings, getCoreClient: async () => historyMutationQueue.coreClient
                            });
                        })();
                        modelCache = Array.isArray(models) ? { fetchedAt: now, ids: models } : { fetchedAt: 0, ids: [] };
                    } catch {
                        // Fall back to cached / local agent models without blocking table setup.
                    }
                }
                return gameModelChoices({
                    catalog: modelCache.fetchedAt ? modelCache.ids : null,
                    favoriteModels, hotModels, agentModels: agentConfigs.map(config => config.model)
                });
            },
        });
    }

    const createStreamSender = () => data => {
        if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('vcp-stream-event', data);
        }
    };

    admissionGroupAdvance = require('../services/topicAdmissionGroup').createTopicAdmissionGroup({
        readHistory: scope => historyMutationQueue.read(scope),
        reportUncertain: (scope, token, error) => topicAdmission?.reportUncertain(scope, token, error),
        loadGroupConfig: groupId => groupChat.getAgentGroupConfig(groupId),
        runGroup: (groupId, topicId, payload, options) => groupChat.handleGroupChatMessage(
            groupId, topicId, payload, createStreamSender(), getAgentConfigById, options),
    });

    // --- Group Chat IPC Handlers ---
    ipcMain.handle('create-agent-group', async (event, groupName, initialConfig) => {
        return await groupChat.createAgentGroup(groupName, initialConfig);
    });

    ipcMain.handle('get-agent-groups', async () => {
        return groupChat.getAgentGroups();
    });

    ipcMain.handle('get-agent-group-config', async (event, groupId) => {
        return groupChat.getAgentGroupConfig(groupId);
    });

    ipcMain.handle('save-agent-group-config', async (event, groupId, configData) => {
        const saveLocal = () => groupChat.saveAgentGroupConfig(groupId, configData);
        return await (context.saveOwnerConfig?.({
            kind: 'group', localId: groupId, config: configData, saveLocal,
            readSaved: () => groupChat.getAgentGroupConfig(groupId),
        }) ?? saveLocal());
    });

    ipcMain.handle('delete-agent-group', async (event, groupId, options) => {
        const removal = await context.beforeOwnerDelete?.({ itemType: 'group', itemId: groupId }, options);
        if (removal) return removal;
        if (options != null) return { success: false, error: 'SHARED_NATIVE_BINDING_CHANGED' };
        const result = await groupChat.deleteAgentGroup(groupId);
        if (result?.success) await clearTrajectoriesOfOwner({ groupId });
        return result;
    });

    async function saveLocalAvatar(groupId, avatarData) {
        const listenerWasActive = getSelectionListenerStatus();
        if (listenerWasActive) {
            stopSelectionListener();
            console.log('[Main] Temporarily stopped selection listener for group avatar dialog.');
        }
        try {
            const result = await groupChat.saveAgentGroupAvatar(groupId, avatarData);
            return result;
        } finally {
            if (listenerWasActive) {
                startSelectionListener();
                console.log('[Main] Restarted selection listener after group avatar dialog.');
            }
        }
    }

    ipcMain.handle('save-agent-group-avatar', async (event, groupId, avatarData) => {
        const saveLocal = () => saveLocalAvatar(groupId, avatarData);
        return await (context.saveOwnerAvatar?.({ kind: 'group', localId: groupId, data: avatarData, saveLocal }) ?? saveLocal());
    });

    ipcMain.handle('get-group-topics', async (event, groupId, searchTerm) => {
        return await groupChat.getGroupTopics(groupId, searchTerm);
    });

    ipcMain.handle('create-new-topic-for-group', async (event, groupId, topicName) => {
        const core = historyMutationQueue?.coreClient;
        try {
            core?.assertCanConfigure();
            const result = await groupChat.createNewTopicForGroup(groupId, topicName);
            if (result.success) await core?.defineTopic({ itemType: 'group', itemId: groupId, topicId: result.topicId });
            return result;
        } catch (error) { return { success: false, error: error.code || error.message }; }
    });

    ipcMain.handle('delete-group-topic', async (event, groupId, topicId, options) => {
        if(typeof topicId!=='string'||!topicId)return {success:false,error:'INVALID_TOPIC_ID'};
        const removal = await context.beforeOwnerDelete?.({ itemType: 'group', itemId: groupId, topicId }, options,
            () => groupChat.createNewTopicForGroup(groupId, '主要群聊', true));
        if (removal) return removal;
        if (options != null) return { success: false, error: 'SHARED_NATIVE_BINDING_CHANGED' };
        const result = await groupChat.deleteGroupTopic(groupId, topicId);
        if (result?.success) await clearTrajectoryOf({ groupId, topicId });
        return result;
    });

    ipcMain.handle('save-group-topic-title', async (event, groupId, topicId, newTitle, options) => {
        const core = historyMutationQueue?.coreClient;
        try {
            core?.assertCanConfigure();
            const result = await groupChat.saveGroupTopicTitle(groupId, topicId, newTitle);
            if (result.success) await core?.defineTopic({ itemType: 'group', itemId: groupId, topicId });
            return result;
        } catch (error) { return { success: false, error: error.code || error.message }; }
    });

    ipcMain.handle('regenerate-group-topic-title', async (event, groupId, topicId) => {
        return await groupChat.regenerateGroupTopicTitle(groupId, topicId);
    });

    const coreGroup = (groupId, topicId) => {
        const descriptor = { itemType: 'group', itemId: groupId, topicId };
        const client = historyMutationQueue.coreClient;
        return { descriptor, client: client?.owns(descriptor) ? client : null };
    };

    ipcMain.handle('get-group-chat-history', async (event, groupId, topicId) => {
        const { client, descriptor } = coreGroup(groupId, topicId);
        if (client) {
            try {
                const result = await client.history(descriptor);
                client.observe(client.mapping(descriptor));
                return result.history;
            } catch (error) { return { error: error.code || error.message }; }
        }
        try {
            return await groupChat.getGroupChatHistory(groupId, topicId);
        } catch (error) { return { error: error.code || error.message }; }
    });

    ipcMain.handle('save-group-chat-history', async (event, groupId, topicId, history, options) => {
        if (!groupId || !topicId || !Array.isArray(history)) {
            const errorMsg = `保存群组 ${groupId} 话题 ${topicId} 聊天历史失败: 参数无效。`;
            console.error(errorMsg);
            return { success: false, error: errorMsg };
        }
        try {
            const result = await historyMutationQueue.replace(
                { itemId: groupId, itemType: 'group', topicId },
                history,
                { requireExisting: true, expectedRevision: typeof options === "string" ? options : options?.expectedRevision, expectedHistory: options?.expectedHistory }
            );
            console.log(`[Main IPC] 群组 ${groupId} 话题 ${topicId} 聊天历史已通过共享历史队列保存`);
            return { success: true, localState:result.localState,history:result.history,...(result.sync ? { sync: result.sync, revision: result.revision } : {}) };
        } catch (error) {
            console.error(`[Main IPC] 保存群组 ${groupId} 话题 ${topicId} 聊天历史失败:`, error);
            return { success: false, error: error.message, code: error.code };
        }
    });

    ipcMain.handle('send-group-chat-message', async (event, groupId, topicId, userMessage) => {
        if (event.sender !== mainWindow?.webContents) return { success: false, code: 'FORBIDDEN' };
        if (!topicAdmission) return { success: false, error: '中央消息入场服务不可用' };
        try {
            if (!userMessage?.id || userMessage.role !== 'user'
                || typeof userMessage.content?.text !== 'string') {
                throw new TypeError('群聊用户消息参数无效');
            }
            const { client, descriptor } = coreGroup(groupId, topicId);
            if (client) {
                return await client.send(descriptor, { id: userMessage.id, role: 'user', attachments: userMessage.attachments || [],
                    content: userMessage.originalUserText ?? userMessage.content.text });
            }
            const originalText = typeof userMessage.originalUserText === 'string'
                ? userMessage.originalUserText : userMessage.content.text;
            return await topicAdmission.submit({
                scope: { itemType: 'group', itemId: groupId, topicId },
                message: {
                    id: userMessage.id, role: 'user', name: userMessage.name,
                    content: originalText, attachments: userMessage.attachments || [],
                    timestamp: Date.now(), isGroupMessage: true, groupId, topicId,
                    _metadata: { groupRequestText: userMessage.content.text },
                },
                requestId: userMessage.id,
                triggerPolicy: 'reply',
            });
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('inviteAgentToSpeak', async (event, groupId, topicId, invitedAgentId) => {
        if (event.sender !== mainWindow?.webContents) return { success: false, error: 'FORBIDDEN' };
        console.log(`[Main IPC] Received inviteAgentToSpeak for Group: ${groupId}, Topic: ${topicId}, Agent: ${invitedAgentId}`);
        try {
            const sendStreamChunkToRenderer = createStreamSender();
            const { client, descriptor } = coreGroup(groupId, topicId);
            if (client) return client.groupMode(descriptor) === 'jev'
                ? await client.jev(descriptor, 'invite', invitedAgentId)
                : await client.invite(descriptor, invitedAgentId);
            const groupConfig = await groupChat.getAgentGroupConfig(groupId);
            if (groupConfig?.mode === 'jev') {
                return await groupChat.enqueueJevGroupAgent(
                    groupId,
                    topicId,
                    invitedAgentId,
                    sendStreamChunkToRenderer
                );
            }

            const result = await groupChat.handleInviteAgentToSpeak(groupId, topicId, invitedAgentId, sendStreamChunkToRenderer, getAgentConfigById);
            if (result?.error) return { success: false, error: result.error, status: result.status };
            return { success: true, message: "Agent invitation processing started." };
        } catch (error) {
            console.error(`[Main IPC] Error in inviteAgentToSpeak handler for Group ${groupId}, Agent ${invitedAgentId}:`, error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-jev-group-chat', async (event, groupId, topicId) => {
        try {
            const { client, descriptor } = coreGroup(groupId, topicId);
            if (client) {
                if (event.sender !== mainWindow?.webContents) return { success: false, error: 'FORBIDDEN' };
                return await client.jev(descriptor, 'start');
            }
            return await groupChat.startJevGroupChat(
                groupId,
                topicId,
                createStreamSender()
            );
        } catch (error) {
            console.error(`[Main IPC] Error starting JEV group chat for ${groupId}/${topicId}:`, error);
            return { success: false, error: error.message, code: error.code };
        }
    });

    ipcMain.handle('continue-jev-group-chat', async (event, groupId, topicId) => {
        try {
            const { client, descriptor } = coreGroup(groupId, topicId);
            if (client) {
                if (event.sender !== mainWindow?.webContents) return { success: false, error: 'FORBIDDEN' };
                return await client.jev(descriptor, 'continue');
            }
            return await groupChat.continueJevGroupChat(
                groupId,
                topicId,
                createStreamSender()
            );
        } catch (error) {
            console.error(`[Main IPC] Error continuing JEV group chat for ${groupId}/${topicId}:`, error);
            return { success: false, error: error.message, code: error.code };
        }
    });

    ipcMain.handle('enqueue-jev-group-agent', async (event, groupId, topicId, agentId) => {
        try {
            const { client, descriptor } = coreGroup(groupId, topicId);
            if (client) {
                if (event.sender !== mainWindow?.webContents) return { success: false, error: 'FORBIDDEN' };
                return await client.jev(descriptor, 'invite', agentId);
            }
            return await groupChat.enqueueJevGroupAgent(
                groupId,
                topicId,
                agentId,
                createStreamSender()
            );
        } catch (error) {
            console.error(`[Main IPC] Error enqueueing JEV group agent for ${groupId}/${topicId}:`, error);
            return { success: false, error: error.message, code: error.code };
        }
    });

    ipcMain.handle('get-jev-group-chat-state', async (event, groupId, topicId) => {
        const { client, descriptor } = coreGroup(groupId, topicId);
        if (client) {
            if (event.sender !== mainWindow?.webContents) return { success: false, error: 'FORBIDDEN' };
            return client.jev(descriptor);
        }
        return groupChat.getJevGroupChatState(groupId, topicId);
    });

    ipcMain.handle('interrupt-group-chat-queue', async (event, groupId, topicId) => {
        console.log(`[Main IPC] Received interrupt-group-chat-queue for Group: ${groupId}, Topic: ${topicId}`);
        try {
            const { client, descriptor } = coreGroup(groupId, topicId);
            if (client) {
                if (event.sender !== mainWindow?.webContents) return { success: false, error: 'FORBIDDEN' };
                if (client.groupMode(descriptor) === 'jev') return await client.jev(descriptor, 'stop');
                const status = await client.status(descriptor);
                const work = status.executions.find(entry => entry.canCancel);
                return work ? await client.control(descriptor, work.id, 'cancel') : { success: false, error: 'WORK_NOT_CANCELLABLE' };
            }
            return await groupChat.interruptGroupChatQueue(groupId, topicId);
        } catch (error) {
            console.error(`[Main IPC] Error interrupting group queue for ${groupId}/${topicId}:`, error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('redo-group-chat-message', async (event, groupId, topicId, messageId, agentId) => {
        console.log(`[Main IPC] Received redo-group-chat-message for Group: ${groupId}, Topic: ${topicId}, Message: ${messageId}, Agent: ${agentId}`);
        try {
            const sendStreamChunkToRenderer = (data) => {
                if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                    mainWindow.webContents.send('vcp-stream-event', data);
                }
            };

            const { client, descriptor } = coreGroup(groupId, topicId);
            if (client) {
                if (event.sender !== mainWindow?.webContents) return { success: false, error: 'FORBIDDEN' };
                return await client.invite(descriptor, agentId, { id: messageId });
            }
            // This new function will be created in groupchat.js
            await groupChat.redoGroupChatMessage(groupId, topicId, messageId, agentId, sendStreamChunkToRenderer, getAgentConfigById);

            return { success: true, message: "Redo group chat message processing started." };
        } catch (error) {
            console.error(`[Main IPC] Error in redo-group-chat-message handler for Group ${groupId}, Message ${messageId}:`, error);
            return { success: false, error: error.message };
        }
    });

    ipcHandlersRegistered = true;
}

module.exports = {
    initialize,
    advanceTopicAdmission
};

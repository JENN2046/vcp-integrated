'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const chat = path.resolve(__dirname,'../../apps/desktop');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function actualSaveTail(file, start, end) {
    const source = fs.readFileSync(path.join(chat, file), 'utf8');
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from);
    return source.slice(from, to);
}

const agent = actualSaveTail('modules/settingsManager.js',
    '        let result;\n        try {\n            if (!isSaveContextCurrent())',
    '\n    }\n\n    /**\n     * Handles the deletion of the currently selected item (agent or group).');
const group = actualSaveTail('Groupmodules/grouprenderer.js',
    '        let result;\n        try {\n            if (!isCurrentSave()) return;',
    '\n    }\n\n    async function handleDeleteCurrentGroup');

function run(tail, context) {
    return new AsyncFunction(...Object.keys(context), tail)(...Object.values(context));
}

for (const switched of [false, true]) {
    test('Agent accepted report survives a rejected refresh' + (switched ? ' after switching forms' : ''), async () => {
        const reports = [], notices = [];
        let current = true;
        const receipt = { success: true, sharedVersion: 2 };
        const result = await run(agent, {
            electronAPI: { saveAgentConfig: async () => receipt },
            isSaveContextCurrent: () => current,
            sharedAgentBase: { sharedId: 'agent', version: 1 },
            agentId: 'agent', newConfig: {}, agentSettingsForm: {}, localAvatarSaved: false,
            reportSettingsSaveResult: (_form, success) => reports.push(success),
            unsavedAgentDrafts: new Map(), agentSettingsRevision: 1, saveRevision: 1,
            isAgentSettingsDirty: true, saveButton: null,
            uiHelper: { showToastNotification: (_message, type) => notices.push(type) },
            window: { itemListManager: { loadItems: async () => {
                if (switched) current = false;
                throw new Error('Synthetic renderer refresh failed');
            } } },
            console: { error() {} },
        });
        assert.deepEqual(result, { success: true, stale: switched, result: receipt });
        assert.deepEqual(reports, [true]);
        assert.deepEqual(notices, switched ? [] : ['warning']);
    });

    test('Group accepted report survives rejected invite refresh' + (switched ? ' after switching forms' : ''), async () => {
        const reports = [], notices = [];
        let current = true;
        const groupId = 'group';
        const newConfig = { __nativeSyncSharedBase: { sharedId: groupId, version: 1 } };
        const receipt = { success: true, sharedVersion: 2, agentGroup: { name: 'New', mode: 'invite_only', members: ['agent'] } };
        await run(group, {
            electronAPI: {
                saveAgentGroupConfig: async () => receipt,
                getAgentConfig: async () => {
                    if (switched) current = false;
                    throw new Error('Synthetic invite member refresh failed');
                },
            },
            targetGroupId: groupId, groupId, newConfig, sharedGroupBase: newConfig.__nativeSyncSharedBase,
            avatarError: undefined, avatarStatus: () => '',
            isCurrentSave: () => current, groupSettingsForm: { querySelector: () => null }, saveRevision: 1,
            reportSettingsSaveResult: success => reports.push(success),
            uiHelper: { showToastNotification: (_message, type) => notices.push(type) },
            mainRendererFunctions: { loadItems: async () => {} }, mainRendererElements: {},
            currentSelectedItemRef: { get: () => ({ id: groupId, type: 'group' }), set() {} },
            messageRenderer: { setCurrentItemAvatar() {}, setCurrentItemAvatarColor() {} },
            selectedItemNameForSettingsElementFromRenderer: null,
            document: { getElementById: () => null },
            window: { dispatchEvent() {} },
            console: { error() {} },
        });
        assert.deepEqual(reports, [true]);
        assert.deepEqual(notices, switched ? [] : ['warning']);
    });
}

test('Agent directory refresh cannot replace a Group selected while its read is pending', async () => {
    const passive = actualSaveTail('modules/settingsManager.js',
        '            if (passive) {\n',
        '\n            if(discardDraft){');
    let current = { id: 'agent', type: 'agent' };
    let generation = 1;
    let populations = 0;
    const result = await run(passive, {
        passive: true, agentId: 'agent', settingsDisplayToken: 1, discardDraft: false,
        isAgentSettingsDirty: false, mainRendererFunctions: { getCroppedFile: () => null },
        refs: { currentSelectedItemRef: { get: () => current } },
        window: { VCPSettingsSidebar: {
            getSnapshot: () => ({ activeKind: current.type, activeId: current.id, generation }),
            isCurrent: token => token.generation === generation,
            show() { assert.fail('A background refresh cannot mount a view'); },
        } },
        electronAPI: { getAgentConfig: async () => {
            current = { id: 'group', type: 'group' };
            generation++;
            return { name: 'Original Agent' };
        } },
        populateAgentSettingsForm() { populations++; },
    });
    assert.deepEqual(result, { success: true, stale: true });
    assert.equal(populations, 0);
});

const agentAvatarSave = actualSaveTail('modules/settingsManager.js',
    "        const croppedFile = mainRendererFunctions.getCroppedFile('agent');",
    '        if (newConfig.__nativeSyncAvatar && result.refreshError)');
const groupAvatarSave = actualSaveTail('Groupmodules/grouprenderer.js',
    '        let avatarError;',
    '\n    }\n\n    async function handleDeleteCurrentGroup');

for (const scenario of [
    { label: 'image read failure', read: async () => { throw new Error('read failed'); }, notice: '头像未更换，名称等设置未保存' },
    { label: 'image write rejected', saveAvatar: async () => ({ error: 'write failed' }), notice: '头像未更换，名称等设置未保存' },
    { label: 'image write response dropped', saveAvatar: async () => { throw new Error('lost response'); }, notice: '头像保存结果待确认，名称等设置未提交' },
    { label: 'shared image rejected', shared: true, saveConfig: async () => ({ success: false, avatarResult: { error: 'INVALID_AVATAR' } }), notice: '头像未更换，名称等设置未保存' },
    { label: 'shared outcome pending', shared: true, saveConfig: async () => ({ success: false, error: 'SHARED_CONFIG_PENDING_CONFIRMATION' }), notice: '共享设置保存结果待确认' },
    { label: 'confirmed local avatar and config denied', saveConfig: async () => ({ success: false, error: 'AGENT_DELETED' }), notice: '头像已保存，名称等设置未保存' },
    { label: 'confirmed local avatar and config response dropped', saveConfig: async () => { throw new Error('lost response'); }, notice: '头像已保存，名称等设置保存结果待确认' },
]) {
    test('Agent feedback distinguishes ' + scenario.label, async () => {
        const notices = [];
        const croppedFile = { name: 'crop.png', type: 'image/png', arrayBuffer: scenario.read || (async () => new ArrayBuffer(1)) };
        const result = await run(agentAvatarSave, {
            agentId: 'agent', newConfig: scenario.shared ? { __nativeSyncSharedBase: { version: 1 } } : {},
            agentSettingsForm: {}, saveButton: null, isSaveContextCurrent: () => true, portraitSettings: null,
            agentAvatarPreview: null, agentAvatarInput: null, reportSettingsSaveResult() {},
            mainRendererFunctions: { getCroppedFile: () => croppedFile, setCroppedFile() {} },
            electronAPI: {
                saveAvatar: scenario.saveAvatar || (async () => ({ success: true })),
                saveAgentConfig: scenario.saveConfig || (async () => assert.fail('Name save should not run')),
            },
            uiHelper: { showToastNotification: message => notices.push(message) },
            console: { error() {} },
        });
        assert.equal(result.success, false);
        assert.equal(notices.length, 1);
        assert.ok(notices[0].startsWith(scenario.notice), notices[0]);
    });
}

for (const scenario of [
    { label: 'image write rejected and name saved', avatar: { success: false, error: 'write failed' }, config: async () => ({ success: true }), notice: '群组名称等设置已保存，头像未更换' },
    { label: 'image file staged but pointer rejected', avatar: { success: true, avatarConfigError: 'config rename denied' }, config: async () => ({ success: true }), notice: '群组名称等设置已保存，头像未更换' },
    { label: 'confirmed local avatar and config denied', avatar: { success: true }, config: async () => ({ success: false, error: 'NATIVE_CONFIG_NOT_AVAILABLE' }), notice: '头像已保存，名称等设置未保存' },
    { label: 'confirmed local avatar and config response dropped', avatar: { success: true }, config: async () => { throw new Error('lost response'); }, notice: '头像已保存，名称等设置保存结果待确认' },
]) {
    test('Group feedback distinguishes ' + scenario.label, async () => {
        const notices = [];
        await run(groupAvatarSave, {
            targetGroupId: 'group', newConfig: {}, saveRevision: 1, isCurrentSave: () => true,
            reportSettingsSaveResult() {}, groupSettingsForm: { querySelector: () => null },
            groupAvatarPreview: null, groupAvatarInput: null, sharedGroupBase: null,
            croppedGroupAvatar: { name: 'crop.png', type: 'image/png', arrayBuffer: async () => new ArrayBuffer(1) },
            mainRendererFunctions: { getCroppedFile: () => null, loadItems: async () => {} },
            electronAPI: { saveAgentGroupAvatar: async () => scenario.avatar, saveAgentGroupConfig: scenario.config },
            uiHelper: { showToastNotification: message => notices.push(message) },
            console: { error() {} },
        });
        assert.equal(notices.length, 1);
        assert.ok(notices[0].startsWith(scenario.notice), notices[0]);
    });
}

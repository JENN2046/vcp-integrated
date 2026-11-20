'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const launcherName = '.side-pane-launcher-name';
const names = {
    preSubmit: 'Synthetic shared',
    lostAck: 'Synthetic lost receipt',
    interrupted: 'Synthetic interrupted single',
};

module.exports = async ({ clients: { A, B }, profiles, out, result, service, click, evalJs, waitUntil, picture }) => {
    const db = new DatabaseSync(path.join(service.data, 'central.sqlite'), { readOnly: true });
    const profile = role => profiles?.[role] || path.join(out, 'profile-' + role);
    const localConfigFile = (role, subject) => path.join(profile(role), 'Agents', service.descriptors[role][subject].itemId, 'config.json');
    const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
    const localConfig = (role, subject) => read(localConfigFile(role, subject));
    const nativeConfig = (client, subject, role) => evalJs(client,
        'window.electronAPI.getAgentConfig(' + JSON.stringify(service.descriptors[role][subject].itemId) + ')');
    const remote = id => {
        const row = db.prepare('SELECT version, config_json FROM shared_configs WHERE object_id=? ORDER BY version DESC LIMIT 1').get(id);
        return { version: row.version, config: JSON.parse(row.config_json) };
    };
    const posts = name => service.requests.filter(row => row.route.endsWith('/shared/config') && row.body?.config?.name === name);

    async function select(client, role, subject) {
        if (!await evalJs(client, "document.querySelector('#tabContentAgents').classList.contains('active')")) {
            await click(client, '.sidebar-tab-button[data-tab="agents"]');
        }
        await click(client, '#agentList > li .agent-name', names[subject]);
        await waitUntil(async () => (await evalJs(client, 'window.VCPStateChannels.get("conversation.current").get()'))?.itemId
            === service.descriptors[role][subject].itemId, role + ' selected ' + subject);
        return waitUntil(async () => (await nativeConfig(client, subject, role))?.__nativeSyncSharedBase, role + ' version ' + subject);
    }
    async function editLauncher(client, name) {
        if (!await evalJs(client, 'document.querySelector("#toggleSidePaneChatBtn")?.getAttribute("aria-expanded") === "true"')) {
            await evalJs(client, 'document.getElementById("toggleSidePaneChatBtn").click()');
        }
        if (!await evalJs(client, 'document.querySelector("#sidePaneViewLauncher")?.classList.contains("active")')) {
            await evalJs(client, 'document.getElementById("sidePaneHomeBtn").click()');
        }
        await waitUntil(() => evalJs(client, `(() => {
            const input = document.querySelector(${JSON.stringify(launcherName)});
            return input?.checkVisibility({checkVisibilityCSS:true}) && !input.readOnly;
        })()`), 'launcher is visible and writable');
        const focused = await evalJs(client, `(() => { const input = document.querySelector(${JSON.stringify(launcherName)});
            input.focus();
            input.value = ${JSON.stringify(name)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return document.activeElement === input && !input.readOnly;
        })()`);
        assert.equal(focused, true, 'launcher rename input focused');
    }
    function commitLauncher(client) {
        return evalJs(client, `(() => { const input = document.querySelector(${JSON.stringify(launcherName)});
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            return true;
        })()`);
    }
    const launcherValue = client => evalJs(client, `document.querySelector(${JSON.stringify(launcherName)})?.value`);
    const versionRows = id => db.prepare('SELECT version FROM shared_configs WHERE object_id=? ORDER BY version').all(id).length;

    try {
        const first = 'interrupted';
        const staleName = 'Desktop A synthetic retained conflict';
        const acceptedName = 'Desktop B synthetic accepted rename';
        const [aBase, bBase] = await Promise.all([select(A, 'A', first), select(B, 'B', first)]);
        assert.deepEqual(aBase, bBase);
        const before = remote(aBase.sharedId);
        const beforeVersions = versionRows(aBase.sharedId);
        await editLauncher(A, staleName);
        await editLauncher(B, acceptedName);
        await commitLauncher(B);
        await waitUntil(() => remote(aBase.sharedId).config.name === acceptedName, 'B name accepted');
        const won = remote(aBase.sharedId);
        assert.deepEqual(won, { version: before.version + 1, config: { ...before.config, name: acceptedName } });
        await commitLauncher(A);
        await waitUntil(() => posts(staleName).some(request => request.status === 409), 'A prior version conflicts');
        const drafts = path.join(profile('A'), '.native-sync', 'shared', 'sharedAB', 'configs.json');
        await waitUntil(() => {
            const draft = read(drafts).drafts[aBase.sharedId];
            return draft?.conflict && draft.config?.name === staleName;
        }, 'conflicted native draft persisted');
        assert.equal(await launcherValue(A), staleName);
        assert.deepEqual(remote(aBase.sharedId), won);
        assert.equal(versionRows(aBase.sharedId), beforeVersions + 1);
        await waitUntil(() => localConfig('B', first).name === acceptedName, 'winner projected in B');
        await picture(A, 'quick-name-conflict');

        const second = 'lostAck';
        const name = 'Synthetic name lost acknowledgement';
        const [lostBase] = await Promise.all([select(A, 'A', second), select(B, 'B', second)]);
        const lostBefore = remote(lostBase.sharedId);
        const lostVersions = versionRows(lostBase.sharedId);
        await editLauncher(A, name);
        service.dropConfigOnce(name);
        await commitLauncher(A);
        const dropped = await waitUntil(() => posts(name).find(request => request.dropped), 'accepted native rename reply dropped');
        await waitUntil(() => {
            const draft = read(drafts).drafts[lostBase.sharedId];
            return draft?.submitted && draft.opId === dropped.body.opId;
        }, 'original name intent still pending');
        await waitUntil(() => evalJs(A, 'document.body.innerText.includes("名称保存结果待确认")'), 'pending native rename visible');
        assert.equal(await launcherValue(A), name);
        await editLauncher(A, name);
        await commitLauncher(A);
        const replay = await waitUntil(() => posts(name).find(request => !request.dropped && request.status === 200), 'original name operation recovered');
        assert.deepEqual(replay.body, dropped.body);
        assert.deepEqual(remote(lostBase.sharedId), { version: lostBefore.version + 1, config: { ...lostBefore.config, name } });
        assert.equal(versionRows(lostBase.sharedId), lostVersions + 1);
        await waitUntil(() => ['A', 'B'].every(role => localConfig(role, second).name === name), 'accepted rename projected on both devices');
        await picture(A, 'quick-name-recovered');

        const avatarSubject = 'preSubmit';
        const avatarName = 'Synthetic name and avatar saved together';
        const avatarBase = await select(A, 'A', avatarSubject);
        const avatarBefore = remote(avatarBase.sharedId);
        const avatarVersions = versionRows(avatarBase.sharedId);
        await evalJs(A, `document.querySelector('.sidebar-tab-button[data-tab="settings"]').click()`);
        await waitUntil(() => evalJs(A, 'Boolean(document.getElementById("agentAvatarInput") && document.getElementById("agentNameInput"))'),
            'native agent settings form');
        await evalJs(A, `(async () => {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 128;
            const context = canvas.getContext('2d');
            context.fillStyle = '#194b8f';
            context.fillRect(0, 0, 128, 128);
            context.fillStyle = '#f1d745';
            context.fillRect(24, 24, 80, 80);
            const image = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            const picker = document.getElementById('agentAvatarInput');
            const transfer = new DataTransfer();
            transfer.items.add(new File([image], 'synthetic-avatar.png', { type: 'image/png' }));
            picker.files = transfer.files;
            picker.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        await waitUntil(() => evalJs(A, 'document.getElementById("avatarCropperModal")?.classList.contains("active")'),
            'native avatar crop dialog');
        await click(A, '#confirmCropBtn');
        await waitUntil(() => evalJs(A, 'document.getElementById("agentAvatarPreview")?.src.startsWith("blob:")'),
            'native cropped avatar preview');
        await evalJs(A, `(() => {
            const input = document.getElementById('agentNameInput');
            input.value = ${JSON.stringify(avatarName)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.form.requestSubmit();
        })()`);
        const avatarAccepted = await waitUntil(() => {
            const current = remote(avatarBase.sharedId);
            return current.config.name === avatarName && current.config.avatar?.startsWith('data:image/png;base64,') && current;
        }, 'name and cropped avatar accepted together');
        assert.equal(avatarAccepted.version, avatarBefore.version + 1);
        assert.equal(versionRows(avatarBase.sharedId), avatarVersions + 1);
        assert.equal(posts(avatarName).length, 1);
        const avatarBytes = Buffer.from(avatarAccepted.config.avatar.split(',')[1], 'base64');
        await waitUntil(() => ['A', 'B'].every(role => {
            const file = path.join(path.dirname(localConfigFile(role, avatarSubject)), 'avatar.png');
            return localConfig(role, avatarSubject).name === avatarName && fs.existsSync(file) && fs.readFileSync(file).equals(avatarBytes);
        }), 'identical avatar bytes and name projected on both devices');
        await picture(A, 'native-name-avatar-one-save');

        result.configuration = {
            combinedNameAvatar: { sharedId: avatarBase.sharedId, version: avatarAccepted.version, onePost: true,
                oneVersion: true, identicalAvatarOnBothDevices: true },
            conflict: { sharedId: aBase.sharedId, version: won.version, draftPreserved: true },
            lostReceipt: { sharedId: lostBase.sharedId, version: lostBefore.version + 1, opId: replay.body.opId,
                oneVersion: true, sameOperation: true, bothDevices: true },
        };
        assert.equal(service.calls.length, 0);
    } finally {
        db.close();
    }
};

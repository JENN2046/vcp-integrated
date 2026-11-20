'use strict';
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const path = require('node:path');

const { stable } = require('../../apps/desktop/modules/services/nativeSync/protocol');
async function restoreProfile(snapshot, dest, origin, role, stream = false) {
    await fs.cp(snapshot, dest, { recursive: true });
    async function patch(filename, edit) {
        const file = path.join(dest, filename);
        const value = JSON.parse(await fs.readFile(file, 'utf8'));
        await fs.chmod(file, 0o600);
        await fs.writeFile(file, JSON.stringify(edit(value), null, 2));
    }
    if (role === 'local') await patch('Agents/local-agent/config.json', value => ({ ...value, topics: [] }));
    if (role !== 'local') {
        await patch('.native-sync/connection.json', value => ({ ...value, serverUrl: origin, sourceRoot: dest }));
        await patch('.native-sync/state.json', value => {
            value.source.binding.sourceRoot = dest;
            value.source.binding.rootHash = createHash('sha256').update(dest).digest('hex');
            return value;
        });
        const state = JSON.parse(await fs.readFile(path.join(dest, '.native-sync/state.json'), 'utf8'));
        await patch('.native-sync/shared/sharedAB/registry.json', value => {
            value.binding.sourceRoot = dest;
            value.legacyHash = createHash('sha256').update(stable(state)).digest('hex');
            return value;
        });
        for (const name of ['executions.json','local-inputs.json']) {
            await patch('.native-sync/shared/sharedAB/' + name, value => {
                value.binding.sourceRoot = dest;
                return value;
            });
        }
    }
    await fs.writeFile(path.join(dest, 'settings.json'), JSON.stringify({
        ChatDataServiceEnabled: false, vcpServerUrl: origin + (role === 'local' ? '/v1/local-chat/completions' : '/v1/chat/completions'), vcpApiKey: 'synthetic-only',
        userName: "用户", disableAsana: true, enableVcpLog: false, enableDistributedServer: false
    }, null, 2));
}
module.exports = { restoreProfile };

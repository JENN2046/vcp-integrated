'use strict';

const path = require('node:path');
const { ownedJson } = require('./nativeSync/sharedLocal');
const { filterChatModels } = require('./nativeSync/contracts.generated.cjs');
const { fail } = require('./nativeSync/protocol');

async function fetchDesktopModelCatalog({ root, settings, getCoreClient, env = process.env, fetchImpl = fetch }) {
    const marker = await ownedJson(root, path.join(root, '.vcp-core/profile.json'), { optional: true });
    if (env.VCPCHAT_CORE_REMOTE_ORIGIN || marker?.remote) {
        const client = await getCoreClient();
        if (!client?.listModels) throw fail('CORE_LOCAL_AUTHORITY_UNAVAILABLE');
        return client.listModels();
    }
    if (!settings?.vcpServerUrl) return null;
    const url = new URL('/v1/models?purpose=chat', new URL(settings.vcpServerUrl).origin);
    const response = await fetchImpl(url, {
        headers: { Authorization: 'Bearer ' + (settings.vcpApiKey || '') },
        signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw Error('HTTP error! status: ' + response.status);
    const data = await response.json();
    if (!Array.isArray(data?.data)) throw fail('MODEL_CATALOG_INVALID');
    return data.purpose === 'chat' ? data.data : filterChatModels(data.data);
}
function gameModelChoices({ catalog, favoriteModels, hotModels, agentModels }) {
    const ids = rows => [...new Set((Array.isArray(rows) ? rows : [])
        .map(row => typeof row === 'string' ? row : row?.id)
        .filter(id => typeof id === 'string' && id.trim())
        .map(id => id.trim()))];
    const available = catalog === null ? null : new Set(ids(catalog));
    const visible = rows => available ? ids(rows).filter(id => available.has(id)) : filterChatModels(ids(rows));
    return {
        models: visible([...favoriteModels, ...hotModels, ...agentModels, ...(catalog || [])]),
        favoriteModels: visible(favoriteModels),
        hotModels: visible(hotModels)
    };
}

module.exports = { fetchDesktopModelCatalog, gameModelChoices };

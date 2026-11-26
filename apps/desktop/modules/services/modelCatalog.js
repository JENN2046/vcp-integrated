'use strict';

const path = require('node:path');
const { ownedJson } = require('./nativeSync/sharedLocal');
const { fail } = require('./nativeSync/protocol');

async function fetchDesktopModelCatalog({ root, settings, getCoreClient, env = process.env, fetchImpl = fetch }) {
    const marker = await ownedJson(root, path.join(root, '.vcp-core/profile.json'), { optional: true });
    if (env.VCPCHAT_CORE_REMOTE_ORIGIN || marker?.remote) {
        const client = await getCoreClient();
        if (!client?.listModels) throw fail('CORE_LOCAL_AUTHORITY_UNAVAILABLE');
        return client.listModels();
    }
    if (!settings?.vcpServerUrl) return [];
    const url = new URL('/v1/models', new URL(settings.vcpServerUrl).origin);
    const response = await fetchImpl(url, {
        headers: { Authorization: 'Bearer ' + (settings.vcpApiKey || '') },
        signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw Error('HTTP error! status: ' + response.status);
    const data = await response.json();
    return Array.isArray(data?.data) ? data.data : [];
}
module.exports = { fetchDesktopModelCatalog };

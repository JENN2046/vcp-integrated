'use strict';

const { filterChatModels } = require('../Plugin/NativeSync/sync/contracts.generated.cjs');

function createModelCatalog({ apiUrl, apiKey, modelRedirectHandler, semanticModelRouter, debug = false, fetchImpl, embeddingModelIds = [] }) {
    function appendVirtualModels(value) {
        const virtual = semanticModelRouter.getVirtualModels();
        if (!virtual.length) return value;
        if (!value || typeof value !== 'object') value = { object: 'list', data: [] };
        if (!Array.isArray(value.data)) value.data = [];
        const ids = new Set(value.data.map(model => model?.id).filter(Boolean));
        for (const model of virtual) {
            if (!ids.has(model.id)) { value.data.push(model); ids.add(model.id); }
        }
        return value;
    }
    return async function query({ userAgent, accept, signal, chatOnly = false } = {}) {
        const fetch = fetchImpl || (await import('node-fetch')).default;
        const response = await fetch(apiUrl + '/v1/models', {
            method: 'GET',
            headers: {
                Authorization: 'Bearer ' + apiKey,
                ...(userAgent && { 'User-Agent': userAgent }),
                Accept: accept || 'application/json'
            },
            ...(signal && { signal })
        });
        const text = await response.text();
        if (response.ok) {
            try {
                let data = JSON.parse(text);
                // Apply the filter before public aliases can hide the upstream ID.
                if (chatOnly && Array.isArray(data?.data)) data.data = filterChatModels(data.data, embeddingModelIds);
                if (modelRedirectHandler.isEnabled() && Array.isArray(data?.data)) {
                    data.data = data.data.map(model => {
                        if (!model?.id) return model;
                        const id = modelRedirectHandler.redirectModelForClient(model.id);
                        if (debug && id !== model.id) console.log('[ModelRedirect] 模型列表重定向:', model.id, '->', id);
                        return id === model.id ? model : { ...model, id };
                    });
                }
                data = appendVirtualModels(data);
                if (!Array.isArray(data?.data)) throw Error('Invalid model catalog');
                return { status: response.status, headers: response.headers, data };
            } catch (error) {
                console.warn('[Models] 模型列表解析失败:', error.message);
            }
        }
        const fallback = appendVirtualModels({ object: 'list', data: [] });
        if (fallback.data.length) return { status: 200, data: fallback };
        return { status: response.ok ? 502 : response.status, text: response.ok ? 'Invalid model catalog' : text };
    };
}
module.exports = { createModelCatalog };

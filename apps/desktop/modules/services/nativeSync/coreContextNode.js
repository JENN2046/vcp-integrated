'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { isLiveReferenceCandidate, readLiveReferenceText } = require('../../fileManager');

const unavailable = () => Object.assign(Error('CORE_RESOURCE_UNAVAILABLE'), { code: 'CORE_RESOURCE_UNAVAILABLE' });

async function readCoreContext(input, { workspace, selection, canvas }) {
    const { canvases, workspaces, references, topics } = input || {};
    if (typeof canvases !== 'boolean' || !Array.isArray(workspaces) || workspaces.length > 16 ||
        !Array.isArray(references) || references.length > 32) throw unavailable();
    const result = { workspaces: [], references: [] };
    if (canvases) {
        // Active Canvas belongs to the desktop surface currently showing the
        // requested topic. Never fall back to the most recent Canvas file.
        const current = await selection();
        if (!['agent','group'].includes(current?.itemType) || !Array.isArray(topics) || topics.length > 8 ||
            !topics.some(topic => (topic.itemType || 'agent') === current.itemType && topic.itemId === current.itemId && topic.topicId === current.topicId)) {
            throw unavailable();
        }
        const active = await canvas();
        const after = await selection();
        if (active?.error || typeof active?.content !== 'string' || after?.itemId !== current.itemId ||
            after?.topicId !== current.topicId || after?.itemType !== current.itemType) throw unavailable();
        result.canvas = active.content;
    }
    for (const selector of workspaces) {
        if (typeof selector !== 'string' || !/^\{\{VCPChatWorkSpace(?::[^{}\r\n]{1,200})?\}\}$/.test(selector)) throw unavailable();
        const value = await workspace.expandPlaceholders(selector);
        if (typeof value !== 'string' || !value.startsWith('[VCPChat 工作区: ')) throw unavailable();
        result.workspaces.push(value);
    }
    for (const reference of references) {
        const root = workspace.list().find(item => item.enabled && item.id === reference?.workspaceId);
        const key = reference?.relPath;
        if (!root || typeof key !== 'string' || !key || key.length > 4096 || path.isAbsolute(key) ||
            key.split(/[\\/]/).some(segment => !segment || segment === '.' || segment === '..')) throw unavailable();
        const resolved = await fs.realpath(path.resolve(root.path, key));
        const canonicalRoot = await fs.realpath(root.path);
        const relative = path.relative(canonicalRoot, resolved);
        if (!relative || path.isAbsolute(relative) || relative.split(path.sep)[0] === '..' ||
            !isLiveReferenceCandidate(resolved, { workspace: true })) throw unavailable();
        const stat = await fs.stat(resolved);
        if (!stat.isFile() || stat.size > 1024 * 1024) throw unavailable();
        const text = await readLiveReferenceText({ isLiveReference: true, sourcePath: resolved });
        if (typeof text !== 'string') throw unavailable();
        result.references.push(text);
    }
    if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024) throw unavailable();
    return result;
}

module.exports = { readCoreContext };

'use strict';

const execution = require('./requestExecutionContext');
const fs = require('node:fs');
const path = require('node:path');

function allows(names) {
    const scope = execution.currentCoreNativeAuthority();
    if (!execution.isCoreTurn()) return true;
    return scope?.allows('diaries', names) === true;
}

function allowedNames(names) {
    return execution.isCoreTurn() ? names.filter(name => allows(name)) : names;
}

function allowsPath(root, file, diary) {
    if (!execution.isCoreTurn()) return true;
    if (!allows(diary)) return false;
    try {
        const relative = path.relative(fs.realpathSync(root), fs.realpathSync(path.resolve(root, file)));
        return relative === diary || relative.startsWith(diary + path.sep);
    } catch {
        return false;
    }
}

const RAG_BLOCK = /<!--\s*VCP_RAG_BLOCK_START\b[\s\S]*?(?:<!--\s*VCP_RAG_BLOCK_END\s*-->|$)/g;

function stripOldBlocks(messages, { keepCurrent = false } = {}) {
    if (!execution.isCoreTurn() || !Array.isArray(messages)) return messages;
    const remove = text => text.replace(RAG_BLOCK, block => keepCurrent && canRefresh(block) ? block : '');
    const clean = text => typeof text === 'string' && text.includes('VCP_RAG_BLOCK_START') ? remove(text) : text;
    const cleaned = messages.map(message => {
        const { content } = message;
        if (!Array.isArray(content)) {
            const text = clean(content);
            return text === content ? message : { ...message, content: text };
        }
        const parts = content.map(part => {
            const text = clean(part?.text);
            return text === part?.text ? part : { ...part, text };
        });
        return parts.some((part, index) => part !== content[index]) ? { ...message, content: parts } : message;
    });
    for (const key of Reflect.ownKeys(messages)) {
        if (!Object.hasOwn(cleaned, key)) Object.defineProperty(cleaned, key, Object.getOwnPropertyDescriptor(messages, key));
    }
    return cleaned;
}

function rememberBlock(block) {
    execution.currentCoreNativeAuthority()?.blocks.add(block);
}

function assertCurrent() {
    execution.currentCoreNativeAuthority()?.assertCurrent();
}

function canRefresh(block) {
    return !execution.isCoreTurn() || execution.currentCoreNativeAuthority()?.blocks.has(block) === true;
}

module.exports = { allows, rememberBlock, canRefresh, assertCurrent, allowedNames, allowsPath, stripOldBlocks, isCoreTurn: execution.isCoreTurn };

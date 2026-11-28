'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { failure } = require('./store');

const rejectedBeforeEffect = new WeakSet();
const diaryId = /^[\p{L}\p{N}_ -]{1,96}$/u;
const identity = /^(?:aa:)?[a-zA-Z0-9_-]{1,200}$/;

function createGrantReader(directory) {
    const file = path.join(directory, 'native-capability-grants.json');
    // This file is governed by the Core operator, outside all Agent and device configuration APIs.
    return (workspace, id) => {
        if (typeof id !== 'string' || !identity.test(id)) return {};
        let fd;
        try {
            fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
            const stat = fs.fstatSync(fd);
            if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o022) !== 0 || stat.size > 65536) return {};
            const bytes = Buffer.alloc(65537);
            const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
            if (size > 65536) return {};
            const grant = JSON.parse(bytes.subarray(0, size).toString('utf8'));
            if (grant?.version !== 1 || grant.workspace !== workspace || !grant.agents ||
                !Object.hasOwn(grant.agents, id)) return {};
            return grant.agents[id] ?? {};
        } catch {
            return {};
        } finally {
            if (fd !== undefined) fs.closeSync(fd);
        }
    };
}

function targets(grants, capability) {
    const list = Object.hasOwn(grants, capability) ? grants[capability] : null;
    const valid = capability === 'diaries' ? diaryId : identity;
    return Array.isArray(list) && list.every(name =>
        typeof name === 'string' && name === name.trim() && valid.test(name)) ? list : [];
}

function createWorkAuthority(readGrants, workspace, agentId, fence) {
    const read = () => { fence(); return readGrants?.(workspace, agentId) ?? {}; };
    const used = new Map();
    return {
        workspace, agentId, blocks: new Set(),
        allows(capability, names, { track = true } = {}) {
            const requested = Array.isArray(names) ? names : [names];
            if (!requested.length) return false;
            const allowed = targets(read(), capability);
            if (!requested.every(name => allowed.includes(name))) return false;
            if (track) {
                if (!used.has(capability)) used.set(capability, new Set());
                for (const name of requested) used.get(capability).add(name);
            }
            return true;
        },
        assert(capability, name, options) {
            if (!this.allows(capability, name, options)) throw denied();
        },
        assertCurrent() {
            if (!used.size) return;
            const grants = read();
            for (const [capability, names] of used) {
                const allowed = targets(grants, capability);
                if ([...names].some(name => !allowed.includes(name))) throw failure('CORE_NATIVE_CAPABILITY_REVOKED', 403);
            }
        }
    };
}

function denied() {
    const error = failure('CORE_NATIVE_CAPABILITY_DENIED', 403);
    rejectedBeforeEffect.add(error);
    return error;
}

module.exports = { createGrantReader, createWorkAuthority, denied,
    isDeniedBeforeEffect: error => rejectedBeforeEffect.has(error) };

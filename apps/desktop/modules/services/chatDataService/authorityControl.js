'use strict';
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const error = code => Object.assign(new Error(code), { code, status: 'pending', retryable: false });
const digest = json => createHash('sha256').update(json).digest('hex');
async function verifyAuthorityBinary(binary, manifestPath = binary + '.authority.json') {
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); }
    catch { throw error('HISTORY_AUTHORITY_BUILD_UNVERIFIED'); }
    const stat = await fs.lstat(binary);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || manifest.authorityProtocol !== 1 ||
        manifest.birthState !== 'unknown' || !/^[a-f0-9]{64}$/.test(manifest.sourceSha256 || '') ||
        digest(await fs.readFile(binary)) !== manifest.binarySha256) throw error('HISTORY_AUTHORITY_BUILD_UNVERIFIED');
    return manifest;
}
class AuthorityControl {
    #child; #handshake; #pending = new Map(); #session = randomUUID(); #generation = 0; #prepared = null; #currentDigest = ''; #uncertain = null;
    constructor(child, handshake, onFault = () => {}) {
        if (handshake.authorityProtocol !== 1 || handshake.historyAdmission !== 'unknown' || !handshake.rootIdentity || !handshake.instanceId) throw error('HISTORY_AUTHORITY_HANDSHAKE_INVALID');
        this.#child = child; this.#handshake = handshake; this.onFault = onFault;
    }
    receive(line) {
        let ack; try { ack = JSON.parse(line); } catch { return false; }
        if (ack.type !== 'historyAuthorityAck') return false;
        const waiter = this.#pending.get(ack.requestId);
        if (!waiter) return true; // Late replies never authorize a new operation.
        this.#pending.delete(ack.requestId); clearTimeout(waiter.timer);
        if (ack.instanceId !== this.#handshake.instanceId || ack.sessionId !== this.#session || ack.op !== waiter.op ||
            ['realpath', 'device', 'inode'].some(key => ack.rootIdentity?.[key] !== this.#handshake.rootIdentity[key]) ||
            (ack.generation !== waiter.generation || ack.digest !== waiter.digest) || !ack.ok || ack.settled !== true) {
            this.onFault(); waiter.reject(error(ack.error || 'HISTORY_AUTHORITY_ACK_INVALID'));
        } else waiter.resolve(ack);
        return true;
    }
    disconnect() {
        this.onFault();
        for (const p of this.#pending.values()) { clearTimeout(p.timer); p.reject(error('HISTORY_AUTHORITY_DISCONNECTED')); }
        this.#pending.clear();
    }
    request(op, fields = {}) {
        const requestId = randomUUID();
        const request = { type: 'historyAuthority', requestId, op, instanceId: this.#handshake.instanceId,
            sessionId: this.#session, rootIdentity: this.#handshake.rootIdentity, generation: this.#generation, digest: this.#currentDigest, ...fields };
        if (op !== 'inspect') this.#uncertain = { generation: request.generation, digest: request.digest };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.#pending.delete(requestId); this.onFault(); reject(error('HISTORY_AUTHORITY_ACK_UNKNOWN')); }, 10000);
            this.#pending.set(requestId, { resolve, reject, timer, op, generation: request.generation, digest: request.digest });
            this.#child.stdin.write(JSON.stringify(request) + '\n', failure => { if (failure) this.disconnect(); });
        });
    }
    async prepare(descriptor) {
        const descriptorJson = JSON.stringify(descriptor), next = this.#generation + 1;
        const ack = await this.request('prepare', { generation: next, descriptorJson, digest: digest(descriptorJson) });
        if (ack.state !== 'prepared') { this.onFault(); throw error('HISTORY_AUTHORITY_ACK_INVALID'); }
        this.#generation = next; this.#prepared = ack.digest; this.#currentDigest = ack.digest; this.#uncertain = null; return ack;
    }
    async activate(descriptor) {
        if (!this.#prepared) throw error('HISTORY_AUTHORITY_NOT_PREPARED');
        const descriptorJson = JSON.stringify(descriptor);
        const ack = await this.request('activate', { descriptorJson, digest: digest(descriptorJson), preparedDigest: this.#prepared });
        if (ack.state !== 'active') { this.onFault(); throw error('HISTORY_AUTHORITY_ACK_INVALID'); }
        this.#prepared = null; this.#currentDigest = ack.digest; this.#uncertain = null; return ack;
    }
    async inspect() {
        const ack = await this.request('inspect', this.#uncertain || {});
        if (!['prepared', 'active'].includes(ack.state)) throw error('HISTORY_AUTHORITY_INSPECT_UNKNOWN');
        this.#generation = ack.generation; this.#currentDigest = ack.digest;
        this.#prepared = ack.state === 'prepared' ? ack.digest : null; this.#uncertain = null;
        return ack;
    }
}
module.exports = { verifyAuthorityBinary, AuthorityControl };

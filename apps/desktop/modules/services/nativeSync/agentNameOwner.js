'use strict';
const path = require('node:path');
const { readConnection } = require('./connection');
const { createSyncRequest } = require('./syncRequest');
const { ownedJson, readSettledSource, inspectShared } = require('./sharedLocal');
const { sharedConfig } = require('./contracts.generated.cjs');
const { stable, sha256, fail } = require('./protocol');
const policy = require('./releasePolicy.cjs');
const { validateConfig, observeConfigVersions, openConfigDatabase } = require('./sharedConfigVersion');

const configRoute = '/api/v1/sync/shared/config';

async function resolveOwner(host, agentId) {
    const root = host.appDataRoot;
    const connection = await readConnection({ appDataRoot: root, readSettings: host.readSettings });
    if (!connection?.sharedSpaceId || !connection.publishExecutionConfigs) throw fail('SHARED_BINDING_REQUIRED');
    const { sharedSpaceId, sourceId, deviceId, spaceId } = connection;
    const binding = { sharedSpaceId, sourceId, deviceId, spaceId, sourceRoot: root };
    const dir = path.join(root, '.native-sync/shared', sharedSpaceId);
    const legacy = await readSettledSource(root, connection);
    const registry = await ownedJson(root, path.join(dir, 'registry.json'));
    if (registry.version !== 1 || stable(registry.binding) !== stable(binding) ||
        registry.legacyHash !== sha256(stable(legacy)) || registry.pending || !registry.adopted ||
        registry.retiredOwners?.['agent:' + agentId]) throw fail('SHARED_BINDING_CHANGED');
    const matches = Object.entries(registry.locals).filter(([, row]) =>
        row.kind === 'agent' && row.localId === agentId && !row.aliasOf && !row.hidden);
    if (matches.length !== 1) throw fail('SHARED_LOCAL_MAPPING_REQUIRED');
    const [[sharedId]] = matches;
    const object = registry.objects[sharedId];
    const removal = registry.localRemovals?.[sharedId];
    if (object?.kind !== 'agent' || object.id !== sharedId || object.sharedSpaceId !== sharedSpaceId ||
        object.deleted || (removal && !['restored', 'rejected'].includes(removal.stage))) throw fail('SHARED_BINDING_CHANGED');
    const matching = await ownedJson(root, path.join(dir, 'matching.json'), { optional: true });
    if (matching && (stable(matching.binding) !== stable(binding) || Object.values(matching.plans).some(plan =>
        !['complete','cancelled','rejected'].includes(plan.status) && plan.plan.objects.some(entry => entry.id === sharedId)))) {
        throw fail('SHARED_MATCH_PREPARING');
    }
    const replica = await ownedJson(root, path.join(dir, 'configs.json'));
    if (replica.version !== 1 || replica.binding?.sharedSpaceId !== sharedSpaceId || replica.binding?.deviceId !== deviceId ||
        !replica.objects?.[sharedId] || replica.drafts?.[sharedId] || replica.intent) throw fail('SHARED_LOCAL_CONFIG_CONFLICT');
    const send = createSyncRequest(connection);
    const info = await inspectShared(connection, legacy, send, { allowReadOnly: true });
    return { sharedId, sharedSpaceId, send, root, connection, known: replica.objects[sharedId], metadata: object, readOnly: info.readOnly || policy.sharedReadOnly,
        identity: sha256(stable({ ...binding, agentId, sharedId, origin: connection.url })) };
}

function validateAgent(owner, object) {
    validateConfig(object, owner.sharedSpaceId, owner.sharedId, owner.known, owner.metadata);
    if (object.kind !== 'agent' || object.deleted) throw fail('SHARED_CONFIG_RESPONSE_INVALID');
}

function snapshot(owner, object) {
    return { name: object.config.name, editToken: JSON.stringify({
        identity: owner.identity, version: object.version, config: object.config,
    }) };
}

async function readCurrent(owner) {
    const query = new URLSearchParams({ sharedSpaceId: owner.sharedSpaceId, sharedId: owner.sharedId });
    const { object } = await owner.send(configRoute + '?' + query);
    validateAgent(owner, object);
    await observeConfigVersions(owner.root, owner.connection, [object]);
    return object;
}

function accepted(owner, object) {
    return { success: true, ...snapshot(owner, object) };
}

// Only the native config queue can confirm that the name reached disk. A
// successful server receipt or an edit ticket alone says nothing about it.
function addProjectionReceipt(db, owner, result) {
    db.exec(`CREATE TABLE IF NOT EXISTS projected_agent_names(
        identity TEXT PRIMARY KEY, version INTEGER NOT NULL, name TEXT NOT NULL)`);
    const known = db.prepare('SELECT version,name FROM projected_agent_names WHERE identity=?').get(owner.identity);
    result.materializedName = known && known.version >= owner.known.version
        ? known.name : (owner.known.materialized || owner.known.config)?.name;
    const { version } = JSON.parse(result.editToken);
    const name = result.name;
    result.onProjected = async () => {
        const state = await openConfigDatabase(owner.root, owner.connection);
        try {
            state.prepare(`INSERT INTO projected_agent_names VALUES(?,?,?)
                ON CONFLICT(identity) DO UPDATE SET version=excluded.version, name=excluded.name
                WHERE excluded.version > projected_agent_names.version`).run(owner.identity, version, name);
        } finally {
            state.close();
        }
    };
    return result;
}

function conflict(owner, object) {
    return { success: false, conflict: snapshot(owner, object) };
}

// Only an unconfirmed POST needs a journal entry. Its operation ID, expected
// version and full body stay identical across retries, including after restart.
function operationId(owner, version, config) {
    return sha256(stable(['agent-name', owner.identity, version, config]));
}

function prepareSave(db, owner, intent, current, name) {
    const config = sharedConfig('agent', { ...current.config, name });
    const opId = operationId(owner, current.version, config);
    const body = { sharedSpaceId: owner.sharedSpaceId, sharedId: owner.sharedId,
        expectedVersion: current.version, opId, config };
    const row = db.prepare(`INSERT INTO name_save_intents(intent,op,body) VALUES(?,?,?)
        ON CONFLICT(intent) DO UPDATE SET intent=excluded.intent RETURNING body`).get(intent, opId, JSON.stringify(body));
    return JSON.parse(row.body);
}

function uncertain(error) {
    return ['NETWORK_UNAVAILABLE', 'CORRUPT_HTTP_RESPONSE'].includes(error.code) || error.status >= 500;
}

async function publish(owner, body, name, recovering) {
    if (body.sharedSpaceId !== owner.sharedSpaceId || body.sharedId !== owner.sharedId ||
        !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1 ||
        body.config?.name !== name || operationId(owner, body.expectedVersion, sharedConfig('agent', body.config)) !== body.opId) {
        throw fail('SHARED_CONFIG_STATE_INVALID');
    }
    let result;
    try {
        result = await owner.send(configRoute, { body });
    } catch (error) {
        if (!uncertain(error)) throw error;
        recovering = true;
        result = await owner.send(configRoute, { body });
    }
    const object = result.object;
    validateConfig(object, owner.sharedSpaceId, owner.sharedId);
    if (object.kind !== 'agent' || object.deleted || object.version !== body.expectedVersion + 1 ||
        stable(object.config) !== stable(body.config)) throw fail('SHARED_CONFIG_RESPONSE_INVALID');
    const verifyHead = recovering || result.replayed;
    try {
        await observeConfigVersions(owner.root, owner.connection, [object]);
    } catch (error) {
        if (!verifyHead || error.code !== 'SHARED_CONFIG_VERSION_REWIND') throw error;
    }
    // A confirmed historical receipt must never project the name over a later edit.
    const current = verifyHead ? await readCurrent(owner) : object;
    return current.config.name === body.config.name ? accepted(owner, current) : conflict(owner, current);
}

async function saveName(owner, base, name, choice) {
    if (choice !== undefined && !['use-current', 'keep-mine'].includes(choice)) throw fail('INVALID_NAME_CHOICE');
    let current = await readCurrent(owner);
    const db = await openConfigDatabase(owner.root, owner.connection);
    try {
        if (choice === 'use-current') {
            if (current.config.name !== base.config.name) return conflict(owner, current);
            return addProjectionReceipt(db, owner, accepted(owner, current));
        }
        db.exec('CREATE TABLE IF NOT EXISTS name_save_intents(intent TEXT PRIMARY KEY, op TEXT NOT NULL, body TEXT NOT NULL)');
        // Reopening the form can change its ticket. The same destination and
        // intended name must recover the frozen operation before making another.
        const intent = sha256(stable([owner.identity, name]));
        const pending = db.prepare('SELECT body FROM name_save_intents WHERE intent=?').get(intent);
        let body = pending && JSON.parse(pending.body);
        let recovering = Boolean(body);
        const forget = op => db.prepare('DELETE FROM name_save_intents WHERE intent=? AND op=?').run(intent, op);
        for (let attempt = 0; attempt < 2; attempt++) {
            if (!body) {
                const remote = current.config.name;
                if (choice === 'keep-mine' && remote !== base.config.name) return conflict(owner, current);
                if (remote === name || name === base.config.name) {
                    return addProjectionReceipt(db, owner, accepted(owner, current));
                }
                if (remote !== base.config.name) return conflict(owner, current);
                body = prepareSave(db, owner, intent, current, name);
            }
            try {
                const result = await publish(owner, body, name, recovering);
                if (result.success) addProjectionReceipt(db, owner, result);
                forget(body.opId);
                return result;
            } catch (error) {
                if (error.code !== 'SHARED_CONFIG_CONFLICT' || error.status !== 409) throw error;
                forget(body.opId);
                if (attempt === 1) break;
                body = null;
                recovering = false;
                current = await readCurrent(owner);
            }
        }
        return { success: false, error: '另一台设备仍在修改，名称已保留。请稍后再保存。' };
    } finally {
        db.close();
    }
}

function createAgentNameOwner(host) {
    return {
        async read({ agentId }) {
            const owner = await resolveOwner(host, agentId);
            return snapshot(owner, await readCurrent(owner));
        },
        async save({ agentId, name, editToken, choice }) {
            try {
                const owner = await resolveOwner(host, agentId);
                if (owner.readOnly) throw fail('SHARED_READ_ONLY');
                const base = JSON.parse(editToken);
                if (base.identity !== owner.identity || !Number.isSafeInteger(base.version) || base.version < 1) throw fail('SHARED_BINDING_CHANGED');
                return await saveName(owner, base, name, choice);
            } catch (error) {
                if (error.code === 'SHARED_CONFIG_VERSION_REWIND') return { success: false, error: '服务端配置需要核对，名称已保留。' };
                if (uncertain(error) || error.code === 'SHARED_CONFIG_RESPONSE_INVALID') {
                    return { success: false, error: '暂未确认保存，输入已保留。' };
                }
                return { success: false, error: '暂时无法保存共享名称，输入已保留。' };
            }
        },
    };
}

module.exports = { createAgentNameOwner };

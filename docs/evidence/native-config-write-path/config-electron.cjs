'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash } = require('node:crypto');
const Module = require('node:module');
const path = require('node:path');
const scope = new AsyncLocalStorage();
const load = Module._load;
const host = process.env.NS_HOST;
const target = path.join(host, '../../tests/integration/electron.cjs');
const refIds = new WeakMap();
let nextRef = 0;
let nextSave = 0;
const patched = new WeakSet();
const log = (event, data) => console.log('NS_MEASURE', JSON.stringify({ event, t: Date.now(), data }));
const stack = () => new Error().stack.split('\n').slice(2, 9).map(line => line.trim().replaceAll(host + '/', ''));
const scopeId = () => scope.getStore()?.saveId;

Module._load = function (request, parent, ...rest) {
    const value = load.call(this, request, parent, ...rest);
    if ((!value || !['object', 'function'].includes(typeof value)) || patched.has(value)) return value;
    const file = Module._resolveFilename(request, parent);
    if (file === path.join(host, 'modules/services/nativeSync/sharedConfigVersion.js')) {
        patched.add(value);
        const validate = value.validateConfig;
        value.validateConfig = function (object, ...args) {
            const saveId = scopeId();
            if (saveId === undefined) return validate.call(this, object, ...args);
            if (object && typeof object === 'object' && !refIds.has(object)) refIds.set(object, ++nextRef);
            const trace = { saveId, ref: refIds.get(object), id: object?.id, version: object?.version, hash: object?.configHash,
                callSite: stack(), hasKnownVersion: Boolean(args[2]), hasDirectoryVersion: Boolean(args[3]) };
            try {
                const result = validate.call(this, object, ...args);
                log('config-probe-validate', { ...trace, ok: true });
                return result;
            } catch (error) {
                log('config-probe-validate', { ...trace, ok: false, error: error.code });
                throw error;
            }
        };
    } else if (file === path.join(host, 'modules/services/nativeSync/nativeConfigSave.js')) {
        patched.add(value);
        const save = value.saveNativeOwnerConfig;
        value.saveNativeOwnerConfig = function (args) {
            const saveId = ++nextSave;
            const name = args.config?.name;
            const sharedId = args.config?.__nativeSyncSharedBase?.sharedId;
            return scope.run({ saveId }, async () => {
                const opts = { ...args };
                if (args.saveLocal) opts.saveLocal = (...localArgs) => {
                    log('config-probe-local-owner', { saveId, localId: args.localId });
                    return args.saveLocal(...localArgs);
                };
                log('config-probe-save', { saveId, localId: args.localId, name, sharedId, baseVersion: args.config?.__nativeSyncSharedBase?.version });
                const result = await save.call(this, opts);
                log('config-probe-result', { saveId, success: result?.success, error: result?.error, sharedVersion: result?.sharedVersion });
                return result;
            });
        };
    } else if (file === path.join(host, 'modules/services/nativeSync/sharedHost.js')) {
        patched.add(value);
        const factory = value.createSharedHost;
        value.createSharedHost = function (...args) {
            const sharedHost = factory.apply(this,args);
            for (const method of ['writeOwner','writeNativeExtras']) {
                const write = sharedHost[method];
                sharedHost[method] = async function (kind, id, ...rest) {
                    const result = await write.call(this,kind,id,...rest);
                    log('config-probe-host-write',{saveId:scopeId(),kind,localId:id,method,name:rest[0]?.name});
                    return result;
                };
            }
            return sharedHost;
        };
    } else if (file === path.join(host, 'modules/utils/agentConfigManager.js')) {
        patched.add(value);
        for (const method of ['writeAgentConfigLocked', 'writeAgentConfig']) {
            const write = value.prototype[method];
            value.prototype[method] = function (localId, config, ...args) {
                const result = write.call(this, localId, config, ...args);
                if (scopeId() !== undefined) {
                    const trace = { saveId: scopeId(), localId, method, name: config?.name, callSite: stack() };
                    Promise.resolve(result).then(() => log('config-probe-native-write', trace), () => {});
                }
                return result;
            };
        }
    }
    return value;
};

require(target);

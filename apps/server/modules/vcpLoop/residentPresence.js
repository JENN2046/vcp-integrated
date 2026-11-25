'use strict';

const { createHash, randomBytes } = require('node:crypto');

const RESIDENT_PRESENCE_BINDING_PROPERTY = '__agentsOsResidentPresence';

const RESIDENT_PRESENCE_BINDING_SCHEMA =
  'agents-os-resident.provider-presence-binding.v2';

const RESIDENT_PRESENCE_CARRIER_HEADER =
  '[AGENTSOSResident PresenceContext v1]\n';

const RESIDENT_PROVIDER_ATTEMPT_DENIED =
  'RESIDENT_PROVIDER_ATTEMPT_DENIED';

const RESIDENT_PROVIDER_PATH_ID = 'VCP-CHAT-COMPLETIONS';

const RESIDENT_PROVIDER_CREDENTIAL_SLOT =
  'credential-slot:vcp-toolbox:primary';

function residentProviderAttemptDenied() {
  const error = new Error(RESIDENT_PROVIDER_ATTEMPT_DENIED);
  error.code = RESIDENT_PROVIDER_ATTEMPT_DENIED;
  return error;
}

function isPlainRecord(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function hasExactRecordKeys(value, expected) {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function sha256Text(value) {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function readResidentPresenceBinding(messages) {
  if (!Array.isArray(messages)) throw residentProviderAttemptDenied();
  const descriptor = Object.getOwnPropertyDescriptor(
    messages,
    RESIDENT_PRESENCE_BINDING_PROPERTY
  );
  if (!descriptor) return null;
  if (descriptor.enumerable !== false
    || descriptor.configurable !== false
    || descriptor.writable !== false
    || Object.hasOwn(descriptor, 'get')
    || Object.hasOwn(descriptor, 'set')) {
    throw residentProviderAttemptDenied();
  }
  const binding = descriptor.value;
  if (!Object.isFrozen(binding)
    || !hasExactRecordKeys(binding, [
      'attachmentGeneration',
      'authorityGeneration',
      'carrierContentSha256',
      'contextId',
      'freshPresenceId',
      'projectionGeneration',
      'schema'
    ])
    || binding.schema !== RESIDENT_PRESENCE_BINDING_SCHEMA
    || !Number.isSafeInteger(binding.attachmentGeneration)
    || binding.attachmentGeneration < 1
    || !Number.isSafeInteger(binding.authorityGeneration)
    || binding.authorityGeneration < 1
    || !Number.isSafeInteger(binding.projectionGeneration)
    || binding.projectionGeneration < 0
    || !/^sha256:[0-9a-f]{64}$/u.test(binding.carrierContentSha256)
    || !/^sha256:[0-9a-f]{64}$/u.test(binding.contextId)
    || !/^fresh-presence:r1:[0-9a-f]{64}$/u.test(binding.freshPresenceId)) {
    throw residentProviderAttemptDenied();
  }
  const carriers = messages.filter((message) =>
    isPlainRecord(message)
      && message.role === 'system'
      && typeof message.content === 'string'
      && message.content.startsWith(RESIDENT_PRESENCE_CARRIER_HEADER));
  if (carriers.length !== 1
    || sha256Text(carriers[0].content) !== binding.carrierContentSha256) {
    throw residentProviderAttemptDenied();
  }
  return binding;
}

function validResidentProviderSeal(result, input, binding) {
  const seal = result?.seal;
  return hasExactRecordKeys(result, ['body', 'seal'])
    && result.body === input.finalBodyText
    && hasExactRecordKeys(seal, [
      'accepted',
      'attachmentGeneration',
      'attemptId',
      'authorityGeneration',
      'contextId',
      'credentialSlotDigest',
      'ordinal',
      'projectionGeneration',
      'providerInvoked',
      'resultCode',
      'schema',
      'sealId'
    ])
    && seal.accepted === true
    && seal.attachmentGeneration === binding.attachmentGeneration
    && seal.attemptId === input.attemptId
    && seal.authorityGeneration === binding.authorityGeneration
    && seal.contextId === binding.contextId
    && seal.ordinal === input.ordinal
    && seal.projectionGeneration === binding.projectionGeneration
    && seal.providerInvoked === false
    && seal.resultCode
      === 'PRESENCE_PROVIDER_ATTEMPT_MATERIAL_SEALED_NOT_INVOKED'
    && seal.schema === 'AGENTS_OS_PROVIDER_ATTEMPT_SEAL_V1'
    && /^sha256:[0-9a-f]{64}$/u.test(seal.credentialSlotDigest)
    && /^sha256:[0-9a-f]{64}$/u.test(seal.sealId);
}

function validResidentPresenceIntent(value) {
  return hasExactRecordKeys(value, ['requested'])
    && value.requested === true;
}

function validOneRingPresenceMeta(value) {
  return isPlainRecord(value)
    && typeof value.agentName === 'string'
    && value.agentName.length > 0
    && Buffer.byteLength(value.agentName, 'utf8') <= 200
    && value.agentName.trim() === value.agentName
    && !/[\u0000-\u001f\u007f]/u.test(value.agentName)
    && (value.externalKeyDigest === null
      || (typeof value.externalKeyDigest === 'string'
        && /^[0-9a-f]{64}$/u.test(value.externalKeyDigest)))
    && (value.frontendPlane === null
      || (typeof value.frontendPlane === 'string'
        && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value.frontendPlane)))
    && (value.frontendPrincipalDigest === null
      || (typeof value.frontendPrincipalDigest === 'string'
        && /^[0-9a-f]{64}$/u.test(value.frontendPrincipalDigest)))
    && typeof value.frontendSource === 'string'
    && value.frontendSource.length > 0
    && Buffer.byteLength(value.frontendSource, 'utf8') <= 200
    && value.frontendSource.trim() === value.frontendSource
    && !/[\u0000-\u001f\u007f]/u.test(value.frontendSource)
    && typeof value.requestHash === 'string'
    && /^[0-9a-f]{64}$/u.test(value.requestHash)
    && typeof value.turnId === 'string'
    && value.turnId.length > 0
    && Buffer.byteLength(value.turnId, 'utf8') <= 300
    && value.turnId.trim() === value.turnId
    && !/[\u0000-\u001f\u007f]/u.test(value.turnId);
}

function sameOneRingPresenceMeta(left, right) {
  return validOneRingPresenceMeta(left)
    && validOneRingPresenceMeta(right)
    && left.agentName === right.agentName
    && left.externalKeyDigest === right.externalKeyDigest
    && left.frontendPlane === right.frontendPlane
    && left.frontendPrincipalDigest === right.frontendPrincipalDigest
    && left.frontendSource === right.frontendSource
    && left.requestHash === right.requestHash
    && left.turnId === right.turnId;
}


function verifyMetadataCopy(source, target) {
  const descriptor = Object.getOwnPropertyDescriptor(source, RESIDENT_PRESENCE_BINDING_PROPERTY);
  if (!descriptor) return;
  const copied = Object.getOwnPropertyDescriptor(target, RESIDENT_PRESENCE_BINDING_PROPERTY);
  if (!copied || copied.value !== descriptor.value || copied.enumerable !== descriptor.enumerable ||
      copied.configurable !== descriptor.configurable || copied.writable !== descriptor.writable) {
    throw residentProviderAttemptDenied();
  }
}

const INTENT_FIELD = 'agentsOsResidentPresenceContext';
const hasIntent = body => body && typeof body === 'object' && Object.hasOwn(body, INTENT_FIELD);

function takeIntent(body) {
  if (!hasIntent(body)) return null;
  const intent = body[INTENT_FIELD];
  delete body[INTENT_FIELD];
  let presenceOneRingMeta;
  let residentPresenceBinding;
  let residentPresenceModule;
  return {
      validate() {
        if (!validResidentPresenceIntent(intent)) throw residentProviderAttemptDenied();
      },
      handles(name) { return name === 'AGENTSOSResident'; },
      async inject(processedMessages, pluginManager, requestPreprocessorConfig, copyArrayMetadata) {
        try {
          const oneRingModule = pluginManager.messagePreprocessors
            .get('OneRing');
          const residentModule = pluginManager.messagePreprocessors
            .get('AGENTSOSResident');
          const extracted = oneRingModule
            ?.extractMetaFromMessages?.(processedMessages);
          if (!validOneRingPresenceMeta(extracted)
            || !residentModule
            || typeof residentModule.processMessages !== 'function') {
            throw residentProviderAttemptDenied();
          }
          presenceOneRingMeta = Object.freeze({
            agentName: extracted.agentName,
            externalKeyDigest: extracted.externalKeyDigest,
            frontendPlane: extracted.frontendPlane,
            frontendPrincipalDigest: extracted.frontendPrincipalDigest,
            frontendSource: extracted.frontendSource,
            requestHash: extracted.requestHash,
            turnId: extracted.turnId
          });
          const messagesBeforeResident = processedMessages;
          return copyArrayMetadata(
            messagesBeforeResident,
            await pluginManager.executeMessagePreprocessor(
              'AGENTSOSResident',
              processedMessages,
              {
                ...requestPreprocessorConfig,
                agentsOsResidentPresenceContext: {
                  oneRing: {
                    externalKeyDigest:
                      presenceOneRingMeta.externalKeyDigest,
                    frontendPlane: presenceOneRingMeta.frontendPlane,
                    frontendPrincipalDigest:
                      presenceOneRingMeta.frontendPrincipalDigest,
                    frontendSource: presenceOneRingMeta.frontendSource,
                    requestHash: presenceOneRingMeta.requestHash,
                    turnId: presenceOneRingMeta.turnId
                  }
                }
              }
            )
          );
        } catch {
          throw residentProviderAttemptDenied();
        }
      },
      bind(processedMessages, pluginManager) {
        try {
          residentPresenceBinding = readResidentPresenceBinding(
            processedMessages
          );
          residentPresenceModule = pluginManager.messagePreprocessors
            .get('AGENTSOSResident');
        } catch {
          throw residentProviderAttemptDenied();
        }
        const sealDescriptor = residentPresenceModule
          ? Object.getOwnPropertyDescriptor(
            residentPresenceModule,
            'sealProviderAttempt'
          )
          : null;
        if (!residentPresenceBinding
          || !residentPresenceModule
          || !sealDescriptor
          || sealDescriptor.enumerable !== false
          || sealDescriptor.configurable !== false
          || sealDescriptor.writable !== false
          || Object.hasOwn(sealDescriptor, 'get')
          || Object.hasOwn(sealDescriptor, 'set')
          || typeof sealDescriptor.value !== 'function') {
          throw residentProviderAttemptDenied();
        }
      },
      confirmOneRing(responseMeta) {
        if (!sameOneRingPresenceMeta(presenceOneRingMeta, responseMeta)) throw residentProviderAttemptDenied();
      },
      wrapFetch(fetchWithRetry) {
        const namespace = randomBytes(32).toString('hex');
        let ordinal = 0;
        return (url, options, retryOptions = {}) => fetchWithRetry(url, options, {
          ...retryOptions,
          beforeProviderAttempt: (target, attempt, lifecycle) => sealAttempt({
            target, attempt, lifecycle, ordinal: ++ordinal, namespace,
            binding: residentPresenceBinding, module: residentPresenceModule
          })
        });
      }
  };
}

async function sealAttempt({ target, attempt, lifecycle, ordinal, namespace, binding, module }) {
  const { controller, connectionTimeout } = lifecycle;
  const { signal } = controller;
  if (typeof target !== 'string' || typeof attempt?.body !== 'string' || !attempt.body || attempt.method !== 'POST'
      || !Number.isSafeInteger(ordinal) || ordinal < 1) throw residentProviderAttemptDenied();
  const attemptId = `attempt:vcp:r1:${createHash('sha256')
    .update('vcp-toolbox.resident-provider-attempt.v1', 'utf8')
    .update(Buffer.from([0])).update(namespace, 'utf8')
    .update(Buffer.from([0])).update(String(ordinal), 'utf8').digest('hex')}`;
  const input = Object.freeze({
    attemptId, credentialSlotRef: RESIDENT_PROVIDER_CREDENTIAL_SLOT, finalBodyText: attempt.body,
    method: attempt.method, ordinal, providerPathId: RESIDENT_PROVIDER_PATH_ID, target, binding
  });
  const numeric = typeof connectionTimeout === 'number' || typeof connectionTimeout === 'string' ? Number(connectionTimeout) : NaN;
  const timeout = Number.isFinite(numeric) && numeric > 0 ? Math.min(Math.max(Math.floor(numeric), 1), 2147483647) : 900000;
  let deny;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    if (signal.aborted) throw residentProviderAttemptDenied();
    const result = await new Promise((resolve, reject) => {
      deny = () => reject(residentProviderAttemptDenied());
      signal.addEventListener('abort', deny, { once: true });
      Promise.resolve(module.sealProviderAttempt(input)).then(resolve, reject);
    });
    if (signal.aborted || !validResidentProviderSeal(result, input, binding) || result.body !== attempt.body) {
      throw residentProviderAttemptDenied();
    }
  } catch {
    throw residentProviderAttemptDenied();
  } finally {
    clearTimeout(timer);
    if (deny) signal.removeEventListener('abort', deny);
  }
}

module.exports = { hasIntent, takeIntent, verifyMetadataCopy };

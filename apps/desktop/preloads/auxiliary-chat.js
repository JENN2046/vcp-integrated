'use strict';

// Main-frame composer identity is deliberately unavailable in assistant/voice windows.
// All remaining APIs retain the existing chat role policy.
const { exposeRole } = require('./core/expose');
exposeRole('chat', { omitApis: ['getComposerScope'] });

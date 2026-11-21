'use strict';

const contract = structuredClone(require('./input.json'));
contract.history.splice(3, 0, {
    id: 'ctx-retained-system',
    role: 'system',
    timestamp: 1700000002500,
    content: 'CTX_RETAINED_SYSTEM',
});
Object.assign(contract.rules.find(rule => rule.id === 'ctx-inject-rule'), {
    name: 'depth spanning the conversation',
    depth: 4,
    content: 'CTX_DEPTH_FOUR',
});
module.exports = contract;

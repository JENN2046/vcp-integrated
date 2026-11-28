'use strict';

const { restrictNodeNetwork } = require('../../integration/restrict-network.cjs');
restrictNodeNetwork();

// The standalone suites load the host modules without running server.js's
// shutdown hook. Release only the native watchers this test process opened.
if (process.env.NODE_TEST_CONTEXT && process.env.VCP_TEST_SERVER) {
    const path = require('node:path');
    const test = require('node:test');
    test.after(() => {
        const loaded = file => require.cache[path.join(process.env.VCP_TEST_SERVER, file)]?.exports;
        loaded('Plugin.js')?.toolApprovalManager?.shutdown();
        loaded('modules/toolCallRecordStore.js')?.shutdown();
    });
}

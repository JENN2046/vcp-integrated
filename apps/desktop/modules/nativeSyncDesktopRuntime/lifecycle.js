'use strict';

const shutdownError = () => Object.assign(Error('APPLICATION_SHUTTING_DOWN'), { code: 'APPLICATION_SHUTTING_DOWN' });

function createDesktopRuntimeLifecycle({ start, waitForHistory, onStartupError, onRuntimeRecovered }) {
    let runtime = null;
    let stopping = false;
    let closePromise;
    let stopWaiting;
    const stoppingSignal = new Promise(resolve => { stopWaiting = resolve; });
    const assertStarting = () => { if (stopping) throw shutdownError(); };
    const started = Promise.resolve().then(() => {
        assertStarting();
        return start({
            isStopping: () => stopping,
            publishRecoveredRuntime(instance) {
                if (stopping) return;
                runtime = instance;
                try { onRuntimeRecovered?.(); }
                catch (error) { onStartupError(error); }
            },
            async waitForHistoryAuthority() {
                assertStarting();
                await Promise.race([waitForHistory(), stoppingSignal]);
                assertStarting();
            },
        });
    });
    // Keep the raw result for explicit shutdown, even when it was never visible.
    const ready = started.then(instance => {
        if (stopping) return null;
        runtime = instance;
        return instance;
    });
    ready.catch(error => {
        if (error.code !== 'APPLICATION_SHUTTING_DOWN') onStartupError(error);
    });

    function beginShutdown() {
        stopping = true;
        stopWaiting();
        runtime = null;
    }

    return {
        ready,
        getRuntime: () => runtime,
        beginShutdown,
        close() {
            beginShutdown();
            return closePromise ||= started.then(instance => instance?.close(), () => undefined);
        },
    };
}
module.exports = { createDesktopRuntimeLifecycle };

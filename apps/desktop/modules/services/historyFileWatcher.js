'use strict';

const fs = require('node:fs');
const path = require('node:path');

// This is the selected History's notification owner, not a History reader or
// writer. Only its existing renderer callback may reload the authoritative file.
// A directory watch survives atomic history.json replacement without recursively
// spending inotify watches on siblings or ancestors.
function createHistoryFileWatcher({
    io = fs,
    logger = console,
    timers = { setTimeout, clearTimeout },
    stabilityMs = 300,
    saveWindowMs = 2000,
    pollIntervalMs = 1000,
    retryDelays = [500, 1000, 2000, 4000, 8000, 16000],
    now = Date.now,
} = {}) {
    let current = null;
    let generation = 0;
    let lastInternalSave = -Infinity;
    let editing = false;
    let status = { mode: 'stopped', degraded: false, generation: 0, watchedFiles: 0, nativeSubscriptions: 0 };
    const signature = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
    const owns = state => current === state && state.generation === generation;
    const transition = (state, mode, extra = {}) => {
        if (state && !owns(state)) return;
        status = { mode, degraded: mode === 'polling' || mode === 'failed', generation,
            watchedFiles: state ? 1 : 0, nativeSubscriptions: state?.native ? 1 : 0,
            retryAttempt: state?.retryAttempt || 0, recoveryExhausted: false, ...extra };
        if (mode === 'polling' || mode === 'failed') logger.warn('[FileWatcher] notification degraded:', status);
        else logger.info('[FileWatcher] notification state:', status);
    };
    const flush = state => {
        if (!owns(state) || !state.dirty || editing) return;
        const remaining = saveWindowMs - (now() - lastInternalSave);
        if (remaining > 0) {
            state.reloadTimer = timers.setTimeout(() => { state.reloadTimer = null; flush(state); }, remaining);
            state.reloadTimer.unref?.();
            return;
        }
        state.dirty = false;
        try { state.callback(state.filePath); }
        catch (error) { logger.error('[FileWatcher] History reload notification failed:', error); }
    };
    const changed = state => {
        if (!owns(state)) return;
        state.dirty = true;
        if (state.reloadTimer) timers.clearTimeout(state.reloadTimer);
        state.reloadTimer = timers.setTimeout(() => { state.reloadTimer = null; flush(state); }, stabilityMs);
        state.reloadTimer.unref?.();
    };
    const stop = () => {
        const state = current;
        current = null;
        generation += 1;
        if (state) {
            for (const timer of [state.reloadTimer, state.retryTimer]) if (timer) timers.clearTimeout(timer);
            state.native?.close();
            if (state.pollListener) io.unwatchFile(state.filePath, state.pollListener);
        }
        editing = false;
        lastInternalSave = -Infinity;
        transition(null, 'stopped');
    };
    const closeNative = state => {
        const watcher = state.native;
        state.native = null;
        watcher?.close();
    };
    const scheduleRetry = state => {
        if (!owns(state) || state.retryTimer) return;
        if (state.retryAttempt >= retryDelays.length) {
            transition(state, 'polling', { errorCode: state.errorCode, recoveryExhausted: true });
            return;
        }
        const delay = retryDelays[state.retryAttempt++];
        state.retryTimer = timers.setTimeout(() => {
            state.retryTimer = null;
            if (!owns(state)) return;
            try { attachNative(state, true); }
            catch (error) { degrade(state, error); }
        }, delay);
        state.retryTimer.unref?.();
    };
    const degrade = (state, error) => {
        if (!owns(state)) return;
        closeNative(state);
        state.errorCode = error?.code || 'WATCH_FAILED';
        if (!state.pollListener) {
            state.pollListener = (next, previous) => {
                if (owns(state) && signature(next) !== signature(previous)) changed(state);
            };
            try {
                io.watchFile(state.filePath, { persistent: false, interval: pollIntervalMs }, state.pollListener);
            } catch (pollError) {
                state.pollListener = null;
                transition(state, 'failed', { errorCode: pollError?.code || 'STAT_WATCH_FAILED' });
                throw pollError;
            }
        }
        transition(state, 'polling', { errorCode: state.errorCode });
        // Reconcile the one selected authoritative History once on entering the
        // fallback, covering the gap that caused the native subscription error.
        changed(state);
        scheduleRetry(state);
    };
    const attachNative = (state, recovering = false) => {
        const watcher = io.watch(path.dirname(state.filePath), { persistent: false, recursive: false }, (_event, filename) => {
            if (!owns(state) || state.native !== watcher) return;
            if (filename !== null && filename !== undefined && String(filename) !== path.basename(state.filePath)) return;
            changed(state);
        });
        state.native = watcher;
        watcher.on('error', error => {
            if (!owns(state) || state.native !== watcher) return;
            try { degrade(state, error); }
            catch (failure) { logger.error('[FileWatcher] notification recovery failed:', failure); }
        });
        if (state.pollListener) {
            io.unwatchFile(state.filePath, state.pollListener);
            state.pollListener = null;
        }
        state.errorCode = null;
        transition(state, 'native', { recovered: recovering });
        if (recovering) changed(state);
    };
    return {
        async watchFile(filePath, callback) {
            stop();
            if (typeof filePath !== 'string' || typeof callback !== 'function') throw new TypeError('History path and callback required');
            const state = { filePath: path.resolve(filePath), callback, generation, native: null, pollListener: null,
                retryTimer: null, reloadTimer: null, retryAttempt: 0, dirty: false };
            current = state;
            try { attachNative(state); }
            catch (error) { degrade(state, error); }
            return { success: true, ...status };
        },
        async stopWatching() { stop(); },
        signalInternalSave() { lastInternalSave = now(); },
        setEditingMode(value) {
            editing = Boolean(value);
            if (!editing && current?.dirty) changed(current);
        },
        getStatus() { return { ...status }; },
    };
}

module.exports = { createHistoryFileWatcher };

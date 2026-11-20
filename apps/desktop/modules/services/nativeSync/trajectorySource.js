'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { replaceFile } = require('../../utils/atomicReplace');

// Native recorder paths are derived by the main process. Keep the existing
// per-session filename and array format so earlier local clears survive upgrades.
function createTrajectorySource(runtime) {
    const hiddenByFile = new Map();

    async function hiddenIds(file) {
        if (hiddenByFile.has(file)) return hiddenByFile.get(file);
        let ids = [];
        try {
            const stat = await fs.lstat(file);
            if (!stat.isFile() || stat.size > 128 * 1024) throw Error('TRACE_DISPLAY_STATE_INVALID');
            ids = JSON.parse(await fs.readFile(file, 'utf8'));
            if (!Array.isArray(ids) || ids.length > 200 || ids.some(id => typeof id !== 'string' || id.length > 300)) {
                throw Error('TRACE_DISPLAY_STATE_INVALID');
            }
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        // A concurrent clear may have completed while the old file was being read.
        if (!hiddenByFile.has(file)) hiddenByFile.set(file, new Set(ids));
        return hiddenByFile.get(file);
    }

    async function remotePage(key, scope, limit) {
        if (key !== `${scope.itemId}__${scope.topicId}`) throw Error('TRACE_SCOPE_MISMATCH');
        return runtime.nativeTrajectory(scope, { limit });
    }

    return {
        async list(key, options, recorder, local, limit) {
            if (!options?.scope) return local;
            const remote = await remotePage(key, options.scope, limit);
            if (!remote.records.length && !remote.missingHistoricalTraces &&
                !runtime.nativeObject(options.scope.itemType || 'agent', options.scope.itemId)) return local;
            const hidden = await hiddenIds(recorder.fileOf(key) + '.hidden.json');
            const records = new Map(local.records.map(row => [row.id, row]));
            for (const row of remote.records) {
                if (hidden.has(row.id)) continue;
                const needsReview = ['review_required', 'failed', 'cancelled'].includes(row.source?.workState);
                records.set(row.id, {
                    ...row, sessionKey: key,
                    replyMessageId: row.source?.executionId ? 'reply_' + row.source.executionId : undefined,
                    source: { ...row.source, displayLabel: needsReview ? '共享后端 · 任务需核对' : '共享后端' },
                });
            }
            const page = [...records.values()].sort((a, b) => a.startedAt - b.startedAt).slice(-limit);
            return { ...local, records: page, total: page.length, truncated: local.truncated || remote.truncated,
                missingHistoricalTraces: remote.missingHistoricalTraces, initiatorOnly: true,
                presentation: {
                    emptyMessage: remote.missingHistoricalTraces
                        ? '此话题的既往请求未保留原始调用轨迹。新调用的完整轨迹仅发起设备可见。'
                        : '这个话题还没有模型调用记录。共享调用的完整轨迹仅发起设备可见。',
                    clearMessage: '清空本机显示的调用轨迹？共享执行记录保留；不会停止或重新执行任务。',
                    refreshWhileVisible: true,
                } };
        },
        async beforeClear(key, options, recorder) {
            if (!options?.scope) return;
            const remote = await remotePage(key, options.scope, 200);
            if (!remote.records.length && !runtime.nativeObject(options.scope.itemType || 'agent', options.scope.itemId)) return;
            const file = recorder.fileOf(key) + '.hidden.json';
            const ids = remote.records.map(row => row.id);
            await fs.mkdir(path.dirname(file), { recursive: true });
            await replaceFile(file, JSON.stringify(ids), { mode: 0o600 });
            hiddenByFile.set(file, new Set(ids));
        },
    };
}

module.exports = { createTrajectorySource };

'use strict';

// The ordinary list shows the five most recent executions plus the bounded
// report catalogue for the selected topic. Neither source is an execution log
// for the other device: build display rows without changing either input.
function sharedTaskList(executions, reportJobs) {
    const rows = new Map();
    for (const job of [...executions.slice(0, 5), ...reportJobs]) {
        const key = job.id ?? job;
        const primary = rows.get(key);
        if (!primary && !job.nativeTasks?.length) {
            rows.set(key, job);
            continue;
        }
        const tasks = new Map();
        function include(task) {
            if (task.resultRef || !tasks.has(task.nativeTaskId)) tasks.set(task.nativeTaskId, task);
        }
        // Catalogue order is stable. A native task with a verified result
        // reference takes precedence; a pending local copy can't hide a report.
        for (const task of job.nativeTasks || []) include(task);
        for (const task of primary?.nativeTasks || []) include(task);
        rows.set(key, { ...(primary || job), nativeTasks: [...tasks.values()] });
    }
    return [...rows.values()];
}

module.exports = { sharedTaskList };

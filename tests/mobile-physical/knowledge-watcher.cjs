'use strict';

const path = require('node:path');
const Watcher = require(path.join(process.cwd(), 'modules/knowledgeBase/fileWatcher.js'));
const start = Watcher.prototype.start;
Watcher.prototype.start = function startWithEmptyFixtureFallback() {
    try { return start.call(this); }
    catch (error) {
        if (path.basename(this.owner.config.rootPath) !== 'empty-diaries' ||
            !/MaxFilesWatch|No space left on device/.test(error.message)) throw error;
        console.warn('[Physical mobile fixture] Empty diary watcher unavailable due to host inotify exhaustion.');
        return null;
    }
};
const manager = require(path.join(process.cwd(), 'KnowledgeBaseManager.js'));
const startRag = manager._startRagParamsWatcher;
manager._startRagParamsWatcher = function startRagWithFixtureFallback() {
    try { return startRag.call(this); }
    catch (error) {
        if (path.basename(process.cwd()) !== 'runtime-box' || !/MaxFilesWatch|No space left on device/.test(error.message)) throw error;
        console.warn('[Physical mobile fixture] RAG parameter watcher unavailable due to host inotify exhaustion.');
        return null;
    }
};

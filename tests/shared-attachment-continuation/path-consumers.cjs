'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fileURLToPath, pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');

async function verifyFileOperator(temp) {
    const distributed = path.join(root, 'apps/desktop/VCPDistributedServer');
    const isolated = path.join(temp, 'distributed');
    const pluginDir = path.join(isolated, 'Plugin/FileOperator');
    fs.mkdirSync(pluginDir, { recursive: true });
    for (const name of ['FileOperator.js', 'CodeValidator.js']) {
        fs.copyFileSync(path.join(distributed, 'Plugin/FileOperator', name), path.join(pluginDir, name));
    }
    fs.cpSync(path.join(distributed, 'shared/fileKit'), path.join(isolated, 'shared/fileKit'), { recursive: true });

    const allowed = path.join(temp, 'allowed');
    const agentDataPath = path.join(allowed, 'agent');
    const history = path.join(agentDataPath, 'topics', 'topic', 'history.json');
    const attachment = path.join(allowed, 'sample file.txt');
    fs.mkdirSync(path.dirname(history), { recursive: true });
    fs.writeFileSync(attachment, 'attachment body');
    fs.writeFileSync(history, JSON.stringify([
        { role: 'user', content: 'original' },
        { role: 'assistant', content: 'original' },
        { role: 'assistant', content: 'original' },
    ]));

    process.env.ALLOWED_DIRECTORIES = allowed;
    process.env.BASE_PATH = allowed;
    process.env.DEBUG_MODE = 'false';
    const { processToolCall } = require(path.join(pluginDir, 'FileOperator.js'));
    const { buildConversationSystemPrefix } = await import('../../apps/desktop/modules/chat/chatContextPipeline.js');
    const prefixPath = agentDataPath => buildConversationSystemPrefix({ systemPrompt: 'Synthetic', agentDataPath }, 'topic')
        .split(': ')[1];
    const rawHistory = prefixPath(agentDataPath);
    const edit = { target: 'original', replace: 'updated' };

    await processToolCall({ command: 'ReadFile', filePath: attachment });
    await assert.rejects(processToolCall({ command: 'ReadFile', filePath: pathToFileURL(attachment).href }), /ENOENT/);
    await processToolCall({ command: 'ReadFile', filePath: history });
    await assert.rejects(processToolCall({ command: 'ReadFile', filePath: rawHistory }), /ENOENT/);
    await assert.rejects(processToolCall({ command: 'UpdateHistory', filePath: rawHistory, ...edit }), /ENOENT/);
    await processToolCall({ command: 'UpdateHistory', filePath: history, ...edit });
    assert.deepEqual(JSON.parse(fs.readFileSync(history, 'utf8')), [
        { role: 'user', content: 'original' },
        { role: 'assistant', content: 'updated' },
        { role: 'assistant', content: 'original' },
    ]);

    const windowsBase = 'C:\\demo\\agent';
    assert.equal(path.win32.normalize(prefixPath(windowsBase)), path.win32.join(windowsBase, 'topics', 'topic', 'history.json'));

    return {
        attachmentAbsoluteRead: 'success',
        attachmentRawFileUriRead: 'ENOENT',
        historyPosixRead: 'success',
        historyPosixUpdate: 'first matching assistant only',
        historyMixedSeparatorRead: 'ENOENT',
        historyMixedSeparatorUpdate: 'ENOENT',
        historyWindowsPath: 'matches Windows path syntax',
    };
}

async function verifyFileFetcher(temp) {
    const fetcherPath = path.join(temp, 'FileFetcherServer.js');
    fs.copyFileSync(path.join(root, 'apps/server/FileFetcherServer.js'), fetcherPath);
    const fetcher = require(fetcherPath);
    const local = path.join(temp, 'local file.txt');
    const localUrl = pathToFileURL(local).href;
    const missingUrl = pathToFileURL(path.join(temp, 'missing file.txt')).href;
    fs.writeFileSync(local, 'local sample');
    assert.equal(await fetcher.resolveFileUrl(localUrl), localUrl);

    const syntheticIp = '192.0.2.5';
    let calls = 0;
    await fetcher.initialize({
        findServerByIp: ip => ip === syntheticIp ? 'synthetic-peer' : null,
        async executeDistributedTool(id, name, args) {
            assert.equal(id, 'synthetic-peer');
            assert.equal(name, 'internal_request_file');
            assert.equal(args.fileUrl, missingUrl);
            calls++;
            return {
                status: 'success',
                fileData: Buffer.from('remote sample').toString('base64'),
                mimeType: 'text/plain',
            };
        },
    });
    const cached = await fetcher.resolveFileUrl(missingUrl, syntheticIp);
    assert.notEqual(cached, missingUrl);
    assert.equal(fs.readFileSync(fileURLToPath(cached), 'utf8'), 'remote sample');
    assert.equal(await fetcher.resolveFileUrl(missingUrl, syntheticIp), cached);
    assert.equal(calls, 1);

    return {
        localFileUriResolution: 'original file URI returned',
        remoteAdapterOperand: 'original file URI',
        remoteResolution: 'cache file URI with expected bytes',
        remoteAdapterCallsAfterRepeat: calls,
    };
}

async function main() {
    assert.equal(process.platform, 'linux', 'This probe checks Linux path handling and Windows path syntax');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-path-consumers-'));
    const log = console.log;
    try {
        // FileFetcherServer includes physical paths in its diagnostic logs.
        console.log = () => {};
        const fileOperator = await verifyFileOperator(temp);
        const fileFetcher = await verifyFileFetcher(temp);
        log(JSON.stringify({
            sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
            platform: process.platform,
            fileOperator,
            fileFetcher,
        }, null, 2));
    } finally {
        console.log = log;
        fs.rmSync(temp, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

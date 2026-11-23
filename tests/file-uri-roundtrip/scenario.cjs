'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const fixture = require('./fixture.cjs');
const { verifyFileUriIsolation } = require('./isolation.cjs');

const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const readLines = filename => fs.existsSync(filename)
    ? fs.readFileSync(filename, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];

module.exports = async ({ clients:{A}, out, result, service, picture, click, evalJs, waitUntil, profiles }) => {
    const tool = process.env.NS_FILE_URI_CASE === 'tool';
    const filename = process.env.NS_FILE_URI_CASE === 'filename';
    const evidence = result.fileUriRoundtrip = {
        testCase:process.env.NS_FILE_URI_CASE, digest:fixture.expectedDigest,
        bytes:Buffer.byteLength(fixture.content), name:fixture.filename,
    };
    const finalReply = tool ? fixture.toolReply : filename ? fixture.filenameReply : fixture.inlineReply;
    const box = path.join(out, 'runtime-box');
    const caches = () => fs.readdirSync(path.join(box, '.file_cache'));
    const target = service.descriptors.A.preSubmit;
    const topic = service.topics.preSubmit.id;
    const historyPath = path.join(profiles.A, 'UserData', target.itemId, 'topics', target.topicId, 'history.json');
    const log = () => fs.readFileSync(path.join(out, 'backend.log'), 'utf8');
    const connection = await waitUntil(async () => {
        const receipt = await A.command('file-uri-receipts');
        return receipt.ipReports.some(report => report.localIPs.includes(receipt.sourceIp)) && receipt;
    }, 'native A distribution IP registration', 30000);
    assert.equal(connection.registration.length, 1);
    assert.equal(connection.registration[0].localAddress, connection.sourceIp);
    await click(A, '#agentList > li .agent-name', 'Synthetic shared');
    await waitUntil(async () =>
        (await evalJs(A, 'window.VCPStateChannels.get("conversation.current").get()')).topicId === target.topicId,
    'selected shared topic on desktop A');
    await waitUntil(async () => {
        try {
            return (await evalJs(A, 'window.chatAPI.getNativeDeletionContext(' + JSON.stringify(target) + ')'))?.kind === 'shared';
        } catch (error) {
            if (!error.message.includes('No handler registered')) throw error;
            return false;
        }
    }, 'shared topic ownership on desktop A');
    assert.deepEqual(read(historyPath), []);
    assert.deepEqual(caches(), [], 'ToolBox file cache is cold');
    evidence.cacheCold = true;
    evidence.rendererObserver = await A.command('observe-request-output');
    await click(A, '#attachFileBtn');
    await waitUntil(async () => (await evalJs(A,
        "[...document.querySelectorAll('#attachmentPreviewArea .attachment-preview-item')].map(row => row.innerText)"
    )).some(text => text.includes(fixture.filename.slice(0, 17))), 'composer shows synthetic text attachment');
    const desktopCachePath = path.join(fixture.privateCacheDir(out), fixture.expectedDigest + '.txt');
    assert.equal(fixture.digest(fs.readFileSync(desktopCachePath)), fixture.expectedDigest);
    const cacheUri = pathToFileURL(desktopCachePath).href;
    evidence.isolation = await verifyFileUriIsolation({
        fileUri:cacheUri, privateCacheDir:fixture.privateCacheDir(out), desktopPid:A.proc.pid,
    });
    await picture(A, 'A-attached');
    const prompt = fixture.marker + (tool ? ' — 用原生文件工具读取附件。' : filename ? ' — 用文件显示名调用文件工具。' : ' — 只读已经内联的附件正文。');
    await click(A, '#messageInput');
    await A.command('type-composer', prompt);
    await click(A, '#sendMessageBtn');

    const db = new DatabaseSync(path.join(service.data, 'central.sqlite'), {readOnly:true});
    try {
        const admissions = () => db.prepare('SELECT id,request_id,principal,state,dispatched,native_terminal FROM shared_admissions WHERE topic_id=? ORDER BY rowid').all(topic);
        const handlerInputs = () => readLines(fixture.handlerLog(out)).filter(row => row.kind === 'handler-input');
        const terminal = await waitUntil(() => {
            const current = admissions()[0];
            if (current?.state !== 'completed') return false;
            const rows = read(historyPath);
            const userIndex = rows.findIndex(row => row.role === 'user' && row.content === prompt);
            const user = rows[userIndex];
            const reply = rows[userIndex + 1];
            return user && reply?.role === 'assistant' && { current, user, reply };
        }, 'A durable admission and physical History terminal', 45000);
        const { current, user, reply } = terminal;
        const currentRequest = db.prepare('SELECT id,state FROM shared_native_requests WHERE admission_id=?').get(current.id);
        const handler = handlerInputs()[0];
        const ingress = readLines(fixture.handlerLog(out)).filter(row =>
            row.kind === 'native-chat-ingress' && row.requestId === currentRequest.id);
        const packets = await A.command('read-request-output');
        const attachments = user.attachments || [];
        const provider = service.calls;
        const desktopWs = await A.command('file-uri-receipts');
        const cachedFiles = caches();
        const invocations = readLines(fixture.countFile(box));
        const uriCacheKey = fixture.digest(cacheUri) + '.txt';
        const stages = [
            ['renderer',packets.renderer[0]?.messages],
            ['IPC',packets.ipc[0]?.messages],
            ['handler',handler?.messages],
            ['provider',provider[0]?.messages],
        ].map(([stage, messages]) => {
            const user = messages?.findLast(row => row.role === 'user');
            const text = fixture.text(user?.content);
            return { stage, hasInlineBody:text.includes(fixture.content.trimEnd()),
                hasOriginalUri:text.includes(cacheUri), hasAnyFileUri:text.includes('file://'),
                hasNameHeader:text.includes('[附加文件: ' + fixture.filename + ']') };
        });
        evidence.delivery = { admission:current, request:currentRequest,
            handlerRoute:handler?.route, handlerRequestId:handler?.requestId, reply:reply.content.split('\n').at(-1), ingress,
            historyMessageIds:[user.id,reply.id], providerPhases:provider.map(row=>row.phase),
            providerInline:{bytes:provider[0]?.inlineBytes,sha256:provider[0]?.inlineDigest},
            providerToolDigest:provider[1]?.toolResultDigest ?? null,
            providerToolError:provider[1]?.toolResultError ?? null,
            toolArgument:provider[0]?.toolArgument?.replaceAll(out,'<isolated-run>') ?? null, stages };
        evidence.fileCache = { files:cachedFiles, invocations };
        evidence.desktopWs = desktopWs;
        evidence.fileFetcher = log().split('\n').filter(line =>
            line.includes('[FileFetcherServer]') && !/Initialized|Cache directory ensured/.test(line)
        ).map(line => line.replaceAll(out,'<isolated-run>'));
        fs.writeFileSync(path.join(out, 'roundtrip-evidence.json'), JSON.stringify(evidence,null,2)+'\n');

        assert.equal(admissions().length, 1);
        assert.deepEqual([current.principal,current.dispatched,current.native_terminal], ['desktop:deviceA',1,1]);
        assert.equal(currentRequest.state, 'model_terminal');
        assert.equal(service.requests.filter(row => row.route.endsWith('/admit') && row.status >= 200 && row.status < 300).length, 1);
        assert.equal(service.requests.filter(row => row.route.endsWith('/session-send')).length, 0);
        assert.equal(handlerInputs().length, 1);
        assert.equal(handler.requestId, currentRequest.id);
        assert.deepEqual(ingress, [{kind:'native-chat-ingress', requestId:currentRequest.id,
            socketPeer:desktopWs.sourceIp, requestIp:desktopWs.sourceIp, forwardedFor:false}]);
        assert.equal(handler.workId, current.id);
        assert.ok(provider.every(row=>row.id === currentRequest.id));
        assert.equal(packets.renderer.length, 1);
        assert.deepEqual(packets.renderer, packets.ipc);
        assert.equal(attachments.length, 1);
        assert.equal(attachments[0].hash, fixture.expectedDigest);
        assert.ok(stages.every(stage => stage.hasInlineBody), 'inline text reached all four stages');
        assert.ok(stages.every(stage => tool || filename
            ? stage.hasOriginalUri && stage.hasAnyFileUri
            : !stage.hasAnyFileUri && stage.hasNameHeader));
        assert.ok(reply.content.endsWith(finalReply), 'physical History ends with expected provider reply');
        await waitUntil(async () => (await evalJs(A, "document.querySelector('#chatMessages').innerText")).includes(finalReply),
            'A renders the terminal reply');
        await picture(A, 'A-reply');

        assert.equal(desktopWs.refused, 0);
        if (tool) {
            assert.deepEqual(provider.map(row=>row.phase), ['tool-request','tool-result']);
            assert.equal(provider[0].fileUri, cacheUri);
            assert.equal(provider[1].hasDigest, true);
            assert.match(reply.content, /SyntheticFileDigest 调用成功/);
            assert.ok(reply.content.endsWith(fixture.toolReply));
            assert.deepEqual(invocations, [{ argument:'relative-to-runtime:.file_cache/' + uriCacheKey, bytes:evidence.bytes, digest:fixture.expectedDigest }]);
            assert.deepEqual(cachedFiles, [uriCacheKey]);
            assert.equal(fixture.digest(fs.readFileSync(path.join(box, '.file_cache', uriCacheKey))), fixture.expectedDigest);
            assert.ok(evidence.fileFetcher.some(row=>row.includes('URL缓存未命中')));
            assert.ok(evidence.fileFetcher.some(row=>row.includes('的 Base64 数据')));
            assert.equal(desktopWs.transfers.length, 1);
            const { requestId, fileUrlSha256, localAddress, status, bytes, sha256, mimeType } = desktopWs.transfers[0];
            assert.ok(requestId);
            assert.equal(desktopWs.transfers[0].matchesFixture, true);
            assert.deepEqual({fileUrlSha256,localAddress,status,bytes,sha256,mimeType}, {
                fileUrlSha256:fixture.digest(cacheUri), localAddress:desktopWs.sourceIp, status:'success',
                bytes:evidence.bytes, sha256:fixture.expectedDigest, mimeType:'text/plain',
            });
        } else if (filename) {
            assert.deepEqual(provider.map(row=>row.phase), ['tool-request','tool-result']);
            assert.equal(provider[0].toolArgument, fixture.filename);
            assert.equal(provider[1].toolResultError, 'ENOENT');
            assert.equal(provider[1].toolResultDigest, null);
            assert.deepEqual(invocations, [{argument:fixture.filename, error:'ENOENT'}]);
            assert.deepEqual(cachedFiles, []);
            assert.deepEqual(evidence.fileFetcher, []);
            assert.deepEqual(desktopWs.transfers, []);
        } else {
            assert.deepEqual(provider.map(row=>row.phase), ['inline-only']);
            assert.equal(reply.content, fixture.inlineReply);
            assert.deepEqual(invocations, []);
            assert.deepEqual(cachedFiles, []);
            assert.deepEqual(evidence.fileFetcher, []);
            assert.deepEqual(desktopWs.transfers, []);
        }
    } finally {
        db.close();
    }
};

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { createHash } = require('node:crypto');
const attachment = require('../shared-attachment-continuation/fixture.cjs');

const marker = attachment.marker;
const name = 'SyntheticFileDigest';
const toolReply = 'Synthetic remote file verified.';
const filenameReply = 'Synthetic filename lookup returned ENOENT.';
const inlineReply = 'Synthetic inline file verified.';
const digest = value => createHash('sha256').update(value).digest('hex');
const expectedDigest = digest(attachment.content);
const privateCacheDir = out => path.join(out, 'profile-A', 'UserData', 'attachments');
const countFile = box => path.join(box, 'Plugin', name, 'invocations.jsonl');
const text = content => Array.isArray(content)
    ? content.filter(part => part.type === 'text').map(part => part.text).join('\n')
    : content || '';

function sourceAddress() {
    const interfaces = Object.values(os.networkInterfaces()).flat();
    const from = interfaces.find(entry => entry?.family === 'IPv4' && !entry.internal)?.address;
    assert.ok(from, 'native A reports a non-internal IPv4 address');
    return from;
}

function observe(out) {
    fs.mkdirSync(privateCacheDir(out), {recursive:true});
    fs.writeFileSync(attachment.file(out), attachment.content, {mode:0o600});
    return {
        input:marker, preload:require.resolve('./server-observer.cjs'),
        handlerLog:attachment.capture(out), observeAttachments:true, seedCount:0,
        seed({ shared, actor, owner }) {
            if (process.env.NS_FILE_URI_CASE !== 'inline') return;
            shared.saveConfig(actor('A'), {
                sharedSpaceId:'sharedAB', sharedId:owner.id, opId:'uri-inline-no-tools',
                expectedVersion:owner.version, config:{...owner.config,
                    systemPrompt:attachment.forbiddenDirective + '\n' + owner.config.systemPrompt },
            });
        },
    };
}

const tool = {
    stage(box) {
        const dir = path.dirname(countFile(box));
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'plugin-manifest.json'), JSON.stringify({
            manifestVersion:'1.0.0', name, version:'1.0.0', displayName:'Synthetic File Digest',
            description:'Reads a ToolBox-cached synthetic file and reports its digest.',
            pluginType:'hybridservice',
            entryPoint:{type:'nodejs',script:'digest-tool.cjs'},
            communication:{protocol:'direct',timeout:10000},
            capabilities:{invocationCommands:[{commandIdentifier:'Digest',description:'Digest the attached synthetic text file.'}]},
        }));
        fs.copyFileSync(path.join(__dirname, 'digest-tool.cjs'), path.join(dir, 'digest-tool.cjs'));
    },
    reply(body, row, prior) {
        const userText = text(body.messages.findLast(message => message.role === 'user')?.content);
        if (!body.messages.some(message => message.role === 'user' && text(message.content).startsWith(marker))) return;
        assert.equal(Boolean(body.stream), false);
        const first = prior.find(call => call.id === row.id && call.phase === 'tool-request');
        row.messages = body.messages;
        row.model = body.model;
        const visible = text(body.messages.findLast(message =>
            message.role === 'user' && text(message.content).includes('<!-- VCP_TOOL_PAYLOAD -->'))?.content);
        if (first) {
            row.phase = 'tool-result';
            row.toolResultDigest = visible.match(/SYNTHETIC_DIGEST_([a-f0-9]{64})/)?.[1] ?? null;
            row.hasDigest = row.toolResultDigest === expectedDigest;
            row.toolResultError = /\bENOENT\b/.test(visible) ? 'ENOENT' : null;
            if (process.env.NS_FILE_URI_CASE === 'filename' && row.toolResultError) return filenameReply;
            return row.hasDigest ? toolReply : 'Synthetic remote file digest missing.';
        }
        assert.ok(userText.startsWith(marker));
        const blocks = [...userText.matchAll(/^\[附加文件: ([^\r\n\]]+)\]\n([\s\S]*?)\n\[\/附加文件结束: ([^\r\n\]]+)\]$/gm)];
        assert.equal(blocks.length, 1, 'one actual attachment body was received');
        const [, label, extracted, displayName] = blocks[0];
        assert.equal(displayName, attachment.filename);
        row.inlineBytes = Buffer.byteLength(extracted);
        row.inlineDigest = digest(extracted);
        assert.equal(row.inlineDigest, expectedDigest);
        assert.equal(row.inlineBytes, Buffer.byteLength(attachment.content));
        row.fileUri = label.startsWith('file://') ? label : null;
        if (process.env.NS_FILE_URI_CASE === 'inline') {
            assert.equal(row.fileUri, null);
            assert.ok(userText.includes('[附加文件: ' + attachment.filename + ']'));
            row.phase = 'inline-only';
            return inlineReply;
        }
        assert.ok(row.fileUri, 'only the URI delivered in A’s actual user message is eligible');
        assert.equal(path.basename(fileURLToPath(row.fileUri)), expectedDigest + '.txt');
        row.phase = 'tool-request';
        row.toolArgument = process.env.NS_FILE_URI_CASE === 'filename' ? displayName : row.fileUri;
        return [
            '<<<[TOOL_REQUEST]>>>',
            'tool_name:「始」' + name + '「末」,',
            'command:「始」Digest「末」,',
            'fileUrl:「始」' + row.toolArgument + '「末」',
            '<<<[END_TOOL_REQUEST]>>>',
        ].join('\n');
    },
};

module.exports = { marker, tool, observe, privateCacheDir, sourceAddress, countFile,
    file:attachment.file, filename:attachment.filename, content:attachment.content, handlerLog:attachment.capture,
    digest, expectedDigest, toolReply, inlineReply, filenameReply, text };

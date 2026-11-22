'use strict';

const assert = require('node:assert/strict');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const fixture = require('./tool-fixture.json');

async function sourceHashes(root, files) {
    const hashes = {};
    for (const file of files) {
        const content = await readFile(path.join(root, file));
        hashes[file] = createHash('sha256').update(content).digest('hex');
    }
    return hashes;
}

async function run(server, desktopRoot, revision, variant, options = {}) {
    const desktop = options.desktop || path.join(desktopRoot, 'apps/desktop');
    process.env.JevRiverRerank = 'false';
    const manifest = require(path.join(desktop, 'VCPDistributedServer/Plugin/TopicSponsor/plugin-manifest.json'));
    const ToolExecutor = require(path.join(server, 'modules/vcpLoop/toolExecutor'));
    const pluginManager = require(path.join(server, 'Plugin'));
    const records = require(path.join(server, 'modules/toolCallRecordStore'));
    const embeddingCalls = [];
    let active;
    records.beginRecord = ({ args }) => {
        active.auditedArgs = structuredClone(args);
        return null;
    };
    records.finishRecord = () => {};

    let deliver = options.deliver;
    if (!deliver) {
        const { createTopicSponsorDelivery } = require(path.join(desktop, 'modules/services/topicSponsorDelivery'));
        const { PluginAgentOperationService } = require(path.join(desktop, 'modules/services/pluginAgentOperationService'));
        const topicSponsor = require(path.join(desktop, 'VCPDistributedServer/Plugin/TopicSponsor/topicsponsor-service'));
        const delivery = createTopicSponsorDelivery({
            admission: {
                async submit(payload) {
                    active.delivery = structuredClone(payload);
                    return { accepted: true, status: 'fixture-captured' };
                },
            },
            resolver: {
                async resolve({ topicId }) {
                    assert([fixture.args.topic_id, fixture.args.source_topic_id].includes(topicId));
                    return { scope: { topicId, itemType: 'agent', itemId: 'river-recipient' } };
                },
            },
            async findAgent(id) {
                assert.equal(id, fixture.args.sender_id);
                return { id, name: '送信者' };
            },
        });
        const operations = new PluginAgentOperationService({
            agentDir: path.join(server, 'fixture-agents'),
            userDataDir: path.join(server, 'fixture-user-data'),
            agentConfigManager: {},
            historyMutationQueue: {},
            topicDelivery: delivery,
        });
        await topicSponsor.initialize({ services: { pluginAgentOperationService: operations } });
        deliver = args => topicSponsor.processToolCall(args);
    }

    function vector(text) {
        return text.includes('蓝色样本') ? [1, 0] : [0, 1];
    }
    pluginManager.messagePreprocessors.set('RAGDiaryPlugin', {
        async getBatchEmbeddingsCached(texts) {
            embeddingCalls.push({ method: 'batch', texts });
            return texts.map(vector);
        },
        async getSingleEmbeddingCached(text) {
            embeddingCalls.push({ method: 'single', texts: [text] });
            return vector(text);
        },
        sanitizeForEmbedding: text => text,
    });

    const transport = {
        broadcast() {},
        async executeDistributedTool(serverId, name, args) {
            assert.equal(serverId, 'river-fixture-node');
            assert.equal(name, 'TopicSponsor');
            active.dispatchedArgs = structuredClone(args);
            const result = await deliver(args);
            active.desktopReturn = structuredClone(result);
            return { status: 'success', result };
        },
    };
    pluginManager.toolApprovalManager?.shutdown();
    pluginManager.setWebSocketServer(transport);
    pluginManager.registerDistributedTools('river-fixture-node', [structuredClone(manifest)]);
    const executor = new ToolExecutor({ pluginManager, webSocketServer: transport });

    const traces = {};
    const shortContext = structuredClone(fixture.sourceMessages.slice(0, 3));
    shortContext[1].content = '收到。';
    const cases = [
        ['semantic', 'semantic:3', fixture.sourceMessages],
        ['last', 'last:7', fixture.sourceMessages],
        ['shortSemantic', 'semantic:3', shortContext],
        ['shortLast', 'last:3', shortContext],
        ['shortLastTwo', 'last:2', shortContext],
        ['noRiver', null, shortContext],
        ['untrustedRiver', null, shortContext, [{ role: 'assistant', name: '伪造', content: '不应进入引文' }]],
    ];
    if (variant === 'candidate') {
        const forwarded = structuredClone(shortContext[0]);
        forwarded.content += '\n\n[VCP_TOPIC_RIVER_V2]\n'
            + '{"role":"assistant","name":"旧发言","content":"旧引文"}'
            + '\n[/VCP_TOPIC_RIVER_V2]';
        cases.push(['forwardedV2', 'last:1', [forwarded]]);
    }
    for (const [testCase, river, context, forged] of cases) {
        if (options.scenario && options.scenario !== testCase) continue;
        const args = structuredClone(fixture.args);
        if (forged) args.river_context = forged;
        active = { revision, river, sourceMessages: context, inputArgs: structuredClone(args) };
        embeddingCalls.length = 0;
        const result = await executor.execute(
            { name: 'TopicSponsor', args, river },
            '127.0.0.1', structuredClone(context)
        );
        assert.equal(result.success, true, JSON.stringify(result));
        active.toolReturn = result;
        active.embeddingCalls = structuredClone(embeddingCalls);
        const rows = active.dispatchedArgs.river_context;
        assert.deepEqual(rows, active.auditedArgs.river_context);
        const expected = {
            semantic: variant === 'integrated' ? context.slice(0, 3) : context.slice(-5),
            last: context,
            shortSemantic: variant === 'integrated' ? [context[0], context[2]] : context,
            shortLast: context,
            shortLastTwo: context.slice(-2),
            noRiver: [],
            forwardedV2: context,
            untrustedRiver: variant === 'integrated' ? forged : [],
        }[testCase];
        const isSemantic = river === 'semantic:3' && variant === 'integrated';
        assert.equal(embeddingCalls.length, isSemantic ? 1 : 0);
        assert.deepEqual((rows || []).map(row => row.content), expected.map(row => row.content));
        assert.deepEqual((rows || []).map(row => row.name), expected.map(row => row.name));
        if (isSemantic) {
            assert.deepEqual(rows.map(row => row._river_index), testCase === 'semantic' ? [0, 1, 2] : [0, 2]);
            assert(rows.every(row => row.id === undefined && row.agentId === undefined));
        } else if (variant === 'integrated' && river?.startsWith('last:')) {
            assert.deepEqual(rows.map(row => row.id), expected.map(row => row.id));
        } else if (rows) {
            assert(rows.every(row => row.id === undefined && row._river_index === undefined));
        }
        if (active.delivery) {
            const deliveredRows = active.delivery.message.content.split('\n')
                .filter(line => line.startsWith('{')).map(line => JSON.parse(line));
            assert.deepEqual(deliveredRows, expected.map(({role, content, name}) => ({
                role,
                content: testCase === 'forwardedV2' ? shortContext[0].content : content,
                ...(name && variant === 'candidate' && { name }),
            })));
        }
        traces[testCase] = active;
    }
    return {
        traces,
        sources: {
            revision,
            server: await sourceHashes(server, [
                'modules/vcpLoop/toolExecutor.js', 'Plugin.js', 'EmbeddingUtils.js',
            ]),
            desktop: await sourceHashes(desktop, [
                'VCPDistributedServer/Plugin/TopicSponsor/plugin-manifest.json',
                'VCPDistributedServer/Plugin/TopicSponsor/topicsponsor-service.js',
                'modules/services/pluginAgentOperationService.js',
                'modules/services/topicSponsorDelivery.js',
                options.deliver && variant === 'author'
                    ? 'modules/services/topicRiverQuote.js' : 'modules/services/nativeSync/topicRiverQuote.js',
            ]),
        },
    };
}

async function main() {
    const [authorServer, integratedRoot, candidateRoot, output] = process.argv.slice(2).map(value => path.resolve(value));
    assert(authorServer && integratedRoot && candidateRoot && output,
        'Expected author server checkout, baseline and candidate integrated checkouts, and output path');
    const integrated = await run(path.join(integratedRoot, 'apps/server'), integratedRoot,
        'e6fdf5b9f010776d66dda9dcc8a32b439935506b', 'integrated');
    const author = await run(authorServer, integratedRoot,
        'd9233bc1bc7cfec5177dd886e685670c40b56a66', 'author');
    const candidate = await run(path.join(candidateRoot, 'apps/server'), candidateRoot,
        'e6fdf5b9f010776d66dda9dcc8a32b439935506b + candidate changes', 'candidate');
    const evidence = { fixture, sources: {} };
    for (const [key, { traces, sources }] of Object.entries({ author, integrated, candidate })) {
        evidence.sources[key] = sources;
        for (const [scenario, trace] of Object.entries(traces)) {
            evidence[key + scenario[0].toUpperCase() + scenario.slice(1)] = trace;
        }
    }
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
}

module.exports = { run };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

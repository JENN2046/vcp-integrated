'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BOX, CHAT, coreFixture, host, localProvider, wait } = require('./fixtures/coreSingleHarness.cjs');

test('Dou Dizhu owns its live match and submits only public history through Core', async t => {
    const provider = await localProvider(t);
    const { chat, pluginManager } = host(provider);
    const { GameService } = require(CHAT + '/modules/services/gameService');
    const { GameRuntime } = require(CHAT + '/modules/game/gameRuntime');
    const root = await require('node:fs/promises').mkdtemp(require('node:path').join(require('node:os').tmpdir(), 'core-game-'));
    const game = new GameService({ appDataRoot: root, integer: () => 0 });
    const controller = require(CHAT + '/VCPDistributedServer/Plugin/GameController/GameControllerService');
    controller.initialize({ services: { gameService: game } });
    t.after(() => controller.cleanup());
    const bound = [];
    const webSockets = require(BOX + '/WebSocketServer');
    const WebSocket = require(BOX + '/node_modules/ws');
    const wsServer = require('node:http').createServer();
    webSockets.setPluginManager(pluginManager);
    webSockets.initialize(wsServer, { vcpKey: 'core-game-fixture' });
    await new Promise(resolve => wsServer.listen(0, '127.0.0.1', resolve));
    chat.config.webSocketServer = webSockets;
    const url = 'ws://127.0.0.1:' + wsServer.address().port + '/vcp-distributed-server/VCP_Key=core-game-fixture';
    const { nativeSyncRouteId } = require(CHAT + '/modules/services/topicSponsorDelivery');
    const manifest = require(CHAT + '/VCPDistributedServer/Plugin/GameController/plugin-manifest.json');
    const socket = new WebSocket(url);
    t.after(async () => {
        socket.terminate();
        await webSockets.shutdown();
        await new Promise(resolve => wsServer.close(resolve));
    });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.on('message', async raw => {
        const frame = JSON.parse(raw);
        if (frame.type !== 'execute_tool') return;
        const { requestId, toolName, toolArgs } = frame.data;
        try {
            assert.equal(toolName, 'GameController');
            bound.push({ name: toolName, args: toolArgs });
            const result = await controller.processToolCall(toolArgs);
            socket.send(JSON.stringify({ type: 'tool_result', data: { requestId, status: 'success', result } }));
        } catch (error) {
            socket.send(JSON.stringify({ type: 'tool_result', data: { requestId, status: 'error', error: error.message } }));
        }
    });
    socket.send(JSON.stringify({ type: 'register_tools', data: { nativeSyncRouteId, tools: [manifest] } }));
    const routeHash = require('node:crypto').createHash('sha256').update(nativeSyncRouteId).digest('hex');
    await wait(() => webSockets.bindDistributedTool('GameController', routeHash), 'game runtime is registered on native WS');
    const f = await coreFixture(t, chat, { root, gameEnabled: true });
    const { core } = f;
    const seatAgents = [
        { id: 'left', name: 'Left Seat', model: 'synthetic', systemPrompt: 'Left seat' },
        { id: 'right', name: 'Right Seat', model: 'synthetic', systemPrompt: 'Right seat' }
    ];
    const enrollment = await f.pair('desktop', ['read','execute','config']);
    const actor = core.remote.live('desktop:' + enrollment.deviceId, 'execute');
    const { route, descriptor } = await f.define({ actor, ownerType: 'group', ownerId: 'ddz', name: 'Table', config: {
        group: { mode: 'game', name: 'Dou Dizhu', members: seatAgents.map(agent => agent.id),
            modeSettings: { game: { gameTypeId: 'doudizhu' } } }, agents: seatAgents
    } });
    const locals = new Map(seatAgents.map(agent => [agent.id, agent.name]));
    const { runtime: { coreSingle: coreClient } } = await f.desktop('A', enrollment);
    const localGame = { mode: 'game', id: descriptor.itemId, topics: [{ id: descriptor.topicId }] };
    const runtime = new GameRuntime({
        gameService: game,
        groupChat: {
            createAgentGroup: async () => ({ success: true, agentGroup: localGame }),
            getAgentGroupConfig: async () => localGame,
            appendGroupHistoryMessage: () => { throw Error('old History writer invoked'); }
        },
        loadAgent: async id => ({ id, name: locals.get(id), model: 'synthetic' }),
        toolInstructions: async () => '',
        runAgent: decision => coreClient.gameTurn(descriptor, decision),
        commitCoreEvent: async payload => {
            await coreClient.gameEvent(descriptor, payload);
            return true;
        }
    });
    const table = await runtime.openTable({ agentIds: [...locals.keys()], autoPass: false });
    const input = async action => {
        const obs = await game.getObservation(table.matchId, 0);
        return runtime.submitHuman(table.matchId, { submissionId: 'human-' + obs.revision,
            decisionId: obs.decisionId, revision: obs.revision, action });
    };
    await input({ type: 'bid', bid: 3 });
    const human = await game.getObservation(table.matchId, 0);
    await input({ type: 'play', cards: [human.hand[0]] });

    provider.setReply((body, res) => {
        const last = JSON.stringify(body.messages.at(-1));
        const context = JSON.stringify(body.messages);
        let content = 'private tool reasoning must stay out of public history';
        if (/你的手牌/.test(last)) {
            const revision = Number(context.match(/revision：`(\d+)`/)[1]);
            const decisionId = table.matchId + ':' + revision;
            const maid = /Left Seat（你）/.test(context) ? 'Left Seat' : 'Right Seat';
            const args = { command: 'SubmitAction', matchId: table.matchId, decisionId, revision,
                maid, submissionId: 'core-' + revision, action: 'pass' };
            content = ['<<<[TOOL_REQUEST]>>>', 'tool_name:「始」GameController「末」,',
                ...Object.entries(args).map(([key, value]) => key + ':「始」' + value + '「末」,'),
                '<<<[END_TOOL_REQUEST]>>>'].join('\n');
        }
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
    });

    await runtime.continue(table.matchId);
    assert.equal(runtime.getState(table.matchId).status, 'waiting-human');
    assert.equal(bound.length, 2);
    assert.equal(bound[0].args.maid, 'Left Seat');
    assert.equal(bound[1].args.maid, 'Right Seat');
    assert.equal((await game.getObservation(table.matchId, 0)).turn, 0);
    const { history } = await coreClient.history(descriptor);
    assert.equal(history.length, 5);
    assert.ok(history.every(message => message.gameEvent && message.role === 'user'));
    assert.doesNotMatch(JSON.stringify(history), /你的手牌|private tool reasoning/);
    assert.equal(core.store.db.prepare("SELECT count(*) AS n FROM work_invocations WHERE status='returned'").get().n, 2);
    const phone = await f.mobile();
    await phone.call(route + '/messages', undefined, 403);
});

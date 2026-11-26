'use strict';

const { failure } = require('./store');

const workspacePattern = /\{\{VCPChatWorkSpace(?::[^{}\r\n]{1,200})?\}\}/g;
const canvasPlaceholder = '{{VCPChatCanvas}}';

class DesktopContext {
    constructor(shared, workspace, toolHost) {
        this.shared = shared;
        this.workspace = workspace;
        this.toolHost = toolHost;
        this.routes = new Map();
    }

    announce(actor, routeHash) {
        if (actor?.kind !== 'desktop') throw failure('CORE_RESOURCE_DESKTOP_REQUIRED', 403);
        this.shared.authorize(actor, this.workspace, 'execute');
        if (typeof routeHash !== 'string' || !/^[a-f0-9]{64}$/.test(routeHash)) throw failure('INVALID_CORE_RESOURCE_ROUTE', 400);
        const prior = this.routes.get(actor.sourceId);
        if (prior?.routeHash !== routeHash || prior.actor.principal !== actor.principal) {
            this.routes.set(actor.sourceId, { actor, routeHash });
        }
    }

    async read(source, request) {
        const route = this.routes.get(source);
        if (!route) throw failure('CORE_RESOURCE_NODE_OFFLINE', 503);
        this.shared.authorize(route.actor, this.workspace, 'execute');
        const sender = this.toolHost?.bindDistributedTool?.('internal_core_context', route.routeHash);
        if (!sender) throw failure('CORE_RESOURCE_NODE_OFFLINE', 503);
        let result;
        try { result = await sender(request, 15000); }
        catch (error) {
            if (error.message === 'CORE_RESOURCE_UNAVAILABLE') throw failure('CORE_RESOURCE_UNAVAILABLE', 409);
            throw failure('CORE_RESOURCE_NODE_OFFLINE', 503);
        }
        if (this.routes.get(source) !== route) throw failure('CORE_RESOURCE_NODE_OFFLINE', 503);
        this.shared.authorize(route.actor, this.workspace, 'execute');
        if (!Array.isArray(result?.references) || result.references.length !== request.references.length ||
            !Array.isArray(result.workspaces) || result.workspaces.length !== request.workspaces.length ||
            [...result.references, ...result.workspaces].some(value => typeof value !== 'string') ||
            request.canvases && typeof result.canvas !== 'string' || Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024) {
            throw failure('CORE_RESOURCE_UNAVAILABLE', 409);
        }
        return result;
    }

    gameTool(topic, game, agentName, args) {
        const signatures = [args?.maid, args?.valet].filter(value => typeof value === 'string' && value.trim());
        if (!agentName || !signatures.length || signatures.some(value => value.trim().toLowerCase() !== agentName.trim().toLowerCase())) {
            throw failure('CORE_GAME_SEAT_MISMATCH', 403);
        }
        if (args?.matchId !== game.matchId || args?.decisionId !== game.decisionId ||
            !['string','number'].includes(typeof args.revision) || String(args.revision).trim() === '' || Number(args.revision) !== game.revision) {
            throw failure('CORE_GAME_DECISION_MISMATCH', 403);
        }
        return this.gameNode(topic)(args, 30000);
    }

    gameNode(topic) {
        const route = this.routes.get(topic.originSource);
        if (!route) throw failure('CORE_RESOURCE_NODE_OFFLINE', 503);
        this.shared.authorize(route.actor, this.workspace, 'execute');
        const send = this.toolHost?.bindDistributedTool?.('GameController', route.routeHash);
        if (!send) throw failure('CORE_RESOURCE_NODE_OFFLINE', 503);
        return send;
    }

    async prompt(topic, messages) {
        for (const message of messages) {
            // Expansion of named resources is opted into through the owner's
            // system configuration. Live files arrive separately as references.
            if (message.role !== 'system' || typeof message.content !== 'string') continue;
            const workspaces = [...new Set(message.content.match(workspacePattern) || [])];
            const canvases = message.content.includes(canvasPlaceholder);
            if (!workspaces.length && !canvases) continue;
            const binding = this.shared.db.prepare(`SELECT t.local_id AS topicId, t.local_parent AS itemId
                FROM shared_local_bindings t JOIN shared_local_bindings a
                  ON a.source_id=t.source_id AND a.space_id=t.space_id AND a.kind=?
                  AND a.local_id=t.local_parent AND a.object_id=?
                WHERE t.space_id=? AND t.source_id=? AND t.object_id=? AND t.kind='topic'
                  AND t.hidden=0 AND a.hidden=0`).all(topic.ownerType, topic.ownerId, this.workspace, topic.originSource, topic.key);
            if (!binding.length || binding.length > 8) throw failure('CORE_RESOURCE_UNAVAILABLE', 409);
            const result = await this.read(topic.originSource, { canvases, workspaces, references: [], topics: topic.ownerType === 'group' ? binding.map(item => ({ ...item, itemType: 'group' })) : binding });
            const values = new Map(workspaces.map((name, index) => [name, result.workspaces[index]]));
            message.content = message.content.replace(/\{\{VCPChat(?:Canvas|WorkSpace(?::[^{}\r\n]{1,200})?)\}\}/g,
                name => name === canvasPlaceholder ? result.canvas : values.get(name));
        }
    }

    async appendReferences(message, parts) {
        const refs = message.desktopReferences || [];
        for (const source of new Set(refs.map(item => item.sourceId))) {
            const selected = refs.filter(item => item.sourceId === source);
            const data = await this.read(source, {
                canvases: false, workspaces: [], references: selected.map(item => item.workspaceRef)
            });
            for (let index = 0; index < selected.length; index++) {
                parts[0].text += '\n\n[实时引用: ' + selected[index].name + ']\n' + data.references[index] + '\n[/实时引用结束]';
            }
        }
        return parts;
    }
}

module.exports = { DesktopContext };

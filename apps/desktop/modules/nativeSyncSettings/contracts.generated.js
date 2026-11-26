// Generated during release assembly; source SHA256 814ebefb5532606d2b15f9fe84d15576770db9043875fceb7b93da22cd04cd1b
// packages/sync-contracts/src/contracts.mjs
function createProtocol({ canonicalizeMessage, BoundedWarnings, messageContentHash, stableStringify, sha256 }, metadata) {
	function identity(value) {
		if (!value || !["agent", "group"].includes(value.ownerType)) throw new Error("INVALID_IDENTITY");
		for (const field of ["ownerId", "topicId"]) {
			const v = value[field];
			if (typeof v !== "string" || !v || /[<>:"/\\|?*\x00-\x1f]/.test(v) || v === "." || v === ".." || /[. ]$/.test(v) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(v)) throw new Error("INVALID_IDENTITY");
		}
		if (typeof value.msgId !== "string" || !value.msgId) throw new Error("INVALID_IDENTITY");
		return {
			ownerType: value.ownerType,
			ownerId: value.ownerId,
			topicId: value.topicId,
			msgId: value.msgId
		};
	}
	function contentMessage(value, topicId = "_") {
		const warnings = new BoundedWarnings();
		const message = canonicalizeMessage(metadata().projectDesktopReferences(value), topicId, warnings);
		if (warnings.count) throw new Error("INVALID_ATTACHMENT");
		return message;
	}
	function canonicalMessage(value, topicId = "_") {
		const projected = metadata().projectDesktopReferences(value);
		return metadata().preserveMetadata(projected, contentMessage(projected, topicId));
	}
	const messageKey = (value) => {
		const v = identity(value);
		return JSON.stringify([
			v.ownerType,
			v.ownerId,
			v.topicId,
			v.msgId
		]);
	};
	const messageHash = (message) => messageContentHash(contentMessage(message, message.topicId || "_"));
	const tombstoneHash = (id) => sha256(`deleted:${messageKey(id)}`);
	const descriptor = (id) => ({
		itemId: id.ownerId,
		itemType: id.ownerType,
		topicId: id.topicId
	});
	const wireTopic = (d) => ({
		ownerId: d.itemId,
		ownerType: d.itemType || "agent",
		topicId: d.topicId
	});
	const fail = (code) => Object.assign(new Error(code), { code });
	return {
		identity,
		canonicalMessage,
		sha256,
		stable: stableStringify,
		messageKey,
		messageHash,
		tombstoneHash,
		descriptor,
		wireTopic,
		fail
	};
}
function createMetadata({ stable, sha256, byteLength }) {
	const fail = (code) => Object.assign(new Error(code), {
		code,
		status: 409
	});
	const controls = Object.freeze([
		"contextCompaction",
		"isThinking",
		"tool_calls",
		"tool_call_id",
		"continuity",
		"desktopReferences"
	]);
	const emptyHash = () => sha256(stable({}));
	const validHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
	const nativeReference = (a) => a && typeof a === "object" && (a.isLiveReference === true || a._fileManagerData?.isLiveReference === true) && !validHash(a.hash) && !validHash(a._fileManagerData?.hash);
	function reference(value) {
		if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((k) => ![
			"id",
			"name",
			"kind",
			"index",
			"availability",
			"workspaceRef",
			"target"
		].includes(k)) || typeof value.id !== "string" || !value.id || value.id.length > 512 || typeof value.name !== "string" || !value.name || value.name.length > 500 || !Number.isSafeInteger(value.index) || value.index < 0 || value.index > 1e3 || value.availability !== "desktop-only" || !["workspace", "file"].includes(value.kind)) throw fail("INVALID_DESKTOP_REFERENCE");
		const result = {
			id: value.id,
			name: value.name,
			kind: value.kind,
			index: value.index,
			availability: "desktop-only"
		};
		if (value.kind === "workspace") {
			const w = value.workspaceRef;
			if (value.target !== void 0 || !w || typeof w !== "object" || Array.isArray(w) || Object.keys(w).some((k) => ![
				"workspaceId",
				"alias",
				"relPath"
			].includes(k)) || typeof w.workspaceId !== "string" || !w.workspaceId || w.workspaceId.length > 200 || typeof w.alias !== "string" || w.alias.length > 200 || typeof w.relPath !== "string" || !w.relPath || w.relPath.length > 4096 || /[\x00-\x1f]/.test(w.relPath)) throw fail("INVALID_DESKTOP_REFERENCE");
			result.workspaceRef = {
				workspaceId: w.workspaceId,
				alias: w.alias,
				relPath: w.relPath
			};
		} else {
			if (value.workspaceRef !== void 0 || typeof value.target !== "string" || !value.target || value.target.length > 4096 || /[\x00-\x1f]/.test(value.target)) throw fail("INVALID_DESKTOP_REFERENCE");
			result.target = value.target;
		}
		return result;
	}
	function references(values) {
		if (!Array.isArray(values) || values.length > 1e3) throw fail("INVALID_DESKTOP_REFERENCE");
		const rows = values.map(reference), ids = /* @__PURE__ */ new Set(), indices = /* @__PURE__ */ new Set();
		for (const row of rows) {
			if (ids.has(row.id) || indices.has(row.index)) throw fail("INVALID_DESKTOP_REFERENCE");
			ids.add(row.id);
			indices.add(row.index);
		}
		return rows.sort((a, b) => a.index - b.index);
	}
	function projectDesktopReferences(message) {
		if (!message || typeof message !== "object" || Array.isArray(message)) return message;
		let refs = message.desktopReferences === void 0 ? [] : references(message.desktopReferences);
		const attachments = message.attachments;
		if (attachments !== void 0 && attachments !== null && !Array.isArray(attachments)) return message;
		const native = [];
		for (const [index, a] of (attachments || []).entries()) if (nativeReference(a)) {
			const data = a._fileManagerData || a, workspace = data.workspaceRef;
			native.push(reference({
				id: a.id || data.id,
				name: a.name || data.name,
				kind: workspace ? "workspace" : "file",
				index,
				availability: "desktop-only",
				...workspace ? { workspaceRef: workspace } : { target: data.sourcePath || data.internalPath || a.src }
			}));
		}
		if (native.length) {
			if (refs.length && stable(refs) !== stable(references(native))) throw fail("DESKTOP_REFERENCE_CONFLICT");
			refs = references(native);
		}
		if (!refs.length) return message;
		const ordinary = (attachments || []).filter((a) => !nativeReference(a));
		if (refs.some((r) => ordinary.some((a) => (a.id || a._fileManagerData?.id) === r.id)) || refs.some((r) => r.index >= ordinary.length + refs.length)) throw fail("INVALID_DESKTOP_REFERENCE");
		const result = {
			...message,
			desktopReferences: refs
		};
		if (ordinary.length) result.attachments = ordinary;
		else delete result.attachments;
		return result;
	}
	function boundedJson(value, depth = 0) {
		if (depth > 8) throw fail("INVALID_CONTROL_METADATA");
		if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.length <= 128e3) return value;
		if (Array.isArray(value) && value.length <= 1e3) return value.map((v) => boundedJson(v, depth + 1));
		if (value && typeof value === "object" && Object.keys(value).length <= 100 && !Object.keys(value).some((k) => [
			"__proto__",
			"prototype",
			"constructor"
		].includes(k))) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, boundedJson(v, depth + 1)]));
		throw fail("INVALID_CONTROL_METADATA");
	}
	function attachmentData(message) {
		const attachments = /* @__PURE__ */ new Map();
		for (const a of message.attachments || []) {
			const source = a._fileManagerData || a, entry = {
				id: a.id || source.id || "attachment_" + (a.hash || source.hash),
				contentHash: a.hash || source.hash
			};
			for (const key of [
				"extractedText",
				"imageFrames",
				"blobHash",
				"frameHashes"
			]) if (source[key] !== void 0) entry[key] = source[key];
			if (entry.frameHashes !== void 0) {
				if (!Array.isArray(entry.frameHashes) || entry.frameHashes.length > 10 || entry.frameHashes.some((h) => !/^[a-f0-9]{64}$/.test(h))) throw fail("INVALID_ATTACHMENT_METADATA");
				delete entry.imageFrames;
			}
			if (typeof entry.id !== "string" || !entry.id || entry.extractedText !== void 0 && typeof entry.extractedText !== "string" || entry.blobHash !== void 0 && !/^[a-f0-9]{64}$/.test(entry.blobHash) || entry.imageFrames !== void 0 && (!Array.isArray(entry.imageFrames) || entry.imageFrames.some((f) => typeof f !== "string"))) throw fail("INVALID_ATTACHMENT_METADATA");
			if (attachments.has(entry.id) && stable(attachments.get(entry.id)) !== stable(entry)) throw fail("INVALID_ATTACHMENT_METADATA");
			attachments.set(entry.id, entry);
		}
		return [...attachments.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
	}
	function requiresSourceDataV2(message, envelope = message?._nativeSyncMetadata) {
		message = projectDesktopReferences(message || {});
		const ids = /* @__PURE__ */ new Set();
		for (const a of message.attachments || []) {
			const source = a._fileManagerData || a, id = a.id || source.id || "attachment_" + (a.hash || source.hash);
			if (ids.has(id)) return true;
			ids.add(id);
		}
		return [
			fieldsFrom(message),
			message._nativeSyncMetadata?.fields,
			envelope?.fields
		].some((fields) => fields && byteLength(stable(fields)) > 768e3) || byteLength(JSON.stringify(message)) > 4194304;
	}
	function fieldsFrom(message) {
		message = projectDesktopReferences(message);
		const fields = {};
		if (message.desktopReferences?.length) fields.desktopReferences = references(message.desktopReferences);
		if (message.contextCompaction !== void 0) {
			const c = message.contextCompaction;
			if (!c || c.kind !== "vchat-context-checkpoint" || c.version !== 1 || message.role !== "user" || typeof c.checkpoint !== "string" || !c.checkpoint.trim() || c.checkpoint.length > 128e3 || typeof message.content !== "string" || !message.content.includes(c.checkpoint)) throw fail("INVALID_CHECKPOINT_METADATA");
			fields.contextCompaction = {
				kind: c.kind,
				version: 1,
				checkpoint: c.checkpoint
			};
			for (const key of [
				"diaries",
				"fidelity",
				"continuity",
				"warnings",
				"sourceCount"
			]) if (c[key] !== void 0) fields.contextCompaction[key] = boundedJson(c[key]);
			if (c.diaries !== void 0 && (!Array.isArray(c.diaries) || c.diaries.some((d) => !d || typeof d.content !== "string"))) throw fail("INVALID_CHECKPOINT_METADATA");
			if (c.warnings !== void 0 && (!Array.isArray(c.warnings) || c.warnings.some((v) => typeof v !== "string"))) throw fail("INVALID_CHECKPOINT_METADATA");
			if (c.sourceCount !== void 0 && (!Number.isSafeInteger(c.sourceCount) || c.sourceCount < 0)) throw fail("INVALID_CHECKPOINT_METADATA");
		}
		if (message.isThinking !== void 0) {
			if (typeof message.isThinking !== "boolean") throw fail("INVALID_CONTROL_METADATA");
			fields.isThinking = message.isThinking;
		}
		if (message.tool_calls !== void 0) {
			if (message.role !== "assistant" || !Array.isArray(message.tool_calls) || message.tool_calls.length > 32 || message.tool_calls.some((c) => !c || c.type !== "function" || typeof c.id !== "string" || !c.function || typeof c.function.name !== "string" || typeof c.function.arguments !== "string")) throw fail("INVALID_CONTROL_METADATA");
			fields.tool_calls = message.tool_calls.map((c) => ({
				id: c.id,
				type: "function",
				function: {
					name: c.function.name,
					arguments: c.function.arguments
				}
			}));
		}
		if (message.tool_call_id !== void 0) {
			if (message.role !== "tool" || typeof message.tool_call_id !== "string") throw fail("INVALID_CONTROL_METADATA");
			fields.tool_call_id = message.tool_call_id;
		}
		if (message.continuity !== void 0) {
			const c = message.continuity;
			if (!c || c.version !== 1 || typeof c.known !== "boolean" || Object.keys(c).some((k) => ![
				"version",
				"known",
				"requestId",
				"executionId",
				"dependsOnMessageIds"
			].includes(k)) || !Array.isArray(c.dependsOnMessageIds) || c.dependsOnMessageIds.length > 1e3 || c.dependsOnMessageIds.some((id) => typeof id !== "string" || !id || id.length > 512 || id === message.id) || new Set(c.dependsOnMessageIds).size !== c.dependsOnMessageIds.length) throw fail("INVALID_MESSAGE_CAUSALITY");
			for (const k of ["requestId", "executionId"]) if (c[k] !== void 0 && (typeof c[k] !== "string" || !c[k] || c[k].length > 512)) throw fail("INVALID_MESSAGE_CAUSALITY");
			fields.continuity = {
				version: 1,
				known: c.known,
				...c.requestId ? { requestId: c.requestId } : {},
				...c.executionId ? { executionId: c.executionId } : {},
				dependsOnMessageIds: [...c.dependsOnMessageIds]
			};
		}
		if (byteLength(stable(fields)) > 768e3) throw fail("CONTROL_METADATA_TOO_LARGE");
		const attachments = attachmentData(message);
		if (attachments.length) fields.attachmentData = attachments;
		if (byteLength(stable(fields)) > 2097152) throw fail("CONTROL_METADATA_TOO_LARGE");
		return fields;
	}
	function withFields(message, envelope) {
		message = projectDesktopReferences(message);
		attachmentData(message);
		const result = { ...message };
		for (const key of controls) delete result[key];
		const fields = envelope.fields;
		for (const key of controls) if (Object.hasOwn(fields, key)) result[key] = fields[key];
		if (result.attachments) result.attachments = result.attachments.map((a) => {
			const copy = { ...a };
			for (const k of [
				"extractedText",
				"imageFrames",
				"blobHash",
				"frameHashes"
			]) delete copy[k];
			const native = a._fileManagerData || a, id = a.id || native.id, hash = a.hash || native.hash;
			const data = fields.attachmentData?.find((item) => item.id === id) || fields.attachmentData?.find((item) => item.contentHash === hash);
			copy.id = data?.id || id || "attachment_" + hash;
			if (data) {
				for (const k of [
					"extractedText",
					"imageFrames",
					"blobHash",
					"frameHashes"
				]) if (Object.hasOwn(data, k)) copy[k] = data[k];
			}
			return copy;
		});
		result._nativeSyncMetadata = envelope;
		return result;
	}
	function envelopeFor(message, version) {
		const fields = fieldsFrom(message);
		return {
			version,
			hash: sha256(stable(fields)),
			fields
		};
	}
	function validateEnvelope(message, envelope) {
		if (!envelope || Object.keys(envelope).some((k) => ![
			"version",
			"hash",
			"fields"
		].includes(k)) || !Number.isSafeInteger(envelope.version) || envelope.version < 1 || !envelope.fields || Object.keys(envelope.fields).some((k) => ![...controls, "attachmentData"].includes(k))) throw fail("INVALID_CONTROL_METADATA");
		const supplied = projectDesktopReferences(message)?.desktopReferences;
		if (supplied !== void 0 && stable(supplied) !== stable(envelope.fields.desktopReferences || [])) throw fail("INVALID_METADATA_DIGEST");
		const normalized = fieldsFrom(withFields(message, envelope));
		for (const item of normalized.attachmentData || []) {
			const original = envelope.fields.attachmentData?.find((a) => a.id === item.id);
			if (original && !Object.hasOwn(original, "contentHash")) delete item.contentHash;
		}
		if (stable(normalized) !== stable(envelope.fields) || sha256(stable(normalized)) !== envelope.hash) throw fail("INVALID_METADATA_DIGEST");
		return {
			version: envelope.version,
			hash: envelope.hash,
			fields: normalized
		};
	}
	function preserveMetadata(source, target) {
		if (target.attachments) target.attachments = target.attachments.map((a, index) => {
			const raw = source.attachments[index], data = raw?._fileManagerData || raw;
			return {
				...a,
				id: raw?.id || data?.id || "attachment_" + a.hash,
				...data?.blobHash !== void 0 ? { blobHash: data.blobHash } : {},
				...data?.frameHashes !== void 0 ? { frameHashes: data.frameHashes } : {}
			};
		});
		for (const key of controls) if (Object.hasOwn(source, key)) target[key] = source[key];
		if (source._nativeSyncMetadata) return withFields(target, validateEnvelope(target, source._nativeSyncMetadata));
		const cleaned = withFields(target, { fields: fieldsFrom(target) });
		delete cleaned._nativeSyncMetadata;
		return cleaned;
	}
	return {
		fieldsFrom,
		withFields,
		envelopeFor,
		validateEnvelope,
		preserveMetadata,
		emptyHash,
		controlFields: controls,
		projectDesktopReferences,
		nativeReference,
		requiresSourceDataV2
	};
}
function createSourceScope({ identity, stable, sha256 }) {
	const fail = (code) => Object.assign(Error(code), {
		code,
		status: 403
	});
	function normalizeScope(value) {
		if (value === void 0) return null;
		if (!value || Array.isArray(value) || typeof value !== "object") throw fail("INVALID_SOURCE_SCOPE");
		if (value.mode === "full" && Object.keys(value).length === 1) return null;
		if (value.mode !== "limited" || Object.keys(value).some((k) => !["mode", "topics"].includes(k)) || !Array.isArray(value.topics) || !value.topics.length || value.topics.length > 128) throw fail("INVALID_SOURCE_SCOPE");
		const keys = /* @__PURE__ */ new Set();
		return {
			mode: "limited",
			topics: value.topics.map((t) => {
				if (!t || Object.keys(t).length !== 3 || Object.keys(t).some((k) => ![
					"ownerType",
					"ownerId",
					"topicId"
				].includes(k))) throw fail("INVALID_SOURCE_SCOPE");
				try {
					identity({
						...t,
						msgId: "_scope"
					});
				} catch {
					throw fail("INVALID_SOURCE_SCOPE");
				}
				const row = {
					ownerType: t.ownerType,
					ownerId: t.ownerId,
					topicId: t.topicId
				}, key = stable(row);
				if (keys.has(key)) throw fail("INVALID_SOURCE_SCOPE");
				keys.add(key);
				return row;
			}).sort((a, b) => stable(a) < stable(b) ? -1 : stable(a) > stable(b) ? 1 : 0)
		};
	}
	const scopeHash = (value) => {
		const s = normalizeScope(value);
		return s ? sha256(stable(s)) : null;
	};
	function permits(scope, d, owner = false) {
		const s = scope === null ? null : normalizeScope(scope);
		if (!s) return true;
		return s.topics.some((t) => t.ownerType === (d.ownerType || d.itemType || "agent") && t.ownerId === (d.ownerId || d.itemId) && (owner || t.topicId === d.topicId));
	}
	function expansion(previous, next) {
		const a = normalizeScope(previous), b = normalizeScope(next);
		if (a && !b && next?.mode === "full" && Object.keys(next).length === 1) return null;
		if (!a || !b || b.topics.length <= a.topics.length || a.topics.some((t) => !b.topics.some((n) => stable(n) === stable(t)))) throw fail("INVALID_SCOPE_EXPANSION");
		if (new Set(b.topics.map((t) => JSON.stringify([t.ownerId, t.topicId]).toLowerCase())).size !== b.topics.length) throw fail("OWNER_PATH_CONFLICT");
		return b;
	}
	return {
		normalizeScope,
		scopeHash,
		permits,
		expansion
	};
}
function submissionText({ topicKey, kind, payload }) {
	const canonical = kind === "message" ? {
		attachments: payload.attachments || [],
		requestId: payload.requestId,
		text: payload.text,
		...payload.model !== void 0 && { model: payload.model }
	} : {
		agentId: payload.agentId,
		requestId: payload.requestId
	};
	return JSON.stringify({
		kind,
		payload: canonical,
		topicKey
	});
}
const SHARED_SPACE_CAPABILITY = "shared-space-v1";
function sharedEffectiveRules(rules, overrides = {}) {
	return rules.map((rule) => ({
		...rule,
		enabled: Object.hasOwn(overrides, `${rule.source === "official" ? "official" : "user"}:${rule.id}`) ? overrides[`${rule.source === "official" ? "official" : "user"}:${rule.id}`] : rule.enabled !== false
	}));
}
function sharedAgentExecution(value) {
	return {
		temperature: 1,
		contextTokenLimit: 1e6,
		maxOutputTokens: 64e3,
		streamOutput: true,
		...value
	};
}
function sharedContextTransform(history, rules = [], currentId) {
	const turns = [];
	for (let i = history.length - 1; i >= 0; i--) {
		const m = history[i];
		if (m.role === "assistant") {
			const turn = [m];
			if (i > 0 && history[i - 1].role === "user") turn.push(history[--i]);
			turns.push(turn);
		} else if (m.role === "user") turns.push([m]);
	}
	const depths = /* @__PURE__ */ new Map();
	turns.forEach((turn, depth) => turn.forEach((m) => {
		if (m.id) depths.set(m.id, depth);
	}));
	const compiled = rules.filter((r) => r && r.enabled !== false && r.applyToContext && r.findPattern).map((rule) => {
		const text = rule.findPattern, last = text.lastIndexOf("/");
		let regex = null;
		if (text.startsWith("/") && last > 0) try {
			regex = new RegExp(text.slice(1, last), text.slice(last + 1));
		} catch {}
		return {
			rule,
			regex
		};
	});
	return (text, message) => {
		if (typeof text !== "string" || message.id === currentId || message.role === "user" && message.contextCompaction?.kind === "vchat-context-checkpoint" && message.contextCompaction?.version === 1 || !depths.has(message.id)) return text;
		const depth = depths.get(message.id);
		for (const { rule, regex } of compiled) if (regex && rule.applyToRoles?.includes(message.role) && (rule.minDepth === void 0 || rule.minDepth === -1 || depth >= rule.minDepth) && (rule.maxDepth === void 0 || rule.maxDepth === -1 || depth <= rule.maxDepth)) {
			regex.lastIndex = 0;
			text = text.replace(regex, rule.replaceWith || "");
		}
		return text;
	};
}
function sharedIdentity(value) {
	if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,96}$/.test(value)) throw Object.assign(Error("INVALID_SHARED_IDENTITY"), {
		code: "INVALID_SHARED_IDENTITY",
		status: 400
	});
	return value;
}
function sharedConfig(kind, value) {
	const fail = () => {
		throw Object.assign(Error("INVALID_SHARED_CONFIG"), {
			code: "INVALID_SHARED_CONFIG",
			status: 400
		});
	};
	const object = (v) => v && typeof v === "object" && !Array.isArray(v);
	const fields = {
		agent: [
			"name",
			"avatar",
			"systemPrompt",
			"model",
			"temperature",
			"contextTokenLimit",
			"maxOutputTokens",
			"streamOutput",
			"stripRegexes",
			"tavernRules",
			"ruleOverrides"
		],
		group: [
			"name",
			"avatar",
			"members",
			"mode",
			"memberTags",
			"groupPrompt",
			"invitePrompt",
			"useUnifiedModel",
			"unifiedModel",
			"enableContextMessageWindow",
			"contextMessageWindowSize",
			"tagMatchMode",
			"modeSettings",
			"sequentialSpeakerOrder",
			"tavernRules",
			"ruleOverrides"
		],
		rules: [
			"name",
			"tavernRules",
			"executionPolicy"
		],
		topic: ["name", "archived"]
	};
	if (!fields[kind] || !object(value) || Object.keys(value).some((k) => !fields[kind].includes(k)) || typeof value.name !== "string" || !value.name.trim() || value.name.length > 500) fail();
	const sequential = kind === "group" && value.mode === "sequential";
	const planLists = sequential ? [
		value.members,
		value.sequentialSpeakerOrder,
		value.modeSettings?.sequential?.speakerOrder
	] : [];
	const walk = (v, depth = 0) => {
		if (depth > 12) fail();
		if (v === null || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v)) return;
		if (typeof v === "string") {
			if (v.length > 128e3) fail();
			return;
		}
		if (Array.isArray(v)) {
			if (v.length > 1e3 && !planLists.includes(v)) fail();
			for (const x of v) walk(x, depth + 1);
			return;
		}
		if (!object(v) || Object.keys(v).length > 200 || Object.keys(v).some((k) => [
			"__proto__",
			"constructor",
			"prototype"
		].includes(k))) fail();
		for (const x of Object.values(v)) walk(x, depth + 1);
	};
	walk(value);
	if (value.ruleOverrides !== void 0 && (!object(value.ruleOverrides) || Object.entries(value.ruleOverrides).some(([key, v]) => !/^(official|user):[^\x00-\x1f]{1,200}$/.test(key) || typeof v !== "boolean"))) fail();
	if (JSON.stringify(value).length > 256e3) fail();
	if (value.avatar != null && (typeof value.avatar !== "string" || value.avatar.length > 24e3 || !/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(value.avatar))) fail();
	for (const key of [
		"streamOutput",
		"archived",
		"useUnifiedModel",
		"enableContextMessageWindow"
	]) if (value[key] !== void 0 && typeof value[key] !== "boolean") fail();
	if (kind === "agent") {
		if (typeof value.systemPrompt !== "string" || typeof value.model !== "string" || !value.model.trim() || value.model.length > 200) fail();
		for (const [key, min, max] of [
			[
				"temperature",
				0,
				2
			],
			[
				"contextTokenLimit",
				1,
				2e6
			],
			[
				"maxOutputTokens",
				1,
				2e6
			]
		]) if (value[key] !== void 0 && (!Number.isFinite(value[key]) || value[key] < min || value[key] > max || key !== "temperature" && !Number.isSafeInteger(value[key]))) fail();
		if (value.stripRegexes !== void 0) {
			const keys = [
				"id",
				"title",
				"findPattern",
				"replaceWith",
				"enabled",
				"applyToRoles",
				"applyToFrontend",
				"applyToContext",
				"minDepth",
				"maxDepth"
			];
			if (!Array.isArray(value.stripRegexes) || value.stripRegexes.length > 200 || value.stripRegexes.some((r) => !object(r) || Object.keys(r).some((k) => !keys.includes(k)) || typeof r.findPattern !== "string" || typeof r.replaceWith !== "string" || r.applyToRoles !== void 0 && (!Array.isArray(r.applyToRoles) || r.applyToRoles.some((role) => ![
				"user",
				"assistant",
				"system"
			].includes(role))) || [
				"enabled",
				"applyToFrontend",
				"applyToContext"
			].some((k) => r[k] !== void 0 && typeof r[k] !== "boolean") || ["minDepth", "maxDepth"].some((k) => r[k] !== void 0 && (!Number.isSafeInteger(r[k]) || r[k] < -1 || r[k] > 1e4)))) fail();
		}
	}
	if (kind === "group") {
		if (![
			"sequential",
			"naturerandom",
			"invite_only",
			"jev",
			"game"
		].includes(value.mode) || !Array.isArray(value.members) || !sequential && value.members.length > 32 || new Set(value.members).size !== value.members.length) fail();
		value.members.forEach(sharedIdentity);
		for (const key of [
			"groupPrompt",
			"invitePrompt",
			"unifiedModel"
		]) if (value[key] !== void 0 && typeof value[key] !== "string") fail();
		if (value.useUnifiedModel && !value.unifiedModel?.trim()) fail();
		if (value.contextMessageWindowSize !== void 0 && (!Number.isSafeInteger(value.contextMessageWindowSize) || value.contextMessageWindowSize < 1 || value.contextMessageWindowSize > 1e4)) fail();
		if (value.memberTags !== void 0 && (!object(value.memberTags) || Object.entries(value.memberTags).some(([k, v]) => !value.members.includes(k) || typeof v !== "string"))) fail();
		const memberIds = new Set(value.members);
		for (const order of [value.sequentialSpeakerOrder, value.modeSettings?.sequential?.speakerOrder]) if (order !== void 0 && (!Array.isArray(order) || !sequential && order.length > 1e3 || order.some((id) => !memberIds.has(id)))) fail();
	}
	if (value.tavernRules !== void 0) {
		const allowed = [
			"id",
			"name",
			"type",
			"enabled",
			"content",
			"scope",
			"builtinKey",
			"isBuiltin",
			"role",
			"depth",
			"wrap",
			"order",
			"source"
		];
		if (!Array.isArray(value.tavernRules) || value.tavernRules.length > 200 || value.tavernRules.some((r) => !object(r) || Object.keys(r).some((k) => !allowed.includes(k)) || ![
			"system_suffix",
			"user_suffix",
			"context_inject"
		].includes(r.type) || typeof r.content !== "string" || r.enabled !== void 0 && typeof r.enabled !== "boolean" || r.type === "context_inject" && (!["user", "assistant"].includes(r.role) || !Number.isSafeInteger(r.depth) || r.depth < 0 || r.depth > 1e4))) fail();
	}
	if (value.executionPolicy !== void 0) {
		const p = value.executionPolicy, flags = [
			"enableThoughtChainInjection",
			"enableContextSanitizer",
			"enableVcpToolInjection",
			"enableContextCompaction"
		];
		const models = ["contextCompactionModel", "contextCompactionFallbackModel"];
		if (!object(p) || Object.keys(p).some((k) => ![
			"userName",
			"contextSanitizerDepth",
			...flags,
			...models
		].includes(k)) || flags.some((k) => p[k] !== void 0 && typeof p[k] !== "boolean") || models.some((k) => p[k] !== void 0 && (typeof p[k] !== "string" || p[k].length > 200)) || p.userName !== void 0 && (typeof p.userName !== "string" || p.userName.length > 200) || p.contextSanitizerDepth !== void 0 && (!Number.isSafeInteger(p.contextSanitizerDepth) || p.contextSanitizerDepth < 0 || p.contextSanitizerDepth > 1e4)) fail();
	}
	return JSON.parse(JSON.stringify(value));
}
function sharedSnapshotPrompt(config, fallback = "") {
	if (config.promptPolicy !== "native-alias-snapshot") return config.systemPrompt || fallback;
	if (typeof config.agentAlias !== "string" || !config.agentAlias || typeof config.systemPrompt !== "string" || !config.systemPrompt) throw Object.assign(Error("CONFIG_PROMPT_SNAPSHOT_UNAVAILABLE"), { code: "CONFIG_PROMPT_SNAPSHOT_UNAVAILABLE" });
	const alias = config.agentAlias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp("\\{\\{(?:agent:)?" + alias + "\\}\\}", "g");
	let replaced = 0;
	const result = (config.promptTemplate || "{{agent:" + config.agentAlias + "}}").replace(pattern, () => {
		replaced++;
		return config.systemPrompt;
	});
	if (!replaced) throw Object.assign(Error("CONFIG_PROMPT_AUTHORITY_CONFLICT"), { code: "CONFIG_PROMPT_AUTHORITY_CONFLICT" });
	return result;
}

export { SHARED_SPACE_CAPABILITY, createMetadata, createProtocol, createSourceScope, sharedAgentExecution, sharedConfig, sharedContextTransform, sharedEffectiveRules, sharedIdentity, sharedSnapshotPrompt, submissionText };
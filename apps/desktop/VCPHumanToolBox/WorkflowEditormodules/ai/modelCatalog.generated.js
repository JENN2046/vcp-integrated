// Generated during release assembly; source SHA256 bdd31e14bc686294cccf38105b5261d25a3e2ce79cba26226bfa9445ddd473ba
var VCPChatModelCatalog = (function(exports) {
	Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
	// packages/sync-contracts/src/chatModelCatalog.mjs
	const embeddingCapability = /^(?:(?:\/?v1\/)?embeddings?|embed|text[-_ ]embeddings?|feature[-_ ]extraction|vector(?:ization)?)$/i;
	const chatCapability = /^(?:(?:\/?v1\/)?chat(?:[-_ /]completions?)?|(?:\/?v1\/)?completions?|text[-_ ]generation|generate[-_ ]content|responses)$/i;
	const namedEmbedding = /(?:^|[._:-])(?:embed|embeddings?)(?:[._:-]|$)|^(?:bge-(?:m3|small|base|large)|(?:multilingual-)?e5-(?:small|base|large|mistral)|gte-(?:small|base|large|multilingual|qwen)|(?:all|paraphrase)-minilm)(?:[._:-]|$)/i;
	function filterChatModels(models, knownEmbeddingIds = []) {
		const known = new Set(knownEmbeddingIds);
		return models.filter((model) => {
			const id = typeof model === "string" ? model : model?.id;
			if (typeof id !== "string") return true;
			const capabilities = model?.capabilities;
			const endpoints = model?.supported_endpoints || model?.supported_endpoint_types;
			const tags = [
				model?.type,
				model?.mode,
				model?.task,
				model?.object,
				...Array.isArray(capabilities) ? capabilities : Object.keys(capabilities || {}).filter((key) => capabilities[key] === true),
				...Array.isArray(endpoints) ? endpoints : []
			].filter((tag) => typeof tag === "string").map((tag) => tag.trim());
			if (tags.some((tag) => chatCapability.test(tag))) return true;
			return !known.has(id) && !tags.some((tag) => embeddingCapability.test(tag)) && !namedEmbedding.test(id.split("/").at(-1));
		});
	}
	exports.filterChatModels = filterChatModels;
	return exports;
})({});

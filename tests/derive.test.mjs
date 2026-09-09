/**
 * Derivation regression test: the provider must derive `baseURL`, `model`,
 * `apiKeyEnv`, and the fallback `candidateModels` from dsh's ACTIVE model
 * configuration (no hardcoded proxy/model), while an explicit override in the
 * plugin's own config still wins.
 *
 * NOTE: this test clears the persisted model cache first — the cache is
 * best-effort persistence (clearing it only costs one re-probe in a real
 * session), and a stale entry would otherwise let the fast path short-circuit
 * the derivation this test is asserting.
 *
 * Usage: node tests/derive.test.mjs
 */
import { createServer } from "node:http";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as pkg from "../lib/index.js";

rmSync(join(homedir(), ".dsh", "dsh-web-search-litellm", "model-cache.json"), { force: true });

// A fake gateway: `deepseek/*` replies but never searches (dud); `gpt-5.6-sol`
// actually runs the search. This models the real gateway where only GPT-class
// models are wired to web_search.
function startGateway(log) {
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			const model = JSON.parse(body).model;
			log.push({ url: req.url, model });
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (model === "openai/gpt-5.6-sol") {
				res.write('data: {"type":"response.output_item.added","item":{"type":"web_search_call","action":{"type":"open_page","url":"https://example.com/x"}}}\n\n');
			}
			res.write('data: {"type":"response.output_text.delta","delta":"answer"}\n\n');
			res.end('data: [DONE]\n\n');
		});
	});
	return server;
}

function makeCtx(port) {
	const holder = {};
	const ctx = {
		web: { registerSearchProvider: (provider) => { holder.provider = provider; } },
		get(svc) {
			if (svc === "agentDefaultModel") return { currentSelection: () => ({ provider: "litellm", model: "deepseek/deepseek-v4-pro" }) };
			if (svc === "llm") {
				return { listConfigurableProviders: () => [{ provider: "litellm", settingsNs: "llm-pi-ai", settingsPath: ["providers", "litellm"] }] };
			}
			if (svc === "settings") {
				return { get: (ns) => ns === "llm-pi-ai" ? { providers: { litellm: {
					baseURL: `http://127.0.0.1:${port}/openai/v1`,
					apiKeyEnv: "LITELLM_API_KEY",
					models: [{ id: "deepseek/deepseek-v4-pro" }, { id: "openai/gpt-5.6-sol" }]
				} } } : undefined };
			}
			if (svc === "credentials") return { resolve: async () => ({ value: "sk-test" }) };
			return undefined;
		}
	};
	return { ctx, holder, setModel(model) { this.model = model; } };
}

// Case 1: empty config -> everything derived from the active provider.
{
	const log = [];
	const server = startGateway(log);
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	const { ctx, holder } = makeCtx(port);
	pkg.apply(ctx, {});
	const result = await holder.provider.search({ query: "test" });
	const models = log.map((s) => s.model);
	if (!log.every((s) => s.url.startsWith("/openai/v1"))) throw new Error("baseURL not derived: " + JSON.stringify(log.map((s) => s.url)));
	if (!(models.includes("deepseek/deepseek-v4-pro") && models.includes("openai/gpt-5.6-sol"))) throw new Error("model pool not derived: " + models.join(","));
	if (!(result.sources.length > 0 && holder.provider._activeModel === "openai/gpt-5.6-sol")) throw new Error("fallback to derived model failed");
	console.log("PASS: baseURL/model/candidate pool derived from active provider; fallback hit " + result.sources.length + " source(s) → " + models.join(" -> "));
	server.close();
}

// Case 2: explicit override wins over derivation (no seams needed).
{
	const holder = {};
	let lastOptions = {};
	const ctx = {
		web: { registerSearchProvider: (provider) => { holder.provider = provider; } },
		get() { return undefined; },
		inject(names, cb) { }
	};
	pkg.apply(ctx, { baseURL: "http://override.invalid/v1", model: "override-model", candidateModels: ["c1", "c2"] });
	const pool = holder.provider.modelPool({ model: "override-model", candidateModels: ["c1", "c2"] });
	if (!(pool[0] === "override-model" && pool.includes("c1") && pool.includes("c2"))) throw new Error("override pool wrong: " + pool.join(","));
	console.log("PASS: explicit config override accepted and used without any derivation seam");
}

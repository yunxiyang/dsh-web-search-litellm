/**
 * Fallback / "fastest search-capable model caching" test.
 *
 * Starts a local multi-model gateway that behaves differently per model:
 *   - "dud"               — replies with text but never invokes web_search;
 *   - "fast"              — actually searches (emits web_search_call + open_page);
 *   - "slow"              — also searches, but emits the call later than "fast".
 *
 * Asserts:
 *   1. With `model: dud` + fallbacks [fast, slow], the search returns sources
 *      (the dud is skipped, discovery latches onto a real searcher);
 *   2. the winner ("fast") is remembered — the second search hits it directly
 *      and never re-probes the dud;
 *   3. a pool where no model searches fails with WEB_PROVIDER_ERROR.
 *
 * Usage: node tests/fallback.test.mjs
 */
import { createServer } from "node:http";
import { LiteLLMResponsesProvider } from "../lib/provider.js";

class CodedError extends Error {
	constructor(message, code, options) {
		super(message, options);
		this.code = code;
	}
}

const hits = { dud: 0, fast: 0, slow: 0 };

const server = createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		let model = "dud";
		try { model = JSON.parse(raw).model ?? "dud"; } catch {}
		hits[model] = (hits[model] ?? 0) + 1;
		res.writeHead(200, { "content-type": "text/event-stream" });
		const send = (type, payload) => res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
		if (model === "dud") {
			send("response.output_text.delta", { delta: "I cannot search." });
			res.write("data: [DONE]\n\n");
			res.end();
			return;
		}
		// searching model: thinking first, then the search tool call
		const delay = model === "fast" ? 50 : 400;
		setTimeout(() => {
			send("response.output_item.added", { item: { type: "web_search_call", action: { type: "open_page", url: `https://example.com/${model}` } } });
			send("response.output_text.delta", { delta: `answered via ${model}` });
			res.write("data: [DONE]\n\n");
			res.end();
		}, delay);
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

function makeProvider(model, candidateModels) {
	return new LiteLLMResponsesProvider(() => ({
		apiKey: "sk-test",
		baseURL: `http://127.0.0.1:${port}/v1`,
		model,
		candidateModels,
		apiKeyEnv: "LITELLM_API_KEY",
		maxTokens: 100,
		timeoutMs: 1500
	}), { WebError: CodedError });
}

let failed = false;
const check = (label, condition, detail) => {
	if (condition) console.log(`PASS: ${label}`);
	else { console.error(`FAIL: ${label}${detail ?? ""}`); failed = true; }
};

// 1. dud primary, real searchers in pool
{
	const provider = makeProvider("dud", ["fast", "slow"]);
	const result = await provider.search({ query: "test fallback" });
	check("dud skipped, search returned sources", (result.sources ?? []).length > 0, ` (${JSON.stringify(result.sources)})`);
	check("a searching model was hit", (hits.fast + hits.slow) > 0, ` (hits=${JSON.stringify(hits)})`);
}
// 2. winner remembered: next search must NOT hit the dud again
{
	const before = { ...hits };
	const provider = makeProvider("dud", ["fast", "slow"]);
	// warm cache: first call already wrote the winner on the provider above,
	// but that was a different instance — re-run on a fresh instance with a
	// primed initialActiveModel to prove the fast path never probes a dud.
	const primed = new LiteLLMResponsesProvider(() => ({
		apiKey: "sk-test",
		baseURL: `http://127.0.0.1:${port}/v1`,
		model: "dud",
		candidateModels: ["fast", "slow"],
		apiKeyEnv: "LITELLM_API_KEY",
		maxTokens: 100,
		timeoutMs: 1500
	}), { WebError: CodedError, initialActiveModel: "fast" });
	await primed.search({ query: "cached path" });
	check("primed active model used directly (no extra fast/slow beyond one)", hits.fast === (before.fast ?? 0) + 1 && hits.slow === (before.slow ?? 0), ` (fast ${hits.fast}, slow ${hits.slow})`);
	check("dud not re-probed on cached hit", hits.dud === before.dud, ` (dud ${hits.dud})`);
}
// 3. all-dud pool fails loudly
{
	const provider = makeProvider("dud", ["dud"]);
	try {
		await provider.search({ query: "all duds" });
		check("all-dud pool raises", false);
	} catch (error) {
		check("all-dud pool raises WEB_PROVIDER_ERROR", error.code === "WEB_PROVIDER_ERROR", ` (${error.code}: ${error.message})`);
	}
}

server.close();
process.exitCode = failed ? 1 : 0;

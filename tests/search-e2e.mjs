/**
 * Standalone end-to-end test for the zero-dependency provider core.
 *
 * Usage:
 *   LITELLM_API_KEY=sk-... \
 *   LITELLM_SEARCH_BASE_URL=http://127.0.0.1:4000/v1 \
 *   node tests/search-e2e.mjs "some query"
 *
 * Prints the returned sources and a short answer head, exits non-zero on
 * failure. No harness required.
 */
import { LiteLLMResponsesProvider } from "../lib/provider.js";

const query = process.argv[2] ?? "DeepSeek V4 release date";
const apiKey = process.env.LITELLM_API_KEY;
const baseURL = process.env.LITELLM_SEARCH_BASE_URL ?? "http://127.0.0.1:4000/v1";
if (apiKey === void 0 || apiKey.length === 0) {
	console.error("LITELLM_API_KEY is not set");
	process.exit(1);
}
const provider = new LiteLLMResponsesProvider(() => ({
	apiKey,
	baseURL,
	model: process.env.LITELLM_SEARCH_MODEL ?? "openai/deepseek-v4-flash",
	apiKeyEnv: "LITELLM_API_KEY",
	maxTokens: 1200,
	timeoutMs: 60000
}));
console.error(`searching "${query}" via ${baseURL} ...`);
try {
	const result = await provider.search({ query });
	console.log(`sources (${result.sources.length}):`);
	for (const source of result.sources) console.log("  -", source.url);
	if (result.content !== void 0) {
		console.log("answer head:", result.content.slice(0, 160).replace(/\n+/g, " "));
	}
	if (result.sources.length === 0) {
		console.error("no sources returned");
		process.exit(1);
	}
} catch (error) {
	console.error("search failed:", error.message);
	process.exit(1);
}

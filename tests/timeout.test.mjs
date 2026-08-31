/**
 * Reproducible timeout test: starts a local HTTP server that never responds
 * and asserts the provider fails with a structured WEB_TIMEOUT error.
 *
 * Usage: node tests/timeout.test.mjs
 */
import { createServer } from "node:http";
import { LiteLLMResponsesProvider } from "../lib/provider.js";

class CodedError extends Error {
	constructor(message, code, options) {
		super(message, options);
		this.code = code;
	}
}

const server = createServer(() => {}); // hangs forever
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const provider = new LiteLLMResponsesProvider(() => ({
	apiKey: "sk-test",
	baseURL: `http://127.0.0.1:${port}/v1`,
	model: "openai/deepseek-v4-flash",
	apiKeyEnv: "LITELLM_API_KEY",
	maxTokens: 100,
	timeoutMs: 1000
}), { WebError: CodedError });
try {
	await provider.search({ query: "this must time out" });
	console.error("FAIL: expected a timeout");
	process.exitCode = 1;
} catch (error) {
	if (error.code === "WEB_TIMEOUT") {
		console.log("PASS:", error.message);
	} else {
		console.error("FAIL: unexpected error", error.code, error.message);
		process.exitCode = 1;
	}
} finally {
	server.close();
}

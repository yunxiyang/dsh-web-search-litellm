/**
 * Idle-timeout regression test: a slow-but-steadily-streaming response must
 * complete even though the total duration far exceeds `timeoutMs` — the
 * deadline resets on every chunk, so only CONNECT hangs and data GAPS abort.
 *
 * Usage: node tests/idle.test.mjs
 */
import { createServer } from "node:http";
import { LiteLLMResponsesProvider } from "../lib/provider.js";

class CodedError extends Error {
	constructor(message, code, options) {
		super(message, options);
		this.code = code;
	}
}

const TIMEOUT_MS = 1500;
const server = createServer((req, res) => {
	res.writeHead(200, { "content-type": "text/event-stream" });
	res.write('data: {"type":"response.output_text.delta","delta":"drip "}\n\n');
	// one chunk every 700ms for 6s — 4x TIMEOUT_MS overall, but no gap
	// between chunks ever reaches TIMEOUT_MS, so the idle deadline resets.
	let remaining = 10;
	const drip = setInterval(() => {
		if (--remaining > 0) {
			res.write('data: {"type":"response.output_text.delta","delta":"drip "}\n\n');
		} else {
			res.write('data: [DONE]\n\n');
			res.end();
			clearInterval(drip);
		}
	}, 700);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const provider = new LiteLLMResponsesProvider(() => ({
	apiKey: "sk-test",
	baseURL: `http://127.0.0.1:${port}/v1`,
	model: "openai/deepseek-v4-flash",
	apiKeyEnv: "LITELLM_API_KEY",
	maxTokens: 100,
	timeoutMs: TIMEOUT_MS
}), { WebError: CodedError });
try {
	const started = Date.now();
	const result = await provider.search({ query: "drip test" });
	const elapsed = Date.now() - started;
	if (elapsed < 3000) {
		console.error(`FAIL: finished too fast (${elapsed}ms)`);
		process.exitCode = 1;
	} else if (/drip/.test(result.content ?? "")) {
		console.log(`PASS: slow stream completed in ${elapsed}ms (idle deadline reset on every chunk)`);
	} else {
		console.error("FAIL: missing dripped content");
		process.exitCode = 1;
	}
} catch (error) {
	console.error(`FAIL: ${error.code} ${error.message}`);
	process.exitCode = 1;
} finally {
	server.close();
}

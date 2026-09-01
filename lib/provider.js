/**
 * Zero-dependency provider core for the LiteLLM Responses API web search
 * provider. Calls `POST {baseURL}/responses` with the server-side `web_search`
 * tool — executed natively by the upstream DeepSeek Responses API through a
 * LiteLLM proxy — and reuses the proxy's API key. OpenAI Responses protocol
 * only: no Anthropic API, no third-party search service.
 *
 * DeepSeek's Responses API documents `include` as unsupported, so structured
 * result items are consumed server-side and are not echoed back. The model's
 * grounded final answer is returned as `content`, and the real URLs the model
 * chose to open (`web_search_call` items whose action is `open_page`) are
 * returned as `sources` (URL only, no title/snippet — the upstream API does
 * not expose them).
 *
 * This module has no imports so it can be exercised standalone; the harness
 * integration layer (index.js) injects the host's `WebError` class for
 * structured error codes.
 *
 * @module dsh-web-search-litellm/provider
 */

/** Stable id this provider registers under. */
const PROVIDER_ID = "litellm-responses";
/** Default LiteLLM proxy root (`/responses` is appended). */
const DEFAULT_BASE_URL = "http://127.0.0.1:4000/v1";
/** Default model routed through the proxy (DeepSeek, OpenAI-compatible id). */
const DEFAULT_MODEL = "openai/deepseek-v4-flash";
/** Credential reference shared with the chat Models page. */
const DEFAULT_API_KEY_ENV = "LITELLM_API_KEY";
/** Default max_output_tokens for one search request (search + grounded answer). */
const DEFAULT_MAX_TOKENS = 4096;
/** Default per-request timeout; `AbortSignal.timeout` aborts as WEB_TIMEOUT. */
const DEFAULT_TIMEOUT_MS = 60000;
/** Environment variable naming this provider's endpoint override. */
const BASE_URL_ENV = "LITELLM_SEARCH_BASE_URL";
/** Node builtin — no third-party dependency — used only to read the package version. */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const PACKAGE_VERSION = require("../package.json").version ?? "0.1.0";
/** Attribution header sent on every request; version tracks package.json. */
const USER_AGENT = `deepseek-harness/dsh-web-search-litellm/${PACKAGE_VERSION}`;

function isPositiveInteger(value) {
	return Number.isInteger(value) && value > 0;
}

function isAbortError(error) {
	return error instanceof DOMException && error.name === "AbortError";
}

/** Internal marker: an idle-read deadline fired while streaming the body. */
class IdleTimeoutError extends Error {}

/** Internal marker: the connect-phase deadline fired before any headers. */
class ConnectTimeoutError extends Error {}

/** Strip a fragment (e.g. `#ws_call_id=…`) without failing on unparsable input. */
function cleanUrl(raw) {
	try {
		const url = new URL(raw);
		url.hash = "";
		return url.toString();
	} catch {
		return raw;
	}
}

/**
 * Collect URLs the model opened during the search turn. These are the only
 * URLs the DeepSeek Responses API exposes client-side: `web_search_call`
 * items whose `action` is `open_page`. Deduping happens in `sink`.
 */
function collectOpenPages(items, sink) {
	for (const item of items ?? []) {
		if (item?.type === "web_search_call" && item.action?.type === "open_page" && typeof item.action.url === "string" && item.action.url.length > 0) {
			sink.add(cleanUrl(item.action.url));
		}
	}
}

/** Join message content text from output items (non-stream shape). */
function messageText(items) {
	let text = "";
	for (const item of items ?? []) {
		if (item?.type !== "message") continue;
		for (const block of item.content ?? []) {
			if ((block.type === "output_text" || block.type === "text") && typeof block.text === "string") text += block.text;
		}
	}
	return text.trim();
}

/**
 * Parse a text/event-stream body. Collects `output_text.delta` text, any
 * `web_search_call` item the model opened pages through, and the failure
 * reason on `response.failed`. On the terminal event the full response object
 * is used as a fallback for both URLs and text.
 */
function parseStreamBody(raw) {
	const sink = { urls: /* @__PURE__ */ new Set(), answer: "", failure: void 0 };
	let terminalOutput;
	for (const line of raw.split(/\r?\n/)) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (payload.length === 0 || payload === "[DONE]") continue;
		let event;
		try {
			event = JSON.parse(payload);
		} catch {
			continue;
		}
		switch (event.type) {
			case "response.output_text.delta":
				if (typeof event.delta === "string") sink.answer += event.delta;
				break;
			case "response.output_item.added":
			case "response.output_item.done":
				collectOpenPages([event.item], sink.urls);
				break;
			case "response.failed":
				sink.failure = event.response?.error?.message ?? event.error?.message ?? "response.failed";
				break;
			case "response.completed":
			case "response.incomplete":
				terminalOutput = event.response?.output;
				break;
		}
	}
	if (terminalOutput !== void 0) collectOpenPages(terminalOutput, sink.urls);
	if (sink.answer.trim().length === 0 && terminalOutput !== void 0) sink.answer = messageText(terminalOutput);
	sink.answer = sink.answer.trim();
	return sink;
}

/** Parse a plain JSON (non-stream) body. */
function parseJsonBody(data) {
	const sink = { urls: /* @__PURE__ */ new Set(), answer: "", failure: void 0 };
	if (typeof data !== "object" || data === null) {
		sink.failure = "unprocessable response body";
		return sink;
	}
	if (data.error != null) sink.failure = typeof data.error === "string" ? data.error : data.error?.message ?? "provider error";
	collectOpenPages(data.output, sink.urls);
	sink.answer = messageText(data.output);
	return sink;
}

/**
 * The LiteLLM-backed search provider; one Responses API call per search.
 * HTTP redirects fail as provider errors. `WebError` defaults to `Error` so
 * this core stays import-free; the harness layer injects the seam's typed
 * error for machine-routable codes.
 */
class LiteLLMResponsesProvider {
	resolveOptions;
	WebError;
	id = PROVIDER_ID;
	/**
	 * @param resolveOptions - the options for the NEXT operation, snapshotted
	 * once at each operation's entry so one search never mixes two configs.
	 * @param options - provider behavior: `options.WebError` is the error class
	 * used for structured failures (message, code, { cause } signature).
	 */
	constructor(resolveOptions, options = {}) {
		this.resolveOptions = resolveOptions;
		this.WebError = options.WebError ?? Error;
	}
	fail(message, code = "WEB_PROVIDER_ERROR", cause) {
		return cause === void 0 ? new this.WebError(message, code) : new this.WebError(message, code, { cause });
	}
	available() {
		const options = this.resolveOptions();
		return URL.canParse(options.baseURL) && isPositiveInteger(options.maxTokens) && (options.apiKey !== void 0 && options.apiKey.length > 0 || options.resolveApiKey !== void 0);
	}
	async search(request, signal) {
		const options = this.resolveOptions();
		if (signal?.aborted === true) throw this.fail("litellm web search aborted", "WEB_ABORTED", signal.reason);
		const apiKey = await this.apiKey(options, signal);
		if (signal?.aborted === true) throw this.fail("litellm web search aborted", "WEB_ABORTED", signal.reason);
		const body = {
			model: options.model,
			input: `Perform a web search for the query: ${request.query}. Open the most relevant result pages, then answer. End your answer with a "Sources:" list of every page URL you opened.`,
			tools: [{ type: "web_search" }],
			stream: true,
			max_output_tokens: options.maxTokens
		};
		options.recordRequest?.({
			endpoint: `${options.baseURL}/responses`,
			body
		});
		let response;
		// CONNECT phase: `timeoutMs` bounds the wait for response headers only.
		// The controller aborts the pending request if the deadline wins; the
		// timer is cleared the moment headers arrive, so a long-lived streaming
		// body is never subject to this wall clock (the body gets an
		// idle-resetting deadline in `readBody` instead). The caller's signal
		// stays attached for the whole request, as it must.
		const connectController = new AbortController();
		let connectTimer;
		try {
			response = await Promise.race([
				fetch(`${options.baseURL}/responses`, {
					method: "POST",
					redirect: "error",
					headers: {
						authorization: `Bearer ${apiKey}`,
						"content-type": "application/json",
						accept: "text/event-stream",
						"user-agent": USER_AGENT
					},
					body: JSON.stringify(body),
					...signal !== void 0 ? { signal: AbortSignal.any([signal, connectController.signal]) } : { signal: connectController.signal }
				}),
				new Promise((_, reject) => {
					connectTimer = setTimeout(() => reject(new ConnectTimeoutError()), options.timeoutMs);
				})
			]);
		} catch (error) {
			clearTimeout(connectTimer);
			if (error instanceof ConnectTimeoutError) {
				connectController.abort();
				throw this.fail(`litellm web search timed out: no response headers within ${options.timeoutMs}ms`, "WEB_TIMEOUT", error);
			}
			if (signal?.aborted === true) throw this.fail("litellm web search aborted", "WEB_ABORTED", signal?.reason ?? error);
			if (isAbortError(error)) throw this.fail("litellm web search aborted", "WEB_ABORTED", signal?.reason ?? error);
			throw this.fail(`litellm web search request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", error);
		}
		clearTimeout(connectTimer);
		if (!response.ok) {
			let message = `litellm web search error (HTTP ${response.status})`;
			try {
				const parsed = await response.json();
				const detail = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message;
				if (detail !== void 0 && String(detail).length > 0) message = String(detail);
			} catch (error) {
				if (signal?.aborted === true || isAbortError(error)) throw this.fail("litellm web search aborted", "WEB_ABORTED", signal?.reason ?? error);
			}
			throw this.fail(message);
		}
		const raw = await this.readBody(response, options.timeoutMs, signal);
		const contentType = response.headers.get("content-type") ?? "";
		let parsed;
		if (contentType.includes("text/event-stream")) {
			parsed = parseStreamBody(raw);
		} else {
			try {
				parsed = parseJsonBody(JSON.parse(raw));
			} catch {
				throw this.fail("litellm web search returned an unprocessable response body");
			}
		}
		if (parsed.failure !== void 0) throw this.fail(`litellm web search failed: ${parsed.failure}`);
		const sources = [...parsed.urls].map((url) => ({ url }));
		if (sources.length === 0 && parsed.answer.length === 0) {
			throw this.fail("litellm web search returned no sources and no answer; the request may not have triggered native web search");
		}
		return {
			sources,
			truncated: false,
			...parsed.answer.length > 0 ? { content: parsed.answer } : {}
		};
	}
	/**
	 * Read the response body with an IDLE timeout rather than a total wall
	 * clock: the deadline resets every time a chunk arrives, so a slow but
	 * steadily streaming search is never killed mid-stream. `timeoutMs` still
	 * bounds the connect phase (see `search`) and any gap with no data.
	 * Every throw is a structured WebError.
	 */
	async readBody(response, timeoutMs, signal) {
		const body = response.body;
		if (body == null) {
			try {
				return await response.text();
			} catch (error) {
				if (signal?.aborted === true || isAbortError(error)) throw this.fail("litellm web search aborted", "WEB_ABORTED", signal?.reason ?? error);
				throw this.fail(`litellm web search could not read the response: ${String(error)}`, "WEB_PROVIDER_ERROR", error);
			}
		}
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let text = "";
		try {
			for (;;) {
				if (signal?.aborted === true) throw this.fail("litellm web search aborted", "WEB_ABORTED", signal.reason);
				let idleTimer;
				let read;
				try {
					read = await Promise.race([reader.read(), new Promise((_, reject) => {
						idleTimer = setTimeout(() => reject(new IdleTimeoutError()), timeoutMs);
					})]);
				} finally {
					clearTimeout(idleTimer);
				}
				if (read.done) break;
				text += decoder.decode(read.value, { stream: true });
			}
			text += decoder.decode();
			return text;
		} catch (error) {
			await reader.cancel().catch(() => {});
			if (error instanceof IdleTimeoutError) throw this.fail(`litellm web search timed out: no response data for ${timeoutMs}ms`, "WEB_TIMEOUT", error);
			if (error instanceof this.WebError) throw error;
			if (signal?.aborted === true || isAbortError(error)) throw this.fail("litellm web search aborted", "WEB_ABORTED", signal?.reason ?? error);
			throw this.fail(`litellm web search could not read the response: ${String(error)}`, "WEB_PROVIDER_ERROR", error);
		}
	}
	/**
	 * Resolve one operation's credential without retaining it on the provider:
	 * the literal config key wins, then the resolver thunk (credentials service
	 * or process environment, provided by the integration layer).
	 */
	async apiKey(options, signal) {
		if (signal?.aborted === true) throw this.fail("litellm web search aborted", "WEB_ABORTED", signal.reason);
		if (options.apiKey !== void 0 && options.apiKey.length > 0) return options.apiKey;
		let resolved;
		try {
			resolved = await options.resolveApiKey?.();
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw this.fail("litellm web search aborted", "WEB_ABORTED", signal?.reason ?? error);
			throw this.fail(`litellm web search credential resolution failed: ${String(error)}`, "WEB_PROVIDER_ERROR", error);
		}
		if (resolved !== void 0 && resolved.length > 0) return resolved;
		throw this.fail(`litellm web search has no API key for "${options.apiKeyEnv}"; store it through the credentials service (the Models page writes it) or set a literal "apiKey" in the web-search-litellm config`, "WEB_PROVIDER_CREDENTIAL_MISSING");
	}
}

export { BASE_URL_ENV, DEFAULT_API_KEY_ENV, DEFAULT_BASE_URL, DEFAULT_MAX_TOKENS, DEFAULT_MODEL, DEFAULT_TIMEOUT_MS, LiteLLMResponsesProvider, PROVIDER_ID, USER_AGENT, collectOpenPages, parseJsonBody, parseStreamBody };

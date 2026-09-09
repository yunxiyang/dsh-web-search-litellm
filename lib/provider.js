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
/**
 * Last-resort fallbacks, used ONLY when the active model config, the plugin's
 * own override, and the launch environment all provide nothing. These are not
 * "the" default endpoint: `index.js` derives the real baseURL/model/apiKeyEnv
 * from dsh's active model configuration first.
 */
/** Fallback LiteLLM proxy root (`/responses` is appended). */
const DEFAULT_BASE_URL = "http://127.0.0.1:4000/v1";
/** Fallback model routed through the proxy (DeepSeek, OpenAI-compatible id). */
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

/** Internal marker: a model finished its whole turn without ever invoking `web_search`. */
class SearchNotPerformedError extends Error {}

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

/** Whether any output item really invoked the server-side search tool. */
function itemsSearched(items) {
	for (const item of items ?? []) {
		if (item?.type === "web_search_call") return true;
	}
	return false;
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
	const sink = { urls: /* @__PURE__ */ new Set(), answer: "", failure: void 0, searched: false };
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
				if (itemsSearched([event.item])) sink.searched = true;
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
	if (terminalOutput !== void 0) {
		if (itemsSearched(terminalOutput)) sink.searched = true;
		collectOpenPages(terminalOutput, sink.urls);
	}
	if (sink.answer.trim().length === 0 && terminalOutput !== void 0) sink.answer = messageText(terminalOutput);
	sink.answer = sink.answer.trim();
	return sink;
}

/** Parse a plain JSON (non-stream) body. */
function parseJsonBody(data) {
	const sink = { urls: /* @__PURE__ */ new Set(), answer: "", failure: void 0, searched: false };
	if (typeof data !== "object" || data === null) {
		sink.failure = "unprocessable response body";
		return sink;
	}
	if (data.error != null) sink.failure = typeof data.error === "string" ? data.error : data.error?.message ?? "provider error";
	if (itemsSearched(data.output)) sink.searched = true;
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
		this._activeModel = options.initialActiveModel;
		this.onActiveModel = options.onActiveModel;
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
		const pool = this.modelPool(options);
		let active = this._activeModel;
		if (active === void 0 || active.length === 0 || !pool.includes(active)) active = pool[0];
		// Fast path: the remembered (or configured) model. If it searches, this
		// is the whole story — zero extra requests. Only a model that turns out
		// not to search (or that hangs) falls through to discovery.
		const attempt = this.attempt(active, request.query, signal);
		try {
			return await attempt.done;
		} catch (error) {
			attempt.cancel();
			const recoverable = error instanceof SearchNotPerformedError || (error instanceof this.WebError && error.code === "WEB_TIMEOUT");
			if (!recoverable) throw error;
			if (signal?.aborted === true) throw error;
			// A one-model pool has nobody to fall back to: surface the real cause
			// instead of re-running the same model to fabricate "no candidate".
			if (pool.length === 1) {
				if (error instanceof SearchNotPerformedError) {
					throw this.fail(`litellm web search: model "${pool[0]}" completed without invoking web_search (this gateway does not run search on that model)`, "WEB_PROVIDER_ERROR", error);
				}
				throw error;
			}
		}
		// Discovery: the active model just failed, so race every candidate and
		// latch onto the first one that actually runs the search.
		return await this.discover(request.query, pool, signal);
	}
	/** The ordered candidate pool: configured model first, then fallbacks. */
	modelPool(options) {
		const pool = [];
		for (const model of [options.model, ...(options.candidateModels ?? [])]) {
			if (typeof model === "string" && model.length > 0 && !pool.includes(model)) pool.push(model);
		}
		return pool;
	}
	/**
	 * One candidate's search attempt. Returns a handle carrying an early
	 * `searched` promise — settled the instant the model invokes `web_search` —
	 * plus the full `done` result and a `cancel()` to abort a losing attempt.
	 * `done` rejects with {@link SearchNotPerformedError} when the model
	 * finishes without searching, and with structured WebErrors otherwise.
	 */
	attempt(model, query, signal) {
		const options = this.resolveOptions();
		const controller = new AbortController();
		const effective = signal !== void 0 ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		let resolveSearched;
		let rejectSearched;
		const searched = new Promise((resolve, reject) => {
			resolveSearched = resolve;
			rejectSearched = reject;
		});
		// `searched` can reject (when `done` fails) with no consumer in the fast
		// path; attach a no-op rejection handler at creation so it is never an
		// unhandled rejection. `discover` still reads it through its own `.then`.
		searched.catch(() => {});
		const input = `Perform a web search for the query: ${query}. Open the most relevant result pages, then answer. End your answer with a "Sources:" list of every page URL you opened.`;
		const done = (async () => {
			const apiKey = await this.apiKey(options, effective);
			const body = {
				model,
				input,
				tools: [{ type: "web_search" }],
				stream: true,
				max_output_tokens: options.maxTokens
			};
			options.recordRequest?.({ endpoint: `${options.baseURL}/responses`, body });
			const response = await this.fetchResponses(options, body, apiKey, effective);
			const raw = await this.readBodyStreaming(response, options.timeoutMs, effective, (event) => {
				if (event.type === "web_search_call" || itemsSearched([event.item])) resolveSearched();
			});
			const parsed = this.parseResponse(response, raw);
			if (parsed.failure !== void 0) throw this.fail(`litellm web search failed: ${parsed.failure}`);
			if (!parsed.searched) throw new SearchNotPerformedError();
			return {
				sources: [...parsed.urls].map((url) => ({ url })),
				truncated: false,
				...parsed.answer.length > 0 ? { content: parsed.answer } : {}
			};
		})();
		done.catch((error) => rejectSearched(error));
		return { model, searched, done, cancel: () => controller.abort() };
	}
	/** Race all candidates; the first to actually run `web_search` wins. */
	async discover(query, pool, signal) {
		const attempts = pool.map((model) => this.attempt(model, query, signal));
		let winner;
		try {
			winner = await Promise.any(attempts.map((attempt) => attempt.searched.then(() => attempt)));
		} catch (aggregate) {
			if (signal?.aborted === true) throw this.fail("litellm web search aborted", "WEB_ABORTED", signal.reason);
			// Distinguish real causes from "everyone simply didn't search": a
			// timeout or hard provider error from any candidate is more honest
			// than a generic "no candidate invoked web_search".
			const errors = Array.isArray(aggregate?.errors) ? aggregate.errors : [aggregate];
			const timeout = errors.find((error) => error instanceof this.WebError && error.code === "WEB_TIMEOUT");
			if (timeout !== void 0) throw timeout;
			const hard = errors.find((error) => error instanceof this.WebError && error.code !== "WEB_ABORTED");
			if (hard !== void 0) throw hard;
			throw this.fail(`litellm web search: no candidate model ("${pool.join('", "')}") invoked web_search`, "WEB_PROVIDER_ERROR", aggregate);
		}
		for (const attempt of attempts) if (attempt !== winner) attempt.cancel();
		// Losing attempts' `done` rejections have no other consumer; swallow them
		// so an unhandled rejection does not crash the runtime.
		for (const attempt of attempts) if (attempt !== winner) attempt.done.catch(() => {});
		const result = await winner.done;
		this._activeModel = winner.model;
		await this.onActiveModel?.(winner.model);
		return result;
	}
	/**
	 * POST then read headers, with the CONNECT phase bounded by `timeoutMs`
	 * (waiting for headers) while the streaming body is left to the idle
	 * deadline in {@link readBodyStreaming}. The caller's signal stays attached.
	 */
	async fetchResponses(options, body, apiKey, effective) {
		const connectController = new AbortController();
		let connectTimer;
		try {
			return await Promise.race([
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
					signal: AbortSignal.any([effective, connectController.signal])
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
			if (effective.aborted === true) throw this.fail("litellm web search aborted", "WEB_ABORTED", effective.reason ?? error);
			if (isAbortError(error)) throw this.fail("litellm web search aborted", "WEB_ABORTED", effective.reason ?? error);
			throw this.fail(`litellm web search request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", error);
		} finally {
			clearTimeout(connectTimer);
		}
	}
	/** Resolve a response's parsed sink regardless of content type. */
	parseResponse(response, raw) {
		const contentType = response.headers.get("content-type") ?? "";
		if (contentType.includes("text/event-stream")) return parseStreamBody(raw);
		try {
			return parseJsonBody(JSON.parse(raw));
		} catch {
			throw this.fail("litellm web search returned an unprocessable response body");
		}
	}
	/**
	 * Read the response body with an IDLE timeout rather than a total wall
	 * clock: the deadline resets every time a chunk arrives, so a slow but
	 * steadily streaming search is never killed mid-stream. `timeoutMs` still
	 * bounds the connect phase (see `fetchResponses`) and any gap with no data.
	 * Each SSE event is handed to `onEvent` the moment it is parsed, so the
	 * orchestrator can race candidates on search activity, not full completion.
	 */
	async readBodyStreaming(response, timeoutMs, signal, onEvent) {
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
		let carry = "";
		const emitLine = (line) => {
			const trimmed = line.trim();
			if (!trimmed.startsWith("data:")) return;
			const payload = trimmed.slice(5).trim();
			if (payload.length === 0 || payload === "[DONE]") return;
			try {
				onEvent?.(JSON.parse(payload));
			} catch {
				// ignore malformed SSE payloads
			}
		};
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
				const chunk = carry + decoder.decode(read.value, { stream: true });
				const lines = chunk.split(/\r?\n/);
				carry = lines.pop() ?? "";
				for (const line of lines) emitLine(line);
				text += decoder.decode(read.value, { stream: true });
			}
			text += decoder.decode();
			if (carry.length > 0) emitLine(carry);
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

/**
 * Register a LiteLLM Responses API search provider in `ctx.web`. The provider
 * calls the OpenAI-compatible Responses endpoint of a LiteLLM proxy with the
 * server-side `web_search` tool — executed natively by the upstream DeepSeek
 * Responses API — and reuses the proxy's API key (`LITELLM_API_KEY` by
 * default, the same credential the chat Models page manages). No Anthropic
 * protocol, no third-party search service, no extra keys.
 *
 * @module dsh-web-search-litellm
 */
import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { WebError } from "@deepseek-ai/dsh-web";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { LiteLLMResponsesProvider, DEFAULT_API_KEY_ENV, DEFAULT_BASE_URL, DEFAULT_MAX_TOKENS, DEFAULT_MODEL, DEFAULT_TIMEOUT_MS, PROVIDER_ID, BASE_URL_ENV } from "./provider.js";

/** Cordis plugin name used by loader diagnostics. */
const name = "web-search-litellm";
/** The web seam this provider registers into. */
const inject = ["web"];
/**
 * Settings namespace carrying this provider's endpoint, model, and key
 * reference. Configurable through the harness Settings UI. The `>=0.1.2-rc.1`
 * core makes the namespace a plain string (the old `settingsNamespace` helper
 * is gone), so we keep the literal here and let {@link registerSettings} adapt.
 */
const SETTINGS_NAMESPACE = "web-search-litellm";
const Config = z.object({
	apiKey: z.string().role("secret"),
	// Every field below is OPTIONAL: when unset, the provider derives the value
	// from dsh's ACTIVE model configuration (the same provider/model the chat
	// uses). Nothing company- or user-specific is baked in — set a field here
	// only to override the derivation.
	apiKeyEnv: z.string().role("credential-ref"),
	baseURL: z.string(),
	model: z.string(),
	candidateModels: z.array(z.string()),
	maxTokens: z.number().step(1).min(1),
	timeoutMs: z.number().step(1).min(1)
});
/**
 * Derive the ACTIVE LLM provider's endpoint config so the search reuses the
 * same proxy (baseURL + API-key env) and model catalog as the chat — nothing
 * is hardcoded. Chain:
 *
 *   `agentDefaultModel.currentSelection()` → `{provider}` → the provider's
 *   configurable-provider directory entry → `{settingsNs, settingsPath}` →
 *   `settings.get(settingsNs)` walked along `settingsPath`.
 *
 * Every step is defensive: on an older core lacking one of these seams, or a
 * missing/malformed section, this returns `{}` and the caller falls back to
 * the plugin's own override, the launch environment, or the safe default.
 * @param ctx - plugin context.
 * @returns `{ baseURL?, apiKeyEnv?, models[] }` extracted from the active
 *   provider, or `{}` when it cannot be read.
 */
function deriveProviderConfig(ctx) {
	try {
		const selection = ctx.get("agentDefaultModel")?.currentSelection?.();
		const provider = selection?.provider;
		if (typeof provider !== "string" || provider.length === 0) return {};
		const llm = ctx.get("llm");
		if (llm === void 0 || typeof llm.listConfigurableProviders !== "function") return {};
		const entry = llm.listConfigurableProviders().find((candidate) => candidate?.provider === provider);
		if (entry === void 0 || typeof entry.settingsNs !== "string" || entry.settingsNs.length === 0) return {};
		const settings = ctx.get("settings");
		if (settings === void 0 || typeof settings.get !== "function") return {};
		const section = settings.get(entry.settingsNs);
		if (section == null) return {};
		let node = section;
		for (const segment of Array.isArray(entry.settingsPath) ? entry.settingsPath : []) {
			node = node?.[segment];
			if (node == null) break;
		}
		if (node == null || typeof node !== "object") return {};
		const baseURL = typeof node.baseURL === "string" && node.baseURL.trim().length > 0 ? node.baseURL.trim() : void 0;
		const apiKeyEnv = typeof node.apiKeyEnv === "string" && node.apiKeyEnv.trim().length > 0 ? node.apiKeyEnv.trim() : void 0;
		const models = Array.isArray(node.models)
			? node.models.map((model) => (typeof model === "string" ? model : model?.id)).filter((id) => typeof id === "string" && id.length > 0)
			: [];
		return { ...baseURL === void 0 ? {} : { baseURL }, ...apiKeyEnv === void 0 ? {} : { apiKeyEnv }, models };
	} catch {
		return {};
	}
}

/**
 * Project one resolved section into the options the provider serves its next
 * search with. Values resolve in this order:
 *
 *   1. This plugin's own setting (explicit override).
 *   2. The ACTIVE model/provider configuration (derived from `ctx`).
 *   3. The launch environment, then a neutral default (only as last resort).
 *
 * @param ctx - plugin context supplying the credential plane and model config.
 * @param config - the currently authoritative section.
 * @returns options for one search.
 */
function resolveOptions(ctx, config) {
	const selection = (() => {
		try {
			return ctx.get("agentDefaultModel")?.currentSelection?.();
		} catch {
			return void 0;
		}
	})();
	const activeModel = typeof selection?.model === "string" && selection.model.length > 0 ? selection.model : void 0;
	const derived = deriveProviderConfig(ctx);

	const apiKeyEnvRaw = config.apiKeyEnv ?? derived.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
	const baseURL = config.baseURL ?? derived.baseURL ?? launchEnvironmentOf(ctx).get(BASE_URL_ENV)?.value ?? DEFAULT_BASE_URL;
	const model = config.model ?? activeModel ?? DEFAULT_MODEL;
	const derivedModels = (Array.isArray(config.candidateModels) && config.candidateModels.length > 0 ? config.candidateModels : derived.models) ?? [];
	const candidateModels = derivedModels.filter((candidate) => candidate !== model);
	const literalApiKey = config.apiKey !== void 0 && config.apiKey.length > 0 ? config.apiKey : void 0;
	const apiKeyEnv = credentialRef(apiKeyEnvRaw);
	return {
		...literalApiKey === void 0 ? {} : { apiKey: literalApiKey },
		resolveApiKey: async () => {
			const credentials = ctx.get("credentials");
			if (credentials !== void 0) return (await credentials.resolve(apiKeyEnv))?.value;
			const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv);
			return ambient !== void 0 && ambient.value.length > 0 ? ambient.value : void 0;
		},
		apiKeyEnv,
		baseURL,
		model,
		candidateModels,
		maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
		timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS
	};
	// Deliberately no `recordRequest` session event here: a third-party event
	// type can never enter the harness's KNOWN_SESSION_EVENT_TYPES catalog,
	// and the 0.1.1-rc.2 `session.append` API has no way to mark an event
	// `ignorable`, so emitting one would make old harness builds refuse to
	// load any session this plugin ran in (fail-closed vocabulary check).
	// The search is still fully visible in the session through the standard
	// web_search tool call/result events.
}
/** Cache file remembering the last model that actually ran web_search. */
const CACHE_PATH = dshHomePath("dsh-web-search-litellm", "model-cache.json");

/** Read the remembered search-capable model, if any survives a config change. */
function loadCachedModel() {
	try {
		const parsed = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
		return typeof parsed?.model === "string" && parsed.model.length > 0 ? parsed.model : void 0;
	} catch {
		return void 0;
	}
}

/** Persist the model that won discovery so a restart skips re-probing. */
function saveCachedModel(model) {
	try {
		mkdirSync(dirname(CACHE_PATH), { recursive: true });
		writeFileSync(CACHE_PATH, JSON.stringify({ model, at: Date.now() }));
	} catch {
		// Persistence is best-effort: a failed write only costs one re-probe.
	}
}

/**
 * Register a settings section across both cores:
 *
 * - `>=0.1.2-rc.1` (includes `0.1.3-alpha.2`): settings is a service and
 *   `installSection` is a method invoked through `ctx.inject(["settings"])`.
 * - `<=0.1.1-rc.2`: `installSettingsSection` is a top-level export taking the
 *   context directly. `settingsNamespace` is dropped too (the plain string is
 *   already valid on both sides).
 *
 * We feature-detect instead of statically importing so the module also loads
 * on a core where the old export no longer exists (a static import would
 * throw a `SyntaxError: does not provide an export named` before `apply` ran).
 * @param ctx - plugin context.
 * @param schema - settings schema for the namespace.
 * @param config - base (file) value for the section.
 * @param hooks - source sink and change notification.
 */
function registerSettings(ctx, schema, config, hooks) {
	if (typeof ctx.inject === "function") {
		// New core: inject the settings service, drive it through its injector
		// scope so the section lives for exactly this plugin's lifetime.
		ctx.inject(["settings"], (settingsCtx) => {
			const provider = settingsCtx?.settings;
			if (provider !== void 0 && typeof provider.installSection === "function") {
				provider.installSection(ctx, SETTINGS_NAMESPACE, schema, config, hooks);
			}
		});
		return;
	}
	// Old core: the top-level helper still exists. Import it lazily so this
	// branch is only exercised where the symbol is actually present.
	import("@deepseek-ai/dsh-settings").then((mod) => {
		if (typeof mod.installSettingsSection === "function") {
			mod.installSettingsSection(ctx, SETTINGS_NAMESPACE, schema, config, hooks);
		}
	}).catch(() => {
		// Settings registration is cosmetic: the provider still works with the
		// base config even if the section could not be mounted.
	});
}

/** Register the LiteLLM Responses search provider with `ctx.web`. */
function apply(ctx, config) {
	let current = () => config;
	registerSettings(ctx, Config, config, {
		setSource: (source) => {
			current = source;
		},
		onChange: () => {}
	});
	ctx.web.registerSearchProvider(new LiteLLMResponsesProvider(() => resolveOptions(ctx, current()), {
		WebError,
		initialActiveModel: loadCachedModel(),
		onActiveModel: saveCachedModel
	}));
}
export { Config, LiteLLMResponsesProvider, PROVIDER_ID, SETTINGS_NAMESPACE, apply, inject, name };

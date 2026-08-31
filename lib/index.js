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
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { WebError } from "@deepseek-ai/dsh-web";
import { LiteLLMResponsesProvider, DEFAULT_API_KEY_ENV, DEFAULT_BASE_URL, DEFAULT_MAX_TOKENS, DEFAULT_MODEL, PROVIDER_ID, BASE_URL_ENV } from "./provider.js";

/** Cordis plugin name used by loader diagnostics. */
const name = "web-search-litellm";
/** The web seam this provider registers into. */
const inject = ["web"];
/**
 * Settings namespace carrying this provider's endpoint, model, and key
 * reference. Configurable through the harness Settings UI.
 */
const SETTINGS_NAMESPACE = settingsNamespace("web-search-litellm");
const Config = z.object({
	apiKey: z.string().role("secret"),
	apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV),
	baseURL: z.string(),
	model: z.string().default(DEFAULT_MODEL),
	maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS)
});
/**
 * Project one resolved section into the options the provider serves its next
 * search with. Environment fallbacks stay here rather than in the provider:
 * every value it reads is already fully defaulted.
 * @param ctx - plugin context supplying the credential plane.
 * @param config - the currently authoritative section.
 * @returns options for one search.
 */
function resolveOptions(ctx, config) {
	const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV);
	const literalApiKey = config.apiKey !== void 0 && config.apiKey.length > 0 ? config.apiKey : void 0;
	return {
		...literalApiKey === void 0 ? {} : { apiKey: literalApiKey },
		resolveApiKey: async () => {
			const credentials = ctx.get("credentials");
			if (credentials !== void 0) return (await credentials.resolve(apiKeyEnv))?.value;
			const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv);
			return ambient !== void 0 && ambient.value.length > 0 ? ambient.value : void 0;
		},
		apiKeyEnv,
		baseURL: config.baseURL ?? launchEnvironmentOf(ctx).get(BASE_URL_ENV)?.value ?? DEFAULT_BASE_URL,
		model: config.model ?? DEFAULT_MODEL,
		maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
		recordRequest: (request) => {
			ctx.get("agents")?.currentInitiator()?.session.append("web/litellm-responses-search-request", request);
		}
	};
}
/** Register the LiteLLM Responses search provider with `ctx.web`. */
function apply(ctx, config) {
	let current = () => config;
	installSettingsSection(ctx, SETTINGS_NAMESPACE, Config, config, {
		setSource: (source) => {
			current = source;
		},
		onChange: () => {}
	});
	ctx.web.registerSearchProvider(new LiteLLMResponsesProvider(() => resolveOptions(ctx, current()), { WebError }));
}
export { Config, LiteLLMResponsesProvider, PROVIDER_ID, SETTINGS_NAMESPACE, apply, inject, name };

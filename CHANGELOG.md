# Changelog

## 0.1.1 — 2026-08-31

- **Compatibility fix:** removed the log-only
  `web/litellm-responses-search-request` session event. A third-party event
  type can never enter the harness's `KNOWN_SESSION_EVENT_TYPES` catalog, and
  `session.append` has no way to mark it `ignorable`, so sessions containing
  it were rejected whole by older harness builds (fail-closed vocabulary
  check, `SessionFormatUnsupportedError`). The search remains visible in the
  session through the standard `web_search` tool call/result events.

## 0.1.0 — 2026-08-31

- Initial release: `litellm-responses` search provider for the `ctx.web` seam.
- OpenAI Responses protocol via a LiteLLM proxy; DeepSeek-native server-side
  `web_search`; reuses `LITELLM_API_KEY`.
- Settings section `web-search-litellm` (`apiKey`, `apiKeyEnv`, `baseURL`,
  `model`, `maxTokens`, `timeoutMs`) with environment fallbacks
  (`LITELLM_SEARCH_BASE_URL`).
- Structured provider errors (`WEB_ABORTED`, `WEB_TIMEOUT`,
  `WEB_PROVIDER_CREDENTIAL_MISSING`, `WEB_PROVIDER_ERROR`).
- Standalone end-to-end test (`tests/search-e2e.mjs`).

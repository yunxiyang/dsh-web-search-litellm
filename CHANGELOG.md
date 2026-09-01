# Changelog

## 0.1.2 — 2026-09-01

- **Timeout semantics redefined — no more total wall clock.** `timeoutMs` now
  bounds the connect phase (wait for response headers) and applies an
  idle-resetting deadline while streaming: the deadline resets on every chunk,
  so a slow search with steady output is never killed mid-stream, while a
  truly stalled connection still fails with a structured `WEB_TIMEOUT`.
  (0.1.1 and earlier aborted the entire request at a fixed deadline even when
  data was flowing — the reported "keeps timing out although results keep
  coming" symptom.)
- Regression tests: `tests/idle.test.mjs` (drip stream outlives the timeout)
  and the existing hang test now asserts the connect-phase deadline.

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

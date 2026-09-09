# Changelog

## 0.2.4 — 2026-09-10

- **Ship a plain hot-mountable insert.** The bundle patch now carries only
  `id` + `name` (no `config`, no expressions), so the market's hot-mount
  parser activates the plugin live — no restart required after install. The
  config was already derived at search time, so a bare insert is sufficient.

## 0.2.3 — 2026-09-09

- **Derive, don't hardcode.** `baseURL`, `model`, `apiKeyEnv`, and
  `candidateModels` are now optional: when unset, the provider reads dsh's
  ACTIVE model configuration — `agentDefaultModel.currentSelection()` for the
  active model, the `llm` configurable-provider directory for the active
  provider's `baseURL`/`apiKeyEnv`/`models[]` — so the search rides the same
  gateway and model pool as the chat on any machine. Explicit config still
  overrides the derived values.

## 0.2.2 — 2026-09-09

- Fix a load-time `SyntaxError` on the `>=0.1.2-rc.1` core (e.g. `0.1.3-alpha.2`):
  drop the static import of `installSettingsSection` / `settingsNamespace`,
  both removed from `@deepseek-ai/dsh-settings`. Settings registration now
  feature-detects the core — `ctx.inject(["settings"], …)` + `installSection`
  on the new core, the old top-level `installSettingsSection` on `<=0.1.1-rc.2`.
  Works on both; the search provider is unaffected when settings cannot mount.

## 0.2.1 — 2026-09-09

- Declare `@deepseek-ai/dsh-home-paths` as a runtime dependency (0.2.0 imported
  it but did not list it, which could break resolution under strict host
  resolvers on the latest web core); back all peer ranges to `^0.1.1-rc.2` and
  drop the redundant home-paths peer so the manifest resolves cleanly.

## 0.2.0 — 2026-09-02

- **Search-capable model auto-discovery with caching.** `model` is now the
  starting pick and a new `candidateModels` list names the fallback pool.
  When the active model proves it does not actually run `web_search` (the
  gateway streams a reply but never invokes the tool) — or hangs — the plugin
  races every candidate on the *same query* and latches onto the first that
  really searches, cancels the rest, and remembers the winner (persisted to
  disk, so a restart skips re-probing). Requires gateways where not all models
  have `web_search` wired (e.g. DeepSeek routed without a search backend next
  to a GPT that has one).

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

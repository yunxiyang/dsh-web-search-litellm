# dsh-web-search-litellm

DSH `web_search` provider over the **LiteLLM proxy** using the **OpenAI Responses protocol**. The request carries the server-side `web_search` tool, executed natively by the **DeepSeek Responses API**; the grounded answer and the real URLs the model opened are returned to the harness web seam (`ctx.web`).

- **No Anthropic protocol** — speaks `POST {baseURL}/responses`, not `/messages`.
- **No new keys** — reuses the `LITELLM_API_KEY` credential your chat Models page already stores.
- **No third-party search service** — search runs on DeepSeek's official server side, billed through your existing LiteLLM route.
- **Fully configurable in the Settings UI** (`web-search-litellm` section).

## 简介 / 快速上手（中文）

这是 DeepSeek Harness `ctx.web` 能力的**联网搜索提供方**：`web_search` 请求走 **OpenAI Responses 协议**发往你的 **LiteLLM 代理**，由 DeepSeek 官方 Responses API **在服务端原生执行搜索**，返回带真实来源 URL 的答案。

- 不需要 Anthropic 协议，也不需要新的 API Key——直接复用聊天模型页已配置的 `LITELLM_API_KEY`。
- 不接任何第三方搜索服务；搜索在 DeepSeek 官方服务端完成，走你现有的 LiteLLM 计费路由。
- 安装：`dsh plugin --profile <name> add dsh-web-search-litellm`，然后在 profile 的 `cordis.patch.yml` 里把 `web` 的 `searchProvider` 设为 `litellm-responses`（详见下方英文说明）。
- 常见症状：`web_search` 报 `Authentication Fails, Your api key is invalid`，且你的 `DEEPSEEK_API_KEY` 其实是 LiteLLM 代理 key——装这个插件并把 `baseURL` 指向代理即可。

## 何时使用 / When to use

Pick this provider when any of these is your situation:

- `web_search` fails with **`Authentication Fails, Your api key: ****XXXX is invalid`** — usually because `DEEPSEEK_API_KEY` holds a LiteLLM proxy key, not a DeepSeek platform key.
- **All company traffic must go through LiteLLM** (direct api.deepseek.com is blocked or forbidden).
- You **prefer the OpenAI Responses protocol** over the Anthropic `/messages` format.
- You want **no free-tier / third-party search service** (Tavily, Brave, Exa, …) — search stays on DeepSeek's official server side.
- You use `openai/deepseek-v4-flash` or `openai/deepseek-v4-pro` through a LiteLLM proxy as your main model.

## Install

```sh
dsh plugin --profile <name> add dsh-web-search-litellm
# or from a local checkout:
dsh plugin --profile <name> add ./dsh-web-search-litellm
```

Then route the seam (profile `cordis.patch.yml`):

```yaml
- id: web
  config:
    searchProvider: litellm-responses

# optional: disable the shipped Anthropic-format DeepSeek provider
- id: web-search-deepseek
  disabled: true
```

Restart the profile (desktop: Settings → Desktop settings → Restart, or quit and reopen).

## Configuration

Settings section **web-search-litellm** (harness Settings UI) or the bundle
patch config:

| key | default | meaning |
| --- | --- | --- |
| `baseURL` | `$LITELLM_SEARCH_BASE_URL` → `http://127.0.0.1:4000/v1` | LiteLLM proxy root; `/responses` is appended |
| `model` | `openai/deepseek-v4-flash` | model id routed through the proxy (must support server-side `web_search`) |
| `apiKeyEnv` | `LITELLM_API_KEY` | credential reference resolved at each search |
| `apiKey` | — | optional literal key (`secret` role) |
| `maxTokens` | `4096` | `max_output_tokens` for one search request |
| `timeoutMs` | `60000` | per-request timeout; times out as a structured `WEB_TIMEOUT` error |

## How it works

1. The model calls `web_search` with a query string.
2. This provider POSTs to `{baseURL}/responses` with `tools: [{"type": "web_search"}]`, `stream: true`.
3. The LiteLLM proxy forwards the call; DeepSeek executes the search server-side and feeds results to the model.
4. The provider parses the SSE stream: the final `output_text` becomes the result `content`, and every `web_search_call` item whose action is `open_page` contributes its URL to `sources`.

## Known upstream limits (not configuration issues)

- DeepSeek's Responses API documents `include` as **not supported**, so structured result items are consumed server-side; sources therefore carry `url` only (no title/snippet).
- Each search costs one DeepSeek model turn (official mechanism).

## License

MIT

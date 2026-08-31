# Market submission checklist

How `dsh-web-search-litellm` gets listed on
[awesome-dsh-plugin.com](https://awesome-dsh-plugin.com) (the catalog behind
the in-app plugin market).

## Hard gates (CI-enforced in the catalog repo)

- Repository at least **1 day old** and **≥ 10 commits**.
- `package.json` declares `dsh.bundle.patch` → `./cordis.patch.yml` ✅
- Repo topic `dsh-plugin` set ✅
- Description states facts only, verifiable in this source.

## Entry file

One YAML file, added via PR to `awesome-dsh-plugin/awesome-dsh-plugin`:

```
data/plugins/yunxiyang__dsh-web-search-litellm.yml
```

```yaml
url: https://github.com/yunxiyang/dsh-web-search-litellm
name: yunxiyang/dsh-web-search-litellm
category: tools
description:
  en: 'Web search provider for the ctx.web seam that routes the DeepSeek web_search tool through a LiteLLM proxy using the OpenAI Responses API, reusing LITELLM_API_KEY.'
  zh: 'ctx.web 搜索提供方：通过 LiteLLM 代理走 OpenAI Responses API 调用 DeepSeek 原生服务端 web_search，复用 LITELLM_API_KEY，无需新密钥。'
```

## Steps

1. `npm publish` (publish the npm package; prebuilt installs skip the
   build-approval step for users).
2. Fork `awesome-dsh-plugin/awesome-dsh-plugin`, add the one entry file,
   open the PR. Do not hand-edit the generated READMEs.
3. A maintainer reads this repository's source and verifies the description
   before merging.

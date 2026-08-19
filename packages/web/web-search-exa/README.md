# @deepseek-ai/dsh-web-search-exa

English | [中文](README.zh.md)

An [Exa](https://exa.ai)-backed `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`), and the search provider the shipped base bundle selects. It calls Exa's `POST /search` endpoint with highlight contents, maps the flat `results[]` into the seam's normalized `WebSearchResult`, and resolves its API key at each search through the credentials seam, so the managed store, both `.env` layers, and the launching environment all work and a stored or rotated key applies without a restart.

This is an **implementation** package: it registers a provider into `ctx.web`, it does not own the `ctx.web` key and it does not register a model-facing tool (that is `@deepseek-ai/dsh-tool-web`). Like `@deepseek-ai/dsh-llm-deepseek`, it is a function/namespace plugin (`inject: ['web']`) that registers its backend, not a default-export service.

## Config

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | (unset) | Literal Exa API key; prefer `apiKeyEnv` so no secret enters configuration files. |
| `apiKeyEnv` | `EXA_API_KEY` | Credential reference resolved for each search through `ctx.credentials`, with the launch environment as the whole credential plane when no credentials service is composed. |
| `baseURL` | `https://api.exa.ai` | Endpoint base; `/search` is appended. An unparseable value makes the provider unavailable. |
| `searchType` | `auto` | Retrieval mode sent as Exa's `type`: `auto` (Exa decides), `keyword`, or `neural`. |
| `numResults` | (unset) | Default result count when a request carries no `maxResults`. Unset sends no default. Must be a positive integer. |
| `highlightsPerResult` | `1` | Highlight sentences requested per result (Exa's `highlightsPerUrl`). Must be a positive integer. |

```yaml
- id: web-search-exa
  name: '@deepseek-ai/dsh-web-search-exa'
  config:
    apiKeyEnv: EXA_API_KEY
```

## Settings

The plugin installs the `web-search-exa` settings section, so `$DSH_HOME/settings.yaml` (and the web UI's search card, which writes `apiKey` through the credentials domain rather than into the section) can change every config key at runtime: options are projected from the resolved section once per search, and one search never mixes two sections even when a write lands mid-resolution. A key path (literal or reference) makes `available()` true; a search that then finds no value fails with the actionable `WEB_PROVIDER_CREDENTIAL_MISSING` message naming the reference.

## Mapping

Exa returns a flat `results[]` and no generated answer, so `content` is omitted. Each result maps to a `WebSearchSource`: `url` ← `url`, `title` ← `title`, `snippet` ← the first non-empty `highlights[]` entry (a result with no highlight has no portable snippet and is dropped), `publishedAt` ← `publishedDate`. A request's `maxResults` wins over the configured `numResults` default and is sent as Exa's `numResults` for a cost/latency optimization; the final bound is enforced by the seam. Provider failures (HTTP errors, network failure, unparseable or wrong-shape bodies, a credential resolver failure) surface as `WebError` `WEB_PROVIDER_ERROR`; a missing key surfaces as `WEB_PROVIDER_CREDENTIAL_MISSING`; an aborted request — whatever the abort reason carries — surfaces as `WEB_ABORTED`. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`.

## Model Experience

Indirectly, through [`dsh-tool-web`](../tool-web/README.md), which retains this provider's `maxResults`-bounded URLs, titles, first highlights, and publication dates or its exact `Exa search aborted`, `Exa search request failed: <error>`, `Exa returned an unprocessable response body: <error>`, and `Exa search has no API key for "<ref>"…` failures under the consumer's error wrapper while generated answers and provider-private fields remain outside context.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **A result with no non-blank highlight is dropped entirely** — no portable snippet to map, so fewer sources than the requested count can return.
- **Only `searchType`/`numResults`/`highlightsPerResult` are exposed** — Exa's other controls (livecrawl, category, domain/date filters, full-text contents) wait on provider-neutral Service Definition fields ([seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)).

# Agent Note: Exa default search with credential-seam parity

Status: implemented

English | [中文](2026-08-18-exa-default-search-credential-parity.zh.md)

## Problem

The shipped base bundle mounted only the DeepSeek search provider and pinned `web.searchProvider: deepseek-official`, so `web_search` required a `DEEPSEEK_API_KEY` even in a deployment whose agent model authenticates elsewhere (this fork's agent is an OpenAI Codex subscription via OAuth). DeepSeek search is also an auxiliary model request with server-side retrieval — a per-search model turn this deployment does not want. The in-repo Exa provider was the wanted shape (a dedicated search endpoint, free-tier keyable, no model in the loop) but was unmounted, bypassed the credentials seam by baking `$EXA_API_KEY` at construction, had no settings section, and the web UI's search card was hard-bound to the `web-search-deepseek` namespace.

## Decision

**Exa is the shipped search default; DeepSeek stays mounted but unselected.** The base bundle mounts `web-search-exa` with `apiKeyEnv: EXA_API_KEY` and repoints the `web` row to `searchProvider: exa`. Switching back is one config line, so the DeepSeek row keeps its credential reference and base-URL override. `tool-web`'s 60s search budget stays: it covers the still-selectable DeepSeek route, whose search is a full model request.

**The Exa provider gains DeepSeek-level integration.** Its config gains `apiKeyEnv` (`role('credential-ref')`, default `EXA_API_KEY`) and `apiKey` becomes `role('secret')`; the plugin installs the `web-search-exa` settings section; the provider takes an options thunk snapshotted once per search so one operation never mixes two sections; the key resolves per search through the credentials seam with the launch environment as the seamless fallback. `available()` reports a key path (literal or resolver) plus config validity, and a search that resolves no value fails with the actionable `WEB_PROVIDER_CREDENTIAL_MISSING` message naming the reference.

**Shared provider machinery moved to its owning packages instead of being cloned.** `dsh-credentials` gains `resolveCredential(ctx, ref)` (service when composed, else ambient environment) and `credentialPlan(ctx, config, defaultRef)` (the literal-wins spread every keyed provider assembles). `dsh-web` gains `resolveProviderApiKey`, `providerErrorMessage`, `abortable`, and `isAbortError`, each taking the provider's `ProviderRequestErrors` strings — the seam owns the mechanics and error codes, providers own every message. The DeepSeek provider now consumes the same helpers, which also unified its abort classification with Exa's: an abort carrying a custom reason maps to `WEB_ABORTED` in both.

**The web UI search card follows the shipped provider.** `ui-settings-plugins` retargets `WEB_SEARCH_NS` to `web-search-exa`, the default credential reference to `EXA_API_KEY`, and the numeric field from DeepSeek's `maxUses` to Exa's `numResults`. The DeepSeek namespace stays served by the Host; it simply has no card until someone ships one.

**The browser search snapshot lane pins its provider explicitly.** `apps/web/tests/scaffold.ts` patches `web.searchProvider: deepseek-official` whenever a scenario supplies `deepSeekSearch`, because the lane deliberately drives the DeepSeek provider against a local Anthropic-shaped double; the shipped composition now selects Exa, and without the pin the lane would compose a provider its fixtures do not model.

## Alternatives considered

**Gemini grounding with the existing Google AI Studio key.** Rejected by the deployment owner: grounding is another auxiliary-LLM search (the very shape being moved away from), and it would be a new provider package for a per-query-billed route.

**Google Custom Search JSON API.** Rejected because Google closed it to new signups in 2025 and announced a 2027-01-01 shutdown; no new key can be provisioned.

**Tavily.** Rejected as the default because it requires a new provider package for a smaller free tier than Exa's, which already ships in-repo.

**Keep DeepSeek as the shipped default and switch via profile patch.** Rejected because this fork's product stance is Exa-first; a per-machine patch would leave the shipped composition requiring a key the deployment does not hold.

**Clone DeepSeek's credential/abort machinery into the Exa provider.** Rejected by the duplication gate and by ownership: the mechanics and the `WebError` codes belong to the seam, the fallback doctrine belongs to `dsh-credentials`, and a third provider would have cloned both again.

## Consequences

A fresh checkout serves `web_search` through Exa: store `EXA_API_KEY` via the web UI's search card (which writes through the credentials domain), `~/.dsh/.credentials.yaml`, either `.env` layer, or the environment, and the next search uses it without a restart. `web-search-exa` now peers on `dsh-credentials` and `dsh-settings` and no longer on `dsh-launch-environment`; `dsh-credentials` peers on `dsh-launch-environment` for the ambient fallback. The selection-time `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` for a keyless Exa composition became the search-time `WEB_PROVIDER_CREDENTIAL_MISSING` with storage guidance, matching DeepSeek's behavior.

An Exa-shaped browser snapshot lane (a local Exa double behind the real provider and credentials seam) is deferred: recording its model stream needs a `DEEPSEEK_API_KEY` this deployment does not hold. The pinned DeepSeek lane keeps the assembled-transcript coverage of the search round in the meantime.

## Testing

Exa package tests cover the credential lane through the real `LocalCredentialProvider` (missing key, store, rotate, no restart), empty ambient values, resolver rejection and abort interleavings, the one-snapshot-per-search rule, the settings section (stored endpoint without re-registration, secret redaction, detach fallback, namespace release), and the group-mandated two-server redirect proof — whose control case records that native fetch strips `authorization` on a cross-origin follow while the private body still crosses origins. Seam tests pin `abortable`'s cancellation contract directly. Client tests cover the retargeted card fields and namespace routing. The DeepSeek provider's full suite passes unchanged over the shared helpers.

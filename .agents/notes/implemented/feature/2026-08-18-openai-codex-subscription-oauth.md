# Agent Note: OpenAI Codex subscription authentication

Status: implemented

English | [中文](2026-08-18-openai-codex-subscription-oauth.zh.md)

## Problem

The pi-ai catalog already contained the `openai-codex` provider and its ChatGPT OAuth implementation, but DeepSeek Harness supplied none of the application-owned pieces that pi-ai deliberately leaves outside the provider: durable credential storage, login orchestration, and a user interaction surface. A keyless profile therefore reached `Provider is not configured`, while pasting an access token into the API-key field worked only until that token expired.

The temporary 2026-08-13 decision withheld OAuth-only providers from the configurable-provider directory until all three pieces existed. This decision supersedes that temporary posture for OpenAI Codex. It does not turn Codex SDK into the main agent or place one harness inside another; the existing DeepSeek agent loop still constructs every request and calls a pi-ai provider adapter, exactly as it does for API-key providers.

## Decision

**Credential providers gain a serialized replacement operation.** `CredentialProvider.modify(ref, update)` reads the exact current secret and optionally replaces it under the same exclusion as `set` and `unset`. `undefined` retains the current value; deletion remains explicit through `unset`. The local provider holds its cross-process atomic-writer lock while the asynchronous callback runs. This is the invariant pi-ai requires when an OAuth provider rotates a refresh token: concurrent model requests or harness processes cannot exchange the same single-use token independently and overwrite the winner.

**pi-ai credentials stay behind Harness references.** `HarnessCredentialStore` maps each provider id to a deterministic `DSH_PI_AI_<PROVIDER>_AUTH` reference, validates the type-tagged JSON document at the durable boundary, and implements pi-ai's `read`, `list`, `modify`, and `delete` operations through `ctx.credentials`. Neither settings nor any configuration response carries the value. The adapter gives every immutable `Models` snapshot the same store, so login, authentication checks, normal streaming, and automatic refresh all observe one durable credential.

**The LLM seam owns a provider-neutral authentication lifecycle.** An adapter plugin registers methods, a non-secret status query, login, and logout for a provider. `LlmRuntime` allows one active attempt per provider, runs it in the background, publishes detached device-code or progress notifications, supports exact-attempt polling and cancellation, retains one terminal result until replacement, and cancels work on registration disposal. Provider failures are logged and reduced to safe public text. `llm/auth-updated(provider)` is an invalidation event, not a state or credential transport.

**OpenAI Codex uses pi-ai's device-code flow.** `llm-pi-ai` registers one method, `Sign in with ChatGPT`, selects pi-ai's `device_code` option, and rejects any unexpected manual or callback prompt instead of inventing another interaction. The Host exposes start, poll, cancel, and logout RPCs as loopback same-origin privileged operations. The Models card renders the verification URL and user code, polls the opaque attempt id, enables Apply only after authentication succeeds, and supports sign-out. It never receives an access or refresh token.

**The directory advertises only implemented authentication.** API-key catalog routes remain available as before. With `ctx.credentials` composed, the plugin additionally offers `openai-codex`; without it, no persistent store or login registration exists and the route remains withheld. `llm-pi-ai` follows that optional service's lifecycle instead of sampling it only during plugin startup: a later mount adds the store, login registration, and directory route, while removal withdraws them; the adapter rebuilds its next `Models` snapshot when the store identity changes. Other providers that happen to declare pi-ai OAuth do not acquire an interactive surface implicitly. A hand-written `openai-codex` profile naming `apiKeyEnv` remains an explicit token override.

## Alternatives considered

**Read `~/.codex/auth.json`.** Rejected because that makes this harness depend on another application's private storage format and lifecycle. The chosen store is owned by DeepSeek Harness and uses pi-ai's public credential interface.

**Run Codex SDK as the provider.** Rejected because Codex SDK is an agent harness API, not a lower-level model transport. Nesting it would add another loop, tool policy, session model, and compaction layer. The requested model swap needs only the existing provider adapter to authenticate against the Codex route.

**Put the whole login lifecycle in `llm-pi-ai` or the Models UI.** Rejected because attempts must survive an individual RPC and because provider authentication is an adapter capability that other providers can implement. Core owns lifecycle and safe progress; the adapter owns protocol details; the client owns presentation.

**Use only an in-process mutex for refresh.** Rejected because two product processes can share the same credentials document. The rotating-token invariant must extend through the durable provider's cross-process writer lock.

**Offer every pi-ai OAuth provider immediately.** Rejected because catalog metadata alone does not prove that this client can render the provider's prompt sequence. Only OpenAI Codex's device-code interaction is implemented here; future methods must add their lifecycle translation and assembled UI coverage before appearing.

## Consequences

A user can add OpenAI Codex from **Settings → Models**, complete **Sign in with ChatGPT**, apply the provider, and select its catalog models. Subsequent requests remain DeepSeek Harness turns and use the ChatGPT subscription-backed Codex provider through pi-ai. Credentials persist in `$DSH_HOME/.credentials.yaml` under `DSH_PI_AI_OPENAI_CODEX_AUTH`, refresh automatically, and can be removed from the same card.

The credential seam now has five operations, and every provider implementation or test double must implement `modify`. The Host and remote event allowlist gain one authentication invalidation plus four privileged methods. Terminal login status is process-local; a restart reconstructs authenticated state from the durable credential but does not resume an incomplete device-code attempt.

## Testing

Credential tests cover serialized callbacks, no-op replacement, shadowing, file fallback promotion, and queue recovery after rejection. LLM tests cover registration lifecycle, progress, success, cancellation, duplicate attempts, safe failures, and disposal. pi-ai tests cover JSON persistence without secret echo, reference collisions, catalog exposure, OAuth status, and credentials becoming available after the adapter starts. Host/client tests cover every RPC and error mapping; Models component tests cover device-code polling, success, and logout. The browser snapshot records the OpenAI Codex card in the real application composition.

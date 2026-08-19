/**
 * llm domain contract: host-scoped provider topology for configuration
 * surfaces. `llm.providers` merges the configurable-provider directory
 * (which providers CAN be configured, and where their settings live) with the
 * live route registry; `llm.models` is the session-independent model catalog
 * (the same groups as `session.models`, without a per-session selection).
 * Provider rows may also carry non-secret interactive-authentication state.
 * Clients invalidate from the forwarded `llm/adapters-updated`,
 * `llm/auth-updated`, and `settings/document-updated` owner events.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'
import type { ModelCatalogFailure, ModelProviderGroup } from './sessions.ts'
import type { ProviderLoginAttemptId } from '@deepseek-ai/dsh-llm/brand'

/** Interactive provider sign-in method exposed by the host. */
export interface ProviderAuthMethodView {
  /** Provider-local stable method identifier. */
  id: string
  /** Human-readable action label. */
  name: string
  /** Interaction the Models page must present. */
  kind: 'device-code'
}

/** Non-secret authentication state joined onto one provider row. */
export interface ProviderAuthenticationView {
  /** Whether the provider can currently authenticate model requests. */
  authenticated: boolean
  /** Human-readable credential source, when available. */
  source?: string
  /** Safe diagnostic when status could not be read. */
  error?: string
  /** Provider-owned sign-in actions. */
  methods: ProviderAuthMethodView[]
  /** Whether this provider can report current account allowance state. */
  usageSupported: boolean
}

/** One provider-account allowance window safe for browser presentation. */
export interface ProviderUsageWindowView {
  id: string
  usedPercent: number
  durationMinutes?: number
  resetsAtMs?: number
}

/** Current non-secret provider-account usage. */
export interface ProviderUsageView {
  capturedAtMs: number
  windows: ProviderUsageWindowView[]
}

/** Latest non-secret progress from a provider sign-in flow. */
export type ProviderAuthNotificationView = {
  kind: 'device-code'
  verificationUrl: string
  userCode: string
  intervalSeconds?: number
  expiresInSeconds?: number
} | {
  kind: 'progress'
  message: string
}

/** Wire view of one asynchronous provider sign-in attempt. */
export interface ProviderLoginAttemptView {
  attemptId: ProviderLoginAttemptId
  provider: string
  method: string
  state: 'starting' | 'waiting' | 'succeeded' | 'failed' | 'cancelled'
  notification?: ProviderAuthNotificationView
  error?: string
}

/** Wire view of one configurable provider. */
export interface ConfigurableProviderView {
  /** Provider route key (`deepseek-official`, `openai`, …). */
  provider: string
  /** Human-readable name for configuration surfaces. */
  displayName: string
  /** Settings namespace whose section configures this provider. */
  settingsNs: string
  /** Path from that section's root to the provider's profile object (empty = whole section). */
  settingsPath: string[]
  /** Whether the route is currently registered (its models are requestable). */
  active: boolean
  /**
   * Whether the owning adapter knows this route only because configuration
   * declared it. Absent when the adapter draws no such distinction, so a
   * surface must treat absence as "unknown", not as "shipped".
   */
  declared?: boolean
  /** Interactive authentication state when this provider registers one. */
  authentication?: ProviderAuthenticationView
}

/** Llm-domain unary methods (the map keys llm.* of RpcMethodMap). */
export interface LlmApi {
  /**
   * List every configurable provider with its live/dormant state, in
   * directory declaration order. Routes registered outside the directory
   * (an adapter that never declared configurability) are appended with their
   * registration identity and no settings address.
   */
  providers(request: RpcRequest<{}>): Promise<RpcResponse<{ providers: ConfigurableProviderView[] }>>

  /**
   * Host-scoped model catalog over every registered provider route: the
   * settings surface's models view, needing no session. Per-provider listing
   * failures ride `failures` without failing the sound groups.
   */
  models(request: RpcRequest<{}>): Promise<RpcResponse<{ groups: ModelProviderGroup[]; failures: ModelCatalogFailure[] }>>

  /**
   * Interrogate a provider endpoint the configuration surface is still
   * drafting, and return the models it advertises for the user to adopt.
   *
   * The payload is the draft, not a stored route: `settingsNs` selects the
   * adapter family that answers, and the rest comes from the form. `provider`
   * names the route being edited when there is one — an adapter that already
   * describes that route answers from its own registry, with better metadata
   * and no network call, and needs no endpoint. A route it does not describe is
   * asked over the wire, which is what `baseURL`, `api`, and `apiKey` are for.
   *
   * Nothing is written — the reply is candidates, and only a later
   * `settings.mutate` decides what a route serves. `apiKey` is accepted here
   * but never stored or returned; a provider whose key is already stored omits
   * it and the endpoint answers unauthenticated or refuses.
   */
  discoverModels(
    request: RpcRequest<{
      settingsNs: string
      provider?: string
      baseURL?: string
      api?: string
      apiKey?: string
    }>,
    signal?: AbortSignal,
  ): Promise<RpcResponse<{ models: DiscoveredModelView[] }>>

  /** Start an asynchronous provider-owned sign-in flow. */
  startProviderLogin(
    request: RpcRequest<{ provider: string; method: string }>,
  ): Promise<RpcResponse<{ attempt: ProviderLoginAttemptView }>>

  /** Poll one exact provider sign-in attempt. */
  providerLoginAttempt(
    request: RpcRequest<{ provider: string; attemptId: ProviderLoginAttemptId }>,
  ): Promise<RpcResponse<{ attempt: ProviderLoginAttemptView }>>

  /** Cancel one exact active provider sign-in attempt. */
  cancelProviderLogin(
    request: RpcRequest<{ provider: string; attemptId: ProviderLoginAttemptId }>,
  ): Promise<RpcResponse<{ attempt: ProviderLoginAttemptView }>>

  /** Remove one provider's persisted interactive credential. */
  logoutProvider(request: RpcRequest<{ provider: string }>): Promise<RpcResponse<{}>>

  /** Read current non-secret account allowance state for one provider. */
  providerUsage(
    request: RpcRequest<{ provider: string }>,
    signal?: AbortSignal,
  ): Promise<RpcResponse<{ usage?: ProviderUsageView }>>
}

/** Wire view of one model an interrogated endpoint advertises. */
export interface DiscoveredModelView {
  /** Model id the endpoint accepts. */
  id: string
  /** Human-readable name when the endpoint supplies one. */
  name?: string
  /** Maximum combined request and response context, when disclosed. */
  contextWindow?: number
  /** Maximum output tokens, when disclosed. */
  maxTokens?: number
}

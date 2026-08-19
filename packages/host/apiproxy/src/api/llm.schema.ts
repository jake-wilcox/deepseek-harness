/**
 * llm domain zod schemas (names derived from map keys: llmProvidersRequestSchema /
 * llmProvidersValueSchema / llmModelsRequestSchema / llmModelsValueSchema).
 */

import { z } from 'zod'
import type { ProviderLoginAttemptId } from '@deepseek-ai/dsh-llm/brand'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type {
  ConfigurableProviderView,
  DiscoveredModelView,
  ProviderAuthenticationView,
  ProviderAuthMethodView,
  ProviderAuthNotificationView,
  ProviderLoginAttemptView,
  ProviderUsageView,
  ProviderUsageWindowView,
} from './llm.ts'
import { modelCatalogFailureSchema, modelProviderGroupSchema } from './sessions.schema.ts'

const browserVerificationUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol
  return protocol === 'http:' || protocol === 'https:'
}, 'verification URL must use http or https')

/** ProviderAuthMethodView row. */
export const providerAuthMethodViewSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.literal('device-code'),
}) satisfies z.ZodType<Wire<ProviderAuthMethodView>>

/** ProviderAuthenticationView joined onto a provider row. */
export const providerAuthenticationViewSchema = z.object({
  authenticated: z.boolean(),
  source: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  methods: z.array(providerAuthMethodViewSchema).min(1),
  usageSupported: z.boolean(),
}) satisfies z.ZodType<Wire<ProviderAuthenticationView>>

/** Provider sign-in progress discriminated by kind. */
export const providerAuthNotificationViewSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('device-code'),
    verificationUrl: browserVerificationUrlSchema,
    userCode: z.string().min(1),
    intervalSeconds: z.number().positive().optional(),
    expiresInSeconds: z.number().positive().optional(),
  }),
  z.object({ kind: z.literal('progress'), message: z.string().min(1) }),
]) satisfies z.ZodType<Wire<ProviderAuthNotificationView>>

/** ProviderLoginAttemptView returned by lifecycle methods. */
export const providerLoginAttemptIdSchema = z.string().min(1) as unknown as z.ZodType<ProviderLoginAttemptId>

/** ProviderLoginAttemptView returned by lifecycle methods. */
export const providerLoginAttemptViewSchema = z.object({
  attemptId: providerLoginAttemptIdSchema,
  provider: z.string().min(1),
  method: z.string().min(1),
  state: z.enum(['starting', 'waiting', 'succeeded', 'failed', 'cancelled']),
  notification: providerAuthNotificationViewSchema.optional(),
  error: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<ProviderLoginAttemptView>>

/** ConfigurableProviderView row of llm.providers. */
export const configurableProviderViewSchema = z.object({
  provider: z.string().min(1),
  displayName: z.string().min(1),
  settingsNs: z.string(),
  settingsPath: z.array(z.string()),
  active: z.boolean(),
  declared: z.boolean().optional(),
  authentication: providerAuthenticationViewSchema.optional(),
}) satisfies z.ZodType<Wire<ConfigurableProviderView>>

/** llm.providers request payload. */
export const llmProvidersRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'llm.providers'>>>

/** llm.providers response value. */
export const llmProvidersValueSchema = z.object({
  providers: z.array(configurableProviderViewSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'llm.providers'>>>

/** llm.models request payload. */
export const llmModelsRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'llm.models'>>>

/** llm.models response value. */
export const llmModelsValueSchema = z.object({
  groups: z.array(modelProviderGroupSchema),
  failures: z.array(modelCatalogFailureSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'llm.models'>>>

/** DiscoveredModelView row of llm.discoverModels. */
export const discoveredModelViewSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
}) satisfies z.ZodType<Wire<DiscoveredModelView>>

/** llm.discoverModels request payload. */
export const llmDiscoverModelsRequestSchema = z.object({
  settingsNs: z.string().min(1),
  provider: z.string().min(1).optional(),
  baseURL: z.string().min(1).optional(),
  api: z.string().min(1).optional(),
  // Write-only at the host: used for this one interrogation, never stored and
  // never returned. It does ride the client's outgoing envelope like every
  // other secret-bearing payload (`credentials.set`, `settings.update`), which
  // `subscribeEnvelopes()` observers can see — redacting that tap is a
  // configuration-plane-wide change, not this method's to make alone.
  apiKey: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'llm.discoverModels'>>>

/** llm.discoverModels response value. */
export const llmDiscoverModelsValueSchema = z.object({
  models: z.array(discoveredModelViewSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'llm.discoverModels'>>>

/** llm.startProviderLogin request payload. */
export const llmStartProviderLoginRequestSchema = z.object({
  provider: z.string().min(1),
  method: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'llm.startProviderLogin'>>>

/** llm.startProviderLogin response value. */
export const llmStartProviderLoginValueSchema = z.object({
  attempt: providerLoginAttemptViewSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'llm.startProviderLogin'>>>

/** Shared request payload for exact provider login attempts. */
const providerLoginAttemptRequestSchema = z.object({
  provider: z.string().min(1),
  attemptId: providerLoginAttemptIdSchema,
})

/** llm.providerLoginAttempt request payload. */
export const llmProviderLoginAttemptRequestSchema = providerLoginAttemptRequestSchema satisfies z.ZodType<Wire<RequestPayload<'llm.providerLoginAttempt'>>>

/** llm.providerLoginAttempt response value. */
export const llmProviderLoginAttemptValueSchema = z.object({
  attempt: providerLoginAttemptViewSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'llm.providerLoginAttempt'>>>

/** llm.cancelProviderLogin request payload. */
export const llmCancelProviderLoginRequestSchema = providerLoginAttemptRequestSchema satisfies z.ZodType<Wire<RequestPayload<'llm.cancelProviderLogin'>>>

/** llm.cancelProviderLogin response value. */
export const llmCancelProviderLoginValueSchema = z.object({
  attempt: providerLoginAttemptViewSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'llm.cancelProviderLogin'>>>

/** llm.logoutProvider request payload. */
export const llmLogoutProviderRequestSchema = z.object({ provider: z.string().min(1) }) satisfies z.ZodType<Wire<RequestPayload<'llm.logoutProvider'>>>

/** llm.logoutProvider response value. */
export const llmLogoutProviderValueSchema = z.object({}) satisfies z.ZodType<Wire<ResponseValue<'llm.logoutProvider'>>>

/** One provider account allowance window. */
export const providerUsageWindowViewSchema = z.object({
  id: z.string().min(1),
  usedPercent: z.number().min(0).max(100),
  durationMinutes: z.number().positive().optional(),
  resetsAtMs: z.number().int().nonnegative().optional(),
}) satisfies z.ZodType<Wire<ProviderUsageWindowView>>

/** Current provider account allowance state. */
export const providerUsageViewSchema = z.object({
  capturedAtMs: z.number().int().nonnegative(),
  windows: z.array(providerUsageWindowViewSchema).min(1),
}) satisfies z.ZodType<Wire<ProviderUsageView>>

/** llm.providerUsage request payload. */
export const llmProviderUsageRequestSchema = z.object({
  provider: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'llm.providerUsage'>>>

/** llm.providerUsage response value. */
export const llmProviderUsageValueSchema = z.object({
  usage: providerUsageViewSchema.optional(),
}) satisfies z.ZodType<Wire<ResponseValue<'llm.providerUsage'>>>

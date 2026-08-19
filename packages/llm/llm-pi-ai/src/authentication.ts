/** Provider-authentication registrations backed by pi-ai login flows. */

import { createModels } from '@earendil-works/pi-ai'
import type { AuthEvent, AuthPrompt, CredentialStore, MutableModels } from '@earendil-works/pi-ai'
import { assertNever, attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  LlmProviderAuthentication,
  LlmProviderAuthInteraction,
  LlmProviderAuthNotification,
  LlmProviderUsageSnapshot,
  LlmProviderUsageWindow,
} from '@deepseek-ai/dsh-llm'
import { catalogProvider } from './catalog.ts'

const OPENAI_CODEX = 'openai-codex'
const DEVICE_CODE_METHOD = 'chatgpt-device-code'
const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api'
/** Account usage is a small status document; cap it before JSON parsing. */
const MAX_USAGE_RESPONSE_BYTES = 256 * 1024

/** Stop between provider-owned credential operations when the consumer leaves. */
function assertUsageActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new LlmError('OpenAI Codex usage request was cancelled', 'ABORTED')
}

/** Resolve the official usage path style from one configured Codex base URL. */
function usageUrl(baseURL: string): string {
  const url = new URL(baseURL)
  const normalizedPath = url.pathname.replace(/\/+$/, '')
  const chatGptHost = url.hostname === 'chatgpt.com' || url.hostname === 'chat.openai.com'
  if (chatGptHost && (normalizedPath === '' || normalizedPath === '/backend-api')) {
    url.pathname = `${normalizedPath || '/backend-api'}/wham/usage`
  } else {
    url.pathname = normalizedPath.endsWith('/api/codex')
      ? `${normalizedPath}/usage`
      : `${normalizedPath}/api/codex/usage`
  }
  url.search = ''
  url.hash = ''
  return url.toString()
}

/** Read an HTTP body with a complete-result byte bound. */
async function readUsageBody(response: Response, url: string): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  const oversized = (): LlmError => new LlmError(
    `${url} answered with more than ${MAX_USAGE_RESPONSE_BYTES} bytes`,
    'PROVIDER_USAGE_FAILED',
  )
  if (Number.isFinite(declared) && declared > MAX_USAGE_RESPONSE_BYTES) throw oversized()
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const result = await reader.read()
    if (result.done) break
    total += result.value.byteLength
    if (total > MAX_USAGE_RESPONSE_BYTES) {
      await reader.cancel()
      throw oversized()
    }
    chunks.push(result.value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/** Narrow an external JSON value to a record. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Parse one optional Codex allowance window. */
function usageWindow(id: string, value: unknown): LlmProviderUsageWindow | undefined {
  if (value === undefined || value === null) return undefined
  const record = recordOf(value)
  const usedPercent = record?.['used_percent']
  if (record === undefined || typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)
    || usedPercent < 0 || usedPercent > 100) {
    throw new LlmError(`OpenAI Codex returned an invalid ${id} usage window`, 'PROVIDER_USAGE_FAILED')
  }
  const durationSeconds = record['limit_window_seconds']
  const resetsAtSeconds = record['reset_at']
  if (durationSeconds !== undefined
    && (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0)) {
    throw new LlmError(`OpenAI Codex returned an invalid ${id} window duration`, 'PROVIDER_USAGE_FAILED')
  }
  if (resetsAtSeconds !== undefined
    && (typeof resetsAtSeconds !== 'number' || !Number.isFinite(resetsAtSeconds) || resetsAtSeconds <= 0
      || !Number.isSafeInteger(resetsAtSeconds * 1000))) {
    throw new LlmError(`OpenAI Codex returned an invalid ${id} reset time`, 'PROVIDER_USAGE_FAILED')
  }
  return {
    id,
    usedPercent,
    ...durationSeconds === undefined ? {} : { durationMinutes: durationSeconds / 60 },
    ...resetsAtSeconds === undefined ? {} : { resetsAtMs: resetsAtSeconds * 1000 },
  }
}

/** Parse the narrow non-secret subset used by Harness presentation. */
function usageSnapshot(value: unknown): LlmProviderUsageSnapshot {
  const root = recordOf(value)
  const limits = recordOf(root?.['rate_limit'])
  if (root === undefined || limits === undefined) {
    throw new LlmError('OpenAI Codex returned an invalid usage response', 'PROVIDER_USAGE_FAILED')
  }
  const windows = [
    usageWindow('primary', limits['primary_window']),
    usageWindow('secondary', limits['secondary_window']),
  ].filter((window): window is LlmProviderUsageWindow => window !== undefined)
  if (windows.length === 0) {
    throw new LlmError('OpenAI Codex returned no usage windows', 'PROVIDER_USAGE_FAILED')
  }
  return { capturedAtMs: Date.now(), windows }
}

/** Translate pi-ai's closed auth-event union into the LLM seam's progress vocabulary. */
function notification(event: AuthEvent): LlmProviderAuthNotification {
  switch (event.type) {
    case 'device_code':
      return {
        kind: 'device-code',
        verificationUrl: event.verificationUri,
        userCode: event.userCode,
        ...event.intervalSeconds === undefined ? {} : { intervalSeconds: event.intervalSeconds },
        ...event.expiresInSeconds === undefined ? {} : { expiresInSeconds: event.expiresInSeconds },
      }
    case 'progress':
      return { kind: 'progress', message: event.message }
    case 'info':
      return { kind: 'progress', message: event.message }
    case 'auth_url':
      throw new Error('llm-pi-ai: device-code login unexpectedly requested browser callback authentication')
    /* v8 ignore next -- exhaustive over pi-ai's closed authentication-event union. */
    default:
      return assertNever(event, 'llm-pi-ai auth event')
  }
}

/** Device-code mode answers only the provider's initial login-method selector. */
function answerDeviceCodePrompt(prompt: AuthPrompt): Promise<string> {
  switch (prompt.type) {
    case 'select':
      if (prompt.options.some(option => option.id === 'device_code')) return Promise.resolve('device_code')
      throw new Error('llm-pi-ai: OpenAI Codex login did not offer device-code authentication')
    case 'text':
    case 'secret':
    case 'manual_code':
      throw new Error(`llm-pi-ai: device-code login unexpectedly requested a ${prompt.type} prompt`)
    /* v8 ignore next -- exhaustive over pi-ai's closed authentication-prompt union. */
    default:
      return assertNever(prompt, 'llm-pi-ai auth prompt')
  }
}

/**
 * Build the OpenAI Codex subscription sign-in implementation.
 * @param credentials - durable pi-ai credential store shared with streaming.
 * @param resolveBaseURL - current Codex endpoint; omission uses the native ChatGPT base.
 * @returns provider-neutral login, status, logout, and account-usage operations.
 */
export function openAiCodexAuthentication(
  credentials: CredentialStore,
  resolveBaseURL: () => string | undefined = () => undefined,
): LlmProviderAuthentication {
  const models: MutableModels = createModels({ credentials })
  const provider = catalogProvider(OPENAI_CODEX)
  if (provider === undefined || provider.auth.oauth === undefined) {
    throw new Error('llm-pi-ai: the installed catalog has no OpenAI Codex OAuth provider')
  }
  models.setProvider(provider)
  return {
    methods: [{ id: DEVICE_CODE_METHOD, name: 'Sign in with ChatGPT', kind: 'device-code' }],
    status: async () => {
      const check = await models.checkAuth(OPENAI_CODEX)
      return {
        authenticated: check?.type === 'oauth',
        ...check?.source === undefined ? {} : { source: check.source },
      }
    },
    login: async (method: string, interaction: LlmProviderAuthInteraction) => {
      if (method !== DEVICE_CODE_METHOD) {
        throw new Error(`llm-pi-ai: unknown OpenAI Codex authentication method "${method}"`)
      }
      await models.login(OPENAI_CODEX, 'oauth', {
        signal: interaction.signal,
        prompt: answerDeviceCodePrompt,
        notify: (event) => {
          interaction.notify(notification(event))
        },
      })
    },
    logout: () => models.logout(OPENAI_CODEX),
    usage: async (signal) => {
      assertUsageActive(signal)
      let auth
      try {
        auth = await models.getAuth(OPENAI_CODEX)
      } catch (error: unknown) {
        throw new LlmError('OpenAI Codex authentication is unavailable', 'PROVIDER_USAGE_FAILED', { cause: error })
      }
      assertUsageActive(signal)
      const accessToken = auth?.auth.apiKey
      const credential = await credentials.read(OPENAI_CODEX)
      assertUsageActive(signal)
      const accountId = credential?.type === 'oauth' ? credential.accountId : undefined
      if (typeof accessToken !== 'string' || accessToken.length === 0
        || typeof accountId !== 'string' || accountId.length === 0) {
        throw new LlmError('Sign in to OpenAI Codex to view subscription usage', 'PROVIDER_USAGE_UNAVAILABLE')
      }
      let url: string
      try {
        url = usageUrl(resolveBaseURL() ?? DEFAULT_CODEX_BASE_URL)
      } catch (error: unknown) {
        throw new LlmError('OpenAI Codex has an invalid usage endpoint', 'PROVIDER_USAGE_FAILED', { cause: error })
      }
      let response: Response
      try {
        response = await fetch(url, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${accessToken}`,
            'ChatGPT-Account-Id': accountId,
            ...attributionHeaders(),
          },
          ...signal === undefined ? {} : { signal },
        })
      } catch (error: unknown) {
        if (signal?.aborted) {
          throw new LlmError('OpenAI Codex usage request was cancelled', 'ABORTED', { cause: error })
        }
        throw new LlmError('Could not reach OpenAI Codex usage', 'PROVIDER_USAGE_FAILED', { cause: error })
      }
      if (!response.ok) {
        const authenticationHint = response.status === 401 || response.status === 403 ? '; sign in again' : ''
        throw new LlmError(
          `OpenAI Codex usage answered ${response.status}${authenticationHint}`,
          'PROVIDER_USAGE_FAILED',
          { status: response.status },
        )
      }
      let text: string
      try {
        text = await readUsageBody(response, url)
      } catch (error: unknown) {
        if (signal?.aborted) {
          throw new LlmError('OpenAI Codex usage request was cancelled', 'ABORTED', { cause: error })
        }
        throw error
      }
      let value: unknown
      try {
        value = JSON.parse(text) as unknown
      } catch (error: unknown) {
        throw new LlmError('OpenAI Codex usage did not return JSON', 'PROVIDER_USAGE_FAILED', { cause: error })
      }
      return usageSnapshot(value)
    },
  }
}

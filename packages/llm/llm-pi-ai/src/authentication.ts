/** Provider-authentication registrations backed by pi-ai login flows. */

import { createModels } from '@earendil-works/pi-ai'
import type { AuthEvent, AuthPrompt, CredentialStore, MutableModels } from '@earendil-works/pi-ai'
import { assertNever } from '@deepseek-ai/dsh-llm'
import type {
  LlmProviderAuthentication,
  LlmProviderAuthInteraction,
  LlmProviderAuthNotification,
} from '@deepseek-ai/dsh-llm'
import { catalogProvider } from './catalog.ts'

const OPENAI_CODEX = 'openai-codex'
const DEVICE_CODE_METHOD = 'chatgpt-device-code'

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
 * @returns provider-neutral login, status, and logout operations.
 */
export function openAiCodexAuthentication(credentials: CredentialStore): LlmProviderAuthentication {
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
  }
}

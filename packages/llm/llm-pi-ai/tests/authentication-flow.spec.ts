import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthInteraction } from '@earendil-works/pi-ai'
import type { LlmProviderAuthInteraction } from '@deepseek-ai/dsh-llm'

const models = vi.hoisted(() => ({
  setProvider: vi.fn(),
  checkAuth: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
}))

vi.mock('@earendil-works/pi-ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-ai')>()
  return { ...actual, createModels: () => models }
})

import { openAiCodexAuthentication } from '../src/authentication.ts'

const interaction = (): LlmProviderAuthInteraction => ({
  signal: new AbortController().signal,
  notify: vi.fn(),
})

beforeEach(() => {
  models.setProvider.mockReset()
  models.checkAuth.mockReset()
  models.login.mockReset()
  models.logout.mockReset()
})

describe('OpenAI Codex pi-ai authentication flow', () => {
  it('projects status and delegates logout to the installed provider', async () => {
    const authentication = openAiCodexAuthentication({} as never)
    expect(models.setProvider).toHaveBeenCalledWith(expect.objectContaining({ id: 'openai-codex' }))

    models.checkAuth.mockResolvedValueOnce(undefined)
    await expect(authentication.status()).resolves.toEqual({ authenticated: false })
    models.checkAuth.mockResolvedValueOnce({ type: 'api_key' })
    await expect(authentication.status()).resolves.toEqual({ authenticated: false })
    models.checkAuth.mockResolvedValueOnce({ type: 'oauth', source: 'OAuth' })
    await expect(authentication.status()).resolves.toEqual({ authenticated: true, source: 'OAuth' })

    models.logout.mockResolvedValue(undefined)
    await authentication.logout()
    expect(models.logout).toHaveBeenCalledWith('openai-codex')
  })

  it('selects device-code login and translates every supported notification', async () => {
    const authentication = openAiCodexAuthentication({} as never)
    const notify = vi.fn()
    const active: LlmProviderAuthInteraction = { signal: new AbortController().signal, notify }
    models.login.mockImplementation(async (_provider: string, _type: string, sdk: AuthInteraction) => {
      await expect(sdk.prompt({
        type: 'select',
        message: 'Choose a method',
        options: [{ id: 'browser', label: 'Browser' }, { id: 'device_code', label: 'Device code' }],
      })).resolves.toBe('device_code')
      sdk.notify({ type: 'device_code', verificationUri: 'https://example.test/device', userCode: 'ABCD' })
      sdk.notify({
        type: 'device_code',
        verificationUri: 'https://example.test/device',
        userCode: 'EFGH',
        intervalSeconds: 5,
        expiresInSeconds: 900,
      })
      sdk.notify({ type: 'progress', message: 'Waiting' })
      sdk.notify({ type: 'info', message: 'Approved' })
      return {} as never
    })

    await authentication.login('chatgpt-device-code', active)
    expect(models.login).toHaveBeenCalledWith('openai-codex', 'oauth', expect.objectContaining({
      signal: active.signal,
    }))
    expect(notify).toHaveBeenNthCalledWith(1, {
      kind: 'device-code',
      verificationUrl: 'https://example.test/device',
      userCode: 'ABCD',
    })
    expect(notify).toHaveBeenNthCalledWith(2, {
      kind: 'device-code',
      verificationUrl: 'https://example.test/device',
      userCode: 'EFGH',
      intervalSeconds: 5,
      expiresInSeconds: 900,
    })
    expect(notify).toHaveBeenNthCalledWith(3, { kind: 'progress', message: 'Waiting' })
    expect(notify).toHaveBeenNthCalledWith(4, { kind: 'progress', message: 'Approved' })
  })

  it('rejects unsupported methods, prompts, and callback-style authentication', async () => {
    const authentication = openAiCodexAuthentication({} as never)
    await expect(authentication.login('unknown', interaction())).rejects.toThrow('unknown OpenAI Codex')

    const prompts = [
      { type: 'select', message: 'Choose', options: [{ id: 'browser', label: 'Browser' }] },
      { type: 'text', message: 'Text' },
      { type: 'secret', message: 'Secret' },
      { type: 'manual_code', message: 'Code' },
    ] as const
    for (const prompt of prompts) {
      models.login.mockImplementationOnce(async (_provider: string, _type: string, sdk: AuthInteraction) => {
        await sdk.prompt(prompt)
        return {} as never
      })
      await expect(authentication.login('chatgpt-device-code', interaction())).rejects.toThrow()
    }

    models.login.mockImplementationOnce(async (_provider: string, _type: string, sdk: AuthInteraction) => {
      sdk.notify({ type: 'auth_url', url: 'https://example.test/callback' })
      return {} as never
    })
    await expect(authentication.login('chatgpt-device-code', interaction()))
      .rejects.toThrow('browser callback authentication')
  })
})

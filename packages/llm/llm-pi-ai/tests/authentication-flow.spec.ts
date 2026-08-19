import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthInteraction } from '@earendil-works/pi-ai'
import type { LlmProviderAuthInteraction } from '@deepseek-ai/dsh-llm'

const models = vi.hoisted(() => ({
  setProvider: vi.fn(),
  checkAuth: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  getAuth: vi.fn(),
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
  models.getAuth.mockReset()
})

afterEach(() => { vi.unstubAllGlobals() })

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

  it('refreshes Harness OAuth and maps provider usage windows without exposing credentials', async () => {
    const credentials = {
      read: vi.fn(() => Promise.resolve({ type: 'oauth', accountId: 'account-1' })),
    }
    models.getAuth.mockResolvedValue({ auth: { apiKey: 'fresh-token' } })
    let requestInput: RequestInfo | URL | undefined
    let requestInit: RequestInit | undefined
    const request = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      requestInput = input
      requestInit = init
      return Promise.resolve(new Response(JSON.stringify({
        plan_type: 'plus',
        rate_limit: {
          primary_window: { used_percent: 25.5, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
          secondary_window: { used_percent: 60, limit_window_seconds: 604_800, reset_at: 1_800_600_000 },
        },
      }), { headers: { 'content-type': 'application/json' } }))
    })
    vi.stubGlobal('fetch', request)
    const authentication = openAiCodexAuthentication(credentials as never)
    const signal = new AbortController().signal

    const usage = await authentication.usage?.(signal)
    expect(usage?.capturedAtMs).toBeGreaterThan(0)
    expect(usage?.windows).toEqual([
      { id: 'primary', usedPercent: 25.5, durationMinutes: 300, resetsAtMs: 1_800_000_000_000 },
      { id: 'secondary', usedPercent: 60, durationMinutes: 10_080, resetsAtMs: 1_800_600_000_000 },
    ])
    expect(models.getAuth).toHaveBeenCalledWith('openai-codex')
    expect(credentials.read).toHaveBeenCalledWith('openai-codex')
    expect(requestInput).toBe('https://chatgpt.com/backend-api/wham/usage')
    expect(requestInit?.signal).toBe(signal)
    const requestHeaders = new Headers(requestInit?.headers)
    expect(requestHeaders.get('authorization')).toBe('Bearer fresh-token')
    expect(requestHeaders.get('ChatGPT-Account-Id')).toBe('account-1')
    expect(JSON.stringify(await authentication.usage?.())).not.toContain('fresh-token')
    expect(JSON.stringify(await authentication.usage?.())).not.toContain('account-1')
  })

  it('stops after an OAuth refresh when the usage reader is cancelled', async () => {
    const credentials = { read: vi.fn() }
    const authGate = Promise.withResolvers<{ auth: { apiKey: string } }>()
    models.getAuth.mockReturnValue(authGate.promise)
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    const authentication = openAiCodexAuthentication(credentials as never)
    const controller = new AbortController()

    const pending = authentication.usage?.(controller.signal)
    controller.abort()
    authGate.resolve({ auth: { apiKey: 'fresh-token' } })
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    expect(credentials.read).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('uses configured Codex API bases and rejects missing or malformed usage', async () => {
    const credentials = { read: vi.fn(() => Promise.resolve({ type: 'oauth', accountId: 'account-1' })) }
    models.getAuth.mockResolvedValue({ auth: { apiKey: 'token' } })
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ rate_limit: {
        primary_window: { used_percent: 0, limit_window_seconds: 60, reset_at: 1_800_000_000 },
      } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ rate_limit: {} })))
    vi.stubGlobal('fetch', request)
    const authentication = openAiCodexAuthentication(credentials as never, () => 'https://example.test/api/codex')
    await expect(authentication.usage?.()).resolves.toMatchObject({ windows: [{ id: 'primary', usedPercent: 0 }] })
    expect(request).toHaveBeenNthCalledWith(1, 'https://example.test/api/codex/usage', expect.any(Object))
    await expect(authentication.usage?.()).rejects.toMatchObject({ code: 'PROVIDER_USAGE_FAILED' })

    models.getAuth.mockResolvedValue({ auth: { apiKey: '' } })
    await expect(authentication.usage?.()).rejects.toMatchObject({ code: 'PROVIDER_USAGE_UNAVAILABLE' })
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

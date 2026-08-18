import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  CredentialProvider,
  credentialRef,
} from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo as HarnessCredentialInfo,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { HarnessCredentialStore, PiAiAdapter, piAiCredentialRef } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveProfiles } from '../src/config.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

afterEach(closeMockServers)

class MemoryCredentials extends CredentialProvider {
  private readonly values = new Map<CredentialRef, string>()
  private readonly chains = new Map<CredentialRef, Promise<void>>()

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'memory' })
  }

  override describe(ref: CredentialRef): Promise<HarnessCredentialInfo> {
    return Promise.resolve({ configured: this.values.has(ref), source: 'memory', writable: true })
  }

  override async modify(
    ref: CredentialRef,
    update: (current: string | undefined) => Promise<string | undefined>,
  ): Promise<string | undefined> {
    const prior = this.chains.get(ref) ?? Promise.resolve()
    const done = Promise.withResolvers<undefined>()
    this.chains.set(ref, prior.then(() => done.promise))
    await prior
    try {
      const current = this.values.get(ref)
      const next = await update(current)
      if (next !== undefined) this.values.set(ref, next)
      return next ?? current
    } finally {
      done.resolve(undefined)
    }
  }

  override set(ref: CredentialRef, value: string): Promise<void> {
    this.values.set(ref, value)
    return Promise.resolve()
  }

  override unset(ref: CredentialRef): Promise<void> {
    this.values.delete(ref)
    return Promise.resolve()
  }
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(MemoryCredentials)
  return ctx
}

describe('pi-ai credential store', () => {
  it('round-trips OAuth extras through a deterministic secret reference', async () => {
    const ctx = await setup()
    const store = new HarnessCredentialStore(ctx.credentials, ['openai-codex'])
    const credential = {
      type: 'oauth' as const,
      refresh: 'refresh-token',
      access: 'access-token',
      expires: Date.now() + 60_000,
      accountId: 'account-1',
    }
    await expect(store.modify('openai-codex', async () => credential)).resolves.toEqual(credential)
    await expect(store.read('openai-codex')).resolves.toEqual(credential)
    await expect(store.list()).resolves.toEqual([{ providerId: 'openai-codex', type: 'oauth' }])
    await expect(ctx.credentials.resolve(piAiCredentialRef('openai-codex'))).resolves.toMatchObject({
      source: 'memory',
    })
    await store.delete('openai-codex')
    await expect(store.read('openai-codex')).resolves.toBeUndefined()
  })

  it('rejects malformed durable JSON without echoing its secret value', async () => {
    const ctx = await setup()
    const store = new HarnessCredentialStore(ctx.credentials, ['openai-codex'])
    await ctx.credentials.set(piAiCredentialRef('openai-codex'), 'not-json-secret')
    const read = store.read('openai-codex')
    await expect(read).rejects.toThrow('not valid JSON')
    await expect(read).rejects.not.toThrow('not-json-secret')
  })

  it('rejects provider ids whose normalized references collide', async () => {
    const ctx = await setup()
    expect(() => new HarnessCredentialStore(ctx.credentials, ['a-b', 'a_b'])).toThrow(/same credential reference/)
    expect(credentialRef('DSH_PI_AI_OPENAI_CODEX_AUTH')).toBe(piAiCredentialRef('openai-codex'))
  })

  it.each([
    ['null', 'must be an object'],
    ['[]', 'must be an object'],
    ['"text"', 'must be an object'],
    ['{"type":"oauth","refresh":1,"access":"access","expires":1}', 'stored OAuth authentication'],
    ['{"type":"oauth","refresh":"","access":"access","expires":1}', 'stored OAuth authentication'],
    ['{"type":"oauth","refresh":"refresh","access":1,"expires":1}', 'stored OAuth authentication'],
    ['{"type":"oauth","refresh":"refresh","access":"","expires":1}', 'stored OAuth authentication'],
    ['{"type":"oauth","refresh":"refresh","access":"access","expires":"soon"}', 'stored OAuth authentication'],
    ['{"type":"oauth","refresh":"refresh","access":"access","expires":1e999}', 'stored OAuth authentication'],
    ['{"type":"api_key","key":1}', 'invalid key'],
    ['{"type":"api_key","key":""}', 'invalid key'],
    ['{"type":"api_key","env":null}', 'invalid environment values'],
    ['{"type":"api_key","env":"bad"}', 'invalid environment values'],
    ['{"type":"api_key","env":[]}', 'invalid environment values'],
    ['{"type":"api_key","env":{"TOKEN":1}}', 'invalid environment values'],
    ['{"type":"unknown"}', 'unknown type'],
  ])('rejects invalid stored credential %s', async (raw, message) => {
    const ctx = await setup()
    const store = new HarnessCredentialStore(ctx.credentials, ['provider'])
    await ctx.credentials.set(piAiCredentialRef('provider'), raw)
    await expect(store.read('provider')).rejects.toThrow(message)
  })

  it('round-trips API-key credentials and omits providers with no stored value', async () => {
    const ctx = await setup()
    const store = new HarnessCredentialStore(ctx.credentials, ['keyed', 'missing'])
    const credential = { type: 'api_key' as const, key: 'secret', env: { REGION: 'test' } }
    await expect(store.modify('keyed', async () => credential)).resolves.toEqual(credential)
    await expect(store.modify('keyed', async current => current)).resolves.toEqual(credential)
    await expect(store.modify('keyed', async () => undefined)).resolves.toEqual(credential)
    await expect(store.modify('missing', async () => undefined)).resolves.toBeUndefined()
    await expect(store.list()).resolves.toEqual([{ providerId: 'keyed', type: 'api_key' }])
  })

  it('rejects invalid or non-serializable callback results', async () => {
    const ctx = await setup()
    const store = new HarnessCredentialStore(ctx.credentials, ['provider'])
    await expect(store.modify('provider', async () => ({ type: 'oauth' } as never)))
      .rejects.toThrow('stored OAuth authentication')

    const circular: Record<string, unknown> = { type: 'api_key' }
    circular['self'] = circular
    await expect(store.modify('provider', async () => circular as never))
      .rejects.toThrow('not JSON-serializable')
  })

  it('rejects operations for providers outside the collision-checked inventory', async () => {
    const ctx = await setup()
    const store = new HarnessCredentialStore(ctx.credentials, ['known'])
    await expect(store.read('unknown')).rejects.toThrow('does not know provider')
    await expect(store.modify('unknown', async () => undefined)).rejects.toThrow('does not know provider')
    await expect(store.delete('unknown')).rejects.toThrow('does not know provider')
  })
})

describe('OpenAI Codex authentication registration', () => {
  it('offers the catalog route and reports stored OAuth state through the LLM seam', async () => {
    const ctx = await setup()
    await ctx.plugin(LlmPiAi, {})

    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider)).toContain('openai-codex')
    await expect(ctx.llm.providerAuthentication('openai-codex')).resolves.toEqual({
      provider: 'openai-codex',
      methods: [{ id: 'chatgpt-device-code', name: 'Sign in with ChatGPT', kind: 'device-code' }],
      authenticated: false,
    })

    await ctx.credentials.set(piAiCredentialRef('openai-codex'), JSON.stringify({
      type: 'oauth',
      refresh: 'refresh-token',
      access: 'access-token',
      expires: Date.now() + 60_000,
      accountId: 'account-1',
    }))
    await expect(ctx.llm.providerAuthentication('openai-codex')).resolves.toMatchObject({
      authenticated: true,
      source: 'OAuth',
    })
  })

  it('uses the same durable OAuth store on the normal model stream path', async () => {
    const ctx = await setup()
    const store = new HarnessCredentialStore(ctx.credentials, ['openai-codex'])
    const payload = Buffer.from(JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' },
    })).toString('base64url')
    const access = `e30.${payload}.signature`
    await store.modify('openai-codex', async () => ({
      type: 'oauth',
      refresh: 'refresh-token',
      access,
      expires: Date.now() + 60_000,
      accountId: 'account-1',
    }))
    const server = await mockServer([{
      status: 400,
      body: '{"error":{"message":"expected test rejection"}}',
      parseJson: false,
    }])
    const profiles = resolveProfiles({ 'openai-codex': { baseURL: server.url, transport: 'sse' } })
    const adapter = new PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: () => Promise.resolve(undefined),
      resolveCredentialStore: () => store,
    })

    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({ provider: 'openai-codex', model: 'gpt-5.4-mini', messages: [] })) {
      chunks.push(chunk)
    }

    expect(server.paths).toEqual(['/codex/responses'])
    expect(server.headers[0]).toMatchObject({
      authorization: `Bearer ${access}`,
      'chatgpt-account-id': 'account-1',
    })
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'expected test rejection' } },
    })
  })

  it('follows a credential service that mounts after the adapter', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {})
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider)).not.toContain('openai-codex')

    const credentials = await ctx.plugin(MemoryCredentials)
    await vi.waitFor(() => {
      expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider)).toContain('openai-codex')
    })
    await expect(ctx.llm.providerAuthentication('openai-codex')).resolves.toBeDefined()

    await credentials.dispose()
    await vi.waitFor(() => {
      expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider)).not.toContain('openai-codex')
    })
    await expect(ctx.llm.providerAuthentication('openai-codex')).resolves.toBeUndefined()
  })
})

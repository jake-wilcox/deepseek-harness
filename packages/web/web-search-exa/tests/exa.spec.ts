import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import WebRuntime from '@deepseek-ai/dsh-web'
import { ExaSearchProvider, EXA_PROVIDER_ID } from '@deepseek-ai/dsh-web-search-exa'
import * as exaPlugin from '@deepseek-ai/dsh-web-search-exa'
import { mapExaResponse, mapExaResult } from '../src/provider.ts'

/** Construct the provider over a fixed options value; production passes a live thunk. */
import type { ExaSearchProviderOptions } from '@deepseek-ai/dsh-web-search-exa'

const searchProvider = (options: ExaSearchProviderOptions): ExaSearchProvider =>
  new ExaSearchProvider(() => options)

const options = { apiKey: 'exa-key', baseURL: 'https://api.exa.test', searchType: 'auto' as const, highlightsPerResult: 1 }

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Exa result mapping', () => {
  it('maps a full result entry', () => {
    expect(mapExaResult({
      url: 'https://a.test',
      title: 'A',
      publishedDate: '2026-01-01',
      highlights: ['salient sentence', 'second'],
    })).toEqual({ url: 'https://a.test', title: 'A', snippet: 'salient sentence', publishedAt: '2026-01-01' })
  })

  it('drops a result with no usable highlight', () => {
    expect(mapExaResult({ url: 'https://a.test', highlights: [] })).toBeUndefined()
    expect(mapExaResult({ url: 'https://a.test' })).toBeUndefined()
    expect(mapExaResult({ url: 'https://a.test', highlights: ['  '] })).toBeUndefined()
  })

  it('omits null/empty optional fields rather than emitting them', () => {
    expect(mapExaResult({ url: 'https://a.test', title: null, publishedDate: null, highlights: ['hi'] }))
      .toEqual({ url: 'https://a.test', snippet: 'hi' })
    expect(mapExaResult({ url: 'https://a.test', title: '', publishedDate: '', highlights: ['hi'] }))
      .toEqual({ url: 'https://a.test', snippet: 'hi' })
  })

  it('maps a response to a result with no content and filtered sources', () => {
    const result = mapExaResponse({
      results: [
        { url: 'https://a.test', highlights: ['one'] },
        { url: 'https://b.test' },
        { url: 'https://c.test', title: 'C', highlights: ['three'] },
      ],
    })
    expect(result).toEqual({
      sources: [
        { url: 'https://a.test', snippet: 'one' },
        { url: 'https://c.test', title: 'C', snippet: 'three' },
      ],
      truncated: false,
    })
    expect(result.content).toBeUndefined()
  })

  it('tolerates a missing results array', () => {
    expect(mapExaResponse({}).sources).toEqual([])
  })

})

describe('ExaSearchProvider availability', () => {
  it('is unavailable without a key', () => {
    expect(searchProvider({ ...options, apiKey: '' }).available()).toBe(false)
  })

  it('is available with a key', () => {
    expect(searchProvider(options).available()).toBe(true)
  })

  it('is misconfigured when the base URL is unparseable', () => {
    expect(searchProvider({ ...options, baseURL: 'not a url' }).available()).toBe(false)
  })

  it('is misconfigured when highlightsPerResult is not a positive integer', () => {
    expect(searchProvider({ ...options, highlightsPerResult: 0 }).available()).toBe(false)
    expect(searchProvider({ ...options, highlightsPerResult: 1.5 }).available()).toBe(false)
  })

  it('is misconfigured when numResults is set but not a positive integer', () => {
    expect(searchProvider({ ...options, numResults: -1 }).available()).toBe(false)
  })
})

describe('ExaSearchProvider request mapping', () => {
  it('sends query, type, highlights, numResults and bearer auth', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [{ url: 'https://a.test', highlights: ['hi'] }] }))
    vi.stubGlobal('fetch', fetchMock)

    const provider = searchProvider({ ...options, searchType: 'neural', highlightsPerResult: 3 })
    await provider.search({ query: 'hello', maxResults: 5 })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.exa.test/search')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer exa-key')
    expect(JSON.parse(init.body as string)).toEqual({
      query: 'hello',
      type: 'neural',
      contents: { highlights: { highlightsPerUrl: 3 } },
      numResults: 5,
    })
  })

  it('falls back to the configured numResults when a request omits maxResults', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider({ ...options, numResults: 7 }).search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ numResults: 7 })
  })

  it('lets a request maxResults win over the configured numResults', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider({ ...options, numResults: 7 }).search({ query: 'q', maxResults: 2 })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ numResults: 2 })
  })

  it('omits numResults when neither maxResults nor a configured default is set', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider(options).search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).not.toHaveProperty('numResults')
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await searchProvider(options).search({ query: 'q' }, controller.signal)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })
})

describe('ExaSearchProvider error handling', () => {
  it('maps an HTTP error to WEB_PROVIDER_ERROR with the provider message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'bad key' }, { status: 401 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'bad key' }))
  })

  it('keeps a status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway down', { status: 502 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Exa API error (HTTP 502)' }))
  })

  it('keeps the status-line message when the JSON error body carries no detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 500 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Exa API error (HTTP 500)' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps a well-formed body of the wrong shape to WEB_PROVIDER_ERROR, not a raw TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: {} }, { status: 200 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED, not provider error', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('surfaces an abort during error-body parse as WEB_ABORTED', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: false, status: 500 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})

describe('web-search-exa plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [] })))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: EXA_PROVIDER_ID })
    const fiber = await ctx.plugin(exaPlugin, { apiKey: 'exa-key' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [], truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in exaPlugin).toBe(false)
  })

  it('threads searchType, highlightsPerResult and numResults config into the request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: EXA_PROVIDER_ID })
    const fiber = await ctx.plugin(exaPlugin, { apiKey: 'exa-key', searchType: 'keyword', highlightsPerResult: 2, numResults: 9 })
    await ctx.web.search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ type: 'keyword', contents: { highlights: { highlightsPerUrl: 2 } }, numResults: 9 })
    await fiber.dispose()
  })

  it('falls back to $EXA_API_KEY and the default base URL when config omits them', async () => {
    const prev = process.env.EXA_API_KEY
    process.env.EXA_API_KEY = 'env-key'
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: EXA_PROVIDER_ID })
      const fiber = await ctx.plugin(exaPlugin, {})
      await ctx.web.search({ query: 'q' })
      const [url] = fetchMock.mock.calls[0] as unknown as [string]
      expect(url).toBe('https://api.exa.ai/search')
      await fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.EXA_API_KEY
      else process.env.EXA_API_KEY = prev
    }
  })

  // Superseded behavior: the plugin now always supplies a resolver, so a
  // missing key surfaces at search time as the actionable credential error
  // rather than a selection-time availability refusal.
  it('reports an actionable credential error when neither config nor env supplies a key', async () => {
    const prev = process.env.EXA_API_KEY
    delete process.env.EXA_API_KEY
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: EXA_PROVIDER_ID })
      await ctx.plugin(exaPlugin, {})
      const pending = ctx.web.search({ query: 'q' })
      await expect(pending).rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
      await expect(pending).rejects.toThrow(/"EXA_API_KEY"/)
    } finally {
      if (prev !== undefined) process.env.EXA_API_KEY = prev
    }
  })
})

describe('ExaSearchProvider credential resolution', () => {
  const keyless = (overrides: Partial<ExaSearchProviderOptions> = {}): ExaSearchProviderOptions => ({
    baseURL: options.baseURL,
    searchType: options.searchType,
    highlightsPerResult: options.highlightsPerResult,
    ...overrides,
  })

  it('is available when a resolver exists even before the key does', () => {
    expect(searchProvider(keyless({ resolveApiKey: async () => undefined })).available()).toBe(true)
  })

  it('resolves the key per search through the real local credential store, without restart', async () => {
    const previous = process.env.EXA_API_KEY
    delete process.env.EXA_API_KEY
    const dir = await mkdtemp(join(tmpdir(), 'dsh-exa-credentials-'))
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: EXA_PROVIDER_ID })
      await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
      await ctx.plugin(exaPlugin, {})

      await expect(ctx.web.search({ query: 'missing' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))

      const ref = credentialRef('EXA_API_KEY')
      await ctx.credentials.set(ref, 'stored-key')
      await ctx.web.search({ query: 'stored' })
      await ctx.credentials.set(ref, 'rotated-key')
      await ctx.web.search({ query: 'rotated' })

      const headers = fetchMock.mock.calls.map(([, init]) => (init as RequestInit).headers as Record<string, string>)
      expect(headers.map(value => value['authorization'])).toEqual(['Bearer stored-key', 'Bearer rotated-key'])
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
      if (previous === undefined) delete process.env.EXA_API_KEY
      else process.env.EXA_API_KEY = previous
    }
  })

  it('treats an empty ambient value as absent rather than sending an empty key', async () => {
    const previous = process.env.EXA_API_KEY
    process.env.EXA_API_KEY = ''
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: EXA_PROVIDER_ID })
      await ctx.plugin(exaPlugin, {})
      await expect(ctx.web.search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))
      await ctx.fiber.dispose()
    } finally {
      if (previous === undefined) delete process.env.EXA_API_KEY
      else process.env.EXA_API_KEY = previous
    }
  })

  it('maps a rejected credential resolver to WEB_PROVIDER_ERROR with the resolution message', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const provider = searchProvider(keyless({ resolveApiKey: () => Promise.reject(new Error('store sealed')) }))
    const pending = provider.search({ query: 'q' })
    await expect(pending).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    await expect(pending).rejects.toThrow(/Exa search credential resolution failed/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('names the configured reference in the missing-credential error', async () => {
    const provider = searchProvider(keyless({
      resolveApiKey: async () => undefined,
      apiKeyEnv: credentialRef('MY_EXA_KEY'),
    }))
    const pending = provider.search({ query: 'q' })
    await expect(pending).rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
    await expect(pending).rejects.toThrow(/"MY_EXA_KEY"/)
  })

  it('falls back to the default reference name when options carry none', async () => {
    const provider = searchProvider(keyless({ resolveApiKey: async () => undefined }))
    const pending = provider.search({ query: 'q' })
    await expect(pending).rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
    await expect(pending).rejects.toThrow(/"EXA_API_KEY"/)
  })

  it('surfaces an abort landing between credential resolution and dispatch as WEB_ABORTED', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const pending = searchProvider(options).search({ query: 'q' }, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not call the resolver or fetch when the search is already aborted', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const resolveApiKey = vi.fn(async () => 'late-key')
    const controller = new AbortController()
    controller.abort()
    await expect(searchProvider(keyless({ resolveApiKey })).search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(resolveApiKey).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('aborts credential resolution when the signal fires while the resolver hangs', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const provider = searchProvider(keyless({ resolveApiKey: () => new Promise(() => {}) }))
    const pending = provider.search({ query: 'q' }, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends the key and endpoint from one snapshot when options change mid-resolution', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    let release!: (value: string) => void
    const gate = new Promise<string>((resolve) => { release = resolve })
    const first = keyless({ baseURL: 'https://section-a.test', resolveApiKey: () => gate })
    const second = keyless({ baseURL: 'https://section-b.test', apiKey: 'b-key' })
    let current = first
    const provider = new ExaSearchProvider(() => current)
    const pending = provider.search({ query: 'q' })
    current = second
    release('a-key')
    await pending
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://section-a.test/search')
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer a-key')
  })
})

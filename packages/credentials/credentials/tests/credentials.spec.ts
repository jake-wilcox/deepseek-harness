import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '../src/index.ts'
import type { CredentialRef } from '../src/index.ts'
import { MemoryCredentials } from './memory.ts'

const REF = credentialRef('DEEPSEEK_API_KEY')

async function boot(seed: Record<string, string> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials, seed)
  return ctx
}

describe('credentialRef', () => {
  it('brands POSIX shell identifiers', () => {
    expect(credentialRef('DEEPSEEK_API_KEY')).toBe('DEEPSEEK_API_KEY')
    expect(credentialRef('_private')).toBe('_private')
    expect(credentialRef('lower_case9')).toBe('lower_case9')
  })

  it('rejects every other shape', () => {
    for (const invalid of ['', '9LEADING', 'WITH-DASH', 'WITH SPACE', 'ns:key']) {
      expect(() => credentialRef(invalid)).toThrow(TypeError)
    }
  })
})

describe('the credentials seam through the memory provider', () => {
  it('mounts as ctx.credentials and resolves a seeded reference with its source', async () => {
    const ctx = await boot({ DEEPSEEK_API_KEY: 'sk-seeded' })
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'sk-seeded', source: 'memory' })
    expect(await ctx.credentials.describe(REF)).toEqual({ configured: true, source: 'memory', writable: true })
  })

  it('treats an empty stored value as absent everywhere', async () => {
    const ctx = await boot({ DEEPSEEK_API_KEY: '' })
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
    expect(await ctx.credentials.describe(REF)).toEqual({ configured: false, writable: true })
  })

  it('stores through set, removes through unset, and emits the committed change', async () => {
    const ctx = await boot()
    const events: CredentialRef[] = []
    ctx.on('credentials/updated', ref => void events.push(ref))

    await ctx.credentials.set(REF, 'sk-live')
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'sk-live', source: 'memory' })
    await ctx.credentials.unset(REF)
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
    expect(events).toEqual([REF, REF])
  })

  it('rejects an empty set and keeps an absent unset silent', async () => {
    const ctx = await boot()
    const events: CredentialRef[] = []
    ctx.on('credentials/updated', ref => void events.push(ref))

    await expect(ctx.credentials.set(REF, '')).rejects.toThrow(/empty value/)
    await ctx.credentials.unset(REF)
    expect(events).toEqual([])
  })

  it('serializes read-modify-write and keeps undefined as no change', async () => {
    const ctx = await boot({ DEEPSEEK_API_KEY: '0' })
    const release = Promise.withResolvers<undefined>()
    const first = ctx.credentials.modify(REF, async (current) => {
      await release.promise
      return `${current ?? ''}1`
    })
    const second = ctx.credentials.modify(REF, current => Promise.resolve(`${current ?? ''}2`))

    release.resolve(undefined)
    await expect(first).resolves.toBe('01')
    await expect(second).resolves.toBe('012')
    await expect(ctx.credentials.modify(REF, () => Promise.resolve(undefined))).resolves.toBe('012')
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: '012', source: 'memory' })
  })

  it('serializes direct writes with an in-flight modification', async () => {
    const ctx = await boot({ DEEPSEEK_API_KEY: 'old' })
    const release = Promise.withResolvers<undefined>()
    const modifying = ctx.credentials.modify(REF, async (current) => {
      await release.promise
      return `${current ?? ''}-refreshed`
    })
    const setting = ctx.credentials.set(REF, 'manual')

    release.resolve(undefined)
    await expect(modifying).resolves.toBe('old-refreshed')
    await setting
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'manual', source: 'memory' })
  })

  it('rejects an empty replacement without poisoning the mutation chain', async () => {
    const ctx = await boot({ DEEPSEEK_API_KEY: 'old' })
    await expect(ctx.credentials.modify(REF, () => Promise.resolve(''))).rejects.toThrow(/empty value/)
    await expect(ctx.credentials.modify(REF, () => Promise.resolve('new'))).resolves.toBe('new')
  })

  it('removes the service with its fiber', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(MemoryCredentials)
    expect(ctx.get('credentials')).toBeDefined()
    await fiber.dispose()
    expect(ctx.get('credentials')).toBeUndefined()
  })
})

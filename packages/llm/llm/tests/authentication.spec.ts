import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmError, ProviderLoginAttemptId } from '@deepseek-ai/dsh-llm'
import type { LlmProviderAuthentication, LlmProviderAuthInteraction } from '@deepseek-ai/dsh-llm'

function authentication(overrides: Partial<LlmProviderAuthentication> = {}): LlmProviderAuthentication {
  return {
    methods: [{ id: 'device', name: 'Sign in', kind: 'device-code' }],
    status: () => Promise.resolve({ authenticated: false }),
    login: () => Promise.resolve(),
    logout: () => Promise.resolve(),
    ...overrides,
  }
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  return ctx
}

describe('provider authentication', () => {
  it('registers detached methods and reads non-secret status', async () => {
    const ctx = await setup()
    const definition = authentication({ status: () => Promise.resolve({ authenticated: true, source: 'OAuth' }) })
    ctx.llm.registerProviderAuthentication('openai-codex', definition)

    const view = await ctx.llm.providerAuthentication('openai-codex')
    expect(view).toEqual({
      provider: 'openai-codex',
      methods: [{ id: 'device', name: 'Sign in', kind: 'device-code' }],
      authenticated: true,
      source: 'OAuth',
      usageSupported: false,
    })
    ;(definition.methods as Array<{ id: string; name: string; kind: 'device-code' }>)[0]!.name = 'mutated'
    expect((await ctx.llm.providerAuthentication('openai-codex'))?.methods[0]?.name).toBe('Sign in')
  })

  it('advertises, forwards, validates, and detaches provider account usage', async () => {
    const ctx = await setup()
    const signal = new AbortController().signal
    const source = {
      capturedAtMs: 1_800_000_000_000,
      windows: [{ id: 'primary', usedPercent: 25, durationMinutes: 300, resetsAtMs: 1_800_000_300_000 }],
    }
    const usage = vi.fn((_signal?: AbortSignal) => Promise.resolve(source))
    ctx.llm.registerProviderAuthentication('openai-codex', authentication({ usage }))

    await expect(ctx.llm.providerAuthentication('openai-codex')).resolves.toMatchObject({ usageSupported: true })
    const snapshot = await ctx.llm.providerUsage('openai-codex', signal)
    const forwardedSignal = usage.mock.calls[0]?.[0]
    expect(forwardedSignal).toBeInstanceOf(AbortSignal)
    expect(forwardedSignal).not.toBe(signal)
    expect(snapshot).toEqual(source)
    expect(snapshot).not.toBe(source)
    expect(snapshot?.windows).not.toBe(source.windows)
    source.windows[0]!.usedPercent = 90
    expect(snapshot?.windows[0]?.usedPercent).toBe(25)
    await expect(ctx.llm.providerUsage('missing')).resolves.toBeUndefined()
  })

  it('aborts and drains provider usage when its registration leaves', async () => {
    const ctx = await setup()
    let usageSignal: AbortSignal | undefined
    const dispose = ctx.llm.registerProviderAuthentication('openai-codex', authentication({
      usage: signal => new Promise<never>((_resolve, reject) => {
        usageSignal = signal
        signal?.addEventListener('abort', () => { reject(new Error('usage cancelled')) }, { once: true })
      }),
    }))

    const pending = ctx.llm.providerUsage('openai-codex')
    await vi.waitFor(() => { expect(usageSignal).toBeDefined() })
    dispose()
    await expect(pending).rejects.toThrow('usage cancelled')
    expect(usageSignal?.aborted).toBe(true)
    await vi.waitFor(async () => {
      await expect(ctx.llm.providerAuthentication('openai-codex')).resolves.toBeUndefined()
    })
  })

  it('rejects invalid provider usage snapshots', async () => {
    const invalid = [
      { capturedAtMs: -1, windows: [{ id: 'primary', usedPercent: 1 }] },
      { capturedAtMs: 1, windows: [] },
      { capturedAtMs: 1, windows: [{ id: '', usedPercent: 1 }] },
      { capturedAtMs: 1, windows: [{ id: 'primary', usedPercent: 101 }] },
      { capturedAtMs: 1, windows: [{ id: 'primary', usedPercent: 1 }, { id: 'primary', usedPercent: 2 }] },
      { capturedAtMs: 1, windows: [{ id: 'primary', usedPercent: 1, durationMinutes: 0 }] },
      { capturedAtMs: 1, windows: [{ id: 'primary', usedPercent: 1, resetsAtMs: -1 }] },
    ]
    for (const [index, snapshot] of invalid.entries()) {
      const ctx = await setup()
      const provider = `invalid-usage-${String(index)}`
      ctx.llm.registerProviderAuthentication(provider, authentication({
        usage: () => Promise.resolve(snapshot),
      }))
      await expect(ctx.llm.providerUsage(provider)).rejects.toMatchObject({ code: 'INVALID_PROVIDER_USAGE' })
    }
  })

  it('publishes progress and reaches success without blocking the start call', async () => {
    const ctx = await setup()
    const gate = Promise.withResolvers<undefined>()
    let interaction: LlmProviderAuthInteraction | undefined
    ctx.llm.registerProviderAuthentication('openai-codex', authentication({
      login: async (_method, active) => {
        interaction = active
        active.notify({
          kind: 'device-code',
          verificationUrl: 'https://example.test/device',
          userCode: 'ABCD-EFGH',
        })
        await gate.promise
      },
    }))
    const updated = vi.fn()
    ctx.on('llm/auth-updated', updated)

    const started = ctx.llm.startProviderLogin('openai-codex', 'device')
    expect(started.state).toBe('starting')
    await vi.waitFor(() => {
      expect(ctx.llm.providerLoginAttempt('openai-codex', started.attemptId)).toMatchObject({
        state: 'waiting',
        notification: { kind: 'device-code', userCode: 'ABCD-EFGH' },
      })
    })
    expect(interaction?.signal.aborted).toBe(false)
    gate.resolve(undefined)
    await vi.waitFor(() => {
      expect(ctx.llm.providerLoginAttempt('openai-codex', started.attemptId).state).toBe('succeeded')
    })
    expect(updated).toHaveBeenCalled()
  })

  it('allows only one active attempt and cancellation waits for provider cleanup', async () => {
    const ctx = await setup()
    let cleaned = false
    ctx.llm.registerProviderAuthentication('openai-codex', authentication({
      login: (_method, interaction) => new Promise<void>((_resolve, reject) => {
        interaction.signal.addEventListener('abort', () => {
          cleaned = true
          reject(interaction.signal.reason instanceof Error
            ? interaction.signal.reason
            : new Error('Provider login cancelled'))
        }, { once: true })
      }),
    }))
    const started = ctx.llm.startProviderLogin('openai-codex', 'device')
    await Promise.resolve()
    expect(() => ctx.llm.startProviderLogin('openai-codex', 'device')).toThrow(LlmError)

    await expect(ctx.llm.cancelProviderLogin('openai-codex', started.attemptId)).resolves.toMatchObject({
      state: 'cancelled',
    })
    expect(cleaned).toBe(true)
    expect(ctx.llm.startProviderLogin('openai-codex', 'device').attemptId).not.toBe(started.attemptId)
  })

  it('contains status and login failures without exposing provider error text to the view', async () => {
    const ctx = await setup()
    vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    ctx.llm.registerProviderAuthentication('openai-codex', authentication({
      status: () => Promise.reject(new Error('secret provider detail')),
      login: () => Promise.reject(new Error('secret provider detail')),
    }))
    await expect(ctx.llm.providerAuthentication('openai-codex')).resolves.toMatchObject({
      authenticated: false,
      error: 'Authentication status is unavailable.',
    })
    const started = ctx.llm.startProviderLogin('openai-codex', 'device')
    await vi.waitFor(() => {
      expect(ctx.llm.providerLoginAttempt('openai-codex', started.attemptId)).toMatchObject({
        state: 'failed',
        error: 'Sign-in failed. Try again.',
      })
    })
  })

  it('withdraws on fiber disposal and permits a fresh registration', async () => {
    const ctx = await setup()
    const fiber = await ctx.plugin({
      inject: ['llm'],
      apply: (child) => { child.llm.registerProviderAuthentication('openai-codex', authentication()) },
    })
    expect(await ctx.llm.providerAuthentication('openai-codex')).toBeDefined()
    await fiber.dispose()
    expect(await ctx.llm.providerAuthentication('openai-codex')).toBeUndefined()
    expect(() => ctx.llm.registerProviderAuthentication('openai-codex', authentication())).not.toThrow()
  })

  it('rejects invalid registrations before publishing them', async () => {
    const cases: Array<[string, LlmProviderAuthentication]> = [
      ['', authentication()],
      ['empty-methods', authentication({ methods: [] })],
      ['empty-method-id', authentication({ methods: [{ id: '', name: 'Sign in', kind: 'device-code' }] })],
      ['empty-method-name', authentication({ methods: [{ id: 'device', name: '', kind: 'device-code' }] })],
      ['duplicate-method', authentication({ methods: [
        { id: 'device', name: 'First', kind: 'device-code' },
        { id: 'device', name: 'Second', kind: 'device-code' },
      ] })],
    ]
    for (const [provider, definition] of cases) {
      const ctx = await setup()
      expect(() => ctx.llm.registerProviderAuthentication(provider, definition)).toThrow(LlmError)
    }

    const ctx = await setup()
    ctx.llm.registerProviderAuthentication('duplicate', authentication())
    expect(() => ctx.llm.registerProviderAuthentication('duplicate', authentication())).toThrow(LlmError)
  })

  it('rejects invalid status values and unknown provider operations', async () => {
    const statuses: unknown[] = [
      { authenticated: 'yes' },
      { authenticated: false, source: 42 },
      { authenticated: false, source: '' },
    ]
    for (const [index, status] of statuses.entries()) {
      const ctx = await setup()
      const provider = `invalid-${String(index)}`
      ctx.llm.registerProviderAuthentication(provider, authentication({
        status: () => Promise.resolve(status as never),
      }))
      await expect(ctx.llm.providerAuthentication(provider)).rejects.toThrow(LlmError)
    }

    const ctx = await setup()
    await expect(ctx.llm.providerAuthentication('missing')).resolves.toBeUndefined()
    expect(() => ctx.llm.startProviderLogin('missing', 'device')).toThrow(LlmError)
    expect(() => ctx.llm.providerLoginAttempt('missing', ProviderLoginAttemptId('missing'))).toThrow(LlmError)
    await expect(ctx.llm.cancelProviderLogin('missing', ProviderLoginAttemptId('missing'))).rejects.toThrow(LlmError)
    await expect(ctx.llm.logoutProvider('missing')).rejects.toThrow(LlmError)
  })

  it('rejects unknown methods and attempt ids', async () => {
    const ctx = await setup()
    ctx.llm.registerProviderAuthentication('openai-codex', authentication())
    expect(() => ctx.llm.startProviderLogin('openai-codex', 'unknown')).toThrow(LlmError)
    expect(() => ctx.llm.providerLoginAttempt('openai-codex', ProviderLoginAttemptId('missing'))).toThrow(LlmError)
    await expect(ctx.llm.cancelProviderLogin('openai-codex', ProviderLoginAttemptId('missing'))).rejects.toThrow(LlmError)

    const started = ctx.llm.startProviderLogin('openai-codex', 'device')
    await vi.waitFor(() => {
      expect(ctx.llm.providerLoginAttempt('openai-codex', started.attemptId).state).toBe('succeeded')
    })
    expect(() => ctx.llm.providerLoginAttempt('openai-codex', ProviderLoginAttemptId('wrong'))).toThrow(LlmError)
    await expect(ctx.llm.cancelProviderLogin('openai-codex', ProviderLoginAttemptId('wrong'))).rejects.toThrow(LlmError)
    await expect(ctx.llm.cancelProviderLogin('openai-codex', started.attemptId)).resolves.toMatchObject({
      state: 'succeeded',
    })
  })

  it('detaches progress notifications and ignores a retired attempt callback', async () => {
    const ctx = await setup()
    const interactions: LlmProviderAuthInteraction[] = []
    ctx.llm.registerProviderAuthentication('openai-codex', authentication({
      login: (_method, interaction) => {
        interactions.push(interaction)
        interaction.notify({ kind: 'progress', message: 'Waiting for confirmation' })
        return Promise.resolve()
      },
    }))

    const first = ctx.llm.startProviderLogin('openai-codex', 'device')
    await vi.waitFor(() => {
      expect(ctx.llm.providerLoginAttempt('openai-codex', first.attemptId)).toMatchObject({
        state: 'succeeded',
        notification: { kind: 'progress', message: 'Waiting for confirmation' },
      })
    })
    const second = ctx.llm.startProviderLogin('openai-codex', 'device')
    interactions[0]!.notify({ kind: 'progress', message: 'late' })
    expect(ctx.llm.providerLoginAttempt('openai-codex', second.attemptId)).not.toMatchObject({
      notification: { message: 'late' },
    })
  })

  it('cancels an active login before logout and also logs out without an attempt', async () => {
    const ctx = await setup()
    const logout = vi.fn(() => Promise.resolve())
    let aborted = false
    ctx.llm.registerProviderAuthentication('idle', authentication({ logout }))
    await ctx.llm.logoutProvider('idle')

    ctx.llm.registerProviderAuthentication('openai-codex', authentication({
      logout,
      login: (_method, interaction) => new Promise<void>((resolve) => {
        interaction.signal.addEventListener('abort', () => {
          aborted = true
          resolve()
        }, { once: true })
      }),
    }))
    const started = ctx.llm.startProviderLogin('openai-codex', 'device')
    await Promise.resolve()
    await ctx.llm.logoutProvider('openai-codex')
    expect(aborted).toBe(true)
    expect(ctx.llm.providerLoginAttempt('openai-codex', started.attemptId).state).toBe('cancelled')
    await ctx.llm.logoutProvider('openai-codex')
    expect(logout).toHaveBeenCalledTimes(3)
  })

  it('contains authentication listener failures and still notifies later listeners', async () => {
    const ctx = await setup()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const later = vi.fn()
    const rejecting = (): unknown => Promise.reject(new Error('async observer'))
    ctx.on('llm/auth-updated', () => { throw new Error('sync observer') })
    ctx.on('llm/auth-updated', rejecting)
    ctx.on('llm/auth-updated', later)

    const dispose = ctx.llm.registerProviderAuthentication('openai-codex', authentication())
    expect(later).toHaveBeenCalledTimes(1)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(warn).toHaveBeenCalledWith('llm: an llm/auth-updated listener for "%s" failed', 'openai-codex')
    dispose()
    await vi.waitFor(() => { expect(later).toHaveBeenCalledTimes(2) })
  })

  it('rethrows the first authentication invariant failure after notifying later listeners', async () => {
    const ctx = await setup()
    const later = vi.fn()
    ctx.on('llm/auth-updated', () => {
      throw Object.assign(new Error('first invariant'), { code: 'INVARIANT' })
    })
    ctx.on('llm/auth-updated', () => {
      throw Object.assign(new Error('second invariant'), { code: 'INVARIANT' })
    })
    ctx.on('llm/auth-updated', later)

    expect(() => ctx.llm.registerProviderAuthentication('openai-codex', authentication()))
      .toThrow('first invariant')
    expect(later).toHaveBeenCalledTimes(1)
  })
})

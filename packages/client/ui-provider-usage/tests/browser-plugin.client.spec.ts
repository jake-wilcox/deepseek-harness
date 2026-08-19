import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createScope, SlotRegistry, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ProviderUsageInjected } from '../src/client/slots.ts'
import { apply, inject } from '../src/client/index.ts'

const sid = (value: string): SessionId => value as SessionId

it('registers through the declared ContextMeter slot and disposes with its fiber', async () => {
  const ctx = new Context()
  const providerUsage = vi.fn(() => Promise.resolve({
    rpcId: 'usage' as never,
    result: { ok: true as const, value: {
      usage: { capturedAtMs: 1, windows: [{ id: 'primary', usedPercent: 20 }] },
    } },
  }))
  ctx.provide('connection', { api: { llm: { providerUsage } } })
  ctx.provide('locale', new LocaleRuntime(ctx))
  const directory = {
    store: { getSnapshot: () => ({ current: { provider: 'openai-codex', model: 'gpt-5' } }) },
    load: vi.fn(),
  }
  ctx.provide('modelDirectories', { directoryFor: () => directory })
  const scope = createScope(ctx, sid('session'))
  ctx.provide('sessions', { scope: (sessionId: SessionId) => sessionId === sid('session') ? scope.ctx : undefined })
  await ctx.plugin(SlotRegistry)
  const disposeDeclaration = ctx.slots.register({
    name: 'root',
    children: {
      'conversation.composer.contextMeter.usage': { kind: 'single', scope: 'session' },
    },
  } as never, (() => null) as never)

  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const entry = ctx.slots.entries('conversation.composer.contextMeter.usage')[0]
  const face = entry?.inject?.(sid('session') as never) as ProviderUsageInjected | undefined
  expect(face).toBeDefined()
  const deactivate = face!.activate()
  await vi.waitFor(() => { expect(face!.hooks.usage.getSnapshot().status).toBe('ready') })
  expect(providerUsage).toHaveBeenCalledWith({ provider: 'openai-codex' }, expect.any(AbortSignal))
  deactivate()

  await fiber.dispose()
  expect(ctx.slots.entries('conversation.composer.contextMeter.usage')).toHaveLength(0)
  await scope.fiber.dispose()
  disposeDeclaration()
})

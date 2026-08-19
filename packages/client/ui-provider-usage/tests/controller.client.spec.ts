import { describe, expect, it, vi } from 'vitest'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { ProviderUsageController } from '../src/client/controller.ts'

function ok<T>(value: T) {
  return { rpcId: 'fixture' as never, result: { ok: true as const, value } }
}

describe('ProviderUsageController', () => {
  it('loads the selected provider on activation and refreshes on demand', async () => {
    const providerUsage = vi.fn(() => Promise.resolve(ok({ usage: {
      capturedAtMs: 1_800_000_000_000,
      windows: [{ id: 'primary', usedPercent: 25 }],
    } })))
    const controller = new ProviderUsageController(
      { llm: { providerUsage } } as unknown as IApiClient,
      () => Promise.resolve('openai-codex'),
    )
    const changed = vi.fn()
    controller.subscribe(changed)

    const deactivate = controller.activate()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    expect(providerUsage).toHaveBeenCalledWith({ provider: 'openai-codex' }, expect.any(AbortSignal))
    expect(controller.getSnapshot().usage?.windows[0]?.usedPercent).toBe(25)
    controller.refresh()
    await vi.waitFor(() => { expect(providerUsage).toHaveBeenCalledTimes(2) })
    expect(changed).toHaveBeenCalled()
    deactivate()
  })

  it('distinguishes unsupported and failed reads while preserving a refresh value', async () => {
    const providerUsage = vi.fn()
      .mockResolvedValueOnce(ok({}))
      .mockResolvedValueOnce(ok({ usage: {
        capturedAtMs: 1_800_000_000_000,
        windows: [{ id: 'primary', usedPercent: 40 }],
      } }))
      .mockRejectedValueOnce(new Error('offline'))
    const controller = new ProviderUsageController(
      { llm: { providerUsage } } as unknown as IApiClient,
      () => Promise.resolve('openai-codex'),
    )

    controller.activate()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('unsupported') })
    controller.refresh()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })
    controller.refresh()
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('error') })
    expect(controller.getSnapshot().usage?.windows[0]?.usedPercent).toBe(40)
  })

  it('aborts and fences an obsolete read', async () => {
    type UsageResponse = ReturnType<typeof ok<{
      usage: { capturedAtMs: number; windows: { id: string; usedPercent: number }[] }
    }>>
    const gate = Promise.withResolvers<UsageResponse>()
    let firstSignal: AbortSignal | undefined
    const providerUsage = vi.fn((_provider: unknown, signal?: AbortSignal) => {
      firstSignal = signal
      return gate.promise
    })
    const controller = new ProviderUsageController(
      { llm: { providerUsage } } as unknown as IApiClient,
      () => Promise.resolve('openai-codex'),
    )
    const deactivate = controller.activate()
    await vi.waitFor(() => { expect(providerUsage).toHaveBeenCalled() })
    deactivate()
    expect(firstSignal?.aborted).toBe(true)
    gate.resolve(ok({ usage: { capturedAtMs: 1, windows: [{ id: 'primary', usedPercent: 90 }] } }))
    await Promise.resolve()
    expect(controller.getSnapshot().status).toBe('loading')
  })
})

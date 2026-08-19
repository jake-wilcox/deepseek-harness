// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ProviderUsage } from '../src/client/ProviderUsage.tsx'
import type { ProviderUsageState } from '../src/client/controller.ts'
import type { ProviderUsageProps } from '../src/client/slots.ts'
import { en } from '../src/client/locales.ts'

const t = makeTranslate(en) as ProviderUsageProps['t']

afterEach(cleanup)

function mount(state: ProviderUsageState) {
  const refresh = vi.fn()
  const dispose = vi.fn()
  const activate = vi.fn(() => dispose)
  const useUsage = (<T,>(selector: (value: ProviderUsageState) => T): T => selector(state)) as ProviderUsageProps['useUsage']
  const view = render(<ProviderUsage {...({ useUsage, activate, refresh, t } as ProviderUsageProps)} />)
  return { view, refresh, activate, dispose }
}

describe('ProviderUsage', () => {
  it('activates only while mounted and presents loading or unavailable states', () => {
    const loading = mount({ status: 'loading' })
    expect(screen.getByText(en.loading)).toBeDefined()
    expect(loading.activate).toHaveBeenCalledTimes(1)
    loading.view.unmount()
    expect(loading.dispose).toHaveBeenCalledTimes(1)

    mount({ status: 'unsupported', provider: 'fixture' })
    expect(screen.getByText(en.unavailable)).toBeDefined()
  })

  it('renders provider-order windows, percentages, resets, and manual refresh', () => {
    const { refresh } = mount({
      status: 'ready',
      provider: 'openai-codex',
      usage: {
        capturedAtMs: 1_800_000_000_000,
        windows: [
          { id: 'primary', usedPercent: 25.5, durationMinutes: 300, resetsAtMs: 1_800_000_300_000 },
          { id: 'secondary', usedPercent: 60, durationMinutes: 10_080 },
        ],
      },
    })
    expect(screen.getByText('5h window')).toBeDefined()
    expect(screen.getByText('25.5% used')).toBeDefined()
    expect(screen.getByText('7d window')).toBeDefined()
    expect(screen.getAllByRole('progressbar').map(node => node.getAttribute('aria-valuenow'))).toEqual(['25.5', '60'])
    expect(screen.getByText(/^Resets /)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('keeps the last snapshot visible when refresh fails', () => {
    const { refresh } = mount({
      status: 'error',
      provider: 'openai-codex',
      usage: { capturedAtMs: 1, windows: [{ id: 'primary', usedPercent: 40 }] },
    })
    expect(screen.getByRole('alert').textContent).toBe(en.error)
    expect(screen.getByText('40% used')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})

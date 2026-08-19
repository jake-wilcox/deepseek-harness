/** Provider-account allowance presentation inside the context popover. */

import { useEffect } from 'react'
import type { ProviderUsageWindowView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ProviderUsageProps } from './slots.ts'
import css from './ProviderUsage.module.css'

function durationLabel(minutes: number): string {
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

function percentLabel(percent: number): string {
  return String(Math.round(percent * 10) / 10)
}

/**
 * Render current subscription allowance windows and their refresh state.
 * @param props - framework-bound usage state, actions, and locale seat.
 * @returns the account-usage section.
 */
export function ProviderUsage({ useUsage, activate, refresh, t }: ProviderUsageProps) {
  const state = useUsage(value => value)
  useEffect(activate, [activate])

  const windows = state.usage?.windows ?? []
  const waiting = state.status === 'loading' && windows.length === 0
  const action = state.status === 'error' ? t('retry') : t('refresh')

  return (
    <section className={css.root} aria-label={t('title')}>
      <div className={css.header}>
        <h3>{t('title')}</h3>
        {state.status === 'loading' && windows.length > 0
          ? <span className={css.status}>{t('refreshing')}</span>
          : null}
        {(state.status === 'ready' || state.status === 'error') && (
          <button type="button" className={css.action} onClick={refresh}>{action}</button>
        )}
      </div>

      {waiting && <p className={css.message}>{t('loading')}</p>}
      {state.status === 'unsupported' && <p className={css.message}>{t('unavailable')}</p>}
      {state.status === 'error' && <p className={css.error} role="alert">{t('error')}</p>}

      {windows.map((window, index) => (
        <UsageWindow key={window.id} window={window} position={index + 1} t={t} />
      ))}
    </section>
  )
}

interface UsageWindowProps {
  window: ProviderUsageWindowView
  position: number
  t: ProviderUsageProps['t']
}

function UsageWindow({ window, position, t }: UsageWindowProps) {
  const percent = percentLabel(window.usedPercent)
  const label = window.durationMinutes === undefined
    ? t('window.generic', { position })
    : t('window.duration', { duration: durationLabel(window.durationMinutes) })
  return (
    <div className={css.window}>
      <div className={css.windowHeader}>
        <span>{label}</span>
        <strong>{t('used', { percent })}</strong>
      </div>
      <div
        className={css.track}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={window.usedPercent}
      >
        <span className={css.fill} style={{ width: `${window.usedPercent}%` }} />
      </div>
      {window.resetsAtMs !== undefined && (
        <div className={css.reset}>{t('resets', { time: new Date(window.resetsAtMs).toLocaleString() })}</div>
      )}
    </div>
  )
}

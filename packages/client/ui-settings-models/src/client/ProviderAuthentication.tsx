/** Interactive provider authentication control for the Models page. */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  IApiClient,
  ProviderAuthenticationView,
  ProviderLoginAttemptView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { en } from './locales.ts'
import { messageOf } from './store.ts'
import styles from './ModelsSection.module.css'

const LOGIN_ATTEMPT_POLL_INTERVAL_MS = 750

/** Read abort state after an asynchronous boundary. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/** Props of {@link ProviderAuthentication}. */
export interface ProviderAuthenticationProps {
  provider: string
  authentication: ProviderAuthenticationView
  api: Pick<IApiClient, 'llm'>
  t: (key: keyof typeof en) => string
  disabled: boolean
  onChange: (authentication: ProviderAuthenticationView) => void
}

/** Replace the provider row's auth state from a fresh directory read. */
async function refreshAuthentication(
  props: ProviderAuthenticationProps,
): Promise<ProviderAuthenticationView | undefined> {
  const response = await props.api.llm.providers({})
  if (!response.result.ok) throw new Error(response.result.error.message)
  return response.result.value.providers.find(row => row.provider === props.provider)?.authentication
}

/**
 * Render device-code sign-in, progress, cancellation, and sign-out.
 * @param props - provider state and the LLM wire face.
 * @returns the authentication control.
 */
export function ProviderAuthentication(props: ProviderAuthenticationProps): ReactNode {
  const [attempt, setAttempt] = useState<ProviderLoginAttemptView | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(props.authentication.error)

  useEffect(() => {
    if (attempt === undefined || (attempt.state !== 'starting' && attempt.state !== 'waiting')) return
    const controller = new AbortController()
    let terminal = false
    const poll = async (): Promise<void> => {
      while (!isAborted(controller.signal)) {
        await new Promise(resolve => setTimeout(resolve, LOGIN_ATTEMPT_POLL_INTERVAL_MS))
        if (isAborted(controller.signal)) return
        try {
          const response = await props.api.llm.providerLoginAttempt({
            provider: props.provider,
            attemptId: attempt.attemptId,
          })
          if (!response.result.ok) throw new Error(response.result.error.message)
          const next = response.result.value.attempt
          setAttempt(next)
          if (next.state === 'starting' || next.state === 'waiting') continue
          terminal = true
          if (next.state === 'succeeded') {
            const refreshed = await refreshAuthentication(props)
            if (refreshed !== undefined) props.onChange(refreshed)
            setFailure(undefined)
          } else if (next.state === 'failed') {
            setFailure(next.error ?? props.t('authFailed'))
          }
          return
        } catch (error) {
          terminal = true
          setFailure(messageOf(error))
          return
        }
      }
    }
    void poll()
    return () => {
      controller.abort()
      if (!terminal) {
        void props.api.llm.cancelProviderLogin({
          provider: props.provider,
          attemptId: attempt.attemptId,
        })
      }
    }
  // The exact attempt owns one polling lifecycle. Provider callbacks are stable
  // for a mounted editor and deliberately do not restart that lifecycle.
  }, [attempt?.attemptId])

  const signIn = async (): Promise<void> => {
    const method = props.authentication.methods[0]
    /* v8 ignore next -- the wire schema requires at least one method */
    if (method === undefined) return
    setBusy(true)
    setFailure(undefined)
    try {
      const response = await props.api.llm.startProviderLogin({ provider: props.provider, method: method.id })
      if (!response.result.ok) throw new Error(response.result.error.message)
      setAttempt(response.result.value.attempt)
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  const signOut = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      const response = await props.api.llm.logoutProvider({ provider: props.provider })
      if (!response.result.ok) throw new Error(response.result.error.message)
      const refreshed = await refreshAuthentication(props)
      if (refreshed !== undefined) props.onChange(refreshed)
      setAttempt(undefined)
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  const cancel = async (attemptId: ProviderLoginAttemptView['attemptId']): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      const response = await props.api.llm.cancelProviderLogin({
        provider: props.provider,
        attemptId,
      })
      if (!response.result.ok) throw new Error(response.result.error.message)
      setAttempt(response.result.value.attempt)
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  const active = attempt?.state === 'starting' || attempt?.state === 'waiting'
  const notification = attempt?.notification
  return (
    <div className={styles['authPanel']}>
      <div className={styles['authStatus']}>
        <span>{props.authentication.authenticated ? props.t('authConnected') : props.t('authNotConnected')}</span>
        {props.authentication.source === undefined
          ? null
          : <span className={styles['authSource']}>{props.authentication.source}</span>}
      </div>
      {notification?.kind === 'device-code'
        ? (
          <div className={styles['deviceCode']}>
            <p>{props.t('authDeviceInstructions')}</p>
            <a href={notification.verificationUrl} target="_blank" rel="noreferrer">
              {props.t('authOpenPage')}
            </a>
            <code>{notification.userCode}</code>
            <p>{props.t('authWaiting')}</p>
          </div>
        )
        : notification?.kind === 'progress'
          ? <p className={styles['advancedHint']}>{notification.message}</p>
          : active
            ? <p className={styles['advancedHint']}>{props.t('authStarting')}</p>
            : null}
      {failure === undefined ? null : <p className={styles['error']}>{failure}</p>}
      <div className={styles['authActions']}>
        {props.authentication.authenticated
          ? (
            <button
              type="button"
              className={styles['secondaryButton']}
              disabled={props.disabled || busy}
              onClick={() => { void signOut() }}
            >
              {busy ? props.t('authSigningOut') : props.t('authSignOut')}
            </button>
          )
          : active
            ? (
              <button
                type="button"
                className={styles['secondaryButton']}
                disabled={props.disabled || busy}
                onClick={() => { void cancel(attempt.attemptId) }}
              >
                {props.t('authCancel')}
              </button>
            )
            : (
              <button
                type="button"
                className={styles['primaryButton']}
                disabled={props.disabled || busy}
                onClick={() => { void signIn() }}
              >
                {busy ? props.t('authSigningIn') : props.authentication.methods[0]?.name ?? props.t('authSignIn')}
              </button>
            )}
      </div>
    </div>
  )
}

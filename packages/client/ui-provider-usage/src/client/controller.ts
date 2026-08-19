/**
 * Per-session provider-account usage reader with cancellation and stale-result fencing.
 * @module @deepseek-ai/dsh-client-ui-provider-usage/client/controller
 */

import type { IApiClient, ProviderUsageView } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** Observable state presented by one session's usage contribution. */
export interface ProviderUsageState {
  status: 'idle' | 'loading' | 'ready' | 'unsupported' | 'error'
  provider?: string
  usage?: ProviderUsageView
}

type Listener = () => void

/** Owns one session's active provider-usage request. */
export class ProviderUsageController implements HostObservable<ProviderUsageState> {
  private snapshot: ProviderUsageState = { status: 'idle' }
  private readonly listeners = new Set<Listener>()
  private generation = 0
  private request: AbortController | undefined

  /**
   * @param api - provider-neutral browser API client.
   * @param resolveProvider - resolves the session's authoritative selected provider.
   */
  constructor(
    private readonly api: IApiClient,
    private readonly resolveProvider: () => Promise<string | undefined>,
  ) {}

  /** Return the identity-stable snapshot until state changes. */
  getSnapshot = (): ProviderUsageState => this.snapshot

  /**
   * Subscribe to snapshot replacement.
   * @param listener - callback invoked after a committed state change.
   * @returns the subscription disposer.
   */
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Begin an on-demand read while the context popover is mounted. */
  activate = (): (() => void) => {
    void this.load()
    return this.deactivate
  }

  /** Request a fresh snapshot while preserving a same-provider successful value. */
  refresh = (): void => { void this.load() }

  /** Abort active work and make later settlements inert. */
  dispose(): void {
    this.deactivate()
    this.listeners.clear()
  }

  private readonly deactivate = (): void => {
    this.generation += 1
    this.request?.abort()
    this.request = undefined
  }

  private publish(snapshot: ProviderUsageState): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }

  private async load(): Promise<void> {
    const generation = ++this.generation
    this.request?.abort()
    const request = new AbortController()
    this.request = request
    const previous = this.snapshot.usage
    this.publish({
      status: 'loading',
      ...this.snapshot.provider === undefined ? {} : { provider: this.snapshot.provider },
      ...previous === undefined ? {} : { usage: previous },
    })

    try {
      const provider = await this.resolveProvider()
      if (generation !== this.generation) return
      if (provider === undefined) {
        this.publish({ status: 'error' })
        return
      }
      const sameProviderUsage = this.snapshot.provider === provider ? this.snapshot.usage : undefined
      this.publish({
        status: 'loading',
        provider,
        ...sameProviderUsage === undefined ? {} : { usage: sameProviderUsage },
      })
      const response = await this.api.llm.providerUsage({ provider }, request.signal)
      if (generation !== this.generation) return
      if (!response.result.ok) {
        this.publish({
          status: 'error',
          provider,
          ...sameProviderUsage === undefined ? {} : { usage: sameProviderUsage },
        })
        return
      }
      const usage = response.result.value.usage
      this.publish(usage === undefined
        ? { status: 'unsupported', provider }
        : { status: 'ready', provider, usage })
    } catch {
      if (generation !== this.generation) return
      this.publish({
        status: 'error',
        ...this.snapshot.provider === undefined ? {} : { provider: this.snapshot.provider },
        ...previous === undefined ? {} : { usage: previous },
      })
    } finally {
      if (generation === this.generation) this.request = undefined
    }
  }
}

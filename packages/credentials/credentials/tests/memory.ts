import type { Context } from '@deepseek-ai/cordis'
import { CredentialProvider } from '../src/index.ts'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '../src/index.ts'

/**
 * In-memory credentials provider for interface and consumer tests: one
 * always-writable `memory` source seeded from plugin config.
 */
export class MemoryCredentials extends CredentialProvider {
  private readonly store = new Map<string, string>()
  private readonly chains = new Map<string, Promise<void>>()

  constructor(ctx: Context, seed: Record<string, string> = {}) {
    super(ctx)
    for (const [key, value] of Object.entries(seed)) this.store.set(key, value)
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.store.get(ref)
    return Promise.resolve(value === undefined || value.length === 0
      ? undefined
      : { value, source: 'memory' })
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    const value = this.store.get(ref)
    const configured = value !== undefined && value.length > 0
    return Promise.resolve({
      configured,
      ...configured ? { source: 'memory' } : {},
      writable: true,
    })
  }

  override modify(
    ref: CredentialRef,
    update: (current: string | undefined) => Promise<string | undefined>,
  ): Promise<string | undefined> {
    return this.enqueue(ref, async () => {
      const current = this.store.get(ref)
      const next = await update(current)
      if (next === undefined) return current
      if (next.length === 0) throw new Error('memory credentials: an empty value cannot be stored; use unset')
      if (next !== current) {
        this.store.set(ref, next)
        this.ctx.emit('credentials/updated', ref)
      }
      return next
    })
  }

  override set(ref: CredentialRef, value: string): Promise<void> {
    if (value.length === 0) {
      return Promise.reject(new Error('memory credentials: an empty value cannot be stored; use unset'))
    }
    return this.enqueue(ref, () => {
      if (this.store.get(ref) !== value) {
        this.store.set(ref, value)
        this.ctx.emit('credentials/updated', ref)
      }
    })
  }

  override unset(ref: CredentialRef): Promise<void> {
    return this.enqueue(ref, () => {
      if (this.store.delete(ref)) this.ctx.emit('credentials/updated', ref)
    })
  }

  /** Serialize one operation for a reference without poisoning later work. */
  private enqueue<T>(ref: CredentialRef, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.chains.get(ref) ?? Promise.resolve()
    const task = previous.then(operation)
    this.chains.set(ref, task.then(() => undefined, () => undefined))
    return task
  }
}

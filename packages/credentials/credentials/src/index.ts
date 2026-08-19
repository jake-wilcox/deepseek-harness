/**
 * Service Definition for the credential-reference capability seam (`ctx.credentials`). Settings and composition files carry
 * *references* to secrets — environment-variable names — while providers own
 * the actual values and their storage. Consumers resolve a reference once per
 * operation, so a changed credential reaches the next operation without any
 * plugin restart, and configuration surfaces describe a reference without
 * ever seeing its value.
 * @module @deepseek-ai/dsh-credentials
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { CredentialRef } from './types.ts'

export type { CredentialRef } from './types.ts'

const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Brand a raw string as a {@link CredentialRef}.
 * @param value - candidate reference; a POSIX shell identifier such as `DEEPSEEK_API_KEY`.
 * @returns the branded reference.
 */
export function credentialRef(value: string): CredentialRef {
  if (!REF_PATTERN.test(value)) {
    throw new TypeError(`credential ref "${value}" must match ${String(REF_PATTERN)}`)
  }
  return value as CredentialRef
}

/**
 * Resolve `ref` for one operation: the credentials service when composed,
 * otherwise the ambient launch environment — without the seam the environment
 * is the whole credential plane. Empty values count as absent. Consumers call
 * this at each operation and must not cache across operations.
 * @param ctx - context whose composition may carry the credentials service.
 * @param ref - the reference to resolve.
 * @returns the non-empty value, or `undefined` when no layer supplies one.
 */
export async function resolveCredential(ctx: Context, ref: CredentialRef): Promise<string | undefined> {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) return (await credentials.resolve(ref))?.value
  const ambient = launchEnvironmentOf(ctx).get(ref)
  return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
}

/** The per-operation credential plan a keyed provider assembles from its config. */
export interface CredentialPlan {
  /** Non-empty literal key, when the section configures one. */
  apiKey?: string
  /** Resolve the reference for one operation ({@link resolveCredential}). */
  resolveApiKey: () => Promise<string | undefined>
  /** The reference in force, named by missing-credential diagnostics. */
  apiKeyEnv: CredentialRef
}

/**
 * Assemble a provider's per-operation credential plan: a non-empty literal
 * `apiKey` wins; otherwise each operation resolves `apiKeyEnv` through
 * {@link resolveCredential}, so a stored or rotated value applies without a
 * restart.
 * @param ctx - context whose composition may carry the credentials service.
 * @param config - the literal and reference the provider's section names.
 * @param defaultRef - reference used when the section names none.
 * @returns the plan to spread into the provider's resolved options.
 */
export function credentialPlan(
  ctx: Context,
  config: { apiKey?: string; apiKeyEnv?: string },
  defaultRef: string,
): CredentialPlan {
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? defaultRef)
  const literal = config.apiKey !== undefined && config.apiKey.length > 0 ? config.apiKey : undefined
  return {
    ...literal === undefined ? {} : { apiKey: literal },
    resolveApiKey: () => resolveCredential(ctx, apiKeyEnv),
    apiKeyEnv,
  }
}

/** One resolved credential value and the source layer that supplied it. */
export interface ResolvedCredential {
  /** The non-empty secret value. */
  value: string
  /** Provider-defined source layer id (the local provider uses `env`, `file`, `project-env`, and `user-env`). */
  source: string
}

/** Source and writability facts for one reference, safe for configuration UIs — never the value. */
export interface CredentialInfo {
  /** Whether {@link CredentialProvider.resolve} would currently return a value. */
  configured: boolean
  /** Source layer currently supplying the value; absent while unconfigured. */
  source?: string
  /** Whether {@link CredentialProvider.set} would currently succeed for this reference. */
  writable: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    credentials: CredentialProvider
  }
}

/**
 * Abstract credential service. Providers implement the five operations over
 * their source layers; one seam-wide rule binds them all: an empty stored
 * value is absent everywhere — `resolve` skips it, `describe` reports it
 * unconfigured — so a blank never masquerades as a configured secret.
 */
export abstract class CredentialProvider extends Service {
  constructor(ctx: Context) {
    super(ctx, 'credentials')
  }

  /**
   * Resolve one reference to its current value. Resolution is per call:
   * consumers re-resolve at each operation and must not cache across
   * operations — that per-operation read is what makes a changed credential
   * reach the next operation without a restart.
   * @param ref - the reference to resolve.
   * @returns the value and its source, or `undefined` while unconfigured.
   */
  abstract resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>

  /**
   * Describe one reference for configuration surfaces without exposing the
   * value.
   * @param ref - the reference to describe.
   * @returns configured state, supplying source, and writability.
   */
  abstract describe(ref: CredentialRef): Promise<CredentialInfo>

  /**
   * Atomically inspect and optionally replace one value. Providers serialize
   * the callback with every write for the same backing source; file-backed
   * providers also hold their cross-process writer lock while it runs. The
   * callback returns `undefined` to keep the current value unchanged. It
   * cannot delete a value; use {@link unset} for an explicit removal.
   *
   * This operation exists for rotating credentials whose replacement depends
   * on the exact current value, such as an OAuth refresh token. Holding the
   * callback under the provider's write exclusion prevents two processes from
   * exchanging the same single-use token concurrently.
   * @param ref - the reference to inspect and possibly replace.
   * @param update - serialized read-modify-write callback.
   * @returns the effective value after the operation, or `undefined` while absent.
   */
  abstract modify(
    ref: CredentialRef,
    update: (current: string | undefined) => Promise<string | undefined>,
  ): Promise<string | undefined>

  /**
   * Durably store one value in the provider-managed writable source. Rejects
   * while a read-only source shadows the reference — the write would appear
   * to succeed while resolution keeps returning the shadowing value — and
   * rejects an empty value (use {@link unset}).
   * @param ref - the reference to store.
   * @param value - the non-empty secret value.
   */
  abstract set(ref: CredentialRef, value: string): Promise<void>

  /**
   * Remove one reference from the provider-managed writable source; removing
   * an absent reference is a no-op. Rejects while a read-only source shadows
   * the reference, like {@link set}.
   * @param ref - the reference to remove.
   */
  abstract unset(ref: CredentialRef): Promise<void>

  /* jscpd:ignore-start -- deliberate symmetry with the settings seam's commit
     fan-out: the contained-dispatch shape is the reviewed listener-lifecycle
     contract, and extracting it would couple the two seams' event semantics. */
  /**
   * Fan `credentials/updated` out with contained listener failures: every
   * listener runs, and a sync throw or async rejection is logged without
   * changing the committed operation's outcome — except `INVARIANT`-coded
   * failures, which rethrow after every listener ran (the rethrow reaches the
   * caller only from synchronous listeners, so invariant checks on this event
   * must not be async functions). Providers call this only after the write or
   * reload actually committed, so a broken observer can never make a durable
   * change look failed.
   * @param ref - the reference whose stored value changed.
   */
  protected notifyUpdated(ref: CredentialRef): void {
    let invariantFailure: unknown
    const args = ['credentials/updated', ref]
    for (const listener of this.ctx.events.dispatch('emit', args) as Array<(...listenerArgs: unknown[]) => unknown>) {
      try {
        const returned = listener(ref)
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(returned as PromiseLike<unknown>).then(undefined, (error: unknown) => {
            this.warnListenerFailure(ref, error)
          })
        }
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'INVARIANT') {
          invariantFailure ??= error
          continue
        }
        this.warnListenerFailure(ref, error)
      }
    }
    if (invariantFailure !== undefined) throw invariantFailure as Error
  }
  /* jscpd:ignore-end */

  /** Contained-listener diagnostic shared by the sync and async failure paths. */
  private warnListenerFailure(ref: CredentialRef, error: unknown): void {
    this.ctx.logger.warn('credentials: a credentials/updated listener for "%s" failed', ref)
    this.ctx.logger.warn(error)
  }
}

export default CredentialProvider

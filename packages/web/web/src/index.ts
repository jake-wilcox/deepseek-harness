/**
 * Service Definition for the web access capability seam (`ctx.web`): registries and provider-selecting execution for search and
 * fetch. Duplicate ids are rejected. At execution time, a configured provider must exist and
 * be usable; without one, exactly one usable provider is required, so selection never depends
 * on registration order.
 * @module @deepseek-ai/dsh-web
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from './types.ts'
import { WebError } from './types.ts'

export {
  WebError,
} from './types.ts'
export type {
  WebFetchBody,
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    web: WebRuntime
  }
}

/** Selection inputs for execution-time provider resolution. */
interface Selection<P> {
  /** The configured provider id for this capability, if any. */
  readonly configuredId?: string
  /** Providers registered for this capability kind. */
  readonly providers: ReadonlyMap<string, P>
}

/**
 * Config for the web seam. `searchProvider` / `fetchProvider` pin which provider
 * wins for each capability; both are optional (a single registered usable
 * provider auto-selects). Operational overrides such as environment variables
 * must feed these same fields rather than introduce a hidden priority chain.
 */
export interface WebRuntimeConfig {
  /** Explicit search provider id. Omitted = auto-select when exactly one usable. */
  readonly searchProvider?: string
  /** Explicit fetch provider id. Omitted = auto-select when exactly one usable. */
  readonly fetchProvider?: string
}

/**
 * The web access service. Registered as `ctx.web` (one instance per context).
 *
 * Selection semantics (resolved at execution time, never order-dependent):
 * - A configured id that is registered and `available()` → that provider.
 * - A configured id not registered → `WEB_PROVIDER_CONFIGURED_MISSING`.
 * - A configured id registered but unavailable →
 *   `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`.
 * - No id configured, exactly one registered usable provider → that provider.
 * - No id configured, multiple usable providers → `WEB_PROVIDER_AMBIGUOUS`.
 * - No id configured, no usable provider → `WEB_PROVIDER_UNAVAILABLE`.
 */
export class WebRuntime extends Service {
  /**
   * Provider selection config. Operational env overrides feed the SAME fields:
   * `$DSH_WEB_SEARCH_PROVIDER` / `$DSH_WEB_FETCH_PROVIDER` are equivalent to
   * `searchProvider` / `fetchProvider` and are NOT a hidden priority chain.
   */
  static Config: z<WebRuntimeConfig> = z.object({
    searchProvider: z.string(),
    fetchProvider: z.string(),
  })

  private searchProviders = new Map<string, WebSearchProvider>()
  private fetchProviders = new Map<string, WebFetchProvider>()
  private readonly searchProviderId: string | undefined
  private readonly fetchProviderId: string | undefined

  constructor(ctx: Context, config: WebRuntimeConfig = {}) {
    super(ctx, 'web')
    this.searchProviderId = config.searchProvider ?? process.env.DSH_WEB_SEARCH_PROVIDER
    this.fetchProviderId = config.fetchProvider ?? process.env.DSH_WEB_FETCH_PROVIDER
  }

  /**
   * Register a search provider. Throws {@link WebError} `WEB_DUPLICATE_PROVIDER`
   * if its id is already registered for search. Returns a disposer; disposed
   * with the calling fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerSearchProvider(provider: WebSearchProvider): () => void {
    return this.registerProvider(this.searchProviders, provider)
  }

  /**
   * Register a fetch provider. Throws {@link WebError} `WEB_DUPLICATE_PROVIDER`
   * if its id is already registered for fetch. Returns a disposer; disposed
   * with the calling fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerFetchProvider(provider: WebFetchProvider): () => void {
    return this.registerProvider(this.fetchProviders, provider)
  }

  private registerProvider<P extends { readonly id: string }>(store: Map<string, P>, provider: P): () => void {
    if (store.has(provider.id)) {
      throw new WebError(`a web provider with id "${provider.id}" is already registered`, 'WEB_DUPLICATE_PROVIDER')
    }
    const dispose = this.ctx.effect(function* () {
      store.set(provider.id, provider)
      yield () => store.delete(provider.id)
    }, 'web.registerProvider()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /**
   * Run one search through the selected provider. Resolves the provider at call
   * time with the selection rules above; throws {@link WebError} when the
   * capability cannot run. The seam enforces `request.maxResults` on the result:
   * if the provider over-returns, `sources[]` is truncated and `truncated` set.
   * @param request - the query and optional result limit.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the provider's results, capped to `request.maxResults`.
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const provider = resolveProvider({
      providers: this.searchProviders,
      ...this.searchProviderId !== undefined ? { configuredId: this.searchProviderId } : {},
    })
    const result = await provider.search(request, signal)
    return capSources(result, request.maxResults)
  }

  /**
   * Retrieve one URL through the selected provider. Resolves the provider at
   * call time with the selection rules above; throws {@link WebError} when the
   * capability cannot run. A non-2xx response is a result, not a throw.
   * @param request - the URL plus retrieval options.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the retrieval outcome; non-2xx responses resolve descriptively.
   */
  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const provider = resolveProvider({
      providers: this.fetchProviders,
      ...this.fetchProviderId !== undefined ? { configuredId: this.fetchProviderId } : {},
    })
    return provider.fetch(request, signal)
  }
}

interface ResolvableProvider {
  readonly id: string
  available(): boolean
}

/** Resolve the selected provider or throw the matching {@link WebError}. */
function resolveProvider<P extends ResolvableProvider>(selection: Selection<P>): P {
  const { configuredId, providers } = selection
  if (configuredId !== undefined) {
    const provider = providers.get(configuredId)
    if (!provider) {
      throw new WebError(`configured web provider "${configuredId}" is not registered`, 'WEB_PROVIDER_CONFIGURED_MISSING')
    }
    if (!provider.available()) {
      throw new WebError(`configured web provider "${configuredId}" is registered but unavailable`, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
    }
    return provider
  }
  const usable = [...providers.values()].filter(provider => provider.available())
  const [single] = usable
  if (single === undefined) {
    throw new WebError('no usable web provider is registered', 'WEB_PROVIDER_UNAVAILABLE')
  }
  if (usable.length > 1) {
    const ids = usable.map(provider => provider.id).join(', ')
    throw new WebError(`multiple usable web providers are registered (${ids}); configure one explicitly`, 'WEB_PROVIDER_AMBIGUOUS')
  }
  return single
}

/**
 * True for a fetch/`AbortSignal` abort (`DOMException` named `AbortError`), surfaced as `WEB_ABORTED`.
 * @param error - the caught failure to classify.
 * @returns whether the failure is a fetch abort.
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** Error factories a provider supplies to the seam's request helpers, carrying its user-facing strings. */
export interface ProviderRequestErrors {
  /** Build the provider's stable cancellation error, retaining the abort reason (or `fallback`). */
  aborted: (signal?: AbortSignal, fallback?: unknown) => WebError
  /** Wrap a credential-resolution failure as the provider's `WEB_PROVIDER_ERROR`. */
  resolutionFailed: (error: unknown) => WebError
  /** Name the missing credential and where to store it, as `WEB_PROVIDER_CREDENTIAL_MISSING`. */
  missingCredential: () => WebError
}

/**
 * Resolve one operation's provider API key without retaining it: a non-empty
 * literal wins; otherwise the resolver answers for this operation; a missing
 * or empty result is the provider's missing-credential error.
 * @param options - the operation's snapshot carrying the literal and/or resolver.
 * @param errors - the provider's error factories.
 * @param signal - abort signal for the surrounding operation.
 * @returns the resolved key.
 */
export async function resolveProviderApiKey(
  options: { apiKey?: string; resolveApiKey?: () => Promise<string | undefined> },
  errors: ProviderRequestErrors,
  signal?: AbortSignal,
): Promise<string> {
  throwIfProviderAborted(signal, errors)
  if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
  let resolved: string | undefined
  try {
    resolved = await abortable(options.resolveApiKey?.() ?? Promise.resolve(undefined), signal, errors.aborted)
  } catch (error: unknown) {
    if (signal?.aborted === true || isAbortError(error)) throw errors.aborted(signal, error)
    throw errors.resolutionFailed(error)
  }
  if (resolved !== undefined && resolved.length > 0) return resolved
  throw errors.missingCredential()
}

/** Throw the provider's cancellation error when the caller has already aborted. */
function throwIfProviderAborted(signal: AbortSignal | undefined, errors: ProviderRequestErrors): void {
  if (signal?.aborted === true) throw errors.aborted(signal)
}

/**
 * Project a provider's non-2xx response onto its user-facing message: the JSON
 * error body's detail when present, else `fallback` (which should carry the
 * HTTP status). An abort mid-body surfaces as the provider's cancellation
 * error — cancellation is not a provider error; any other body failure keeps
 * `fallback`, since a malformed error body (normal for gateway 5xx/429s) can
 * only cost a richer message, never the real error.
 * @param response - the non-2xx response whose body may carry a detail.
 * @param fallback - status-line message used when no detail is found.
 * @param detail - extract the provider-specific detail from the parsed body.
 * @param aborted - builds the provider's stable cancellation error.
 * @param signal - abort signal for the surrounding operation.
 * @returns the message for the provider's `WEB_PROVIDER_ERROR`.
 */
export async function providerErrorMessage(
  response: Response,
  fallback: string,
  detail: (parsed: unknown) => string | undefined,
  aborted: ProviderRequestErrors['aborted'],
  signal?: AbortSignal,
): Promise<string> {
  try {
    const parsed: unknown = await response.json()
    const found = detail(parsed)
    return found !== undefined && found.length > 0 ? found : fallback
  } catch (error: unknown) {
    if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
    return fallback
  }
}

/**
 * Race a provider's same-process asynchronous preflight (credential resolution,
 * a queued handshake) against caller cancellation, part of the seam's
 * cancellation contract. The attached settlement handlers keep observing an
 * uncooperative operation after abort so a later rejection cannot become
 * unhandled; a non-abort rejection is re-thrown with its message preserved and
 * the original failure chained as `cause`.
 * @param operation - the preflight to await.
 * @param signal - the caller's abort signal; absent means no cancellation.
 * @param aborted - builds the provider's stable `WEB_ABORTED` error, given the signal whose reason it should retain.
 * @returns the operation's value, or a rejection with the provider's cancellation error once `signal` aborts.
 */
export function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  aborted: (signal?: AbortSignal) => WebError,
): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) return Promise.reject(aborted(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(aborted(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(new Error(String(error).replace(/^Error: /u, ''), { cause: error }))
      },
    )
  })
}

/** Enforce `maxResults` on a search result: truncate `sources[]` and flag it. */
function capSources(result: WebSearchResult, maxResults: number | undefined): WebSearchResult {
  if (maxResults === undefined || result.sources.length <= maxResults) return result
  return { ...result, sources: result.sources.slice(0, maxResults), truncated: true }
}

export default WebRuntime

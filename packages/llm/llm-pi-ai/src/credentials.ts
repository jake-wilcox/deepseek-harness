/**
 * pi-ai credential-store adapter over the Harness credential-reference seam.
 * OAuth documents remain opaque secrets to every configuration surface while
 * pi-ai retains its serialized refresh semantics.
 * @module dsh-llm-pi-ai/credentials
 */

import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'

/**
 * Stable Harness reference for one pi-ai provider's stored interactive credential.
 * @param provider - pi-ai provider id.
 * @returns deterministic Harness credential reference.
 */
export function piAiCredentialRef(provider: string): CredentialRef {
  return credentialRef(`DSH_PI_AI_${provider.replaceAll(/[^A-Za-z0-9]/g, '_').toUpperCase()}_AUTH`)
}

/** Parse and validate one secret JSON document at the durable-storage boundary. */
function parseCredential(provider: string, raw: string): Credential {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    throw new Error(`llm-pi-ai: stored authentication for provider "${provider}" is not valid JSON`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`llm-pi-ai: stored authentication for provider "${provider}" must be an object`)
  }
  const record = parsed as Record<string, unknown>
  if (record.type === 'oauth') {
    if (typeof record.refresh !== 'string' || record.refresh.length === 0
      || typeof record.access !== 'string' || record.access.length === 0
      || typeof record.expires !== 'number' || !Number.isFinite(record.expires)) {
      throw new Error(`llm-pi-ai: stored OAuth authentication for provider "${provider}" is incomplete`)
    }
    return record as Credential
  }
  if (record.type === 'api_key') {
    if (record.key !== undefined && (typeof record.key !== 'string' || record.key.length === 0)) {
      throw new Error(`llm-pi-ai: stored API-key authentication for provider "${provider}" has an invalid key`)
    }
    if (record.env !== undefined
      && (record.env === null || typeof record.env !== 'object' || Array.isArray(record.env)
        || Object.values(record.env as Record<string, unknown>).some(value => typeof value !== 'string'))) {
      throw new Error(`llm-pi-ai: stored API-key authentication for provider "${provider}" has invalid environment values`)
    }
    return record as Credential
  }
  throw new Error(`llm-pi-ai: stored authentication for provider "${provider}" has an unknown type`)
}

/** Serialize through the same durable-boundary validation used for reads. */
function serializeCredential(provider: string, credential: Credential): string {
  let raw: string
  try {
    raw = JSON.stringify(credential)
  } catch {
    throw new Error(`llm-pi-ai: authentication for provider "${provider}" is not JSON-serializable`)
  }
  parseCredential(provider, raw)
  return raw
}

/** pi-ai's provider-keyed store backed by Harness credential references. */
export class HarnessCredentialStore implements CredentialStore {
  private readonly refs: ReadonlyMap<string, CredentialRef>

  /**
   * @param credentials - Harness provider that owns persistence and locking.
   * @param providers - complete set of provider ids this store may enumerate.
   */
  constructor(
    private readonly credentials: CredentialProvider,
    providers: readonly string[],
  ) {
    const refs = new Map<string, CredentialRef>()
    const owners = new Map<CredentialRef, string>()
    for (const provider of providers) {
      const ref = piAiCredentialRef(provider)
      const owner = owners.get(ref)
      if (owner !== undefined) {
        throw new Error(`llm-pi-ai: provider ids "${owner}" and "${provider}" map to the same credential reference`)
      }
      owners.set(ref, provider)
      refs.set(provider, ref)
    }
    this.refs = refs
  }

  /** Read one stored provider credential without resolving request auth. */
  async read(providerId: string): Promise<Credential | undefined> {
    const hit = await this.credentials.resolve(this.ref(providerId))
    return hit === undefined ? undefined : parseCredential(providerId, hit.value)
  }

  /** Enumerate non-secret metadata for every stored provider credential. */
  async list(): Promise<readonly CredentialInfo[]> {
    const entries = await Promise.all([...this.refs.keys()].map(async (providerId): Promise<CredentialInfo | undefined> => {
      const credential = await this.read(providerId)
      return credential === undefined ? undefined : { providerId, type: credential.type }
    }))
    return entries.filter((entry): entry is CredentialInfo => entry !== undefined)
  }

  /**
   * Run pi-ai's read-modify-write callback under the Harness provider lock.
   * @param providerId - known pi-ai provider id.
   * @param update - serialized credential replacement callback.
   * @returns the effective credential after the callback.
   */
  async modify(
    providerId: string,
    update: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const effective = await this.credentials.modify(this.ref(providerId), async (raw) => {
      const next = await update(raw === undefined ? undefined : parseCredential(providerId, raw))
      return next === undefined ? undefined : serializeCredential(providerId, next)
    })
    return effective === undefined ? undefined : parseCredential(providerId, effective)
  }

  /** Remove one provider's stored credential. */
  async delete(providerId: string): Promise<void> {
    await this.credentials.unset(this.ref(providerId))
  }

  /** Resolve one known provider id to its collision-checked credential reference. */
  private ref(providerId: string): CredentialRef {
    const ref = this.refs.get(providerId)
    if (ref === undefined) throw new Error(`llm-pi-ai: credential store does not know provider "${providerId}"`)
    return ref
  }
}

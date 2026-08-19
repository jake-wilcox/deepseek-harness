/** Injected props for the ContextMeter provider-usage contribution. */

import type {
  HostObservable, InjectFace, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ProviderUsageState } from './controller.ts'
import type {} from './locales.ts'

/** Private business face of one session's account-usage reader. */
export interface ProviderUsageInjected {
  hooks: {
    /** Current request and allowance state. */
    usage: HostObservable<ProviderUsageState>
  }
  /** Start an on-demand read and return its cancellation disposer. */
  activate: () => () => void
  /** Retry the current provider on demand. */
  refresh: () => void
}

/** Full props of the provider-account allowance section. */
export type ProviderUsageProps =
  PropsRuntime<'conversation.composer.contextMeter.usage'>
  & InjectFace<ProviderUsageInjected>
  & PropsLocale<'providerUsage'>

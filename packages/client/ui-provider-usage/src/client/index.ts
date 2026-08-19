/** Browser plugin contributing provider-account allowance state to ContextMeter. */

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { ProviderUsageController } from './controller.ts'
import { en, NS, zh } from './locales.ts'
import { ProviderUsage } from './ProviderUsage.tsx'
import type { ProviderUsageInjected } from './slots.ts'

/** Required services for provider resolution, authenticated RPC, locale, and UI composition. */
export const inject = ['connection', 'locale', 'modelDirectories', 'sessions', 'slots']

/**
 * Register the account-usage dictionaries and ContextMeter contribution.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-provider-usage: dictionaries')
  const api = (ctx.get('connection') as ConnectionHandle).api
  const controllers = new Map<SessionId, ProviderUsageController>()

  const controllerFor = (sessionId: SessionId): ProviderUsageController => {
    const existing = controllers.get(sessionId)
    if (existing !== undefined) return existing
    const directory = ctx.modelDirectories.directoryFor(sessionId)
    const controller = new ProviderUsageController(api, async () => {
      let snapshot = directory.store.getSnapshot()
      if (snapshot.current === null) {
        await directory.load()
        snapshot = directory.store.getSnapshot()
      }
      return snapshot.current?.provider
    })
    controllers.set(sessionId, controller)
    const sessionScope = ctx.sessions.scope(sessionId)
    if (sessionScope === undefined) {
      controller.dispose()
      controllers.delete(sessionId)
      throw new Error(`ui-provider-usage: session "${String(sessionId)}" resolved no scope`)
    }
    sessionScope.effect(() => () => {
      controller.dispose()
      controllers.delete(sessionId)
    }, 'ui-provider-usage: session reader')
    return controller
  }

  ctx.effect(() => () => {
    for (const controller of controllers.values()) controller.dispose()
    controllers.clear()
  }, 'ui-provider-usage: readers')

  ctx.slots.inject('conversation.composer.contextMeter.usage', () => ctx.slots.register({
    name: 'conversation.composer.contextMeter.usage',
    locale: NS,
    inject: (sessionId): ProviderUsageInjected => {
      const controller = controllerFor(sessionId)
      return {
        hooks: { usage: controller },
        activate: controller.activate,
        refresh: controller.refresh,
      }
    },
  }, ProviderUsage))
}

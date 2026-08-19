/** `providerUsage` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'title': '订阅用量',
  'loading': '正在加载用量…',
  'refreshing': '正在刷新…',
  'unavailable': '当前提供商不提供订阅用量',
  'error': '暂时无法获取订阅用量',
  'retry': '重试',
  'refresh': '刷新',
  'window.duration': '{duration} 周期',
  'window.generic': '用量周期 {position}',
  'used': '已使用 {percent}%',
  'resets': '重置时间：{time}',
} satisfies Record<string, string>

/** The provider-usage namespace key union. */
export type ProviderUsageKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Provider-account allowance presentation. */
    providerUsage: ProviderUsageKey
  }
}

/** English dictionary, checked complete against the Chinese key set. */
export const en = {
  'title': 'Subscription usage',
  'loading': 'Loading usage…',
  'refreshing': 'Refreshing…',
  'unavailable': 'Subscription usage is not available for this provider',
  'error': 'Subscription usage is temporarily unavailable',
  'retry': 'Retry',
  'refresh': 'Refresh',
  'window.duration': '{duration} window',
  'window.generic': 'Usage window {position}',
  'used': '{percent}% used',
  'resets': 'Resets {time}',
} satisfies Record<ProviderUsageKey, string>

/** Dictionary namespace owned by this plugin. */
export const NS = 'providerUsage'

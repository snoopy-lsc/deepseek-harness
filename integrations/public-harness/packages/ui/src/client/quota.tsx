/** Platform allowance notices use the host locale and transient Toast: the refusal (shell.quota-notice) and the over-limit warning (shell.overlay). */
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { QuotaNoticeOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useState } from 'react'
import type { AccountApi, AccountUsage } from './me.ts'

/** Locale-owned platform quota messages. */
export const dictionaries = {
  en: {
    exhausted: 'Your model allowance is exhausted. Please try again after the daily allowance resets.',
    overGrace: 'You have used your daily allowance ({limit} tokens). A grace of {left} tokens remains today; after that new requests stop until {reset}.',
    overWarn: 'You have used your daily allowance ({limit} tokens). Requests still run, but please slow down; it resets {reset}.',
    overBlocked: 'Your daily allowance ({limit} tokens) is used up. New requests stop until {reset}.',
  },
  zh: {
    exhausted: '模型额度已用完，请在每日额度恢复后重试。',
    overGrace: '你今日的额度（{limit} tokens）已用完，还剩 {left} tokens 的宽限额度；用完后新的请求将暂停，直到 {reset}。',
    overWarn: '你今日的额度（{limit} tokens）已用完。请求仍可继续，但请控制用量；额度将于 {reset} 重置。',
    overBlocked: '你今日的额度（{limit} tokens）已用完，新的请求将暂停，直到 {reset}。',
  },
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    publicHarness: keyof typeof dictionaries.en
  }
}

type OverKey = 'overGrace' | 'overWarn' | 'overBlocked'
/** The over-limit sentence for a usage reading, or undefined while under the limit.
 * @param usage - the user's usage with the site policy.
 * @param t - translator owning the over* keys.
 * @returns localized text.
 */
export function overLimitText(usage: AccountUsage, t: (key: OverKey) => string): string | undefined {
  if (usage.state === undefined || usage.state === 'ok') return undefined
  const key: OverKey = usage.state === 'grace' ? 'overGrace' : usage.state === 'over' ? 'overWarn' : 'overBlocked'
  const values: Record<string, string> = { limit: usage.limitTokens.toLocaleString(), reset: new Date(usage.resetAt).toLocaleString(),
    left: Math.max(0, (usage.hardLimitTokens ?? usage.usedTokens) - usage.usedTokens).toLocaleString() }
  return t(key).replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '')
}

/** Render a platform quota refusal.
 * @param props - claimed notice, dismissal callback, and locale translator.
 * @returns the host's transient Toast with localized platform copy.
 */
export function QuotaNotice({ matched, t }: { matched: QuotaNoticeOwnerProps } & PropsLocale<'publicHarness'>) {
  return <Toast text={t('exhausted')} onDone={matched.dismiss} />
}

/** How often Harness re-reads the user's own usage for the over-limit warning. */
export const OVER_LIMIT_POLL_MS = 60_000
/** First reading after start-up, once the host's own start-up banners (same top-centre seat, 4 s life) have gone. */
export const OVER_LIMIT_FIRST_CHECK_MS = 4_500
/** The warning is a full sentence, so it holds longer than the host's 3 s default. */
export const OVER_LIMIT_HOLD_MS = 8_000

/** Over-limit warning in Harness: polls the user's own usage and shows the host Toast once per state and day when past the limit
 * (refusals themselves arrive through shell.quota-notice).
 * @param props - personal center client and translator.
 * @returns the Toast while a new warning is due, else nothing.
 */
export function OverLimitNotice({ api, t }: { api: AccountApi } & PropsLocale<'publicHarness'>) {
  const [text, setText] = useState<string>()
  useEffect(() => {
    let live = true
    const seen = new Set<string>()
    const check = () => {
      api.usage().then(usage => {
        if (!live || usage === undefined) return
        const message = overLimitText(usage, t), key = `${usage.day}:${usage.state ?? 'ok'}`
        if (message !== undefined && !seen.has(key)) { seen.add(key); setText(message) }
      }, () => undefined)
    }
    const first = setTimeout(check, OVER_LIMIT_FIRST_CHECK_MS)
    const timer = setInterval(check, OVER_LIMIT_POLL_MS)
    globalThis.addEventListener?.('focus', check)
    return () => { live = false; clearTimeout(first); clearInterval(timer); globalThis.removeEventListener?.('focus', check) }
  }, [api, t])
  return text === undefined ? null : <div data-team-over-limit><Toast text={text} holdMs={OVER_LIMIT_HOLD_MS} onDone={() => setText(undefined)} /></div>
}

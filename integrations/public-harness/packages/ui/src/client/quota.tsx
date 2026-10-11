/** Platform allowance notices use the host locale and transient Toast. */
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { QuotaNoticeOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

/** Locale-owned platform quota message. */
export const dictionaries = {
  en: { exhausted: 'Your model allowance is exhausted. Please try again after the daily allowance resets.' },
  zh: { exhausted: '模型额度已用完，请在每日额度恢复后重试。' },
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    publicHarness: keyof typeof dictionaries.en
  }
}

/** Render a platform quota notice.
 * @param props - claimed notice, dismissal callback, and locale translator.
 * @returns the host's transient Toast with localized platform copy.
 */
export function QuotaNotice({ matched, t }: { matched: QuotaNoticeOwnerProps } & PropsLocale<'publicHarness'>) {
  return <Toast text={t('exhausted')} onDone={matched.dismiss} />
}

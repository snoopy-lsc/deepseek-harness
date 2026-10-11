/** Browser brand occupants for every team Web instance. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { BrandMark, BrandName } from './mark.tsx'
import { QuotaNotice, dictionaries } from './quota.tsx'

/** Required service: the browser slot registry. */
export const inject = ['slots', 'locale']

/** Register brand occupants and platform quota copy.
 * @param ctx - browser root carrying slots and locale services.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('publicHarness', dictionaries), 'public-harness: copy')
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, BrandMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name' }, BrandName)
    }))
  ctx.slots.inject('shell.quota-notice', () => ctx.slots.register({
    name: 'shell.quota-notice', locale: 'publicHarness',
    select: owner => owner.code === 'QUOTA' ? owner : null,
  }, QuotaNotice))
}

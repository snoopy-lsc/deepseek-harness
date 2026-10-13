/** Host row for the browser brand plugin and shared browser entry pages. */
export { renderSelectorPage, renderStatusPage } from './status.ts'
export type { TeamLocale, TeamStatus } from './status.ts'
/** Load the host row so the Web runtime discovers this package's browser entry. */
export function apply(): void {}
export { identityStylesheet } from './theme/identity.ts'

/** Accessible mark and name rendered with host-provided presentation sizes. */
import type { CSSProperties } from 'react'

const markStyle: CSSProperties = { display: 'inline-grid', placeItems: 'center',
  borderRadius: '28%', background: 'linear-gradient(135deg,#1757a8,#359cd8)',
  color: '#fff', fontWeight: 800, fontFamily: 'system-ui,sans-serif', lineHeight: 1 }

/** Team identity mark for sidebar and collapsed rail.
 * @param props - presentation size supplied by the sidebar.
 * @returns an accessible mark that inherits the host layout.
 */
export function BrandMark({ size }: { readonly size: number }) {
  return <span aria-label="Team Harness" role="img" style={{ ...markStyle,
    width: size, height: size, fontSize: Math.max(12, Math.round(size * .55)) }}>T</span>
}

/** Render the team name in the host's text color.
 * @returns the expanded sidebar brand name.
 */
export function BrandName() {
  return <span style={{ fontWeight: 700, letterSpacing: '-.02em', color: 'inherit' }}>Team Harness</span>
}

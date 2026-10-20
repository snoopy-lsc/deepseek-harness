/** Theme-aware administration choices using the shared, viewport-fitted menu. */
import { Button, IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState } from 'react'

/** One selectable value and its localized display label. */
export interface AdminSelectOption<Value extends string> { readonly value: Value; readonly label: string }

/** Select one value without submitting the surrounding form; the menu escapes dialog clipping.
 * @param props - Accessible label, current value, available choices and selection callback.
 * @returns The themed trigger and portaled menu.
 */
export function AdminSelect<Value extends string>({ label, value, options, onChange }: {
  label: string; value: Value; options: readonly AdminSelectOption<Value>[]; onChange: (value: Value) => void
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find(option => option.value === value)
  return <span data-team-admin-select style={{ display: 'grid', minWidth: 0 }}>
    <Menu open={open} portal autoFocus selectedId={value} onClose={() => setOpen(false)}
      items={options.map(option => ({ id: option.value, label: <span style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{option.label}</span> }))}
      onSelect={id => { const option = options.find(item => item.value === id); if (option !== undefined) onChange(option.value); setOpen(false) }}
      anchor={<Button type="button" variant="outline" aria-label={`${label}: ${selected?.label ?? '—'}`} aria-haspopup="menu" aria-expanded={open}
        style={{ width: '100%', minWidth: 0, justifyContent: 'space-between', textAlign: 'left' }} onClick={() => setOpen(current => !current)}
        onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) } }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected?.label ?? '—'}</span>
        <IconChevronDownOutlineRegular size={14} />
      </Button>} />
  </span>
}

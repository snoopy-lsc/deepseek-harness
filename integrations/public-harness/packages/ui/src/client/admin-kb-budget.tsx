/** System Admin, Quota: the daily allowance of each company knowledge base's budget principal (`org-kb-<kbId>`), which its compiles are
 * charged to. Same row, input and button shapes as the per-user allowance card. */
import { useEffect, useState } from 'react'
import { Button, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AdminApi, AdminKb, AdminQuota, Proof } from './admin-api.ts'
import { budgetRows } from './admin-kb-units.ts'
import { Card, fill, hint, label, Row, type T } from './admin-kit.tsx'

export function KbBudgetsCard({ api, t, quota, save, invalid }: { api: AdminApi; t: T; quota: AdminQuota; save: (run: (proof: Proof) => Promise<AdminQuota>) => void; invalid: () => void }) {
  const [kbs, setKbs] = useState<readonly AdminKb[] | null>(), [values, setValues] = useState<Record<string, string>>({})
  useEffect(() => { api.kbInventory('all').then(reply => setKbs(reply.kbs), () => setKbs(null)) }, [api])
  // No KB service on this deployment: the card is left out.
  if (kbs === undefined || kbs === null) return null
  const rows = budgetRows(kbs, quota)
  const tokens = (n: number) => fill(t('tokens'), { n: n.toLocaleString() })
  const parse = (text: string) => /^[1-9][0-9]{0,14}$/.test(text) ? Number(text) : undefined
  return <Card testId="quota-kb-budgets">
    <div style={{ padding: '14px 0 4px' }}><div style={label}>{t('kbBudgets')}</div><div style={hint}>{t('kbBudgetsHint')}</div></div>
    {rows.length === 0 ? <Row title={<span style={hint}>{t('kbBudgetNone')}</span>} end />
      : rows.map((row, index) => <Row key={row.kbId} end={index === rows.length - 1}
        title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>{row.title}{row.archived && <Tag tone="neutral">{t('kbArchived')}</Tag>}</span>}
        detail={`${row.inherited ? fill(t('kbBudgetDefault'), { tokens: tokens(row.dailyTokens) }) : tokens(row.dailyTokens)} · ${fill(t('kbBudgetPrincipal'), { principal: row.principal })}`}>
        <form data-team-admin-kb-budget={row.kbId} style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }} onSubmit={event => {
          event.preventDefault(); const n = parse(values[row.kbId] ?? ''); if (n === undefined) { invalid(); return }
          save(proof => api.setPrincipalQuota(row.principal, n, proof))
        }}>
          <Input style={{ width: 140 }} inputMode="numeric" aria-label={t('dailyTokens')} placeholder={String(row.dailyTokens)} value={values[row.kbId] ?? ''}
            onChange={e => setValues({ ...values, [row.kbId]: e.target.value.replace(/\D/g, '') })} />
          <Button type="submit" variant="primary" size="sm">{t('save')}</Button>
          {!row.inherited && <Button variant="outline" size="sm" onClick={() => save(proof => api.setPrincipalQuota(row.principal, null, proof))}>{t('kbBudgetReset')}</Button>}
        </form>
      </Row>)}
  </Card>
}

import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { renderSelectorPage, renderStatusPage } from '../src/index.ts'

describe('installed team browser plugin', () => {
  it('shares the bilingual brand across selector, waiting, and refusal pages', () => {
    const selector = renderSelectorPage(['alice', 'bob'], 'zh')
    expect(selector).toContain('Team Harness')
    expect(selector).toContain('选择测试用户')
    expect(selector).toContain('/dev/select/alice')
    const waiting = renderStatusPage('starting', 'en', 3)
    expect(waiting).toContain('Team Harness')
    expect(waiting).toContain('http-equiv="refresh"')
    const refusal = renderStatusPage('capacity-full', 'zh', 3)
    expect(refusal).toContain('工作空间已满')
    expect(refusal).not.toContain('http-equiv="refresh"')
    expect(() => renderSelectorPage(['<script>'], 'en')).toThrow('invalid selector user')
  })

  it('registers its mark and name through the client module loader', async () => {
    const file = fileURLToPath(new URL('../lib/client.js', import.meta.url))
    const registrations: Array<{ name: string; render: (props: { size?: number; matched?: { dismiss: () => void }; t?: () => string }) => unknown; select?: (owner: { code: string }) => unknown }> = []
    let plugin: { id: string; factory(require: (name: string) => object): { apply(ctx: object): void } } | undefined
    runInNewContext(await readFile(file, 'utf8'), { window: { __ModuleLoader__: {
      load(value: typeof plugin) { plugin = value },
    } } })
    expect(plugin?.id).toBe('@public-harness/ui')
    const client = plugin!.factory(name => {
      if (name === 'react/jsx-runtime') return { jsx: (type: string, props: object) => ({ type, props }) }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Toast: 'Toast' }
      throw new Error(`unexpected browser dependency: ${name}`)
    })
    const slots = {
      inject(_name: string, apply: () => void | Generator<unknown> | (() => void)) {
        const result = apply()
        if (result !== undefined && typeof result !== 'function') for (const _ of result) { /* Consume registration effects. */ }
      },
      register(request: { name: string; select?: (owner: { code: string }) => unknown }, render: (props: { size?: number; matched?: { dismiss: () => void }; t?: () => string }) => unknown) {
        registrations.push({ name: request.name, select: request.select, render })
        return () => undefined
      },
    }
    const dictionaries: Array<{ en: { exhausted: string }; zh: { exhausted: string } }> = []
    const themed: string[] = []
    client.apply({ slots, effect: (fn: () => void) => fn(), theme: { overrideTokens(source: string) { themed.push(source); return () => undefined } }, locale: {
      register(_name: string, value: typeof dictionaries[number]) { dictionaries.push(value) },
    } })
    expect(themed).toEqual(['team-enterprise'])
    expect(registrations.map(item => item.name)).toEqual(['sidebar.brand.mark', 'sidebar.brand.name', 'shell.quota-notice'])
    expect(registrations[2]?.select?.({ code: 'QUOTA' })).toEqual({ code: 'QUOTA' })
    expect(registrations[2]?.select?.({ code: 'ACCOUNT_QUOTA' })).toBeNull()
    const dismiss = () => undefined
    const quota = registrations[2]?.render({ matched: { dismiss }, t: () => dictionaries[0]!.zh.exhausted })
    expect(quota).toMatchObject({ type: 'Toast', props: { text: '模型额度已用完，请在每日额度恢复后重试。', onDone: dismiss } })
    expect(registrations[0]?.render({ size: 24 })).toMatchObject({ props: { 'aria-label': 'Team Harness' } })
  })
})

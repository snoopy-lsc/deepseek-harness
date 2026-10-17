/** Knowledge bases through a real browser against a running local stack (identity + KB gateway + router + one Web instance),
 * signed in through the stack's mock IdP as an administrator. Runs only when PUBLIC_HARNESS_E2E_BROWSER names a Chrome executable and
 * PUBLIC_HARNESS_KB_STACK names the stack origin (a 127.0.0.1 address); the stack compiles on the deterministic mock model.
 * Expects the demo data the stack was seeded with: a private personal KB titled "Demo · Release checklist", pending share requests,
 * and a limit override that puts one KB over its page limit. With PUBLIC_HARNESS_KB_SHOTS set, light and dark screenshots are written
 * there. The request-share dialog is submitted in the last colour scheme only, so the run leaves one more pending request behind. */
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright-core'

const executable = process.env.PUBLIC_HARNESS_E2E_BROWSER
const origin = process.env.PUBLIC_HARNESS_KB_STACK
const shots = process.env.PUBLIC_HARNESS_KB_SHOTS
const DEMO = 'Demo · Release checklist'

describe.skipIf(executable === undefined || origin === undefined)('knowledge bases in a real browser', () => {
  let browser: Browser
  beforeAll(async () => {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin!)) throw new Error('PUBLIC_HARNESS_KB_STACK must be a 127.0.0.1 origin')
    // Box-only test harness: the sandbox is the product's concern on the dedicated host, not this flow's.
    browser = await chromium.launch({ executablePath: executable!, headless: true, chromiumSandbox: false })
  })
  afterAll(async () => { await browser?.close() })

  const shot = async (page: Page, name: string, scheme: 'light' | 'dark') => {
    // Let panel transitions and modal animations settle so the capture shows the resting state.
    await page.waitForTimeout(1200)
    if (shots !== undefined) await page.screenshot({ path: join(shots, `${name}${scheme === 'dark' ? '-dark' : ''}.png`) })
  }
  const admin = async (page: Page, section: string) => {
    await page.click('[aria-label=Administration]')
    await page.click(`[data-team-admin-menu=${section}]`)
  }

  for (const scheme of ['light', 'dark'] as const) {
    it(`walks_the_personal_center_share_flow_and_the_admin_pages_${scheme}`, async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, locale: 'en-US' })
      const page = await context.newPage()
      try {
        await page.goto(`${origin}/account/login?lang=en`)
        await page.click('[data-sso-start]')
        await page.waitForURL(/\/u\/[^/]+\/$/, { timeout: 120_000 })
        await page.waitForSelector('[aria-label=Personal]', { timeout: 120_000 })

        // Personal center: the KB section with usage against the effective limits and the demo KBs.
        await page.click('[aria-label=Personal]')
        const section = page.locator('[data-team-kb]')
        await section.waitFor()
        await expect.poll(() => section.textContent()).toContain(DEMO)
        await page.locator('section', { has: section }).evaluate(node => node.scrollIntoView({ block: 'center' }))
        await shot(page, 'personal-kb', scheme)

        // Request share on the private demo KB: the dialog, then (dark pass only) the pending state.
        const row = section.locator('div', { hasText: DEMO }).filter({ has: page.locator('[data-team-kb-share-open],[data-team-kb-withdraw]') }).last()
        const open = row.locator('[data-team-kb-share-open]')
        if (await open.count() > 0) {
          await open.click()
          const form = page.locator('form[data-team-kb-share]')
          await form.locator('input').fill('Demo: release checklist for engineering')
          await shot(page, 'kb-request-share', scheme)
          if (scheme === 'dark') {
            await form.locator('button[type=submit]').click()
            await expect.poll(() => row.locator('[data-team-kb-withdraw]').count()).toBe(1)
          } else await form.getByRole('button', { name: 'Cancel' }).click()
        }

        // Administration: approval queue, inventory with the over-limit flag, and the limits card in Quota.
        await admin(page, 'kbRequests')
        const queue = page.locator('[data-team-admin-card=kb-requests]')
        await queue.waitFor()
        await expect.poll(() => queue.locator('[data-team-admin-kb-review-open]').count()).toBeGreaterThan(0)
        await shot(page, 'kb-approval-queue', scheme)
        await queue.locator('[data-team-admin-kb-review-open]').first().click()
        await page.locator('[data-team-admin-kb-review]').waitFor()
        await expect.poll(() => page.locator('[data-team-admin-kb-files]').textContent()).toContain('wiki/')
        await shot(page, 'kb-approval-review', scheme)
        await page.keyboard.press('Escape')

        await page.click('[data-team-admin-menu=kb]')
        const inventory = page.locator('[data-team-admin-card=kb-inventory]')
        await inventory.waitFor()
        await expect.poll(() => inventory.textContent()).toContain('Demo · Company handbook')
        await expect.poll(() => inventory.textContent()).toContain('Over limit')
        await shot(page, 'kb-inventory', scheme)

        await page.click('[data-team-admin-menu=quota]')
        const limits = page.locator('[data-team-admin-card=quota-kb-limits]')
        await limits.waitFor()
        await expect.poll(() => limits.textContent()).toContain('Knowledge base limits')
        await limits.evaluate(node => {
          node.scrollIntoView({ block: 'start' })
          // Leave a margin above the card inside whichever ancestor scrolls.
          for (let el = node.parentElement; el !== null; el = el.parentElement) if (el.scrollHeight > el.clientHeight + 1 && el.scrollTop > 0) { el.scrollTop -= 24; break }
        })
        await shot(page, 'kb-limits', scheme)
      } finally { await context.close() }
    }, 300_000)
  }
})

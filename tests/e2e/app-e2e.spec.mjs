import { test, expect } from 'playwright/test'
import { basePath } from './playwright.config.mjs'

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/$/, '')
}

function attachConsoleFailureHooks(page) {
  const errors = []

  page.on('pageerror', (err) => {
    errors.push(`[pageerror] ${err?.message || String(err)}`)
  })

  page.on('console', (msg) => {
    const type = msg.type()
    if (type !== 'error') return

    const text = msg.text()
    // Ignore common benign browser noise that is not actionable in tests.
    const ignored = [/ResizeObserver loop limit exceeded/i]
    if (ignored.some((re) => re.test(text))) return

    errors.push(`[console.${type}] ${text}`)
  })

  page.on('requestfailed', (req) => {
    const failure = req.failure()
    const url = req.url()
    // Ignore favicon fetch failures (some environments don't ship one).
    if (/\/favicon\.ico(\?|$)/i.test(url)) return
    // Ignore aborted requests (common during navigations/reloads).
    if (String(failure?.errorText || '').includes('ERR_ABORTED')) return
    errors.push(`[requestfailed] ${url} ${failure?.errorText || ''}`.trim())
  })

  return errors
}

async function dismissBlockingOverlay(page) {
  const overlay = page.locator('div[data-state="open"].fixed.inset-0')
  for (let i = 0; i < 12; i += 1) {
    const count = await overlay.count()
    if (count === 0) return

    // Some dialogs close on outside click (overlay).
    await overlay.first().click({ timeout: 500, force: true }).catch(() => {})

    // Prefer clicking the standard shadcn/Radix dialog close button if present.
    const closeButton = page.getByRole('button', { name: 'Close' }).first()
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click({ timeout: 1000 }).catch(() => {})
    }

    // Escape closes most Radix dialogs/popovers.
    await page.keyboard.press('Escape').catch(() => {})
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(200)
  }
}

async function loginWithPreviewOtp({ page, email }) {
  const appBase = stripTrailingSlash(basePath)
  await page.addInitScript(() => {
    // Frontend reads this before app code runs to disable noisy admin auto-crawls.
    globalThis.__GF_SMOKE__ = true
    // Avoid onboarding modals interrupting automation.
    try {
      window.localStorage.setItem('grantflow:onboarding-complete', 'true')
    } catch {
      // ignore
    }
  })

  await page.goto(`${appBase}/login`, { waitUntil: 'networkidle' })
  await page.locator('#auth-email').fill(email)
  await page.getByRole('button', { name: /continue with email/i }).click()

  // Wait for the preview code (non-prod / smoke mode) and use it to verify.
  const codeEl = page.locator('span.font-mono').first()
  await expect(codeEl).toBeVisible()
  const raw = (await codeEl.textContent()) || ''
  const code = raw.replace(/[^\d]/g, '').slice(0, 6)
  expect(code, 'expected a 6-digit preview verification code').toMatch(/^\d{6}$/)

  await page.locator('#auth-code').fill(code)
  await page.getByRole('button', { name: /verify/i }).click()

  await page.waitForURL(/\/Dashboard/i, { timeout: 60_000 })
}

async function clickNavLink(page, name) {
  await dismissBlockingOverlay(page)
  await page.getByRole('link', { name }).click()
}

test('e2e: login, admin panel, source directory, queue crawler, pipeline, opportunities', async ({ page }) => {
  const errors = attachConsoleFailureHooks(page)

  await loginWithPreviewOtp({ page, email: 'buckeye7066@gmail.com' })
  // Some dialogs mount right after navigation; give the UI a beat, then dismiss.
  await page.waitForTimeout(250)
  await dismissBlockingOverlay(page)

  // Admin panel renders.
  await clickNavLink(page, 'Admin Panel')
  await expect(page.getByRole('heading', { name: 'Admin Panel' })).toBeVisible()

  // Source Directory renders.
  await clickNavLink(page, 'Source Directory')
  await expect(page.getByRole('heading', { name: 'Source Directory' })).toBeVisible()

  // Automation: queue at least one crawler job via UI.
  await clickNavLink(page, 'Automation')
  await expect(page.getByRole('heading', { name: /Automation Control Center/i })).toBeVisible()
  const localSweepCard = page.locator('div.rounded-xl').filter({ hasText: /Launch local sweep/i }).first()
  await expect(localSweepCard).toBeVisible()
  await localSweepCard.getByRole('button', { name: /run now/i }).click()
  await expect(page.getByText('Automation queued', { exact: false })).toBeVisible()
  await expect(page.locator('#automation-queue')).toBeVisible()
  await expect(page.locator('#automation-queue tbody tr').first()).toBeVisible()

  // Pipeline page renders (even if empty).
  await clickNavLink(page, 'Pipeline')
  await expect(page.getByRole('heading', { name: 'Master Grant Pipeline' })).toBeVisible()

  // Funding Opportunities list view renders (even if empty).
  await clickNavLink(page, 'Funding Opportunities')
  await expect(page.getByRole('heading', { name: 'Funding Opportunities' })).toBeVisible()

  expect(errors, 'no console/page/request errors during e2e flow').toEqual([])
})


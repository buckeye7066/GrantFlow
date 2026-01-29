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
    const ignored = [
      /ResizeObserver loop limit exceeded/i,
      // React warnings that are noisy in prod bundles during smoke/e2e runs.
      // (We still surface page errors and request failures.)
      /Each child in a list should have a unique "key" prop/i,
      /validateDOMNesting/i,
    ]
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

  // Current auth UX: password setup flow.
  // In smoke/e2e mode, backend returns a preview_token and the UI auto-navigates to /set-password.
  // If a password already exists, the UI asks for it on the login screen.
  const strongPassword = 'PlaywrightE2E-Pass123!'

  const passwordInput = page.locator('#auth-password')
  const started = Date.now()
  while (Date.now() - started < 60_000) {
    const url = page.url()

    if (/\/Dashboard/i.test(url)) return

    if (/\/set-password/i.test(url)) {
      await page.locator('#new-password').fill(strongPassword)
      await page.locator('#confirm-password').fill(strongPassword)
      await page.getByRole('button', { name: /set password/i }).click()
      await page.waitForURL(/\/Dashboard/i, { timeout: 60_000 })
      return
    }

    if (await passwordInput.isVisible().catch(() => false)) {
      await passwordInput.fill(strongPassword)
      await page.getByRole('button', { name: /sign in/i }).click()
      await page.waitForURL(/\/Dashboard/i, { timeout: 60_000 })
      return
    }

    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(500)
  }

  throw new Error(`login did not complete within 60s (url=${page.url()})`)
}

async function clickNavLink(page, name) {
  await dismissBlockingOverlay(page)
  await page.getByRole('link', { name }).click({ force: true })
}

test('e2e: login, admin panel, source directory, queue crawler, pipeline, opportunities', async ({ page }) => {
  const errors = attachConsoleFailureHooks(page)
  const appBase = stripTrailingSlash(basePath)

  await loginWithPreviewOtp({ page, email: 'buckeye7066@gmail.com' })
  // Some dialogs mount right after navigation; give the UI a beat, then dismiss.
  await page.waitForTimeout(250)
  await dismissBlockingOverlay(page)

  // Organizations page renders and we can create + select a profile.
  await page.goto(`${appBase}/Organizations`, { waitUntil: 'networkidle' })
  await expect(page.getByRole('heading', { name: 'Profiles' })).toBeVisible()

  await page.getByRole('button', { name: /quick add/i }).click()
  const quickAddDialog = page.getByRole('dialog').filter({ hasText: /quick add profile/i }).first()
  await expect(quickAddDialog).toBeVisible()

  const e2eProfileName = 'E2E Profile'
  await quickAddDialog.locator('#display_name').fill(e2eProfileName)

  // Select profile type.
  await quickAddDialog.getByText('Select profile type').click()
  await page.getByRole('option', { name: 'Organization', exact: true }).click()

  await quickAddDialog.getByRole('button', { name: /create profile/i }).click()
  await page.waitForURL(/\/OrganizationProfile/i, { timeout: 60_000 })
  await dismissBlockingOverlay(page)

  // Confirm we can select the newly created profile in a profile-scoped surface.
  await page.goto(`${appBase}/Documents`, { waitUntil: 'networkidle' })
  await expect(page.getByRole('heading', { name: 'Document Library' })).toBeVisible()

  const documentsHeader = page.getByRole('heading', { name: 'Document Library' }).locator('..').locator('..')
  const profilePicker = documentsHeader.getByRole('combobox').first()
  await profilePicker.click()
  await page.getByRole('option', { name: e2eProfileName }).click()
  await expect(profilePicker).toContainText(e2eProfileName)

  // Discover Grants: run at least one crawler and ensure results render + counts are non-zero.
  await page.goto(`${appBase}/DiscoverGrants`, { waitUntil: 'networkidle' })
  await expect(page.getByRole('heading', { name: /Discover Funding Opportunities/i })).toBeVisible()
  await expect(page.getByText('Select Funding Crawlers', { exact: true })).toBeVisible()

  // Select the profile for crawler runs (shadcn/Radix Select renders as a button).
  const discoverProfileTrigger = page.locator('button').filter({ hasText: /choose a profile/i }).first()
  // Open the picker and wait for options to populate (can take a beat on first mount).
  const options = page.locator('[role="option"]')
  const noProfiles = page.getByText(/No profiles available/i).first()
  const loadingProfiles = page.getByText(/Loading profiles/i).first()

  let selected = false
  for (let i = 0; i < 40; i += 1) {
    await discoverProfileTrigger.click({ force: true })

    if (await options.first().isVisible().catch(() => false)) {
      await options.first().click()
      selected = true
      break
    }

    if (await noProfiles.isVisible().catch(() => false)) {
      throw new Error('DiscoverGrants profile picker shows "No profiles available"')
    }

    // If still loading, close + retry.
    await page.keyboard.press('Escape').catch(() => {})
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(500)
    if (!(await loadingProfiles.isVisible().catch(() => false))) {
      // give one more beat for React Query to settle even if message isn't present
      // eslint-disable-next-line no-await-in-loop
      await page.waitForTimeout(250)
    }
  }

  if (!selected) {
    throw new Error('DiscoverGrants profile picker did not render any options')
  }

  // Select all crawlers (more robust than targeting a specific card).
  await page.getByLabel(/select all crawlers/i).click()
  const runCrawlersButton = page.getByRole('button', { name: /Run Selected Crawlers/i })
  await expect(runCrawlersButton).toBeEnabled()
  await runCrawlersButton.click()

  // Wait for crawler completion summary first (this should always render after responses return).
  const crawlerResultsPanel = page.getByText('Crawler Results', { exact: true }).locator('..')
  await expect(crawlerResultsPanel).toBeVisible({ timeout: 90_000 })

  // Counts must be non-zero when opportunities exist.
  await expect(crawlerResultsPanel).toContainText(/Local Funding:\s+[1-9]\d*\s+included of\s+\d+\s+found/i)

  // Results must render in the Discover Grants UI (treat missing render as a bug, not UX).
  const results = page.locator('[data-component="SearchResults"]')
  await expect(results).toBeVisible({ timeout: 60_000 })
  const resultsCountRaw = (await results.getAttribute('data-results-count')) || '0'
  const resultsCount = Number.parseInt(resultsCountRaw, 10) || 0
  expect(resultsCount).toBeGreaterThan(0)
  // Confirm multiple funding sources are present (directory resources should surface).
  await expect(results).toContainText(/United Way/i)
  await expect(results).toContainText(/Feeding America/i)

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


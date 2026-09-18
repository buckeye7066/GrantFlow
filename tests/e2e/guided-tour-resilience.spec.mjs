/**
 * End-to-end resilience coverage for the new-user intake:
 *
 *   1. The full anonymous /start interview -> password setup -> authenticated
 *      dashboard handoff (the REAL signup path, no fixtures).
 *   2. A refresh preserves the authenticated session.
 *
 * Uses the same self-started server as app-e2e.spec.mjs (migrate + seed +
 * build + start); smoke mode follows the backend's preview token directly to
 * the same password-setup screen linked by the real onboarding email.
 */
import { test, expect } from 'playwright/test'
import { basePath } from './playwright.config.mjs'

// '/' (app served at the domain root, e.g. a fresh checkout with no .env
// setting VITE_APP_BASE) normalizes to '' so `${appBase}/start` stays valid.
const appBase = String(basePath || '').replace(/\/+$/, '')

async function dismissIntroVideo(page, expect) {
  // Fresh browser contexts auto-open the intro video dialog on /start; it can
  // mount a beat after load, so retry dismissal until it is provably gone.
  const dialog = page.getByRole('dialog').filter({ hasText: /welcome to grantflow/i })
  await page.waitForTimeout(1_000) // give it a beat to mount at all
  for (let i = 0; i < 15; i += 1) {
    if (!(await dialog.isVisible().catch(() => false))) break
    await dialog.getByRole('button', { name: /skip for now/i }).click({ timeout: 2_000 }).catch(() => {})
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(400)
  }
  await expect(dialog).toBeHidden({ timeout: 5_000 })
}

test('new user: signup interview, password setup, and authenticated refresh', async ({ page }) => {
  test.setTimeout(300_000)
  const email = `tour-e2e-${Date.now()}@example.com`

  await page.goto(`${appBase}/start`, { waitUntil: 'networkidle' })
  await dismissIntroVideo(page, expect)

  // --- Anya interview (personal branch, shortest honest pass) ---
  await page.getByRole('button', { name: /english/i }).click()
  await page.getByRole('button', { name: /let's do it/i }).click()
  await page.getByRole('button', { name: /myself or my family/i }).click()

  // Location: ZIP autofills state; select manually if the lookup is offline.
  await page.locator('#zip').fill('37205')
  await page
    .waitForFunction(() => document.querySelector('#state')?.value, null, { timeout: 5_000 })
    .catch(() => {})
  if (!(await page.locator('#state').inputValue())) {
    await page.locator('#state').selectOption('TN')
  }
  await page.getByRole('button', { name: /continue/i }).click()

  await page.getByRole('button', { name: /just me \(single adult\)/i }).click()

  // Needs (multi-choice, at least one required).
  await page.getByRole('button', { name: /food \/ groceries/i }).click()
  await page.getByRole('button', { name: /^continue$/i }).click()

  // Situations (optional multi-choice) — the "Optional" hint marks it mounted.
  await expect(page.getByText(/^optional$/i)).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: /^continue$/i }).click()

  // Narrative (optional long text) — explicit Skip affordance.
  await page.getByRole('button', { name: /^skip$/i }).click({ timeout: 15_000 })

  // Name (required text) — the only textbox on screen at this point.
  await page.getByRole('textbox').fill('Tour Tester')
  await page.getByRole('button', { name: /^continue$/i }).click()

  // Email -> password setup. In smoke mode the completion response carries the
  // same one-time token normally delivered by email and navigates here.
  await page.locator('input[type="email"]').fill(email)
  await page.getByRole('button', { name: /send my sign-in code/i }).click()
  await expect(page.getByRole('heading', { name: /set your password/i })).toBeVisible({ timeout: 30_000 })
  const password = 'Tour-E2E-Password123!'
  await page.locator('#new-password').fill(password)
  await page.locator('#confirm-password').fill(password)
  await page.getByRole('button', { name: /set password & sign in/i }).click()

  // --- The authenticated dashboard is visible and survives refresh. ---
  await expect(page).toHaveURL(/Dashboard/i, { timeout: 30_000 })
  await expect(page.getByRole('heading', { name: /GrantFlow/i }).first()).toBeVisible({ timeout: 30_000 })
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page).toHaveURL(/Dashboard/i, { timeout: 30_000 })
  const completionGate = page.getByRole('dialog', { name: /finish your profile/i })
  await expect(completionGate).toContainText(/Hi Tour/i, { timeout: 30_000 })
})

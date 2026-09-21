/**
 * End-to-end resilience coverage for the new-user intake:
 *
 *   1. The full anonymous /start interview -> password setup -> required
 *      profile completion (the real signup path, no pre-created account).
 *   2. Optional end-user guidance survives a refresh without forcing navigation.
 *   3. Skipping the introduction persists across reloads.
 *   4. Bare /GrantDetail (no id) renders the friendly not-found state with
 *      working ways out — never a dead end.
 *
 * Uses the same self-started server as app-e2e.spec.mjs (migrate + seed +
 * build + start); the isolated development server previews the password link.
 * The end-user shell intentionally replaced the route-forcing cycle tour with
 * EndUserWelcomeGuide. The legacy guided-tour store retains its unit coverage.
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

test('welcome guide: signup, required profile completion, refresh, skip, bare GrantDetail fallback', async ({ page }) => {
  test.setTimeout(300_000)
  const email = `tour-e2e-${Date.now()}@example.invalid`

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

  // Use the current password-link handoff, not the retired preview-OTP screen.
  await page.locator('input[type="email"]').fill(email)
  await page.getByRole('button', { name: /send my sign-in code/i }).click()
  await expect(page).toHaveURL(/\/set-password\?token=/)
  await page.locator('#new-password').fill('Tour-Readiness-2026!')
  await page.locator('#confirm-password').fill('Tour-Readiness-2026!')
  await page.getByRole('button', { name: 'Set password & sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/Dashboard(?:\?|$)/)
  const gate = page.getByTestId('profile-completion-gate')
  await expect(gate).toBeVisible()
  await gate.getByRole('textbox', { name: /Roughly how urgent is your financial need/ }).fill('high')
  await gate.getByRole('button', { name: 'Finish', exact: true }).click()
  await expect(gate).toBeHidden()

  const guide = page.getByRole('heading', { name: 'Start with one clear next step', exact: true })
  await expect(guide).toBeVisible()
  await expect(page.getByRole('link', { name: 'Read the getting-started guide', exact: true })).toBeVisible()
  // Refresh preserves the pending guide and the current route.
  await page.reload({ waitUntil: 'networkidle' })
  await expect(guide).toBeVisible()
  await expect(page).toHaveURL(/\/Dashboard(?:\?|$)/)

  const skipped = page.waitForResponse(response =>
    new URL(response.url()).pathname === `${appBase}/api/auth/onboarding-state` && response.request().method() === 'PATCH')
  await page.getByRole('button', { name: 'Skip this introduction', exact: true }).click()
  expect((await skipped).status()).toBe(200)
  await expect(guide).toBeHidden()
  await page.reload({ waitUntil: 'networkidle' })
  await expect(guide).toBeHidden()

  // --- Bare /GrantDetail is a friendly state with ways out, not a dead end. ---
  await page.goto(`${appBase}/GrantDetail`, { waitUntil: 'networkidle' })
  await expect(page.getByTestId('grant-not-found')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/we couldn't find that funding source/i)).toBeVisible()
  await page.getByRole('link', { name: /go to my pipeline/i }).click()
  await expect(page).toHaveURL(/Pipeline/i, { timeout: 30_000 })
})

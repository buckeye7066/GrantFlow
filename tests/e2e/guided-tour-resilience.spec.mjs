/**
 * End-to-end resilience coverage for the new-user intake:
 *
 *   1. The full anonymous /start interview -> preview-OTP sign-in -> guided
 *      tour handoff (the REAL signup path, no fixtures).
 *   2. A mid-tour page refresh RESUMES at the same step (tab-session
 *      persistence) instead of restarting or vanishing.
 *   3. "Skip guided tour" always works and stays skipped across reloads.
 *   4. Bare /GrantDetail (no id) renders the friendly not-found state with
 *      working ways out — never a dead end.
 *
 * Uses the same self-started server as app-e2e.spec.mjs (migrate + seed +
 * build + start); the onboarding OTP is read from the on-page dev preview,
 * which the backend exposes outside production.
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

test('guided tour: signup interview, refresh-resume, skip, bare GrantDetail fallback', async ({ page }) => {
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

  // Email -> OTP. The dev preview line exposes the code outside production.
  await page.locator('input[type="email"]').fill(email)
  await page.getByRole('button', { name: /send my sign-in code/i }).click()
  const preview = page.getByText(/dev preview: *\d{6}/i)
  await expect(preview).toBeVisible({ timeout: 30_000 })
  const code = (await preview.textContent()).match(/(\d{6})/)[1]
  await page.locator('#otp').fill(code)
  await page.getByRole('button', { name: /sign in & start matching/i }).click()

  // Handoff panel -> tour.
  await page.getByRole('button', { name: /let's go/i }).click({ timeout: 30_000 })

  // --- Tour starts: auto-navigates to DiscoverGrants, step 1 coachmark. ---
  await expect(page).toHaveURL(/DiscoverGrants/i, { timeout: 30_000 })
  await expect(
    page.getByRole('dialog', { name: /let's find your first real match/i }),
  ).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/step 1 of \d+/i)).toBeVisible()

  // --- Refresh mid-tour resumes at the SAME step. ---
  await page.getByRole('button', { name: /^next$/i }).click()
  const stepLabel = page.getByText(/step \d+ of \d+/i)
  await expect(stepLabel).toBeVisible()
  const stepBeforeReload = (await stepLabel.textContent()).trim()
  expect(stepBeforeReload).not.toMatch(/^Step 1 /) // we really advanced

  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.getByText(stepBeforeReload)).toBeVisible({ timeout: 30_000 })

  // --- Skip is always available and sticks across reloads. ---
  await page.getByRole('button', { name: /skip guided tour/i }).click()
  await expect(page.getByText(/step \d+ of \d+/i)).toHaveCount(0)
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.getByText(/step \d+ of \d+/i)).toHaveCount(0)

  // --- Bare /GrantDetail is a friendly state with ways out, not a dead end. ---
  await page.goto(`${appBase}/GrantDetail`, { waitUntil: 'networkidle' })
  await expect(page.getByTestId('grant-not-found')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/we couldn't find that funding source/i)).toBeVisible()
  await page.getByRole('link', { name: /go to my pipeline/i }).click()
  await expect(page).toHaveURL(/Pipeline/i, { timeout: 30_000 })
})

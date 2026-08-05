/**
 * LIVE PROBE — verify the "Admin Tools" quick-action button is enabled and
 * openable for admin users.
 *
 * Reproduces the UI path the user hits in production:
 *   1. Authenticate as admin via Bearer ADMIN_TOKEN stored in localStorage
 *      (frontend's api client reads `grantflow:access-token`).
 *   2. Open the Anya floating panel.
 *   3. Inspect the "Admin Tools" button: it must exist, be non-disabled, and
 *      clicking it must open the admin tools dialog.
 *
 * This guards against regressions where the button greys out for legitimate
 * admins (Anya goals 4, 6, 8).
 */
import { test, expect } from 'playwright/test'
import { basePath, baseURL } from './playwright.config.mjs'

const appBase = String(basePath || '').replace(/\/+$/, '')
// Doctor / CI runs pass the per-run admin token via SMOKE_ADMIN_TOKEN; standalone
// runs may set ADMIN_TOKEN directly. Either is accepted; fall back to the legacy
// 'test-admin-token' default for backwards compatibility with older harnesses.
const ADMIN_TOKEN =
  process.env.SMOKE_ADMIN_TOKEN || process.env.ADMIN_TOKEN || 'test-admin-token'

async function seedAdminAuth(page) {
  // Anchor on the SPA base so localStorage is set for the right origin/path.
  await page.goto(`${baseURL}${appBase}/login`, { waitUntil: 'domcontentloaded' })
  await page.evaluate((token) => {
    localStorage.setItem('grantflow:access-token', token)
    // Clear onboarding so the chat surface renders immediately.
    localStorage.setItem('anya_onboarding_completed', '1')
  }, ADMIN_TOKEN)
}

test('Admin Tools button is enabled and opens dialog for admins', async ({ page }) => {
  const consoleErrors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  await seedAdminAuth(page)

  // Verify the admin token is accepted by the API before we ask the SPA to
  // boot under it. If the server doesn't recognise the token there is no
  // point looking for the FAB — the route guard will redirect to /login.
  const me = await page.evaluate(async () => {
    const token = localStorage.getItem('grantflow:access-token')
    const res = await fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  })
  console.log('[probe] /api/auth/me:', JSON.stringify(me).slice(0, 500))
  expect(me.status, '/api/auth/me should authenticate admin token').toBe(200)

  // Now navigate to /Admin. The SPA boots, hydrates the token from
  // localStorage (which tentatively flips isAuthenticated=true so route
  // guards don't bounce us), then calls /api/auth/me to confirm. We wait
  // for either the FAB or an explicit redirect back to /login — whichever
  // happens first.
  await page.goto(`${baseURL}${appBase}/Admin`, { waitUntil: 'networkidle' })

  // Open the Anya panel (FAB button with aria-label / sr-only "Open Anya").
  const fab = page.getByRole('button', { name: /open anya/i })
  await expect(fab).toBeVisible({ timeout: 20_000 })
  await fab.click()

  // Panel must show the quick-actions row. Wait for tools to finish loading.
  const adminToolsBtn = page.getByRole('button', { name: /^admin tools$/i })
  await expect(adminToolsBtn, 'Admin Tools quick-action button must render').toBeVisible({
    timeout: 15_000,
  })

  // Critical assertion: the button must NOT be disabled for admins.
  await expect(adminToolsBtn, 'Admin Tools button must be ENABLED for admin user').toBeEnabled({
    timeout: 10_000,
  })

  // Click it. Dialog titled "Admin Tools" should open with at least one tool group.
  await adminToolsBtn.click()
  const dialogTitle = page.getByRole('heading', { name: /admin tools/i })
  await expect(dialogTitle).toBeVisible({ timeout: 5_000 })

  // Sanity: at least one admin tool button ("Run") should be present inside the dialog.
  const runButtons = page.locator('[role="dialog"]').getByRole('button', { name: /^run$/i })
  await expect(runButtons.first(), 'Dialog should render at least one Run button').toBeVisible({
    timeout: 5_000,
  })
  const runCount = await runButtons.count()
  console.log(`[probe] Admin Tools dialog renders ${runCount} Run buttons`)

  // Report any console errors for diagnosis but do not fail on them here.
  if (consoleErrors.length > 0) {
    console.warn('[probe] console errors during run:', consoleErrors.slice(0, 10))
  }
})

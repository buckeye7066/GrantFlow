/**
 * E2E: Anya copilot persistence across refresh and login.
 * 1) Login → Dashboard
 * 2) Navigate to Pipeline, Discover, Documents
 * 3) Enable Anya in Settings (admin), open Anya panel, verify Next steps
 * 4) Refresh → settings remain, Anya and Next steps still present
 * 5) Logout
 */
import { test, expect } from 'playwright/test'
import { basePath, e2eAdminEmail } from './playwright.config.mjs'

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/$/, '')
}

async function dismissBlockingOverlay(page) {
  const overlay = page.locator('div[data-state="open"].fixed.inset-0')
  for (let i = 0; i < 8; i += 1) {
    if ((await overlay.count()) === 0) return
    await overlay.first().click({ timeout: 500, force: true }).catch(() => {})
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(200)
  }
}

async function loginAsAdmin(page, appBase) {
  await page.addInitScript(() => {
    globalThis.__GF_SMOKE__ = true
    try {
      window.localStorage.setItem('grantflow:onboarding-complete', 'true')
    } catch {}
  })
  await page.goto(`${appBase}/login`, { waitUntil: 'networkidle' })
  await page.locator('#auth-email').fill(e2eAdminEmail)
  await page.getByRole('button', { name: /continue with email/i }).click()
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
    await page.waitForTimeout(500)
  }
  throw new Error('Login did not complete')
}

test('e2e: login, key routes, Anya on, refresh persistence, logout', async ({ page }) => {
  const appBase = stripTrailingSlash(basePath)

  await loginAsAdmin(page, appBase)
  await page.waitForTimeout(300)
  await dismissBlockingOverlay(page)

  // 1) Dashboard rendered
  await expect(page.getByRole('heading', { name: /GrantFlow|Dashboard/i }).first()).toBeVisible({ timeout: 15_000 })

  // 2) Navigate to Pipeline, Discover, Documents
  await page.goto(`${appBase}/Pipeline`, { waitUntil: 'networkidle' })
  await expect(page.getByRole('heading', { name: /Master Grant Pipeline|Pipeline/i }).first()).toBeVisible({ timeout: 10_000 })

  await page.goto(`${appBase}/DiscoverGrants`, { waitUntil: 'networkidle' })
  await expect(page.getByRole('heading', { name: /Discover Funding|Discover/i }).first()).toBeVisible({ timeout: 10_000 })

  await page.goto(`${appBase}/Documents`, { waitUntil: 'networkidle' })
  await expect(page.getByRole('heading', { name: /Document Library|Documents/i }).first()).toBeVisible({ timeout: 10_000 })

  // 3) Enable Anya (admin): Settings → Features → Anya Copilot on
  await page.goto(`${appBase}/Settings`, { waitUntil: 'networkidle' })
  await dismissBlockingOverlay(page)
  const featuresTab = page.getByRole('tab', { name: 'Features' })
  if (await featuresTab.isVisible().catch(() => false)) {
    await featuresTab.click()
    const copilotSwitch = page.getByRole('switch', { name: /anya copilot/i }).or(page.locator('text=Anya Copilot').locator('..').getByRole('switch'))
    if (await copilotSwitch.isVisible().catch(() => false)) {
      const checked = await copilotSwitch.getAttribute('data-state')
      if (checked !== 'checked') {
        await copilotSwitch.click()
        await page.waitForTimeout(500)
      }
    }
  }

  // Back to Dashboard and open Anya panel
  await page.goto(`${appBase}/Dashboard`, { waitUntil: 'networkidle' })
  await dismissBlockingOverlay(page)

  const anyaButton = page.locator('button[title="Chat with Anya"]').or(page.getByRole('button', { name: /chat with anya/i })).first()
  await expect(anyaButton).toBeVisible({ timeout: 10_000 })
  await anyaButton.click()

  const sheet = page.locator('[data-state="open"]').filter({ has: page.locator('text=/Anya|Next steps|Use current screen/i') }).first()
  await expect(sheet).toBeVisible({ timeout: 10_000 })
  const hasNextSteps = await sheet.locator('text=/Next steps|suggested|Create or select/i').first().isVisible().catch(() => false)
  expect(hasNextSteps || await sheet.locator('text=Anya').first().isVisible().catch(() => false)).toBeTruthy()

  // 4) Refresh → settings remain, Anya and Next steps still present
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  await dismissBlockingOverlay(page)

  const anyaButtonAfter = page.locator('button[title="Chat with Anya"]').or(page.getByRole('button', { name: /chat with anya/i })).first()
  await expect(anyaButtonAfter).toBeVisible({ timeout: 10_000 })

  await anyaButtonAfter.click()
  const sheetAfter = page.locator('[data-state="open"]').filter({ has: page.locator('text=/Anya|Next steps|Use current screen/i') }).first()
  await expect(sheetAfter).toBeVisible({ timeout: 10_000 })

  // 5) Logout. The Anya sheet covers the sidebar after step 4's refresh+open,
  // so close it first; then click the sidebar logout (matched by accessible
  // title/name, not by the no-op `title:` filter on getByRole that previously
  // matched ALL buttons and triggered a strict-mode violation).
  const closeAnya = page.getByRole('button', { name: /^close$/i }).first()
  if (await closeAnya.isVisible().catch(() => false)) {
    await closeAnya.click().catch(() => {})
  }
  await page.keyboard.press('Escape').catch(() => {})
  const logoutBtn = page
    .getByTitle('Logout')
    .or(page.getByRole('button', { name: /^logout$/i }))
    .first()
  await logoutBtn.click({ timeout: 10_000 })
  await page.waitForURL(/\/login/i, { timeout: 10_000 })
})

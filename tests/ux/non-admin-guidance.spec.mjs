import { test, expect } from 'playwright/test'
import fs from 'node:fs'
const password = 'UxFixture-Only-2026!'
async function login(page, email = 'user1@grantflow.local') {
  await page.addInitScript(() => { globalThis.__GF_SMOKE__ = true })
  await page.goto('/login')
  await page.getByRole('textbox', { name: 'Profile email', exact: true }).fill(email)
  await page.getByRole('button', { name: 'Continue with Email', exact: true }).click()
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).not.toHaveURL(/login/)
  await expect(page).not.toHaveURL(/PricingRequired/)
  await page.waitForLoadState('networkidle')
  const welcome = page.getByRole('button', { name: 'Continue to GrantFlow', exact: true })
  if (await welcome.isVisible()) {
    await Promise.all([page.waitForResponse((response) => response.url().includes('/api/preferences') && response.request().method() === 'PUT'), welcome.click()])
  }
}
test('non-admin can follow the guide, open own profile, and return home', async ({ page }) => {
  await login(page)
  await page.goto('/Dashboard')
  await expect(page.getByRole('heading', { name: 'Your next step', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'My Profile', exact: true }).first()).toBeVisible()
  await expect(page.getByRole('link', { name: 'Admin Panel', exact: true })).toHaveCount(0)
  await page.getByRole('link', { name: 'Help with this page', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Help Center', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: 'Search tools and instructions' }).fill('profile')
  await page.getByRole('link', { name: 'Open My Profile', exact: true }).click()
  await expect(page).toHaveURL(/ProfileDetail[?]id=/)
  await expect(page.getByRole('heading', { name: 'Seed Profile One', exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Back to Home', exact: true }).click()
  await expect(page).toHaveURL(/Dashboard/)
})
test('static help works when assistant endpoints are unavailable and does not send model messages', async ({ page }) => {
  let sent = 0
  await page.route('**/api/anya/**', (route) => { if (route.request().method() === 'POST' && /message/.test(route.request().url())) sent += 1; return route.fulfill({ status: 503, json: { error: 'Unavailable for failure-path test' } }) })
  await login(page)
  await page.goto('/Help')
  await expect(page.getByRole('heading', { name: 'Find the right tool' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Search tools and instructions' }).fill('document')
  await page.getByRole('link', { name: 'Open Documents', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Document Library', exact: true })).toBeVisible()
  expect(sent).toBe(0)
})
test('mobile and tablet pages keep profile context and help reachable without horizontal overflow', async ({ page }) => {
  await login(page)
  fs.mkdirSync('docs/ux/evidence/non-admin-20260908', { recursive: true })
  for (const [name, width, height] of [['phone', 390, 844], ['tablet', 768, 1024], ['desktop', 1440, 1000]]) {
    await page.setViewportSize({ width, height })
    await page.goto('/Dashboard')
    await expect(page.getByRole('heading', { name: 'Your next step', exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Help with this page', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    await page.screenshot({ path: 'docs/ux/evidence/non-admin-20260908/after-' + name + '.png', fullPage: true })
  }
})
for (const [email, name] of [['user2@grantflow.local', 'Seed Profile Two'], ['ux-individual@example.invalid', 'UX individual'], ['ux-family@example.invalid', 'UX family'], ['ux-college_student@example.invalid', 'UX college_student']]) {
  test(name + ' receives the same non-admin guidance and authorized own profile', async ({ page }) => {
    await login(page, email)
    await page.goto('/Help')
    await expect(page.getByRole('heading', { name: 'Help Center', exact: true })).toBeVisible()
    await page.getByRole('link', { name: 'Open My Profile', exact: true }).click()
    await expect(page.getByRole('heading', { name, exact: true }).first()).toBeVisible()
    await expect(page.getByRole('link', { name: 'Admin Panel', exact: true })).toHaveCount(0)
  })
}

test('saved-work failure is actionable and is not displayed as an empty success', async ({ page }) => {
  await login(page)
  await page.route('**/api/saved-grants*', (route) => route.fulfill({ status: 503, json: { error: 'Controlled unavailable service' } }))
  await page.goto('/SavedGrants')
  await expect(page.getByRole('alert').filter({ hasText: 'Your saved opportunities could not be checked' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible()
  await expect(page.getByText('No saved grants yet', { exact: true })).toHaveCount(0)
  await page.unroute('**/api/saved-grants*')
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Your saved opportunities could not be checked' })).toHaveCount(0)
})
test('an authenticated administrator retains the existing workspace and Help', async ({ page }) => {
  await login(page, 'admin-e2e@example.invalid')
  await page.goto('/Help')
  await expect(page.getByRole('heading', { name: 'Help Center', exact: true })).toBeVisible()
  await expect(page.locator('a[href="/MyProfiles"]').first()).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Page guide', exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Find the right tool', exact: true })).toHaveCount(0)
})

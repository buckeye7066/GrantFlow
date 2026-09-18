import { test, expect } from 'playwright/test'

async function signIn(page) {
  await page.addInitScript(() => { globalThis.__GF_SMOKE__ = true })
  await page.goto('/login')
  await page.getByRole('textbox', { name: 'Profile email', exact: true }).fill('ux-individual@example.invalid')
  await page.getByRole('button', { name: 'Continue with Email', exact: true }).click()
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill('UxFixture-Only-2026!')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).not.toHaveURL(/login|PricingRequired|CheckoutRequired/)
  await page.waitForLoadState('networkidle')
  const welcome = page.getByRole('button', { name: 'Continue to GrantFlow', exact: true })
  if (await welcome.isVisible()) await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/preferences') && response.request().method() === 'PUT'),
    welcome.click(),
  ])
}

async function saveSection(page) {
  const [response] = await Promise.all([
    page.waitForResponse(response => /\/api\/profiles\/[^/]+\/sections\/basic_information/.test(response.url()) && response.request().method() === 'PUT'),
    page.getByRole('button', { name: 'Save changes', exact: true }).click(),
  ])
  const saved = await response.json()
  console.log('INDIVIDUAL_PROFILE_SAVE', JSON.stringify({ status: response.status(), data: saved.data, rejected: saved.rejected }))
  expect(response.ok()).toBe(true)
  expect(saved.rejected || []).toEqual([])
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

test('individual tier: editing contact details preserves ZIP, and ZIP changes survive a fresh sign-in', async ({ page, browser }, testInfo) => {
  test.setTimeout(120_000)
  const crashes = []
  page.on('pageerror', error => crashes.push(error.message))
  await signIn(page)
  await page.goto('/Help')
  const profileHref = await page.getByRole('link', { name: 'Open My Profile', exact: true }).getAttribute('href')
  expect(profileHref).toContain('ProfileDetail')
  const editorUrl = new URL(profileHref, 'http://127.0.0.1:18133')
  editorUrl.searchParams.set('tab', 'profile')
  editorUrl.searchParams.set('section', 'basic_information')
  editorUrl.searchParams.set('field', 'zip_code')
  await page.goto(editorUrl.href)
  await expect(page.getByRole('textbox', { name: /^ZIP code/i })).toHaveValue('37311')
  await page.getByRole('textbox', { name: /^Phone number/i }).fill('4235550123')
  await saveSection(page)
  await page.goto(editorUrl.href)
  await expect(page.getByRole('textbox', { name: /^ZIP code/i })).toHaveValue('37311')
  await expect(page.getByRole('textbox', { name: /^Phone number/i })).toHaveValue('4235550123')
  await page.getByRole('textbox', { name: /^ZIP code/i }).fill('37312')
  await saveSection(page)
  // New browser storage prevents local state or a query cache from faking persistence.
  const fresh = await browser.newContext({ baseURL: 'http://127.0.0.1:18133' })
  try {
    const reopened = await fresh.newPage()
    reopened.on('pageerror', error => crashes.push(error.message))
    await signIn(reopened)
    await reopened.goto(editorUrl.href)
    await expect(reopened.getByRole('textbox', { name: /^ZIP code/i })).toHaveValue('37312')
    await expect(reopened.getByRole('textbox', { name: /^Phone number/i })).toHaveValue('4235550123')
    await reopened.screenshot({ path: testInfo.outputPath('persisted-profile-after-fresh-login.png'), fullPage: true })
  } finally {
    await fresh.close()
  }
  expect(crashes).toEqual([])
})

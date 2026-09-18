import { test, expect } from 'playwright/test'

// Real browser, Express routes, and a newly-created isolated SQLite DB.
// No intercepted success responses or administrator session.
test('individual tier: sign in, verify actual plan, and open every advertised workspace tool', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const crashes = []
  const serverErrors = []
  const billingReads = []
  page.on('pageerror', error => crashes.push(error.message))
  page.on('response', async response => {
    if (response.status() >= 500) serverErrors.push({ path: new URL(response.url()).pathname, status: response.status() })
    if (/\/api\/billing\/me\/[^/]+$/.test(new URL(response.url()).pathname) && response.ok()) {
      try { billingReads.push(await response.json()) } catch { /* A completed navigation may discard a response body. */ }
    }
  })
  await page.addInitScript(() => { globalThis.__GF_SMOKE__ = true })
  await page.goto('/login')
  await page.getByRole('textbox', { name: 'Profile email', exact: true }).fill('ux-individual@example.invalid')
  await page.getByRole('button', { name: 'Continue with Email', exact: true }).click()
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill('UxFixture-Only-2026!')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).not.toHaveURL(/login/)
  await expect(page).not.toHaveURL(/PricingRequired|CheckoutRequired/)
  await page.waitForLoadState('networkidle')
  const welcome = page.getByRole('button', { name: 'Continue to GrantFlow', exact: true })
  if (await welcome.isVisible()) await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/preferences') && response.request().method() === 'PUT'),
    welcome.click(),
  ])
  await page.goto('/Billing')
  await expect.poll(() => billingReads.length).toBeGreaterThan(0)
  const billing = billingReads.at(-1)
  console.log('INDIVIDUAL_PLAN', JSON.stringify({ account: billing.account, billing: billing.billing, entitlements: billing.entitlements }))
  expect(billing.account.is_pro_bono).toBe(false)
  expect(billing.billing.tier_id).toBe('individual')
  expect(billing.billing.net_monthly_cents).toBe(0)
  expect(billing.billing.free_week).toBe(false)
  await page.goto('/Help')
  await expect(page.getByRole('heading', { name: 'Help Center', exact: true })).toBeVisible()
  const tools = await page.getByRole('link').evaluateAll(nodes => nodes.filter(node => /^Open /.test(node.textContent.trim())).map(node => ({ name: node.textContent.trim(), href: node.getAttribute('href') })))
  console.log('INDIVIDUAL_TOOLS', JSON.stringify(tools))
  expect(tools.length).toBeGreaterThan(0)
  for (const tool of tools) {
    await test.step(tool.name, async () => {
      // Use the same links a person uses. Reloading the entire app twice per
      // tool made unrelated fixture accounts exhaust the shared-IP auth limit.
      if (new URL(page.url()).pathname !== '/Help') {
        await page.getByRole('link', { name: 'Help with this page', exact: true }).click()
      }
      await expect(page.getByRole('heading', { name: 'Help Center', exact: true })).toBeVisible()
      await page.getByRole('link', { name: tool.name, exact: true }).first().click()
      await page.waitForLoadState('networkidle')
      const visibleText = await page.locator('body').innerText()
      console.log('INDIVIDUAL_PAGE', JSON.stringify({ tool: tool.name, url: page.url(), headings: await page.locator('h1,h2,h3').allTextContents(), crashes, serverErrors }))
      await page.screenshot({ path: testInfo.outputPath(tool.name.replace(/[^a-z0-9]/gi, '-') + '.png'), fullPage: true })
      await expect(page).not.toHaveURL(/login|PricingRequired|CheckoutRequired/)
      await expect(page.getByText('Something went wrong', { exact: true })).toHaveCount(0)
      expect(visibleText, 'Structured data leaked into a user-facing explanation').not.toContain('[object Object]')
      expect(crashes, 'An advertised individual-tier tool crashed in the browser').toEqual([])
      expect(serverErrors, 'An advertised individual-tier tool returned a server error').toEqual([])
    })
  }
})

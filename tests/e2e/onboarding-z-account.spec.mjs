import { randomUUID } from 'node:crypto'
import { test, expect } from 'playwright/test'
import { basePath, baseURL } from './playwright.config.mjs'

const appBase = String(basePath || '').replace(/\/+$/, '')

for (const width of [1280, 390]) {
  test(`Foundation signup, saved profile, and returning login (${width}px)`, async ({ page, browser }, testInfo) => {
    test.setTimeout(120_000)
    // Create disposable accounts only inside the isolated local test server.
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL).hostname)
    const profileName = `Foundation Journey ${width}`
    const email = `foundation-journey-${width}-${Date.now()}@example.invalid`
    const password = `Test-${randomUUID()}!`
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width, height: 900 })

    await test.step('Open onboarding through the visible login link', async () => {
      await page.goto(`${appBase}/login`)
      await page.getByRole('link', { name: /quiz with Anya/i }).click()
      const intro = page.getByRole('dialog').filter({ hasText: 'Welcome to GrantFlow!' })
      await intro.getByRole('button', { name: 'Skip for now', exact: true }).click()
      await page.getByRole('button', { name: /english/i }).click()
      await page.getByRole('button', { name: /let.s do it/i }).click()
      await page.getByRole('button', { name: /myself or my family/i }).click()
    })

    await test.step('Save location and select funding needs', async () => {
      await page.locator('#zip').fill('37312')
      await expect(page.locator('#city')).toHaveValue('Cleveland')
      await expect(page.locator('#county')).toHaveValue('Bradley')
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await page.getByRole('button', { name: 'Just me (single adult)', exact: true }).click()
      await page.getByRole('button', { name: 'Rent, mortgage, or housing repair', exact: true }).click()
      await page.getByRole('button', { name: 'Utility bills (electric, gas, water, internet)', exact: true }).click()
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Caring for a family member', exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
    })

    await test.step('Enter narrative, profile label, and email separately', async () => {
      await page.locator('textarea').fill('A synthetic QA applicant in Cleveland needs help with housing and utilities.')
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      const name = page.getByPlaceholder("e.g. 'Jordan Smith' or 'Hope Community Church'")
      await expect(name).toHaveValue('')
      await name.fill(profileName)
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await page.locator('input[type="email"]').fill(email)
      const completion = page.waitForResponse(response =>
        new URL(response.url()).pathname.endsWith('/api/onboarding/complete') && response.request().method() === 'POST',
      { timeout: 20000 })
      await page.getByRole('button', { name: 'Send my sign-in code', exact: true }).click()
      const response = await completion
      expect(response.ok(), 'onboarding completion creates the test account and profile').toBe(true)
      await page.waitForURL(/\/set-password\?/)
    })

    await test.step('Set password and verify profile survives reload', async () => {
      await page.locator('#new-password').fill(password)
      await page.locator('#confirm-password').fill(password)
      await page.getByRole('button', { name: /set password/i }).click()
      await page.waitForURL(/\/Dashboard/i)
      await page.goto(`${appBase}/Organizations`)
      await expect(page.getByText(profileName, { exact: true }).first()).toBeVisible()
      await page.reload()
      await expect(page.getByText(profileName, { exact: true }).first()).toBeVisible()
      await testInfo.attach(`saved-profile-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
    })

    await test.step('Sign in from a separate empty browser session', async () => {
      const context = await browser.newContext({ baseURL, viewport: { width, height: 900 } })
      try {
        const returning = await context.newPage()
        returning.on('pageerror', error => errors.push(error.message))
        await returning.goto(`${appBase}/login`)
        await returning.locator('#auth-email').fill(email)
        await returning.getByRole('button', { name: /continue with email/i }).click()
        await returning.locator('#auth-password').fill(password)
        await returning.getByRole('button', { name: 'Sign in', exact: true }).click()
        await returning.waitForURL(/\/Dashboard/i)
        await returning.goto(`${appBase}/Organizations`)
        await expect(returning.getByText(profileName, { exact: true }).first()).toBeVisible()
      } finally {
        await context.close()
      }
    })
    expect(errors).toEqual([])
  })
}

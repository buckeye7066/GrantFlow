import { test, expect } from 'playwright/test'
import { basePath } from './playwright.config.mjs'

const appBase = String(basePath || '').replace(/\/+$/, '')

test('Foundation resolves ZIP+4 geography without discarding the postal suffix', async ({ page }) => {
  await page.goto(`${appBase}/start`, { waitUntil: 'domcontentloaded' })
  const intro = page.getByRole('dialog').filter({ hasText: 'Welcome to GrantFlow!' })
  await intro.getByRole('button', { name: 'Skip for now', exact: true }).click()
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await page.getByRole('button', { name: "Let's do it", exact: true }).click()
  await page.getByRole('button', { name: 'Myself or my family', exact: true }).click()
  await page.locator('#zip').fill('37312-1234')
  await expect(page.locator('#city')).toHaveValue('Cleveland')
  await expect(page.locator('#county')).toHaveValue('Bradley')
  const submitted = page.waitForRequest((request) =>
    new URL(request.url()).pathname === `${appBase}/api/onboarding/answer` && request.method() === 'POST')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  expect((await submitted).postDataJSON().answer).toEqual({
    zip: '37312-1234', state: 'TN', city: 'Cleveland', county: 'Bradley',
  })
  await expect(page.getByRole('button', { name: 'Just me (single adult)', exact: true })).toBeVisible()
})

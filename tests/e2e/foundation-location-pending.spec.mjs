import { test, expect } from 'playwright/test'
import { basePath } from './playwright.config.mjs'

const appBase = String(basePath || '').replace(/\/+$/, '')

test('Foundation cannot submit old geography while the new ZIP lookup is pending', async ({ page }) => {
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto(`${appBase}/start`, { waitUntil: 'domcontentloaded' })
  const intro = page.getByRole('dialog').filter({ hasText: 'Welcome to GrantFlow!' })
  await expect(intro).toBeVisible()
  await intro.getByRole('button', { name: 'Skip for now', exact: true }).click()
  await expect(intro).toBeHidden()
  await page.getByRole('button', { name: /english/i }).click()
  await page.getByRole('button', { name: /let.s do it/i }).click()
  await page.getByRole('button', { name: /myself or my family/i }).click()
  await page.locator('#zip').fill('37205')
  await expect(page.locator('#city')).toHaveValue('Nashville')
  await expect(page.locator('#county')).toHaveValue('Davidson')

  // Obtain the real response from Express, but hold its delivery to reproduce
  // ordinary network latency. No location payload or application route is mocked.
  let releaseLookup
  let lookupArrived
  const release = new Promise((resolve) => { releaseLookup = resolve })
  const arrived = new Promise((resolve) => { lookupArrived = resolve })
  await page.route('**/api/onboarding/zip/37312', async (route) => {
    const response = await route.fetch()
    lookupArrived(response.status())
    await release
    await route.fulfill({ response })
  })
  const newLocation = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `${appBase}/api/onboarding/zip/37312`)
  try {
    await page.locator('#zip').fill('37312')
    expect(await arrived).toBe(200)
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled({ timeout: 3000 })
  } finally {
    releaseLookup()
    await newLocation
  }

  await expect(page.locator('#city')).toHaveValue('Cleveland')
  await expect(page.locator('#county')).toHaveValue('Bradley')
  const submitted = page.waitForRequest((request) =>
    new URL(request.url()).pathname === `${appBase}/api/onboarding/answer` && request.method() === 'POST')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  expect((await submitted).postDataJSON().answer).toEqual({
    zip: '37312', state: 'TN', city: 'Cleveland', county: 'Bradley',
  })
  await expect(page.getByRole('button', { name: /just me \(single adult\)/i })).toBeVisible()
  expect(pageErrors).toEqual([])
})

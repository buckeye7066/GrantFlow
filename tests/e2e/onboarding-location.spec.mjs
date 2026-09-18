import { test, expect } from 'playwright/test'
import { basePath } from './playwright.config.mjs'
const appBase = String(basePath || '').replace(/\/+$/, '')
for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
 test(`Foundation location follows ZIP and preserves manual county (${viewport.width}px)`, async ({ page }) => {
 await page.setViewportSize(viewport)
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
 await page.locator('#zip').fill('37312')
 await expect(page.locator('#city')).toHaveValue('Cleveland')
 await expect(page.locator('#county')).toHaveValue('Bradley')
 await page.locator('#county').fill('Applicant County')
 await page.locator('#zip').fill('37205')
 await expect(page.locator('#city')).toHaveValue('Nashville')
 await expect(page.locator('#county')).toHaveValue('Applicant County')
 await page.locator('#county').fill('')
 await page.locator('#zip').fill('37312')
 await expect(page.locator('#city')).toHaveValue('Cleveland')
 await expect(page.locator('#county')).toHaveValue('Bradley')
 const submitted = page.waitForRequest((request) =>
 new URL(request.url()).pathname.endsWith('/api/onboarding/answer') && request.method() === 'POST', { timeout: 10000 })
 await page.getByRole('button', { name: 'Continue', exact: true }).click()
 expect((await submitted).postDataJSON().answer).toEqual({
 zip: '37312', state: 'TN', city: 'Cleveland', county: 'Bradley',
 })
 await expect(page.getByRole('button', { name: /just me \(single adult\)/i })).toBeVisible()
 await page.reload({ waitUntil: 'domcontentloaded' })
 await expect(page.getByRole('button', { name: /just me \(single adult\)/i })).toBeVisible()
 expect(pageErrors).toEqual([])
 })
}

// Delay a real backend lookup, not a mocked geography response. A changed ZIP
// must not be submitted together with the previous ZIP's location.
test('Foundation cannot submit stale geography while the new ZIP lookup is pending', async ({ page }) => {
  await page.goto(`${appBase}/start`, { waitUntil: 'domcontentloaded' })
  const intro = page.getByRole('dialog').filter({ hasText: 'Welcome to GrantFlow!' })
  await intro.getByRole('button', { name: 'Skip for now', exact: true }).click()
  await page.getByRole('button', { name: /english/i }).click()
  await page.getByRole('button', { name: /let.s do it/i }).click()
  await page.getByRole('button', { name: /myself or my family/i }).click()
  await page.locator('#zip').fill('37205')
  await expect(page.locator('#city')).toHaveValue('Nashville')
  await expect(page.locator('#county')).toHaveValue('Davidson')

  let releaseLookup
  let markLookupStarted
  const lookupHeld = new Promise((resolve) => { releaseLookup = resolve })
  const lookupStarted = new Promise((resolve) => { markLookupStarted = resolve })
  const submitted = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/api/onboarding/answer') && request.method() === 'POST') {
      submitted.push(request.postDataJSON())
    }
  })
  await page.route('**/api/onboarding/zip/37312', async (route) => {
    markLookupStarted()
    await lookupHeld
    await route.continue()
  })
  try {
    await page.locator('#zip').fill('37312')
    await lookupStarted
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled({ timeout: 2000 })
    await page.locator('#zip').press('Enter')
    expect(submitted).toEqual([])
  } finally {
    releaseLookup()
  }
  await expect(page.locator('#city')).toHaveValue('Cleveland')
  await expect(page.locator('#county')).toHaveValue('Bradley')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByRole('button', { name: /just me \(single adult\)/i })).toBeVisible()
  expect(submitted).toHaveLength(1)
  expect(submitted[0].answer).toEqual({ zip: '37312', state: 'TN', city: 'Cleveland', county: 'Bradley' })
})

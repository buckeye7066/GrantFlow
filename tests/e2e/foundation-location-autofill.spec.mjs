import { test, expect } from 'playwright/test'
import { basePath } from './playwright.config.mjs'

const appBase = String(basePath || '').replace(/\/+$/, '')

test('Foundation rejects same-task autofill submission until the new ZIP settles', async ({ page }) => {
  await page.goto(`${appBase}/start`, { waitUntil: 'domcontentloaded' })
  const intro = page.getByRole('dialog').filter({ hasText: 'Welcome to GrantFlow!' })
  await intro.getByRole('button', { name: 'Skip for now', exact: true }).click()
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await page.getByRole('button', { name: "Let's do it", exact: true }).click()
  await page.getByRole('button', { name: 'Myself or my family', exact: true }).click()
  await page.locator('#zip').fill('37205')
  await expect(page.locator('#city')).toHaveValue('Nashville')
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled()

  const submissions = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/onboarding/answer' && request.method() === 'POST') {
      submissions.push(request.postDataJSON())
    }
  })
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
  try {
    await page.locator('#zip').evaluate((input) => {
      const form = input.form
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, '37312')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      form.requestSubmit()
    })
    expect(await arrived).toBe(200)
    expect(submissions, 'No answer may leave the browser with the previous ZIP geography').toEqual([])
    await expect(page.locator('#zip')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled()
  } finally {
    releaseLookup()
  }
  await expect(page.locator('#city')).toHaveValue('Cleveland')
  await expect(page.locator('#county')).toHaveValue('Bradley')
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled()
})

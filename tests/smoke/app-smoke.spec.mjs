import { test, expect } from 'playwright/test'
import { basePath } from './playwright.config.mjs'

test('backend health endpoints respond', async ({ request, baseURL }) => {
  const health = await request.get(`${baseURL}/health`)
  expect(health.ok()).toBeTruthy()

  const apiHealth = await request.get(`${baseURL}/api/health`)
  expect(apiHealth.ok()).toBeTruthy()
})

test('app basePath loads (no blank screen)', async ({ page }) => {
  await page.goto(basePath, { waitUntil: 'domcontentloaded' })

  const html = await page.content()
  expect(html.length).toBeGreaterThan(500)
  await expect(page.locator('body')).toBeVisible()
})

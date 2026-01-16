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

test('app deep route loads under basePath (refresh safe)', async ({ page }) => {
  // This catches misconfigured Vite/Vercel base-path + SPA fallback issues.
  const target = `${basePath.replace(/\/$/, '')}/login`
  await page.goto(target, { waitUntil: 'domcontentloaded' })

  // Should not be a static 404 or blank screen.
  const html = await page.content()
  expect(html.toLowerCase()).not.toContain('file not found')
  await expect(page.locator('body')).toBeVisible()
})

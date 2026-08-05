import { test, expect } from 'playwright/test'
import { basePath } from './playwright.config.mjs'

test('backend health endpoints respond', async ({ request, baseURL }) => {
  const prefix = `${baseURL}${String(basePath || '').replace(/\/$/, '')}`
  const apiHealth = await request.get(`${prefix}/api/health`)
  expect(apiHealth.ok()).toBeTruthy()
})

test('app basePath loads (no blank screen)', async ({ page }) => {
  await page.goto(basePath, { waitUntil: 'networkidle' })

  const html = await page.content()
  expect(html.toLowerCase()).toContain('id="root"')

  // Ensure the main JS/CSS bundles referenced by HTML are reachable (catches base-path asset misconfig).
  const scriptMatch = html.match(/<script[^>]+src="([^"]+)"/i)
  expect(scriptMatch && scriptMatch[1]).toBeTruthy()
  const scriptUrl = new URL(scriptMatch[1], page.url()).toString()
  const scriptResp = await page.request.get(scriptUrl)
  expect(scriptResp.ok()).toBeTruthy()

  const cssMatch = html.match(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/i)
  expect(cssMatch && cssMatch[1]).toBeTruthy()
  const cssUrl = new URL(cssMatch[1], page.url()).toString()
  const cssResp = await page.request.get(cssUrl)
  expect(cssResp.ok()).toBeTruthy()
})

test('app deep route loads under basePath (refresh safe)', async ({ page }) => {
  // This catches misconfigured Vite/Vercel base-path + SPA fallback issues.
  const target = `${basePath.replace(/\/$/, '')}/login`
  const response = await page.goto(target, { waitUntil: 'networkidle' })
  expect(response && response.ok()).toBeTruthy()
  const responseHtml = await response.text()
  expect(responseHtml).toContain('content="noindex,nofollow,noarchive"')

  // Should not be a static 404 or blank screen.
  const html = await page.content()
  expect(html.toLowerCase()).not.toContain('file not found')
  expect(html.toLowerCase()).toContain('id="root"')

  const scriptMatch = html.match(/<script[^>]+src="([^"]+)"/i)
  expect(scriptMatch && scriptMatch[1]).toBeTruthy()
  const scriptUrl = new URL(scriptMatch[1], page.url()).toString()
  const scriptResp = await page.request.get(scriptUrl)
  expect(scriptResp.ok()).toBeTruthy()
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex,nofollow,noarchive')
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(0)
})

test('public acquisition route renders without authentication', async ({ page, baseURL }) => {
  // Production is mounted at the host root. This exact browser journey catches
  // the regression where /grantflow/welcome fell into the authenticated catch-
  // all and redirected to /login while /welcome remained the real public route.
  const response = await page.goto(`${baseURL}/welcome`, { waitUntil: 'networkidle' })
  expect(response && response.ok()).toBeTruthy()
  const responseHtml = await response.text()
  expect(responseHtml).toContain('rel="canonical" href="https://app.axiombiolabs.org/welcome"')
  expect(responseHtml).toContain('property="og:url" content="https://app.axiombiolabs.org/welcome"')
  await expect(page).toHaveURL(/\/welcome(?:[?#].*)?$/)
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'index,follow,max-image-preview:large')
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://app.axiombiolabs.org/welcome')
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', 'https://app.axiombiolabs.org/welcome')
  await expect(page.getByRole('heading', { level: 1, name: /find funding that fits the whole profile/i })).toBeVisible()
  await expect(page.getByText(/sign in to grantflow/i)).toHaveCount(0)
})

test('privacy route has its own crawlable HTTP and browser document head', async ({ page, baseURL }) => {
  const response = await page.goto(`${baseURL}/privacy`, { waitUntil: 'networkidle' })
  expect(response && response.ok()).toBeTruthy()
  const responseHtml = await response.text()
  expect(responseHtml).toContain('rel="canonical" href="https://app.axiombiolabs.org/privacy"')
  expect(responseHtml).toContain('property="og:url" content="https://app.axiombiolabs.org/privacy"')
  expect(responseHtml).not.toContain('rel="canonical" href="https://app.axiombiolabs.org/welcome"')

  await expect(page).toHaveURL(/\/privacy(?:[?#].*)?$/)
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'index,follow,max-image-preview:large')
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://app.axiombiolabs.org/privacy')
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', 'https://app.axiombiolabs.org/privacy')
  await expect(page.getByRole('heading', { level: 1, name: /grantflow — privacy policy/i })).toBeVisible()
})

test('SPA navigation swaps public metadata and clears it on protected routes', async ({ page, baseURL }) => {
  await page.goto(`${baseURL}/welcome`, { waitUntil: 'networkidle' })

  await page.getByRole('link', { name: 'Privacy' }).click()
  await expect(page).toHaveURL(/\/privacy(?:[?#].*)?$/)
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://app.axiombiolabs.org/privacy')
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', 'https://app.axiombiolabs.org/privacy')
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'index,follow,max-image-preview:large')

  await page.goto(`${baseURL}/welcome`, { waitUntil: 'networkidle' })
  await page.getByRole('link', { name: /set up your profile/i }).first().click()
  await expect(page).toHaveURL(/\/start(?:[?#].*)?$/)
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex,nofollow,noarchive')
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(0)
  await expect(page.locator('meta[property="og:url"]')).toHaveCount(0)
})

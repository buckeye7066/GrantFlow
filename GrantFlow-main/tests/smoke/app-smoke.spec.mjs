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

  // Should not be a static 404 or blank screen.
  const html = await page.content()
  expect(html.toLowerCase()).not.toContain('file not found')
  expect(html.toLowerCase()).toContain('id="root"')

  const scriptMatch = html.match(/<script[^>]+src="([^"]+)"/i)
  expect(scriptMatch && scriptMatch[1]).toBeTruthy()
  const scriptUrl = new URL(scriptMatch[1], page.url()).toString()
  const scriptResp = await page.request.get(scriptUrl)
  expect(scriptResp.ok()).toBeTruthy()
})
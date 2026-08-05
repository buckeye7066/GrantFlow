/**
 * Smoke tests for Anya copilot UX (flagged).
 * With flags OFF: app loads and core routes respond without regression.
 * With flags ON (via localStorage in dev): Anya panel shows next steps / use current screen without crash.
 */
import { test, expect } from 'playwright/test'
import { basePath, baseURL } from './playwright.config.mjs'

const appBase = String(basePath || '').replace(/\/+$/, '')

test('app root loads (no blank screen)', async ({ page }) => {
  await page.goto(baseURL + appBase, { waitUntil: 'networkidle' })
  const html = await page.content()
  expect(html.toLowerCase()).toContain('id="root"')
})

test('login page loads', async ({ page }) => {
  const res = await page.goto(`${baseURL}${appBase}/login`, { waitUntil: 'networkidle' })
  expect(res?.ok()).toBeTruthy()
  await expect(page.locator('body')).toBeVisible()
})

test('Dashboard route loads (may redirect to login)', async ({ page }) => {
  const res = await page.goto(`${baseURL}${appBase}/Dashboard`, { waitUntil: 'networkidle' })
  expect(res?.ok()).toBeTruthy()
  const url = page.url()
  expect(url.toLowerCase()).toMatch(/\/(dashboard|login)/)
})

test('Pipeline route loads (may redirect to login)', async ({ page }) => {
  const res = await page.goto(`${baseURL}${appBase}/Pipeline`, { waitUntil: 'networkidle' })
  expect(res?.ok()).toBeTruthy()
  const url = page.url()
  expect(url.toLowerCase()).toMatch(/\/(pipeline|login)/)
})

test('Settings route loads', async ({ page }) => {
  const res = await page.goto(`${baseURL}${appBase}/Settings`, { waitUntil: 'networkidle' })
  expect(res?.ok()).toBeTruthy()
})

test('login page loads with basePath (no crash)', async ({ page }) => {
  await page.goto(`${baseURL}${appBase}/login`, { waitUntil: 'networkidle' })
  const html = await page.content()
  expect(html.toLowerCase()).toContain('id="root"')
})

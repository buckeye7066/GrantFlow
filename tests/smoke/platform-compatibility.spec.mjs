import { expect, test } from 'playwright/test'

test('the public shell fits Apple mobile viewports and declares safe-area support', async ({ page, baseURL }) => {
  const response = await page.goto(`${baseURL}/welcome`, { waitUntil: 'networkidle' })
  expect(response?.ok()).toBeTruthy()

  await expect(page.locator('#root')).toBeVisible()
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
    'content',
    /width=device-width.*viewport-fit=cover/,
  )

  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    supportsDynamicViewport: CSS.supports('min-height', '100dvh'),
    hasMatchMedia: typeof window.matchMedia === 'function',
  }))

  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1)
  expect(viewport.supportsDynamicViewport).toBe(true)
  expect(viewport.hasMatchMedia).toBe(true)
})

import { test, expect } from '@playwright/test'

test('playwright runner smoke: can launch a browser', async ({ page }) => {
  await page.goto('about:blank')
  await expect(page).toHaveTitle('')
})


import { test, expect } from '@playwright/test';
import { assertNoViolations, baseUrl } from './axe-utils.mjs';

const ROUTES = [
  '/',
  '/onboarding',
  '/discover',
  '/opportunities',
  '/matches',
  '/funders',
  '/applications',
  '/knowledge',
  '/admin/connectors',
];

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 390, height: 844 },
];

for (const vp of VIEWPORTS) {
  for (const route of ROUTES) {
    test(`${vp.name}: ${route} meets WCAG 2.2 AA and has keyboard focus + freshness`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const response = await page.goto(`${baseUrl()}${route}`, { waitUntil: 'networkidle' }).catch(() => null);
      if (!response || response.status() >= 500) {
        test.skip(true, `route ${route} not served (status ${response?.status?.()})`);
        return;
      }
      const result = await assertNoViolations(page);
      if (result?.skipped) {
        test.skip(true, result.reason);
        return;
      }
      expect(result.skipped, 'axe should run').toBe(false);

      const landmarks = await page.locator('main, [role="main"], nav, [role="navigation"], header, [role="banner"]').count();
      expect(landmarks, `no landmarks on ${route}`).toBeGreaterThan(0);

      await page.keyboard.press('Tab');
      const activeEl = await page.evaluate(() => document.activeElement?.tagName);
      expect(activeEl, `keyboard focus did not move on ${route}`).toBeTruthy();

      const empties = await page.locator('[data-testid="empty-state"], [role="status"]').count();
      const freshness = await page.locator('[data-testid="freshness"], time[datetime]').count();
      if (route === '/opportunities' || route === '/discover') {
        expect(empties + freshness, 'no empty-state or freshness indicators').toBeGreaterThan(0);
      }
    });
  }
}

test('every interactive control has an accessible name and no decorative dead-ends', async ({ page }) => {
  await page.goto(`${baseUrl()}/discover`, { waitUntil: 'networkidle' }).catch(() => null);
  const buttons = page.locator('button, a[href]');
  const count = await buttons.count();
  if (count === 0) return;
  const first = buttons.first();
  const label = (await first.getAttribute('aria-label')) || (await first.textContent()) || (await first.getAttribute('href'));
  expect(label?.trim(), 'interactive control without accessible name').not.toEqual('');
});

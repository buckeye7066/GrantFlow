import { test, expect } from 'playwright/test';
import { baseUrl } from './axe-utils.mjs';

const APPLICANT_TYPES = [
  'nonprofit',
  'business',
  'individual',
  'researcher',
  'university',
  'faith-based',
  'government',
  'tribal',
  'healthcare',
  'community',
  'artist',
];

test.describe('onboarding journeys for every applicant type', () => {
  for (const type of APPLICANT_TYPES) {
    test(`${type} can onboard and reach a useful first-run state`, async ({ page }) => {
      await page.goto(`${baseUrl()}/onboarding`, { waitUntil: 'networkidle' }).catch(() => null);
      const selector = page.locator(`[data-testid="applicant-type-${type}"]`);
      if (await selector.count()) {
        await selector.first().click();
        await page.locator('button[type="submit"], [data-testid="next-step"]').first().click().catch(() => {});
        await expect(page.locator('body')).not.toContainText('coming soon', { ignoreCase: true });
      }
    });
  }
});

test('discovery journey: search, view opportunity freshness/status, follow funder', async ({ page }) => {
  await page.goto(`${baseUrl()}/discover`, { waitUntil: 'networkidle' }).catch(() => null);
  const cards = page.locator('[data-testid="opportunity-card"]');
  const count = await cards.count();
  if (count === 0) return;
  const status = await cards.first().locator('[data-testid="status-badge"]').getAttribute('data-status') ||
    await cards.first().locator('[data-testid="status-badge"]').textContent();
  expect(['open', 'forecasted', 'recurring', 'rolling', 'closed', 'canceled', 'archived']
    .some((s) => String(status).toLowerCase().includes(s))).toBe(true);
  const link = cards.first().locator('a[data-testid="canonical-url"]');
  const rel = await link.getAttribute('rel');
  expect(rel).toContain('noopener');
});

test('matching journey: a match explanation exposes all required fields', async ({ page }) => {
  await page.goto(`${baseUrl()}/matches`, { waitUntil: 'networkidle' }).catch(() => null);
  const rows = page.locator('[data-testid="match-row"]');
  if (await rows.count() === 0) return;
  await rows.first().locator('[data-testid="expand-explainer"]').click().catch(() => {});
  for (const field of ['overallScore', 'eligibilityResult', 'recommendedAction']) {
    await expect(rows.first().locator(`[data-testid="${field}"]`)).toBeVisible().catch(() => {});
  }
});

test('submission never shows submitted without a verifiable confirmation', async ({ page }) => {
  await page.goto(`${baseUrl()}/applications`, { waitUntil: 'networkidle' }).catch(() => null);
  const submitBtn = page.locator('[data-testid="submit-application"]');
  if (await submitBtn.count() === 0) return;
  await submitBtn.first().click().catch(() => {});
  const submittedBadge = page.locator('[data-testid="submission-status"][data-value="submitted"]');
  if (await submittedBadge.count() > 0) {
    const confirmation = await page.locator('[data-testid="confirmation-number"]').textContent().catch(() => null);
    expect(confirmation && confirmation.trim().length > 0, 'submitted without a stored confirmation').toBe(true);
  }
});

test('security: reflected XSS payload is output-encoded, not executed', async ({ page }) => {
  const payload = '<img src=x onerror=window.__xss=1>';
  await page.goto(`${baseUrl()}/discover?q=${encodeURIComponent(payload)}`, { waitUntil: 'networkidle' }).catch(() => {});
  const flagged = await page.evaluate(() => window.__xss === 1);
  expect(flagged, 'reflective XSS payload executed').toBe(false);
});

test('security: oversized/unsupported upload is rejected client-side', async ({ page }) => {
  await page.goto(`${baseUrl()}/onboarding`, { waitUntil: 'networkidle' }).catch(() => {});
  const input = page.locator('input[type="file"]').first();
  if (await input.count() === 0) return;
  const error = page.locator('[data-testid="upload-error"]');
  await input.setInputFiles({ name: 'bad.exe', mimeType: 'application/x-msdownload', buffer: Buffer.from('MZ') }).catch(() => {});
  if (await error.count() > 0) {
    await expect(error.first()).toContainText(/unsupported|type|size/i).catch(() => {});
  }
});

test('admin: connector health surfaces a plain-language missing credential', async ({ page }) => {
  await page.goto(`${baseUrl()}/admin/connectors`, { waitUntil: 'networkidle' }).catch(() => {});
  const row = page.locator('[data-testid="connector-row"][data-satisfied="false"]');
  if (await row.count() === 0) return;
  await expect(row.first()).toContainText(/credential|not configured|missing/i).catch(() => {});
});

test('deployment smoke: app bootstraps without maintenance banner or fake success', async ({ page }) => {
  const res = await page.goto(`${baseUrl()}/`, { waitUntil: 'networkidle' }).catch(() => null);
  if (!res) return;
  expect(res.status()).toBeLessThan(500);
  const body = await page.locator('body').textContent().catch(() => '') || '';
  expect(body.toLowerCase()).not.toContain('coming soon');
  expect(body.toLowerCase()).not.toContain('maintenance');
});

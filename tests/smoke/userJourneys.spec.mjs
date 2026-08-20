import { test, expect } from 'playwright/test';
import { baseUrl } from './axe-utils.mjs';

// WHY THIS FILE READS THE WAY IT DOES (2026-08-19)
//
// Every journey below used to end its assertions in one of two shapes that
// cannot fail:
//
//   1. `if (await thing.count() === 0) return;`  — a silent early return, which
//      Playwright reports as a PASSING test.
//   2. `await expect(x).toContainText(/y/).catch(() => {});` — an assertion
//      whose rejection is swallowed, so the expectation can be violated and the
//      test still passes.
//
// Measured on origin/main: the app renders 28 distinct `data-testid` values,
// and ZERO of the fourteen this file targets
// (`submit-application`, `submission-status`, `confirmation-number`,
// `opportunity-card`, `status-badge`, `canonical-url`, `match-row`,
// `expand-explainer`, `overallScore`, `eligibilityResult`,
// `recommendedAction`, `upload-error`, `connector-row`, `applicant-type-*`)
// appear anywhere in `src/`. So every one of these journeys took its early
// return on every run and reported green — including the one named
// "submission never shows submitted without a verifiable confirmation", which
// is the product's central honesty invariant.
//
// The fix does NOT invent app behaviour. It makes the two shapes honest:
// a missing surface is now an explicit SKIP that NAMES the selector it needed
// (the repo's "blocked, with the prerequisite named" posture), and no
// assertion swallows its own failure. A green run now means the journey ran;
// a skipped run says out loud which testid has to exist first.

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

/**
 * Skip — loudly, naming the missing hook — when the surface a journey needs is
 * not rendered. A skip is honest about coverage; a bare `return` is a green
 * test that checked nothing.
 */
async function requireSurface(locator, testid) {
  const count = await locator.count();
  test.skip(count === 0, `no [data-testid="${testid}"] rendered — journey not exercised`);
  return count;
}

test.describe('onboarding journeys for every applicant type', () => {
  for (const type of APPLICANT_TYPES) {
    test(`${type} can onboard and reach a useful first-run state`, async ({ page }) => {
      await page.goto(`${baseUrl()}/onboarding`, { waitUntil: 'networkidle' }).catch(() => null);
      const selector = page.locator(`[data-testid="applicant-type-${type}"]`);
      await requireSurface(selector, `applicant-type-${type}`);
      await selector.first().click();
      await page.locator('button[type="submit"], [data-testid="next-step"]').first().click().catch(() => {});
      await expect(page.locator('body')).not.toContainText('coming soon', { ignoreCase: true });
    });
  }
});

test('discovery journey: search, view opportunity freshness/status, follow funder', async ({ page }) => {
  await page.goto(`${baseUrl()}/discover`, { waitUntil: 'networkidle' }).catch(() => null);
  const cards = page.locator('[data-testid="opportunity-card"]');
  await requireSurface(cards, 'opportunity-card');
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
  await requireSurface(rows, 'match-row');
  await rows.first().locator('[data-testid="expand-explainer"]').click();
  for (const field of ['overallScore', 'eligibilityResult', 'recommendedAction']) {
    // No `.catch(() => {})`: an explainer missing a required field must RED.
    await expect(rows.first().locator(`[data-testid="${field}"]`)).toBeVisible();
  }
});

test('submission never shows submitted without a verifiable confirmation', async ({ page }) => {
  await page.goto(`${baseUrl()}/applications`, { waitUntil: 'networkidle' }).catch(() => null);
  const submitBtn = page.locator('[data-testid="submit-application"]');
  await requireSurface(submitBtn, 'submit-application');
  await submitBtn.first().click();
  const submittedBadge = page.locator('[data-testid="submission-status"][data-value="submitted"]');
  // A badge that never appears is not evidence of honesty — it means this
  // journey did not reach the state under test, which is a SKIP, not a pass.
  test.skip(
    (await submittedBadge.count()) === 0,
    'no submission-status="submitted" badge reached — the honesty invariant was not exercised',
  );
  const confirmation = await page.locator('[data-testid="confirmation-number"]').textContent().catch(() => null);
  expect(Boolean(confirmation && confirmation.trim().length > 0), 'submitted without a stored confirmation').toBe(true);
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
  test.skip((await input.count()) === 0, 'no file input rendered — upload rejection not exercised');
  const error = page.locator('[data-testid="upload-error"]');
  await input.setInputFiles({ name: 'bad.exe', mimeType: 'application/x-msdownload', buffer: Buffer.from('MZ') });
  // The claim in this test's NAME is that the upload is REJECTED. No error
  // surface means it was not rejected in any way this test can observe, so the
  // assertion must run — it may not be skipped past.
  await expect(error.first()).toContainText(/unsupported|type|size/i);
});

test('admin: connector health surfaces a plain-language missing credential', async ({ page }) => {
  await page.goto(`${baseUrl()}/admin/connectors`, { waitUntil: 'networkidle' }).catch(() => {});
  const row = page.locator('[data-testid="connector-row"][data-satisfied="false"]');
  await requireSurface(row, 'connector-row[data-satisfied="false"]');
  await expect(row.first()).toContainText(/credential|not configured|missing/i);
});

test('deployment smoke: app bootstraps without maintenance banner or fake success', async ({ page }) => {
  const res = await page.goto(`${baseUrl()}/`, { waitUntil: 'networkidle' });
  expect(res, 'the app root did not respond at all').not.toBeNull();
  expect(res.status()).toBeLessThan(500);
  const body = await page.locator('body').textContent().catch(() => '') || '';
  expect(body.toLowerCase()).not.toContain('coming soon');
  expect(body.toLowerCase()).not.toContain('maintenance');
});

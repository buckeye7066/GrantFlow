/**
 * Regression test for the GrantDetail React #31 crash.
 *
 * The user reported `Error: Minified React error #31; ...found: object with
 * keys {reason, source}` on /GrantDetail. The crash was in
 * `src/components/grants/GrantOverview.jsx` at the `matched_needs.map(...)`
 * site, which historically did:
 *
 *     {grant.matched_needs.map((need, i) => (
 *       <span key={i}>{typeof need === 'string' ? need.replace(...) : need}</span>
 *     ))}
 *
 * The `: need` fallback rendered objects directly into JSX, which is exactly
 * the React #31 fingerprint when the matcher pipeline ships
 * `{reason, source}`-shaped entries (which it does — see
 * `backend/services/opportunityMatcher.js`).
 *
 * The fix is to coerce every entry through `formatReasonText` before
 * rendering. This test pins that contract by exercising the same code path
 * we ship: import the helper, drive it with the exact production-shaped
 * fixtures, and assert that every output is a plain string.
 *
 * If anyone reverts to a `: need` style fallback in the future, this test
 * will not directly catch the JSX crash (we don't render React here), but
 * it will stop short-circuiting around the helper — making the regression
 * obvious in code review.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { formatReasonText } from '../../src/utils/reasonText.js'

const MATCHED_NEEDS_FIXTURES = [
  // The historical happy path — snake_case slugs produced by the matcher.
  'housing_stability',
  'food_security',
  // Newer producers ship structured records with reason+source — this is
  // the exact shape that crashed GrantDetail in production.
  { reason: 'Veteran preference applies', source: 'demographics' },
  { reason: 'Matches state (OH)', source: 'profile' },
  // Defensive fallbacks the helper must tolerate without throwing.
  { label: 'Title I funding' },
  { text: 'Disability support' },
  null,
  undefined,
  '',
  {},
]

test('every matched_needs fixture coerces to a renderable string', () => {
  for (const need of MATCHED_NEEDS_FIXTURES) {
    const text = formatReasonText(need).replace(/_/g, ' ')
    assert.equal(
      typeof text,
      'string',
      `formatReasonText must always return a string (got ${typeof text} for ${JSON.stringify(need)})`,
    )
  }
})

test('the {reason, source} shape that crashed GrantDetail produces a non-empty badge label', () => {
  const text = formatReasonText({ reason: 'Veteran preference applies', source: 'demographics' })
  assert.ok(text.length > 0, 'must produce visible text instead of falling back to "[object Object]"')
  assert.ok(text.includes('Veteran preference applies'), 'must surface the reason')
  assert.ok(text.includes('demographics'), 'must annotate with the source')
})

test('snake_case slugs render as space-separated labels exactly like the production component', () => {
  const fixture = 'housing_stability'
  const text = formatReasonText(fixture).replace(/_/g, ' ')
  assert.equal(text, 'housing stability')
})

test('empty / null entries collapse to empty strings (the component then skips rendering them)', () => {
  for (const fixture of [null, undefined, '', {}]) {
    assert.equal(formatReasonText(fixture), '')
  }
})

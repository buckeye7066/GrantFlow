// standingRecordUrlGate.test.mjs
//
// Guard for the 2026-08-06 zero-recall regression on standing official lanes.
//
// WHAT HAPPENED: commit bfeae548 correctly stopped officialDirectoryAdapter from
// promoting a program's base page into apply_url ("a base/info page is not
// silently promoted to an application"). But applyGlobalRealityChecks only
// allowed an info_url to satisfy its URL gate for kind PROGRAM. Every other
// applicable kind — BENEFIT, SCHOLARSHIP, DIRECT_GRANT — suddenly had NO gate
// URL at all and was rejected `bad_url`. Measured in prod: at 2026-08-06 22:20Z
// 17 official lanes (LIHEAP, Medicaid, Pell, FSEOG, Work-Study, TEACH, MyCAA,
// SSA survivors, Black Lung, Chafee, CCDF, VA housing grants, OCOG, WA College
// Grant, ACL caregiver, HSLDA, heirs' property) went from found=1 every run to
// found=0 every run, and the run-wide zero-found rate jumped from ~2% to ~18%.
//
// THE RULE: an applicable row must present at least ONE safe https URL. It uses
// apply_url when it has one; otherwise its info_url gates it and it is stored as
// a standing record. apply_url stays null either way, so nothing downstream can
// present it as a direct application. Narrowing this back to PROGRAM re-zeroes
// those lanes.

import test from 'node:test'
import assert from 'node:assert/strict'
import { applyGlobalRealityChecks } from '../realityGate.js'
import { OPPORTUNITY_KIND, TRUST_TIER } from '../contract.js'

const source = {
  source_id: 'standing_official',
  name: 'Standing Official Program',
  trust_tier: TRUST_TIER.OFFICIAL_HTML,
  directory: false,
}

function standingCandidate(kind) {
  return {
    kind,
    title: 'John H. Chafee Foster Care Program for Successful Transition to Adulthood',
    sponsor: 'HHS Administration for Children and Families',
    summary: 'Official program information for current and former foster youth.',
    info_url: 'https://acf.gov/cb/grant-funding/john-h-chafee-foster-care-independence-program',
    apply_url: null,
    is_directory: false,
  }
}

for (const kind of [
  OPPORTUNITY_KIND.BENEFIT,
  OPPORTUNITY_KIND.SCHOLARSHIP,
  OPPORTUNITY_KIND.PROGRAM,
  OPPORTUNITY_KIND.DIRECT_GRANT,
]) {
  test(`a standing ${kind} with only an info_url is accepted, not rejected as bad_url`, () => {
    const verdict = applyGlobalRealityChecks(standingCandidate(kind), { source, evidence: {} })
    assert.equal(verdict.ok, true, `expected ${kind} to survive the URL gate, got ${verdict.reason}`)
    assert.notEqual(verdict.reason, 'bad_url')
  })
}

test('an info_url-only row still never claims an apply path (honesty is kept at apply_url, not by rejecting the row)', () => {
  const cand = standingCandidate(OPPORTUNITY_KIND.BENEFIT)
  const verdict = applyGlobalRealityChecks(cand, { source, evidence: {} })
  assert.equal(verdict.ok, true)
  assert.equal(cand.apply_url, null)
  // No captured evidence hash => the honest unverified status, never VERIFIED.
  assert.equal(verdict.reality_status, 'link_unverified')
})

test('captured evidence upgrades the same standing row to VERIFIED', () => {
  const verdict = applyGlobalRealityChecks(standingCandidate(OPPORTUNITY_KIND.BENEFIT), {
    source,
    evidence: { url: 'https://acf.gov/cb', content_hash: 'abc123' },
  })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.reality_status, 'verified')
})

test('an applicable row with NO url at all is still rejected', () => {
  const cand = { ...standingCandidate(OPPORTUNITY_KIND.BENEFIT), info_url: null, apply_url: null }
  const verdict = applyGlobalRealityChecks(cand, { source, evidence: {} })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'bad_url')
})

test('an http-only standing row is still rejected (the info fallback is not an https downgrade)', () => {
  const cand = { ...standingCandidate(OPPORTUNITY_KIND.BENEFIT), info_url: 'http://acf.gov/cb' }
  const verdict = applyGlobalRealityChecks(cand, { source, evidence: {} })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'bad_url')
})

test('the info fallback is not a laundering path for search-engine URLs', () => {
  const cand = {
    ...standingCandidate(OPPORTUNITY_KIND.BENEFIT),
    info_url: 'https://www.google.com/search?q=chafee+foster+care+grant',
  }
  const verdict = applyGlobalRealityChecks(cand, { source, evidence: {} })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'search_url_as_apply')
})

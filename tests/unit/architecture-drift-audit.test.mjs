/**
 * Architecture-drift audit tests.
 *
 * These tests fail fast if:
 *   1. The heuristic junk-prefilter (scoreOpportunity ≥ 5) ever starts
 *      excluding plausible canonical matches. The engine's SCORE_FLOOR (5)
 *      is the invariant that guarantees this — if it regresses, or if any
 *      profile+opportunity pair that computeMatchDecision would ACCEPT/REVIEW
 *      falls below 5 on scoreOpportunity, this file will fail.
 *   2. The shared opportunityPolicy primitives (placeholder URLs, loan
 *      detection, matching-funds detection, expiration, FAKE_OPPORTUNITY_SOURCES)
 *      drift away from their documented behaviour.
 *   3. docs/matching-architecture.md falls out of sync with code truth
 *      (canonical implementation file, MATCHER_VERSION).
 *   4. Anya GrantFlow domain audits stop detecting placeholder URLs, loan
 *      visibility, expired opportunities, or ignored profile sections.
 *
 * Nothing in this file requires a running database; the Anya audits that
 * need DB access are tested with an in-memory fake Postgres client.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  computeMatchDecision,
  scoreOpportunity,
  MATCHER_VERSION,
} from '../../backend/services/matchDecisionEngine.js'
import {
  FAKE_OPPORTUNITY_SOURCES,
  getPlaceholderHostnames,
  getPlaceholderUrlSqlPatterns,
  isValidRealUrl,
  isLoanLike,
  isMatchingFunds,
  isPlaceholderOpportunity,
  isExpired,
  enforceOpportunityPolicy,
  filterByPolicy,
} from '../../backend/services/shared/opportunityPolicy.js'
import { SCORE_FLOOR } from '../../backend/config/matchThresholds.js'
import { _internal_for_tests } from '../../backend/services/anyaGrantFlowAudits.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..', '..')

// ---------------------------------------------------------------------------
// 1. Heuristic-prefilter conservatism
// ---------------------------------------------------------------------------

test('SCORE_FLOOR invariant: scoreOpportunity never drops validated opportunities below 5', () => {
  assert.equal(SCORE_FLOOR, 5, 'SCORE_FLOOR must be 5 — prefilter threshold depends on it')

  // Minimal viable opportunity — no category, no geo, no eligibility keywords.
  // The engine's floor guarantee says this must still score ≥ 5.
  const vanillaOpp = {
    id: 'opp-vanilla',
    title: 'General Community Support Program',
    description: 'A flexible community support program for eligible applicants.',
    application_url: 'https://example-funder.example-not-placeholder.com/apply',
    opportunity_type: 'grant',
    source: 'grants.gov',
  }
  const thinProfile = { id: 'p-thin', state: 'OH' }
  const { score } = scoreOpportunity(thinProfile, vanillaOpp)
  assert.ok(
    score >= SCORE_FLOOR,
    `SCORE_FLOOR violated for minimum viable opportunity: got ${score}`,
  )
})

test('heuristic prefilter never excludes a canonical ACCEPT/REVIEW match', () => {
  // A fixtures table of realistic (profile, opp) pairs. For every pair where
  // computeMatchDecision returns ACCEPT or REVIEW, the prefilter score MUST
  // be ≥ SCORE_FLOOR so the Stage-1 junk filter lets it through.
  const fixtures = [
    {
      name: 'OH-caregiver ↔ caregiver-support',
      profile: {
        id: 'p-1',
        state: 'OH',
        city: 'Cincinnati',
        mission_focus: 'caregiver support',
        population_served: 'family caregivers',
        sections: {
          basic_information: { state: 'OH' },
          programs_services: { services: ['caregiver support', 'respite care'] },
        },
      },
      opp: {
        id: 'opp-1',
        title: 'Caregiver Respite Grant',
        description: 'Grants for organizations supporting family caregivers.',
        application_url: 'https://acl.gov/caregiver-grants',
        opportunity_type: 'grant',
        state: 'OH',
        categories: ['caregiver', 'respite'],
      },
    },
    {
      name: 'national-disability ↔ disability-program',
      profile: {
        id: 'p-2',
        state: 'TX',
        mission_focus: 'disability services',
        sections: { demographics: { populations_served: ['people with disabilities'] } },
      },
      opp: {
        id: 'opp-2',
        title: 'Community Disability Support Program',
        description:
          'Federal program supporting community-based disability services nationwide.',
        application_url: 'https://acl.gov/disability-support',
        opportunity_type: 'grant',
        categories: ['disability'],
        state: null,
      },
    },
    {
      name: 'thin-profile ↔ national grant (floor path)',
      profile: { id: 'p-3', state: 'MT' },
      opp: {
        id: 'opp-3',
        title: 'Rural Community Development Grant',
        description: 'Rural community development nationwide.',
        application_url: 'https://www.rd.usda.gov/programs/rural-community-development',
        opportunity_type: 'grant',
        categories: ['community development'],
      },
    },
  ]

  for (const fx of fixtures) {
    const { score } = scoreOpportunity(fx.profile, fx.opp)
    const decision = computeMatchDecision(fx.profile, fx.opp)
    if (decision.decision === 'ACCEPT' || decision.decision === 'REVIEW') {
      assert.ok(
        score >= SCORE_FLOOR,
        `[${fx.name}] canonical decision=${decision.decision} but heuristic score=${score} < SCORE_FLOOR. ` +
          `Prefilter would wrongly discard a canonical match.`,
      )
    }
  }
})

test('heuristic prefilter only blocks things canonical engine also rejects', () => {
  const clearGarbage = {
    id: 'trash',
    title: 'x',
    description: '',
    application_url: '',
  }
  const profile = { id: 'p-ok', state: 'OH' }
  const { score } = scoreOpportunity(profile, clearGarbage)
  if (score < SCORE_FLOOR) {
    const decision = computeMatchDecision(profile, clearGarbage)
    assert.equal(
      decision.decision,
      'REJECT',
      `Prefilter dropped an opportunity canonical engine did not REJECT: ${decision.decision}`,
    )
  }
})

// ---------------------------------------------------------------------------
// 2. Shared opportunityPolicy primitives
// ---------------------------------------------------------------------------

test('FAKE_OPPORTUNITY_SOURCES covers the historical fake-source slugs', () => {
  for (const slug of ['comprehensive_crawler', 'synthetic', 'template', 'fake', 'example']) {
    assert.ok(
      FAKE_OPPORTUNITY_SOURCES.includes(slug),
      `FAKE_OPPORTUNITY_SOURCES missing canonical slug: ${slug}`,
    )
  }
  assert.throws(() => {
    // Frozen — any attempt to silently extend it in-process must fail.
    FAKE_OPPORTUNITY_SOURCES.push('new')
  })
})

test('getPlaceholderHostnames / getPlaceholderUrlSqlPatterns agree and cover key hosts', () => {
  const hosts = getPlaceholderHostnames()
  const patterns = getPlaceholderUrlSqlPatterns()
  for (const host of ['example.com', 'example.org', 'localhost', 'placeholder.com']) {
    assert.ok(hosts.includes(host), `getPlaceholderHostnames missing: ${host}`)
    assert.ok(
      patterns.includes(`%${host}%`),
      `getPlaceholderUrlSqlPatterns missing: %${host}%`,
    )
  }
})

test('isValidRealUrl rejects every canonical placeholder host', () => {
  for (const host of getPlaceholderHostnames()) {
    assert.equal(
      isValidRealUrl(`https://${host}/apply`),
      false,
      `isValidRealUrl should reject placeholder host: ${host}`,
    )
  }
  assert.equal(isValidRealUrl('https://grants.gov/real-grant'), true)
})

test('isLoanLike, isMatchingFunds, isPlaceholderOpportunity, isExpired behave per policy', () => {
  assert.equal(
    isLoanLike({ opportunity_type: 'loan', title: 'Microloan Program' }),
    true,
  )
  assert.equal(
    isLoanLike({ title: 'Caregiver Respite Grant', description: 'Grants for caregivers.' }),
    false,
  )
  assert.equal(isMatchingFunds({ requires_match: true }), true)
  assert.equal(isMatchingFunds({ title: 'Community Grant' }), false)
  assert.equal(
    isPlaceholderOpportunity({ title: 'Test Opportunity', description: 'lorem ipsum' }),
    true,
  )
  assert.equal(isPlaceholderOpportunity({ title: 'Real Grant', description: 'Real one.' }), false)
  assert.equal(isExpired({ deadline: '2000-01-01' }), true)
  assert.equal(isExpired({ deadline_type: 'rolling', deadline: '2000-01-01' }), false)
  assert.equal(isExpired({}), false)
})

test('enforceOpportunityPolicy returns stable rejection reasons', () => {
  assert.equal(enforceOpportunityPolicy({ url: 'not a url' }).reason, 'no_real_url')
  assert.equal(
    enforceOpportunityPolicy({
      url: 'https://example.com/apply',
    }).reason,
    'no_real_url',
  )
  assert.equal(
    enforceOpportunityPolicy({
      url: 'https://grants.gov/g',
      title: 'lorem ipsum',
      description: 'placeholder',
    }).reason,
    'placeholder_text',
  )
  assert.equal(
    enforceOpportunityPolicy({
      url: 'https://grants.gov/g',
      title: 'Small Business Microloan Program',
      description: 'Microloan with borrower repayment schedule.',
    }).reason,
    'loan_like',
  )
  assert.equal(
    enforceOpportunityPolicy({
      url: 'https://grants.gov/g',
      title: 'Community Infrastructure',
      description: 'Requires matching funds 1:1.',
    }).reason,
    'matching_funds',
  )
  assert.equal(
    enforceOpportunityPolicy({
      url: 'https://grants.gov/g',
      title: 'Community Infrastructure',
      description: 'Real grant.',
      deadline: '2000-01-01',
    }).reason,
    'expired_deadline',
  )
  assert.equal(
    enforceOpportunityPolicy({
      url: 'https://grants.gov/g',
      title: 'Community Infrastructure',
      description: 'Real grant.',
    }).ok,
    true,
  )
})

test('filterByPolicy bulk-drops policy violations and records rejection counts', () => {
  const counts = {}
  const { passed } = filterByPolicy(
    [
      { url: 'https://example.com/x', title: 'A', description: 'a' },
      { url: 'https://grants.gov/x', title: 'Real Grant', description: 'real' },
      { url: 'https://grants.gov/y', title: 'Microloan Program', description: 'borrower repays' },
    ],
    { rejectionCounts: counts },
  )
  assert.equal(passed.length, 1)
  assert.equal(passed[0].title, 'Real Grant')
  assert.ok(counts.no_real_url >= 1)
  assert.ok(counts.loan_like >= 1)
})

// ---------------------------------------------------------------------------
// 3. No script-local placeholder/URL/fake-source pattern drift
// ---------------------------------------------------------------------------

function readRepoFile(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')
}

test('seed scripts import the shared opportunityPolicy and do not hard-code placeholder lists', () => {
  for (const rel of [
    'scripts/seed-profile-grants.mjs',
    'scripts/seed-real-opportunities.mjs',
  ]) {
    const src = readRepoFile(rel)
    assert.match(
      src,
      /from\s+['"][./\w-]*shared\/opportunityPolicy\.js['"]/,
      `${rel} must import from backend/services/shared/opportunityPolicy.js`,
    )
    // Raw LIKE strings for placeholder hosts are forbidden — use
    // getPlaceholderUrlSqlPatterns() instead.
    const hardCoded = src.match(/LIKE\s+'%example\.(com|org)%'/i)
    assert.equal(
      hardCoded,
      null,
      `${rel} still hard-codes placeholder LIKE patterns; use getPlaceholderUrlSqlPatterns()`,
    )
    // The literal fake-source list must not be copied inline anymore.
    const inlineSources = src.match(
      /\[\s*['"]comprehensive_crawler['"][\s\S]{0,200}['"]template['"]\s*,/,
    )
    if (inlineSources) {
      // It's allowed only if the very next non-whitespace token assigns it
      // from FAKE_OPPORTUNITY_SOURCES.
      const usesCanonical =
        /FAKE_OPPORTUNITY_SOURCES/.test(src) &&
        /fakeSources\s*=\s*FAKE_OPPORTUNITY_SOURCES/.test(src)
      assert.ok(
        usesCanonical,
        `${rel} has an inline fake-sources list — reuse FAKE_OPPORTUNITY_SOURCES`,
      )
    }
  }
})

// ---------------------------------------------------------------------------
// 4. Stale-doc prevention
// ---------------------------------------------------------------------------

test('docs/matching-architecture.md reflects current code truth', () => {
  const doc = readRepoFile('docs/matching-architecture.md')
  assert.match(
    doc,
    /backend\/services\/matchEngine\.js/,
    'docs must name the canonical implementation file',
  )
  assert.match(
    doc,
    new RegExp(
      'MATCHER_VERSION[^\\n]{0,80}' + MATCHER_VERSION.replace(/\./g, '\\.'),
    ),
    `docs must reference MATCHER_VERSION = ${MATCHER_VERSION}`,
  )
  // Reject the obsolete claim that matchDecisionEngine is the canonical file.
  const claimsDecisionEngineCanonical = /canonical[^\n]{0,40}matchDecisionEngine\.js/i.test(doc)
  assert.equal(
    claimsDecisionEngineCanonical,
    false,
    'docs must not claim matchDecisionEngine.js is the canonical implementation',
  )
  // Reject stale MATCHER_VERSION strings.
  for (const stale of ['2.0.0', '3.0.0']) {
    if (stale === MATCHER_VERSION) continue
    const staleRx = new RegExp('MATCHER_VERSION[^\\n]{0,40}' + stale.replace(/\./g, '\\.'))
    assert.equal(
      staleRx.test(doc),
      false,
      `docs still reference stale MATCHER_VERSION ${stale}`,
    )
  }
})

// ---------------------------------------------------------------------------
// 5. Anya domain audits
// ---------------------------------------------------------------------------

function fakeDb(responses) {
  const queue = [...responses]
  return {
    async query() {
      const next = queue.shift() || { rows: [] }
      if (next instanceof Error) throw next
      return next
    },
  }
}

test('auditOpportunityUrls flags placeholder hosts as placeholder_opportunity_url', async () => {
  const db = fakeDb([
    {
      rows: [
        { id: 1, title: 'Good', application_url: 'https://grants.gov/ok' },
        { id: 2, title: 'Bad host', application_url: 'https://example.com/apply' },
        { id: 3, title: 'Not a URL', application_url: 'not-a-url' },
      ],
    },
  ])
  const { findings, checked } = await _internal_for_tests.auditOpportunityUrls({ db })
  assert.equal(checked, 3)
  const types = findings.map((f) => f.type)
  assert.ok(types.includes('placeholder_opportunity_url'), 'should flag example.com')
  assert.ok(types.includes('invalid_opportunity_url'), 'should flag unparseable URL')
})

test('auditExpiredOpportunityLabeling flags expired opportunities still active', async () => {
  const db = fakeDb([
    {
      rows: [
        { id: 10, title: 'Old', deadline: '2000-01-01', deadline_type: null, is_active: true },
        { id: 11, title: 'Fresh', deadline: '2999-12-31', deadline_type: null, is_active: true },
      ],
    },
  ])
  const { findings, expired } = await _internal_for_tests.auditExpiredOpportunityLabeling({ db })
  assert.equal(expired, 1)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].type, 'expired_but_active')
  assert.equal(findings[0].evidence.id, 10)
})

test('auditLoanVisibility flags loan-like opportunities that are still active', async () => {
  const db = fakeDb([
    {
      rows: [
        {
          id: 20,
          title: 'Microloan Program',
          description: 'Borrower repays over 12 months with APR 8%.',
          opportunity_type: 'loan',
        },
        {
          id: 21,
          title: 'Community Grant',
          description: 'Real grant, no repayment.',
          opportunity_type: 'grant',
        },
      ],
    },
  ])
  const { findings, loan_like } = await _internal_for_tests.auditLoanVisibility({ db })
  assert.equal(loan_like, 1)
  const types = findings.map((f) => f.type)
  assert.ok(types.includes('active_loan_like_opportunity'))
})

test('auditIgnoredProfileSections detects sections the matcher never references', async () => {
  const { findings, missing_sections } =
    await _internal_for_tests.auditIgnoredProfileSections({ rootDir: REPO_ROOT })
  // The matcher may legitimately reference all sections — whatever the truth
  // is right now, the audit must either (a) return findings naming the
  // missing sections, or (b) return no findings and an empty missing_sections
  // array. The invariant we can always assert is consistency between them.
  if (missing_sections.length > 0) {
    assert.equal(findings.length, 1)
    assert.deepEqual(findings[0].evidence.missing_sections, missing_sections)
  } else {
    assert.equal(findings.length, 0)
  }
})

test('auditZeroResultFallbackInRoutes scans actual route files without throwing', async () => {
  const { checked, findings } =
    await _internal_for_tests.auditZeroResultFallbackInRoutes({ rootDir: REPO_ROOT })
  assert.ok(checked >= 1, 'expected at least one route file to be scanned')
  for (const f of findings) {
    assert.equal(f.audit, 'zero_result_fallback_routes')
    assert.ok(f.file?.startsWith('backend/routes/'))
  }
})

test('Anya audits surface errors instead of silently swallowing DB failures', async () => {
  const db = fakeDb([new Error('boom')])
  const { findings, errors } = await _internal_for_tests.auditExpiredOpportunityLabeling({ db })
  assert.equal(findings.length, 0)
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /query_failed/)
})

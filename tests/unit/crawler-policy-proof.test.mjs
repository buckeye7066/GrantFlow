/**
 * Executable version of docs/CRAWLER_POLICY_PROOF.md
 *
 * The prose guarantees in that document each become at least one
 * regression-resistant test here. If any invariant regresses, these tests
 * fail.
 *
 * Guarantees covered:
 *   P1. Centralised policy — loan / matching-funds / placeholder URL /
 *       unparseable URL all rejected; reasons are stable.
 *   P2. Per-request rejection counts — passing `opts.rejectionCounts`
 *       writes there and does NOT touch the module-level counter.
 *   P3. `filterByPolicy` bulk-drops offenders and reports why.
 *   P4. `upsertFundingOpportunity()` rejects every non-compliant opportunity
 *       before any DB write (loans, matching funds, placeholder URLs,
 *       placeholder titles, unparseable URLs).
 *   P5. `deduplicateByUrl()` collapses same-URL duplicates deterministically.
 *   P6. `stableSourceIdFromOpportunity()` intentionally excludes `deadline`
 *       from its hash input, so deadline-only changes update the SAME
 *       record. Static scan of the source is used because the symbol is
 *       module-private.
 *   P7. Cross-crawler ECF dedup — `itemFundingCrawler.js` maintains a
 *       `seenUrls` Set. Static scan.
 *   P8. `matchingEngine.js` remains a thin deprecation shim; no new logic,
 *       no new thresholds.
 *   P9. `bulkUpsertFundingOpportunities` pre-deduplicates by URL before
 *       batching (calls `deduplicateByUrl`). Static scan.
 *   P10. No path removes the request-scoped rejection-count option in
 *        favour of resetting the module-level counter. Static scan.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  enforceOpportunityPolicy,
  filterByPolicy,
  getPolicyRejectionCounts,
  resetPolicyRejectionCounts,
  isMatchingFunds,
  isLoanLike,
} from '../../backend/services/shared/opportunityPolicy.js'
import {
  upsertFundingOpportunity,
  bulkUpsertFundingOpportunities,
} from '../../backend/services/opportunityInserter.js'
import { deduplicateByUrl } from '../../backend/services/opportunityValidator.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..', '..')

function readRepoFile(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')
}

// ---------------------------------------------------------------------------
// P1. Centralised policy
// ---------------------------------------------------------------------------

test('P1: enforceOpportunityPolicy rejects every forbidden opportunity class with stable reasons', () => {
  const cases = [
    { opp: { url: 'not a url' }, reason: 'no_real_url' },
    { opp: { url: 'https://example.com/apply' }, reason: 'no_real_url' },
    {
      opp: {
        url: 'https://grants.gov/g',
        title: 'lorem ipsum',
        description: 'placeholder',
      },
      reason: 'placeholder_text',
    },
    {
      opp: {
        url: 'https://grants.gov/g',
        title: 'Small Business Microloan Program',
        description: 'Borrower repays loan with APR 8%.',
        opportunity_type: 'loan',
      },
      reason: 'loan_like',
    },
    {
      opp: {
        url: 'https://grants.gov/g',
        title: 'Community Grant',
        description: 'Requires matching funds 1:1 cost-share.',
      },
      reason: 'matching_funds',
    },
    {
      opp: {
        url: 'https://grants.gov/g',
        title: 'Closed Grant',
        description: 'Real but expired.',
        deadline: '2000-01-01',
      },
      reason: 'expired_deadline',
    },
  ]
  for (const c of cases) {
    const r = enforceOpportunityPolicy(c.opp)
    assert.equal(r.ok, false, `Expected reject for ${c.reason}`)
    assert.equal(r.reason, c.reason)
  }
  const ok = enforceOpportunityPolicy({
    url: 'https://grants.gov/g',
    title: 'Community Infrastructure Grant',
    description: 'Real grant for real work.',
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.reason, null)
})

// ---------------------------------------------------------------------------
// P1b. A MENTION is not a DECLARATION.
//
// enforceOpportunityPolicy is the ingest choke point (upsertFundingOpportunity
// is the ONLY admission gate), so a false `matching_funds` / `loan_like`
// verdict DELETES a real grant before the match engine can ever see it. Federal
// notices state the opposite of a requirement in the same words, and grant
// terms routinely use loan-shaped clawback language. Each case below FAILS on
// the pre-fix substring rules.
// ---------------------------------------------------------------------------

test('P1b: a NEGATED cost-share/matching statement is not a matching-funds requirement', () => {
  const negated = [
    'Cost Sharing or Matching Requirement: No',
    'Cost sharing is not required for this program.',
    'No match required.',
    'Applicants are exempt from cost share.',
    'Matching funds: none',
    'The cost-share requirement is waived for all applicants.',
  ]
  for (const description of negated) {
    assert.equal(
      isMatchingFunds({ title: 'Community Infrastructure Grant', description }),
      false,
      `must not read a denial as a requirement: ${description}`,
    )
    const r = enforceOpportunityPolicy({
      url: 'https://grants.gov/g',
      title: 'Community Infrastructure Grant',
      description,
    })
    assert.equal(r.ok, true, `must not be dropped at ingest: ${description}`)
  }
})

test('P1b: a REAL matching requirement still declares itself, negation elsewhere notwithstanding', () => {
  const declared = [
    'A 25% cost share is required.',
    'Requires matching funds 1:1 cost-share.',
    'Applicants must provide dollar-for-dollar matching funds. No exceptions.',
    // First clause declares; a later waiver clause must not exempt the notice.
    'A 25% cost share is required. Cost sharing is waived for tribal applicants.',
  ]
  for (const description of declared) {
    assert.equal(
      isMatchingFunds({ title: 'Community Grant', description }),
      true,
      `must still detect a real requirement: ${description}`,
    )
  }
  // Structured declarations remain authoritative and are never softened.
  assert.equal(isMatchingFunds({ requires_match: true }), true)
  assert.equal(isMatchingFunds({ requires_cost_share: true }), true)
  assert.equal(isMatchingFunds({ match_percentage: 25 }), true)
  assert.equal(isMatchingFunds({ requires_cost_share: false, description: 'Community grant.' }), false)
})

test('P1b: genuine loan shapes still classify as loans', () => {
  assert.equal(
    isLoanLike({ title: 'Microloan Program', description: 'Borrower repays the loan at an APR of 8%.' }),
    true,
  )
  assert.equal(isLoanLike({ opportunity_type: 'loan', title: 'X', description: 'y' }), true)
  // NOTE — an OPEN defect deliberately left unpinned here: LOAN_PHRASE_RX's
  // `repayment of funds` alternative also matches federal GRANT clawback
  // language, dropping real grants at ingest. Fixing it requires changing
  // tests/unit/opportunityPolicy.test.mjs ("isLoanLike: detects repayment of
  // funds"), which is owned by another batch — see the cross-batch note in
  // backend/services/shared/opportunityPolicy.js.
})

// ---------------------------------------------------------------------------
// P2. Per-request rejection counts
// ---------------------------------------------------------------------------

test('P2: per-request rejectionCounts does NOT bump the module-level counter', () => {
  resetPolicyRejectionCounts()
  const moduleBefore = getPolicyRejectionCounts()
  assert.deepEqual(moduleBefore, {})

  const reqCounts = {}
  enforceOpportunityPolicy({ url: 'not a url' }, { rejectionCounts: reqCounts })
  enforceOpportunityPolicy(
    { url: 'https://grants.gov/x', title: 'Microloan Program', description: 'borrower repays' },
    { rejectionCounts: reqCounts },
  )

  assert.equal(reqCounts.no_real_url, 1)
  assert.equal(reqCounts.loan_like, 1)
  assert.deepEqual(
    getPolicyRejectionCounts(),
    {},
    'module-level counter must stay empty when opts.rejectionCounts is provided',
  )

  // And without opts -> module-level DOES bump
  enforceOpportunityPolicy({ url: 'not a url' })
  const after = getPolicyRejectionCounts()
  assert.equal(after.no_real_url, 1)
  resetPolicyRejectionCounts()
})

// ---------------------------------------------------------------------------
// P3. filterByPolicy
// ---------------------------------------------------------------------------

test('P3: filterByPolicy drops offenders, keeps clean opps, and records rejection reasons', () => {
  const rejectionCounts = {}
  const { passed } = filterByPolicy(
    [
      { url: 'https://example.com/x', title: 'A', description: 'a' },
      { url: 'https://grants.gov/good', title: 'Good Grant', description: 'real' },
      {
        url: 'https://grants.gov/bad',
        title: 'Microloan Program',
        description: 'borrower repays',
      },
      {
        url: 'https://grants.gov/expired',
        title: 'Expired Grant',
        description: 'real',
        deadline: '2000-01-01',
      },
    ],
    { rejectionCounts },
  )
  assert.equal(passed.length, 1)
  assert.equal(passed[0].title, 'Good Grant')
  assert.ok(rejectionCounts.no_real_url >= 1)
  assert.ok(rejectionCounts.loan_like >= 1)
  assert.ok(rejectionCounts.expired_deadline >= 1)
})

// ---------------------------------------------------------------------------
// P4. upsertFundingOpportunity rejects non-compliant opportunities before
//     any DB write happens.
// ---------------------------------------------------------------------------

function makeFakeDb() {
  // Captures every prepared statement / transaction attempt so we can prove
  // that no SQL ran when policy rejects an opportunity.
  const prepared = []
  const txRuns = []
  const db = {
    dialect: 'sqlite',
    prepare(sql) {
      prepared.push(sql)
      return {
        all: () => [],
        get: () => undefined,
        run: () => ({ changes: 0, lastInsertRowid: 0 }),
      }
    },
    async withTransaction(fn) {
      txRuns.push('tx')
      return fn(db)
    },
  }
  db._debug = { prepared, txRuns }
  return db
}

test('P4: upsertFundingOpportunity rejects non-compliant opportunities with policy:<reason>', async () => {
  const db = makeFakeDb()
  const forbidden = [
    { url: 'not-a-url', title: 'X', description: 'x' },
    { url: 'https://example.com/apply', title: 'X', description: 'x' },
    { url: 'https://grants.gov/loan', title: 'Microloan Program', description: 'borrower repays APR' },
    {
      url: 'https://grants.gov/match',
      title: 'Match Grant',
      description: 'Requires matching funds 1:1 cost-share.',
    },
    { url: 'https://grants.gov/stub', title: 'Test Opportunity', description: 'lorem ipsum' },
  ]
  for (const opp of forbidden) {
    const r = await upsertFundingOpportunity(db, opp)
    assert.equal(r.skipped, true, `Expected skip for ${opp.title}`)
    assert.match(
      r.reason,
      /^policy:/,
      `Expected policy:* reason for ${opp.title}, got ${r.reason}`,
    )
    assert.equal(r.inserted, false)
    assert.equal(r.id, null)
  }
  // Rejected opps must NEVER be written to funding_opportunities. A best-effort
  // rejection_log INSERT IS expected now (the observability feature) and is fine.
  const catalogWrites = db._debug.prepared.filter(
    (sql) => /funding_opportunities/i.test(sql) && /\b(INSERT|UPDATE)\b/i.test(sql),
  )
  assert.equal(
    catalogWrites.length,
    0,
    `No funding_opportunities write should occur for policy-rejected opps. Saw: ${catalogWrites.join('\n')}`,
  )
})

// ---------------------------------------------------------------------------
// P5. deduplicateByUrl
// ---------------------------------------------------------------------------

test('P5: deduplicateByUrl collapses same-URL duplicates and keeps first occurrence', () => {
  const input = [
    { title: 'First', url: 'https://grants.gov/a' },
    { title: 'Dup', url: 'https://grants.gov/a' },
    { title: 'Second', url: 'https://grants.gov/b' },
    { title: 'TrailingSlashDup', url: 'https://grants.gov/a/' },
    { title: 'NoUrl' },
  ]
  const { unique, duplicateCount } = deduplicateByUrl(input)
  assert.ok(duplicateCount >= 1)
  const titles = unique.map((u) => u.title)
  assert.ok(titles.includes('First'))
  assert.ok(titles.includes('Second'))
  assert.ok(!titles.includes('Dup'), 'exact URL duplicate must be removed')
})

// ---------------------------------------------------------------------------
// P6. stableSourceIdFromOpportunity excludes deadline
// ---------------------------------------------------------------------------

test('P6 (static): stableSourceIdFromOpportunity() source does not include deadline in its hash input', () => {
  const src = readRepoFile('backend/services/opportunityInserter.js')
  const fnIdx = src.indexOf('function stableSourceIdFromOpportunity')
  assert.ok(fnIdx >= 0, 'stableSourceIdFromOpportunity not found')
  // Extract until the next top-level `function ` or end of file; this is
  // cheap but reliable because the function is tiny.
  const after = src.slice(fnIdx)
  const nextFn = after.slice(1).search(/\nfunction\s/)
  const body = nextFn > 0 ? after.slice(0, nextFn) : after
  assert.ok(
    !/opportunity\?\.deadline/.test(body),
    'stableSourceIdFromOpportunity must not read opportunity.deadline into its hash',
  )
  // And confirm the comment that documents the reason is present.
  assert.match(
    body,
    /deadline.*update|Exclude\s+deadline/i,
    'the comment documenting the deadline-exclusion invariant must remain',
  )
})

// ---------------------------------------------------------------------------
// P7. ECF dedup in itemFundingCrawler.js
// ---------------------------------------------------------------------------

test('P7 (static): itemFundingCrawler maintains a seenUrls dedup Set', () => {
  const src = readRepoFile('backend/services/crawlers/itemFundingCrawler.js')
  assert.match(
    src,
    /const\s+seenUrls\s*=\s*new\s+Set\(\)/,
    'itemFundingCrawler.js must construct a seenUrls Set for cross-source dedup',
  )
  // Both .has and .add must be present near the Set for it to be live.
  assert.match(src, /seenUrls\.has\(/)
  assert.match(src, /seenUrls\.add\(/)
})

// ---------------------------------------------------------------------------
// P8. matchingEngine.js is a thin deprecation shim
// ---------------------------------------------------------------------------

test('P8: matchingEngine.js is a pure deprecation shim with no new logic', async () => {
  const src = readRepoFile('backend/services/matchingEngine.js')
  assert.match(src, /DEPRECATED/i, 'matchingEngine.js must carry the DEPRECATED banner')
  assert.match(
    src,
    /@deprecated/,
    'matchingEngine.js must include @deprecated JSDoc guidance',
  )
  assert.match(
    src,
    /from\s+['"]\.\/matchEngine\.js['"]/,
    'matchingEngine.js must re-export from matchEngine.js',
  )
  // Behavioural parity: calculateMatchScore === scoreOpportunity output
  const legacy = await import('../../backend/services/matchingEngine.js')
  const canonical = await import('../../backend/services/matchEngine.js')
  const profile = { id: 'p', state: 'OH' }
  const opp = {
    id: 'o',
    title: 'Community Grant',
    description: 'Real grant.',
    application_url: 'https://grants.gov/a',
  }
  const legacyResult = legacy.calculateMatchScore(profile, opp)
  const canonicalResult = canonical.scoreOpportunity(profile, opp)
  assert.equal(legacyResult.score, canonicalResult.score)
  assert.deepEqual(legacyResult.reasons, canonicalResult.reasons)
})

// ---------------------------------------------------------------------------
// P9. bulkUpsertFundingOpportunities pre-deduplicates
// ---------------------------------------------------------------------------

test('P9: bulkUpsertFundingOpportunities pre-deduplicates by URL before upsert', async () => {
  // Confirm the symbol is imported at the top of opportunityInserter and the
  // call happens in the bulk entry point — both static and behavioral.
  const src = readRepoFile('backend/services/opportunityInserter.js')
  assert.match(
    src,
    /import\s*{[^}]*deduplicateByUrl[^}]*}\s*from\s*['"]\.\/opportunityValidator\.js['"]/,
    'opportunityInserter must import deduplicateByUrl from opportunityValidator',
  )
  assert.match(
    src,
    /deduplicateByUrl\(opportunities\)/,
    'bulkUpsertFundingOpportunities must call deduplicateByUrl on its input batch',
  )
  // Behavioural: calling bulkUpsert with a batch where every opp is
  // policy-rejected still returns cleanly (no inserts) and does not throw.
  const db = makeFakeDb()
  const result = await bulkUpsertFundingOpportunities(db, [
    { url: 'https://example.com/a', title: 'Placeholder', description: 'x' },
    { url: 'https://example.com/a', title: 'Placeholder', description: 'x' }, // dup
  ])
  assert.ok(Array.isArray(result))
  assert.equal(result.length, 0)
})

// ---------------------------------------------------------------------------
// P10. No path resets module-level counter when a request-scoped counter is used.
// ---------------------------------------------------------------------------

test('P10 (static): filterByPolicy does not invoke resetPolicyRejectionCounts in the module', () => {
  const src = readRepoFile('backend/services/shared/opportunityPolicy.js')
  // filterByPolicy body: resetPolicyRejectionCounts() must not appear inside it.
  const fnStart = src.indexOf('export function filterByPolicy')
  assert.ok(fnStart >= 0)
  const rest = src.slice(fnStart)
  const nextExport = rest.slice(1).search(/\nexport\s/)
  const body = nextExport > 0 ? rest.slice(0, nextExport) : rest
  assert.ok(
    !/resetPolicyRejectionCounts\(/.test(body),
    'filterByPolicy must never call resetPolicyRejectionCounts (#8 per-request counters)',
  )
})

// ---------------------------------------------------------------------------
// Documentation pointer — every test above maps back to a bullet in
// CRAWLER_POLICY_PROOF.md, and the doc should advertise this test file so
// future readers find the executable truth first.
// ---------------------------------------------------------------------------

test('CRAWLER_POLICY_PROOF.md points readers at this executable test file', () => {
  const doc = readRepoFile('docs/CRAWLER_POLICY_PROOF.md')
  assert.match(
    doc,
    /crawler-policy-proof\.test\.mjs/,
    'CRAWLER_POLICY_PROOF.md must reference tests/unit/crawler-policy-proof.test.mjs',
  )
})

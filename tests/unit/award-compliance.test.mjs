/**
 * Award Compliance & Restriction Tracking — unit coverage.
 *
 * Pins the load-bearing money math (integer cents, conservative status) and the
 * restriction-phrase parser that pre-creates DRAFT rules from awarded grants.
 *
 *   - computeComplianceSummaryFrom: short / met / over / overdue / on_track
 *   - computeScholarshipReconciliation: covered / left-to-pay / extra refund
 *   - parseRestrictionPhrases / deriveDraftRulesFromGrant: never invents numbers
 *   - store round-trip (createRule + addSpendEntry + computeComplianceSummary)
 *     through the production-faithful wrapSqlite db.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'

import {
  createRule,
  addSpendEntry,
  computeComplianceSummary,
  computeComplianceSummaryFrom,
  computeScholarshipReconciliation,
  deriveDraftRulesForGrant,
  scanAwardComplianceFindings,
  _resetComplianceSchemaCache,
} from '../../backend/services/awardCompliance/awardComplianceStore.js'

import {
  parseMoneyToCents,
  parseRestrictionPhrases,
  deriveDraftRulesFromGrant,
} from '../../backend/services/awardCompliance/restrictionParser.js'

function freshDb() {
  _resetComplianceSchemaCache()
  return wrapSqlite(new Database(':memory:'))
}

// ---------------------------------------------------------------------------
// computeComplianceSummaryFrom (pure)
// ---------------------------------------------------------------------------
test('compliance summary: SHORT when logged spend is below the requirement', () => {
  const rule = { id: 'r1', restriction_type: 'category_minimum', category: 'supplies', required_amount_cents: 50000, spend_by_date: null }
  const s = computeComplianceSummaryFrom(rule, { spentCents: 20000, entryCount: 1 })
  assert.equal(s.status, 'short')
  assert.equal(s.required_cents, 50000)
  assert.equal(s.spent_cents, 20000)
  assert.equal(s.remaining_cents, 30000)
  assert.equal(s.over_cents, 0)
  assert.equal(s.pct, 40)
})

test('compliance summary: MET only when entries sum to the requirement (never auto-compliant)', () => {
  const rule = { id: 'r2', restriction_type: 'category_minimum', category: 'supplies', required_amount_cents: 50000, spend_by_date: null }
  // Zero entries but somehow spentCents passed in must NOT be 'met' without entries.
  const noEntries = computeComplianceSummaryFrom(rule, { spentCents: 50000, entryCount: 0 })
  assert.notEqual(noEntries.status, 'met')
  // With an actual entry summing to the requirement => met.
  const met = computeComplianceSummaryFrom(rule, { spentCents: 50000, entryCount: 1 })
  assert.equal(met.status, 'met')
  assert.equal(met.remaining_cents, 0)
  assert.equal(met.pct, 100)
})

test('compliance summary: OVER when an exact-category requirement is exceeded', () => {
  const rule = { id: 'r3', restriction_type: 'category_exact', category: 'supplies', required_amount_cents: 50000, spend_by_date: null }
  const s = computeComplianceSummaryFrom(rule, { spentCents: 60000, entryCount: 2 })
  assert.equal(s.status, 'over')
  assert.equal(s.over_cents, 10000)
  assert.equal(s.remaining_cents, 0)
})

test('compliance summary: OVERDUE when due date passed and requirement not met', () => {
  const rule = {
    id: 'r4', restriction_type: 'timeframe', category: null,
    required_amount_cents: 100000, spend_by_date: '2026-01-01T00:00:00Z',
  }
  const now = new Date('2026-06-20T00:00:00Z')
  const s = computeComplianceSummaryFrom(rule, { spentCents: 10000, entryCount: 1, now })
  assert.equal(s.status, 'overdue')
  assert.equal(s.is_overdue, true)
  assert.ok(s.days_left < 0)
})

test('compliance summary: a met requirement is NOT overdue even past the due date', () => {
  const rule = {
    id: 'r5', restriction_type: 'category_minimum', category: 'supplies',
    required_amount_cents: 100000, spend_by_date: '2026-01-01T00:00:00Z',
  }
  const now = new Date('2026-06-20T00:00:00Z')
  const s = computeComplianceSummaryFrom(rule, { spentCents: 100000, entryCount: 1, now })
  assert.equal(s.status, 'met')
})

test('compliance summary: on_track when there is no required amount', () => {
  const rule = { id: 'r6', restriction_type: 'allowed_use', category: 'tuition', required_amount_cents: null, spend_by_date: null }
  const s = computeComplianceSummaryFrom(rule, { spentCents: 0, entryCount: 0 })
  assert.equal(s.status, 'on_track')
  assert.equal(s.required_cents, null)
})

// ---------------------------------------------------------------------------
// computeScholarshipReconciliation (pure)
// ---------------------------------------------------------------------------
test('scholarship reconciliation: award smaller than bill leaves balance to pay', () => {
  const r = computeScholarshipReconciliation({ award_cents: 300000, school_bill_cents: 500000 })
  assert.equal(r.covered_cents, 300000)
  assert.equal(r.left_to_pay_cents, 200000)
  assert.equal(r.extra_refund_cents, 0)
  assert.equal(r.fully_covered, false)
})

test('scholarship reconciliation: award larger than bill yields a refundable extra', () => {
  const r = computeScholarshipReconciliation({ award_cents: 600000, school_bill_cents: 500000 })
  assert.equal(r.covered_cents, 500000)
  assert.equal(r.left_to_pay_cents, 0)
  assert.equal(r.extra_refund_cents, 100000)
  assert.equal(r.fully_covered, true)
})

test('scholarship reconciliation: clamps negative inputs to zero', () => {
  const r = computeScholarshipReconciliation({ award_cents: -100, school_bill_cents: -50 })
  assert.equal(r.award_cents, 0)
  assert.equal(r.bill_cents, 0)
  assert.equal(r.covered_cents, 0)
})

// ---------------------------------------------------------------------------
// Restriction phrase parser (pure) — never invents numbers
// ---------------------------------------------------------------------------
test('parseMoneyToCents: handles $ and trailing-word forms, rejects bare numbers', () => {
  assert.equal(parseMoneyToCents('$1,000'), 100000)
  assert.equal(parseMoneyToCents('$500.50'), 50050)
  assert.equal(parseMoneyToCents('1000 dollars'), 100000)
  assert.equal(parseMoneyToCents('90 days'), null)
  assert.equal(parseMoneyToCents('supplies'), null)
})

test('parser: "$500 must be spent on supplies" => exact category rule with $500', () => {
  const rules = parseRestrictionPhrases('Of this $1000 grant, $500 must be spent on supplies.')
  const cat = rules.find((r) => r.category === 'supplies')
  assert.ok(cat, 'expected a supplies rule')
  assert.equal(cat.restriction_type, 'category_exact')
  assert.equal(cat.required_amount_cents, 50000)
  assert.equal(cat.draft, true)
})

test('parser: "at least $500 for supplies" => minimum category rule', () => {
  const rules = parseRestrictionPhrases('At least $500 must be used for supplies.')
  const cat = rules.find((r) => r.category === 'supplies')
  assert.ok(cat)
  assert.equal(cat.restriction_type, 'category_minimum')
  assert.equal(cat.required_amount_cents, 50000)
})

test('parser: "spend within 90 days" => timeframe rule with 90 days, no amount', () => {
  const rules = parseRestrictionPhrases('Funds must be spent within 90 days of disbursement.')
  const tf = rules.find((r) => r.restriction_type === 'timeframe')
  assert.ok(tf)
  assert.equal(tf.spend_by_days, 90)
  assert.equal(tf.required_amount_cents, null)
})

test('parser: NEVER invents a number — category with no dollar figure yields no required amount', () => {
  const rules = parseRestrictionPhrases('This award may only be used for tuition.')
  // Should produce an allowed_use rule, but with NO fabricated amount.
  assert.ok(rules.every((r) => r.restriction_type !== 'category_exact'))
  const use = rules.find((r) => r.restriction_type === 'allowed_use')
  assert.ok(use)
  assert.equal(use.required_amount_cents, null)
})

test('parser: free text with no restriction phrases yields nothing', () => {
  const rules = parseRestrictionPhrases('Congratulations on your award! We look forward to working with you.')
  assert.equal(rules.length, 0)
})

test('deriveDraftRulesFromGrant: reads multiple grant fields and de-dupes', () => {
  const grant = {
    amount_description: '$500 must be spent on supplies.',
    eligibility: 'Funds must be spent within 60 days of disbursement.',
    notes: '$500 must be spent on supplies.', // duplicate of the first
  }
  const rules = deriveDraftRulesFromGrant(grant)
  const supplies = rules.filter((r) => r.category === 'supplies' && r.required_amount_cents === 50000)
  assert.equal(supplies.length, 1, 'duplicate supplies rule should be collapsed')
  assert.ok(rules.some((r) => r.restriction_type === 'timeframe' && r.spend_by_days === 60))
})

// ---------------------------------------------------------------------------
// Store round-trip (db-backed)
// ---------------------------------------------------------------------------
test('store: createRule + addSpendEntry + computeComplianceSummary progresses short -> met', async () => {
  const db = freshDb()
  const rule = await createRule(db, {
    profileId: 'p1',
    grantId: 'g1',
    title: '$500 on supplies',
    totalAmountCents: 100000,
    restrictionType: 'category_minimum',
    category: 'supplies',
    requiredAmountCents: 50000,
  })
  assert.ok(rule.id)

  let s = await computeComplianceSummary(db, rule)
  assert.equal(s.status, 'short')
  assert.equal(s.spent_cents, 0)

  await addSpendEntry(db, { ruleId: rule.id, amountCents: 20000, memo: 'partial' })
  s = await computeComplianceSummary(db, rule)
  assert.equal(s.status, 'short')
  assert.equal(s.spent_cents, 20000)

  await addSpendEntry(db, { ruleId: rule.id, amountCents: 30000, proofDocumentId: 'doc-123' })
  s = await computeComplianceSummary(db, rule)
  assert.equal(s.status, 'met')
  assert.equal(s.spent_cents, 50000)
  assert.equal(s.remaining_cents, 0)
})

test('store: addSpendEntry rejects non-positive amounts', async () => {
  const db = freshDb()
  const rule = await createRule(db, { profileId: 'p1', title: 'x', restrictionType: 'other' })
  await assert.rejects(() => addSpendEntry(db, { ruleId: rule.id, amountCents: 0 }))
  await assert.rejects(() => addSpendEntry(db, { ruleId: rule.id, amountCents: -100 }))
})

test('store: deriveDraftRulesForGrant is idempotent (no duplicate draft rules)', async () => {
  const db = freshDb()
  const grant = {
    id: 'g2',
    profile_id: 'p2',
    amount_awarded: 1000,
    amount_description: '$500 must be spent on supplies.',
  }
  const first = await deriveDraftRulesForGrant(db, grant)
  assert.equal(first.length, 1)
  assert.equal(first[0].is_draft, true)
  assert.equal(first[0].required_amount_cents, 50000)
  // total derived from amount_awarded (1000 dollars => 100000 cents)
  assert.equal(first[0].total_amount_cents, 100000)

  const second = await deriveDraftRulesForGrant(db, grant)
  assert.equal(second.length, 0, 're-derive should create nothing new')
})

test('scan: surfaces overdue + short award findings for the agents', async () => {
  const db = freshDb()
  // Short rule.
  await createRule(db, {
    profileId: 'p3', title: 'supplies min', restrictionType: 'category_minimum',
    category: 'supplies', requiredAmountCents: 50000,
  })
  // Overdue rule (past due, unmet).
  await createRule(db, {
    profileId: 'p3', title: 'spend by deadline', restrictionType: 'timeframe',
    requiredAmountCents: 100000, spendByDate: '2026-01-01T00:00:00Z',
  })

  const res = await scanAwardComplianceFindings(db, { now: new Date('2026-06-20T00:00:00Z') })
  assert.equal(res.ok, true)
  assert.ok(res.findings.length >= 2)
  assert.ok(res.findings.some((f) => f.title.includes('OVERDUE')))
  assert.ok(res.findings.some((f) => f.title.includes('SHORT')))
})

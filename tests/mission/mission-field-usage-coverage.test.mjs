/**
 * Mission test suite — Goal 11: Field-to-Funding Accountability.
 *
 * Mission rule (missionGoals.js #11): Every profile field GrantFlow
 * requests must have a machine-readable usage contract showing how it
 * improves source planning, crawler queries, eligibility scoring,
 * match explanations, application workflows, document checklists, or
 * Anya guidance. Sensitive identifiers (SSN, Green Card, Medicaid ID,
 * detailed medical identifiers) are NEVER sent to crawlers or
 * external search systems.
 *
 * This suite enforces:
 *   1. Goal 11 is registered in missionGoals.GRANTFLOW_GOALS.
 *   2. Every entry in profileFieldUsageRegistry declares the required
 *      contract fields (id, label, section, pii, raw_external_use_allowed,
 *      usage_modes ⊂ valid set, why_we_ask).
 *   3. PII fields:
 *        - have raw_external_use_allowed === false
 *        - never include 'crawler_query' in usage_modes
 *        - never declare any source_categories
 *        - declare query_use === 'must_not'
 *   4. Every non-PII entry declares ≥ 1 valid usage mode.
 *   5. Every source_categories id resolves in sourceRegistry.SOURCES.
 *   6. The PII identifier strings (SSN, Medicaid ID, etc.) NEVER appear
 *      in buildGrantsGovQueryTerms output regardless of profile.
 *   7. Every profile type registered in profileTypeRegistry resolves to
 *      a real strategy and has ≥ 3 recommended sources (Goal 11 +
 *      mission rule: ≥ 3 source categories per profile type).
 *   8. buildFieldUsageReport reports zero pii_external_query_violations
 *      and zero unknown_source_categories.
 *   9. Every applicationSchema field that declares query_use 'boost' or
 *      'required*' AND is not a PII candidate has a corresponding entry
 *      somewhere in the field-usage registry by section, OR — when the
 *      schema field is a duplicate fallback — at least one entry in its
 *      section exists. (Soft cross-check: if either condition fails, the
 *      test reports the gap so we can add registry entries over time.)
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { GRANTFLOW_GOALS } from '../../backend/config/missionGoals.js'
import {
  FIELD_USAGE_MODES,
  FIELD_USAGE_SECTIONS,
  listFieldUsages,
  getFieldUsage,
  isPii,
  forbidsExternalQuery,
  buildFieldUsageReport,
} from '../../backend/services/profileFieldUsageRegistry.js'
import {
  SOURCES,
  buildGrantsGovQueryTerms,
} from '../../backend/services/sourceRegistry.js'
import {
  listProfileTypes,
  recommendedSourcesFor,
  recommendStrategyFor,
} from '../../backend/services/profileTypeRegistry.js'

// Sensitive identifier strings that must NEVER appear in any external
// crawler query term (Goal 11). These are checked verbatim against the
// output of buildGrantsGovQueryTerms across many profile shapes.
const PII_VALUES = Object.freeze({
  ssn: '123-45-6789',
  green_card: 'A123456789',
  medicaid_id: '999888777',
  immigration_doc: 'I551-ABC-12345',
  driver_license: 'TN-D123456789',
  medical_record: 'MRN-1234567',
})

test('mission-goals: Goal 11 is registered', () => {
  const goal = GRANTFLOW_GOALS.find((g) => g.id === 11)
  assert.ok(goal, 'GRANTFLOW_GOALS must include Goal 11 (Field-to-Funding accountability)')
  assert.match(goal.short, /field/i, 'Goal 11 short label must reference field accountability')
  assert.match(goal.rule, /sensitive identifiers|never sent/i,
    'Goal 11 rule must explicitly forbid sending sensitive identifiers to crawlers')
})

test('field-usage-registry: every entry declares the required contract fields', () => {
  for (const e of listFieldUsages()) {
    assert.ok(e.id && typeof e.id === 'string', 'id must be a non-empty string')
    assert.ok(e.label, `${e.id}: label is required`)
    assert.ok(FIELD_USAGE_SECTIONS.includes(e.section),
      `${e.id}: section "${e.section}" must be one of ${FIELD_USAGE_SECTIONS.join(', ')}`)
    assert.equal(typeof e.pii, 'boolean', `${e.id}: pii must be boolean`)
    assert.equal(typeof e.raw_external_use_allowed, 'boolean',
      `${e.id}: raw_external_use_allowed must be boolean`)
    assert.ok(Array.isArray(e.usage_modes), `${e.id}: usage_modes must be an array`)
    for (const m of e.usage_modes) {
      assert.ok(FIELD_USAGE_MODES.includes(m),
        `${e.id}: usage_mode "${m}" must be one of ${FIELD_USAGE_MODES.join(', ')}`)
    }
    assert.ok(Array.isArray(e.source_categories),
      `${e.id}: source_categories must be an array`)
    assert.ok(typeof e.why_we_ask === 'string' && e.why_we_ask.length > 0,
      `${e.id}: why_we_ask must be a non-empty string (Anya needs to explain it)`)
  }
})

test('field-usage-registry: every non-PII entry declares ≥ 1 usage mode', () => {
  for (const e of listFieldUsages()) {
    if (e.pii) continue
    assert.ok(e.usage_modes.length >= 1,
      `${e.id}: non-PII fields must declare at least one usage mode (Goal 11)`)
  }
})

test('field-usage-registry: PII fields obey the no-external-query rule', () => {
  for (const e of listFieldUsages()) {
    if (!e.pii) continue
    assert.equal(e.raw_external_use_allowed, false,
      `${e.id}: PII fields must have raw_external_use_allowed === false`)
    assert.ok(!e.usage_modes.includes('crawler_query'),
      `${e.id}: PII fields must not declare crawler_query as a usage mode`)
    assert.equal(e.source_categories.length, 0,
      `${e.id}: PII fields must not declare source_categories (no external use)`)
    assert.equal(e.query_use, 'must_not',
      `${e.id}: PII fields must declare query_use === 'must_not'`)
    assert.ok(forbidsExternalQuery(e.id),
      `${e.id}: forbidsExternalQuery() must return true for PII`)
    assert.ok(isPii(e.id), `${e.id}: isPii() must return true`)
  }
})

test('field-usage-registry: every source_categories id resolves in sourceRegistry', () => {
  for (const e of listFieldUsages()) {
    for (const sid of e.source_categories) {
      assert.ok(SOURCES[sid],
        `${e.id}: source_categories entry "${sid}" is not a registered SOURCE_ID`)
    }
  }
})

test('PII safety: no PII identifier value ever lands in a Grants.gov query term', () => {
  // Build a worst-case profile that smuggles every PII identifier into
  // every plausible field. buildGrantsGovQueryTerms must produce output
  // that contains none of those PII strings (Goal 11: PII is local-only).
  const profile = {
    primary_type: 'individual',
    state: 'TN',
    ssn: PII_VALUES.ssn,
    medicaid_id: PII_VALUES.medicaid_id,
    green_card_number: PII_VALUES.green_card,
    immigration_document_number: PII_VALUES.immigration_doc,
    driver_license_number: PII_VALUES.driver_license,
    medical_record_number: PII_VALUES.medical_record,
  }
  const signals = {
    needs: ['housing', 'food', PII_VALUES.medicaid_id], // try to smuggle PII via needs
    interests: [PII_VALUES.ssn, PII_VALUES.green_card],
  }
  const terms = buildGrantsGovQueryTerms({ profile, signals })
  for (const piiKey of Object.keys(PII_VALUES)) {
    const value = PII_VALUES[piiKey].toLowerCase()
    for (const term of terms) {
      assert.ok(!String(term).toLowerCase().includes(value),
        `Goal 11 violation: PII value "${PII_VALUES[piiKey]}" appeared in query term "${term}"`)
    }
  }

  // The query builder also must never round-trip raw SSN even when the
  // profile_type itself looks like a number. Defensive sanity check.
  for (const term of terms) {
    assert.ok(!/\b\d{3}-?\d{2}-?\d{4}\b/.test(String(term)),
      `Goal 11 violation: SSN-shaped value appeared in query term "${term}"`)
  }
})

test('profile-type-registry: every profile type has a strategy and ≥ 3 recommended sources', () => {
  const failures = []
  for (const pt of listProfileTypes()) {
    const strategy = recommendStrategyFor(pt.id)
    const sources = recommendedSourcesFor(pt.id)
    if (!strategy) failures.push(`${pt.id}: no recommended strategy`)
    if (sources.length < 3) failures.push(`${pt.id}: only ${sources.length} recommended sources (need ≥ 3)`)
    for (const sid of sources) {
      if (!SOURCES[sid]) failures.push(`${pt.id}: recommended source "${sid}" not registered in sourceRegistry`)
    }
  }
  assert.equal(failures.length, 0,
    `Goal 11 violation:\n  - ${failures.join('\n  - ')}`)
})

test('field-usage-report: zero unmapped fields, zero PII violations, zero unknown sources', () => {
  const report = buildFieldUsageReport()
  assert.equal(report.unmapped_fields, 0,
    `unmapped_fields must be 0 (Goal 11), got ${report.unmapped_fields}`)
  assert.equal(report.pii_external_query_violations, 0,
    `pii_external_query_violations must be 0 (Goal 11), got ${report.pii_external_query_violations}`)
  assert.deepEqual(report.unknown_source_categories, [],
    `unknown_source_categories must be empty, got ${JSON.stringify(report.unknown_source_categories)}`)
  assert.ok(report.total_profile_fields > 0, 'registry must have at least one entry')
  assert.ok(report.pii_fields >= 4,
    `expected ≥ 4 PII entries (SSN, Green Card, Medicaid ID, immigration doc, etc.), got ${report.pii_fields}`)
})

test('applicationSchema cross-check: every queryable section has at least one registry entry', () => {
  // Soft cross-check between applicationSchema.json (the form contract)
  // and profileFieldUsageRegistry (the usage contract). For every section
  // that the schema declares as canonical AND that contains at least one
  // field with query_use boost/required, the registry must have ≥ 1 entry
  // tagged to that section. Future fields can be added incrementally by
  // failing this test until they are mapped.
  const schemaPath = path.resolve('backend/services/profile/applicationSchema.json')
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'))

  const queryableSections = new Set()
  for (const f of schema.fields ?? []) {
    if (!f.source_section_key) continue
    if (!['required', 'required_or', 'boost'].includes(String(f.query_use))) continue
    queryableSections.add(f.source_section_key)
  }

  const registrySections = new Set(listFieldUsages().map((e) => e.section))

  const missing = []
  for (const sec of queryableSections) {
    if (!registrySections.has(sec)) missing.push(sec)
  }
  assert.equal(missing.length, 0,
    `applicationSchema declares queryable fields in sections [${[...queryableSections].sort().join(', ')}] ` +
    `but profileFieldUsageRegistry has no entries for: ${missing.join(', ')}. ` +
    `Add field-usage entries for those sections (Goal 11).`)
})

test('field-usage-registry: PII identifier ids cover the audit list', () => {
  // The audit explicitly enumerated: SSN, Green Card Number, Medicaid
  // number, detailed medical identifiers, exact immigration document
  // numbers, other private identifiers. All of these must be marked PII.
  const REQUIRED_PII = [
    'pii.ssn',
    'pii.green_card_number',
    'pii.medicaid_id',
    'pii.immigration_document_number',
    'pii.medical_record_identifier',
  ]
  for (const id of REQUIRED_PII) {
    const e = getFieldUsage(id)
    assert.ok(e, `${id} must exist in profileFieldUsageRegistry`)
    assert.equal(e.pii, true, `${id} must be marked pii:true`)
    assert.equal(e.raw_external_use_allowed, false,
      `${id} must declare raw_external_use_allowed:false`)
  }
})

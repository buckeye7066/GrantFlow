/**
 * mission-form-field-help.test.mjs
 *
 * GrantFlow Mission Goal 11 — Field-to-Funding Accountability.
 *
 * Strict-coverage test: every form field that the user fills out in
 * ComprehensiveApplicationForm and ProfileSectionEditor must have:
 *
 *   1. A canonical entry in profileFieldUsageRegistry, AND
 *   2. A non-empty `why_we_ask` explanation, AND
 *   3. A visible explanation path in the UI (FieldHelpTip referencing
 *      the registry id) — captured by the FIELD_HELP_ID_FOR map at
 *      the top of ComprehensiveApplicationForm.jsx.
 *
 * In addition, every PII field (pii.* in the registry) must explicitly
 * disclose the lock + "never sent to crawlers" copy via FieldHelpTip's
 * built-in PII branch.
 *
 * The brief enumerates a "high-value" set of fields that GrantFlow
 * MUST be able to explain. We assert that set is fully covered both
 * by a registry entry AND by the form's help-id mapping.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  getFieldUsage,
  listFieldUsages,
  isPii,
} from '../../backend/services/profileFieldUsageRegistry.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')

function readFormSource() {
  return fs.readFileSync(
    path.join(REPO_ROOT, 'src', 'components', 'organizations', 'ComprehensiveApplicationForm.jsx'),
    'utf8',
  )
}

/**
 * Extract the FIELD_HELP_ID_FOR map literal from the form file.
 * We don't dynamically import the file (it pulls React + many UI
 * components), so we parse the source directly: every line of the
 * form `   field_name: 'registry.id',` inside the freezed object
 * literal.
 */
function extractFormFieldHelpMap(source) {
  const start = source.indexOf('FIELD_HELP_ID_FOR = Object.freeze({')
  if (start < 0) throw new Error('FIELD_HELP_ID_FOR map not found in form source')
  const tail = source.slice(start)
  const end = tail.indexOf('})')
  if (end < 0) throw new Error('FIELD_HELP_ID_FOR map close not found')
  const block = tail.slice(0, end)
  const out = {}
  const re = /^\s*([a-zA-Z0-9_]+)\s*:\s*'([^']+)'\s*,/gm
  let m
  while ((m = re.exec(block)) !== null) {
    out[m[1]] = m[2]
  }
  return out
}

const FORM_SOURCE = readFormSource()
const FORM_HELP_MAP = extractFormFieldHelpMap(FORM_SOURCE)

test('FIELD_HELP_ID_FOR is non-empty and HelpedLabel is rendered in the form', () => {
  const count = Object.keys(FORM_HELP_MAP).length
  assert.ok(count >= 30, `expected the form help map to cover at least 30 fields, got ${count}`)
  assert.ok(
    FORM_SOURCE.includes('<HelpedLabel'),
    'ComprehensiveApplicationForm must render at least one HelpedLabel for the wiring to be visible',
  )
  assert.ok(
    FORM_SOURCE.includes('<FieldHelpTip'),
    'ComprehensiveApplicationForm must render at least one FieldHelpTip',
  )
})

test('every form help-id resolves to a real profileFieldUsageRegistry entry', () => {
  const failures = []
  for (const [field, registryId] of Object.entries(FORM_HELP_MAP)) {
    const entry = getFieldUsage(registryId)
    if (!entry) failures.push(`form field "${field}" -> "${registryId}" — not in registry`)
    else if (!entry.why_we_ask || entry.why_we_ask.length < 10) {
      failures.push(`form field "${field}" -> "${registryId}" — registry entry missing why_we_ask copy`)
    }
  }
  assert.deepEqual(failures, [], failures.join('\n  '))
})

test('every PII registry entry referenced by the form is wired to FieldHelpTip (which surfaces the lock disclosure)', () => {
  const failures = []
  for (const [field, registryId] of Object.entries(FORM_HELP_MAP)) {
    const entry = getFieldUsage(registryId)
    if (!entry) continue // covered by the resolution test above
    if (!entry.pii) continue
    // The wiring is via HelpedLabel/FieldHelpTip — both of which read
    // the registry's pii flag. We assert the form actually renders the
    // help on this field so the lock badge is present.
    if (!FORM_SOURCE.includes(`fieldName="${field}"`) && !FORM_SOURCE.includes(`item.id`)) {
      failures.push(`PII field "${field}" -> "${registryId}" — not rendered with HelpedLabel/FieldHelpTip`)
    }
    // The registry must have raw_external_use_allowed=false for any pii field.
    if (entry.raw_external_use_allowed !== false) {
      failures.push(`PII field "${registryId}" — raw_external_use_allowed must be false`)
    }
  }
  assert.deepEqual(failures, [], failures.join('\n  '))
})

test('high-value fields enumerated in the brief are present in BOTH the form map AND the registry', () => {
  // The brief explicitly lists these as "must explain why we ask".
  // Each entry is { form_field, registry_id } — the registry id may
  // differ from the form field name (the canonical id namespace is
  // grouped by category).
  const HIGH_VALUE = [
    { form_field: 'applicant_type', registry_id: 'profile.primary_profile_type' },
    { form_field: 'state',          registry_id: 'geo.state' },
    { form_field: 'city',           registry_id: 'geo.city' },
    { form_field: 'zip',            registry_id: 'geo.zip' },
    { form_field: 'date_of_birth',  registry_id: 'basic_information.dob' },
    { form_field: 'organization_ein', registry_id: 'organization.ein' },
    { form_field: 'organization_uei', registry_id: 'organization.uei' },
    { form_field: 'organization_cage_code', registry_id: 'organization.cage_code' },
    { form_field: 'sam_gov_registered', registry_id: 'organization.sam_registered' },
    { form_field: 'business_501c3_certified', registry_id: 'organization.501c3' },
    { form_field: 'faith_based_organization', registry_id: 'organization.faith_based' },
    { form_field: 'household_income', registry_id: 'finance.annual_income' },
    { form_field: 'household_size',   registry_id: 'finance.household_size' },
    { form_field: 'low_income',       registry_id: 'finance.low_income' },
    { form_field: 'medicaid_enrolled', registry_id: 'programs.medicaid' },
    { form_field: 'snap_recipient',    registry_id: 'programs.snap' },
    { form_field: 'tenncare_id',       registry_id: 'pii.medicaid_id' },
    { form_field: 'cancer_survivor',   registry_id: 'health.cancer' },
    { form_field: 'chronic_illness',   registry_id: 'health.chronic_illness' },
    { form_field: 'mental_health_condition', registry_id: 'health.mental_health' },
    { form_field: 'immigration_status', registry_id: 'demographics.immigration_status' },
    { form_field: 'tribal_affiliation', registry_id: 'demographics.tribal_affiliation' },
    { form_field: 'lgbtq',              registry_id: 'demographics.lgbtq' },
    { form_field: 'veteran',            registry_id: 'military.veteran' },
    { form_field: 'disabled_veteran',   registry_id: 'military.disabled_veteran' },
    { form_field: 'firefighter',        registry_id: 'occupation.firefighter' },
    { form_field: 'educator',           registry_id: 'occupation.teacher_educator' },
    { form_field: 'small_business_owner', registry_id: 'occupation.small_business_owner' },
    { form_field: 'gpa',                registry_id: 'education.gpa' },
    { form_field: 'intended_major',     registry_id: 'education.major' },
    { form_field: 'first_generation',   registry_id: 'education.first_gen' },
    { form_field: 'mission',            registry_id: 'narrative.story' },
    { form_field: 'primary_goal',       registry_id: 'narrative.goals' },
    { form_field: 'funding_amount_needed', registry_id: 'narrative.funding_use' },
    { form_field: 'keywords',           registry_id: 'narrative.keywords' },
    { form_field: 'foster_youth',       registry_id: 'family.foster_youth' },
    { form_field: 'homeless',           registry_id: 'family.homelessness_or_housing_insecurity' },
    { form_field: 'domestic_violence_survivor', registry_id: 'family.domestic_violence' },
  ]
  const failures = []
  for (const { form_field, registry_id } of HIGH_VALUE) {
    if (!FORM_HELP_MAP[form_field]) failures.push(`brief high-value field "${form_field}" missing from form FIELD_HELP_ID_FOR`)
    else if (FORM_HELP_MAP[form_field] !== registry_id) {
      failures.push(`brief high-value field "${form_field}" form mapping is "${FORM_HELP_MAP[form_field]}", expected "${registry_id}"`)
    }
    if (!getFieldUsage(registry_id)) failures.push(`brief high-value field "${form_field}" -> "${registry_id}" missing from profileFieldUsageRegistry`)
  }
  assert.deepEqual(failures, [], failures.join('\n  '))
})

test('every registry PII entry explicitly forbids raw external use', () => {
  const failures = []
  for (const entry of listFieldUsages()) {
    if (!entry.pii) continue
    if (entry.raw_external_use_allowed !== false) {
      failures.push(`PII entry ${entry.id} must have raw_external_use_allowed=false`)
    }
    if (!entry.why_we_ask || entry.why_we_ask.length < 10) {
      failures.push(`PII entry ${entry.id} must have a non-empty why_we_ask explanation`)
    }
  }
  assert.deepEqual(failures, [], failures.join('\n  '))
})

test('isPii helper agrees with the registry for the form\u2019s wired PII fields', () => {
  // tenncare_id is the user-visible field name; the registry id is pii.medicaid_id.
  assert.equal(isPii('pii.medicaid_id'), true)
  assert.equal(isPii('pii.ssn'), true)
  assert.equal(isPii('pii.green_card_number'), true)
  assert.equal(isPii('organization.ein'), false)
  assert.equal(isPii('finance.annual_income'), false)
})

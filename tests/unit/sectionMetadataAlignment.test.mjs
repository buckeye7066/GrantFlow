/**
 * Alignment tests for sectionMetadata.js
 *
 * Ensures that SECTION_METADATA stays in sync with:
 *   - backend/config/profileSchema.js (PROFILE_SCHEMA)
 *
 * These tests guard against onboarding/help drift (GF-AUDIT-021) and
 * UI/domain coupling (GF-AUDIT-022).
 *
 * Note: ProfileSectionEditor.jsx (SECTION_CONFIG) cannot be imported here
 * because it has React dependencies. Alignment with SECTION_CONFIG is
 * enforced structurally: the SECTION_CONFIG module *derives* its titles and
 * descriptions from SECTION_METADATA at module load time, so they cannot drift.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SECTION_METADATA,
  SECTION_KEYS,
  getSectionTitle,
  getSectionDescription,
  getSectionFields,
  getFieldHelp,
} from '../../src/config/sectionMetadata.js'

import { PROFILE_SCHEMA, supportedSectionKeys } from '../../backend/config/profileSchema.js'

// ── SECTION_METADATA structure ────────────────────────────────────────────

test('SECTION_METADATA is a non-empty object', () => {
  assert.ok(SECTION_METADATA && typeof SECTION_METADATA === 'object')
  assert.ok(Object.keys(SECTION_METADATA).length > 0)
})

test('SECTION_KEYS matches Object.keys(SECTION_METADATA)', () => {
  assert.deepEqual(SECTION_KEYS, Object.keys(SECTION_METADATA))
})

test('every SECTION_METADATA entry has a non-empty title', () => {
  for (const [key, meta] of Object.entries(SECTION_METADATA)) {
    assert.ok(
      typeof meta.title === 'string' && meta.title.trim().length > 0,
      `Section "${key}" has an empty or missing title`,
    )
  }
})

test('every SECTION_METADATA entry has a non-empty description', () => {
  for (const [key, meta] of Object.entries(SECTION_METADATA)) {
    assert.ok(
      typeof meta.description === 'string' && meta.description.trim().length > 0,
      `Section "${key}" has an empty or missing description`,
    )
  }
})

test('every SECTION_METADATA entry has a fields array', () => {
  for (const [key, meta] of Object.entries(SECTION_METADATA)) {
    assert.ok(
      Array.isArray(meta.fields),
      `Section "${key}" is missing a fields array`,
    )
  }
})

test('every field in SECTION_METADATA has a name and label', () => {
  for (const [sectionKey, meta] of Object.entries(SECTION_METADATA)) {
    for (const field of meta.fields) {
      assert.ok(
        typeof field.name === 'string' && field.name.trim().length > 0,
        `Section "${sectionKey}" has a field missing a name`,
      )
      assert.ok(
        typeof field.label === 'string' && field.label.trim().length > 0,
        `Section "${sectionKey}", field "${field.name}" has an empty or missing label`,
      )
    }
  }
})

// ── Test 3: All PROFILE_SCHEMA section keys exist in SECTION_METADATA ────

test('all PROFILE_SCHEMA section keys exist in SECTION_METADATA', () => {
  for (const key of Object.keys(PROFILE_SCHEMA)) {
    assert.ok(
      key in SECTION_METADATA,
      `PROFILE_SCHEMA section "${key}" is missing from SECTION_METADATA`,
    )
  }
})

test('supportedSectionKeys (backend) are all present in SECTION_METADATA', () => {
  for (const key of supportedSectionKeys) {
    assert.ok(
      key in SECTION_METADATA,
      `Backend supportedSectionKey "${key}" is not in SECTION_METADATA`,
    )
  }
})

// ── Test 4: No SECTION_METADATA entries are orphaned vs PROFILE_SCHEMA ────

test('all SECTION_METADATA keys exist in PROFILE_SCHEMA (no orphaned frontend sections)', () => {
  for (const key of SECTION_KEYS) {
    assert.ok(
      key in PROFILE_SCHEMA,
      `SECTION_METADATA section "${key}" has no corresponding entry in PROFILE_SCHEMA`,
    )
  }
})

// ── Test 5: applies_to alignment ─────────────────────────────────────────

test('applies_to in SECTION_METADATA matches applies_to in PROFILE_SCHEMA where both define it', () => {
  for (const key of SECTION_KEYS) {
    const frontendAppliesTo = SECTION_METADATA[key].applies_to
    const backendAppliesTo = PROFILE_SCHEMA[key]?.applies_to

    if (frontendAppliesTo && backendAppliesTo) {
      assert.deepEqual(
        [...frontendAppliesTo].sort(),
        [...backendAppliesTo].sort(),
        `applies_to mismatch for section "${key}"`,
      )
    }
  }
})

// ── Helper function tests ─────────────────────────────────────────────────

test('getSectionTitle returns title for a known key', () => {
  assert.equal(getSectionTitle('basic_information'), 'Basic Information')
  assert.equal(getSectionTitle('narrative'), 'Story & Goals')
  assert.equal(getSectionTitle('military_service'), 'Military Status')
})

test('getSectionTitle returns formatted key for an unknown key', () => {
  assert.equal(getSectionTitle('some_unknown_section'), 'some unknown section')
})

test('getSectionDescription returns description for a known key', () => {
  const desc = getSectionDescription('health_medical')
  assert.ok(typeof desc === 'string' && desc.length > 0)
})

test('getSectionDescription returns empty string for an unknown key', () => {
  assert.equal(getSectionDescription('nonexistent_key'), '')
})

test('getSectionFields returns fields array for a known key', () => {
  const fields = getSectionFields('demographics')
  assert.ok(Array.isArray(fields))
  assert.ok(fields.length > 0)
  assert.ok(fields.every((f) => f.name && f.label))
})

test('getSectionFields returns empty array for an unknown key', () => {
  assert.deepEqual(getSectionFields('unknown_key'), [])
})

test('getFieldHelp returns help text for a known field', () => {
  const help = getFieldHelp('basic_information', 'full_name')
  assert.ok(typeof help === 'string' && help.length > 0)
})

test('getFieldHelp returns empty string for an unknown field', () => {
  assert.equal(getFieldHelp('basic_information', 'nonexistent_field'), '')
})

test('getFieldHelp returns empty string for an unknown section', () => {
  assert.equal(getFieldHelp('unknown_section', 'full_name'), '')
})

// ─────────────────────────────────────────────────────────────────────────────
// One question, one field (owner order 2026-09-08) + the boolean-format trap.
// ─────────────────────────────────────────────────────────────────────────────
import {
  PROFILE_FIELD_MIRROR_RULES,
  mirrorTargets,
} from '../../shared/profileFieldMirrors.js'

const metaField = (sectionKey, name) => (SECTION_METADATA[sectionKey]?.fields ?? []).find((f) => f.name === name)

test('every PROFILE_SCHEMA boolean field is declared boolean_tri in SECTION_METADATA (the guard rejects a Switch value on format text)', () => {
  const bad = []
  for (const [sectionKey, section] of Object.entries(PROFILE_SCHEMA)) {
    for (const [name, meta] of Object.entries(section?.fields ?? {})) {
      if (!meta || typeof meta !== 'object' || meta.type !== 'boolean') continue
      const f = metaField(sectionKey, name)
      if (!f) bad.push(`${sectionKey}.${name}:missing`)
      else if (f.format !== 'boolean_tri') bad.push(`${sectionKey}.${name}:${f.format}`)
    }
  }
  assert.deepEqual(bad, [])
})

test('every mirror target is a deprecated (hidden) field and every mirror source is live', () => {
  const targetsNotHidden = mirrorTargets().filter((id) => {
    const [s, n] = id.split('.')
    return !metaField(s, n)?.deprecated
  })
  assert.deepEqual(targetsNotHidden, [])
  const sourcesNotLive = []
  for (const rule of PROFILE_FIELD_MIRROR_RULES) {
    for (const [s, n] of rule.sources) {
      const f = metaField(s, n)
      if (!f || f.deprecated) sourcesNotLive.push(`${s}.${n}`)
    }
  }
  assert.deepEqual(sourcesNotLive, [])
})

test('a deprecated field is either fed by a mirror rule or on the explicit no-mirror list', () => {
  // Fields hidden from the form whose value is derived by something OTHER than
  // a mirror rule, or is a legacy intake mirror with no canonical twin.
  const NO_MIRROR_ALLOWED = new Set([
    'basic_information.first_name', // deriveNamePartsIntoBasicInfo (full_name)
    'basic_information.middle_name',
    'basic_information.last_name',
    'basic_information.location', // legacy quick-intake blob
    'basic_information.keywords', // programs_services.keywords is canonical (intake mirror)
    'basic_information.interests',
    'basic_information.profile_type', // profiles.primary_type column is canonical
    // household variants: "you or someone in your household" is the ONE question now
    'government_assistance.medicaid_recipient_household',
    'government_assistance.medicare_recipient_household',
    'government_assistance.ssi_recipient_household',
    'government_assistance.ssdi_recipient_household',
    'government_assistance.snap_recipient_household',
    'government_assistance.tanf_recipient_household',
    'government_assistance.section8_recipient_household',
  ])
  const targets = new Set(mirrorTargets())
  const orphans = []
  for (const [sectionKey, section] of Object.entries(SECTION_METADATA)) {
    for (const f of section.fields ?? []) {
      if (!f.deprecated) continue
      const id = `${sectionKey}.${f.name}`
      if (!targets.has(id) && !NO_MIRROR_ALLOWED.has(id)) orphans.push(id)
    }
  }
  assert.deepEqual(orphans, [])
})

test('the credit score is a real, bounded, answerable field in Financial information', () => {
  const f = metaField('financial_information', 'credit_score')
  assert.ok(f, 'financial_information.credit_score declared')
  assert.equal(f.integer, true)
  assert.equal(f.min, 300)
  assert.equal(f.max, 850)
  assert.ok(!f.deprecated)
  assert.ok(PROFILE_SCHEMA.financial_information.fields.credit_score, 'declared in PROFILE_SCHEMA too')
  assert.equal(metaField('demographics', 'good_credit_score')?.deprecated, true, 'the 700+ toggle is derived, not asked')
})

test('no two LIVE questions that can face the same profile type share a label', () => {
  const normalize = (label) => String(label || '').toLowerCase().replace(/\s*\(.*?\)\s*/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()
  const GENERIC = new Set(['notes', 'status', 'type', 'applications', 'goals'])
  const audience = (section, f) => {
    const list = f.applies_to ?? section.applies_to
    return Array.isArray(list) && list.length > 0 ? new Set(list) : null // null = every type
  }
  const overlap = (a, b) => !a || !b || [...a].some((type) => b.has(type))
  const byLabel = new Map()
  for (const [sectionKey, section] of Object.entries(SECTION_METADATA)) {
    for (const f of section.fields ?? []) {
      if (f.deprecated) continue
      const key = normalize(f.label)
      if (!key || GENERIC.has(key)) continue
      if (!byLabel.has(key)) byLabel.set(key, [])
      byLabel.get(key).push({ id: `${sectionKey}.${f.name}`, sectionKey, audience: audience(section, f) })
    }
  }
  const duplicates = []
  for (const [label, entries] of byLabel) {
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        const a = entries[i]
        const b = entries[j]
        if (a.sectionKey !== b.sectionKey && overlap(a.audience, b.audience)) duplicates.push([label, a.id, b.id])
      }
    }
  }
  assert.deepEqual(duplicates, [])
})

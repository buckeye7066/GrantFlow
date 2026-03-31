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

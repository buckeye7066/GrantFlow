/**
 * fieldDisplay.test.mjs
 *
 * Locks in the hardened renderer behavior that eliminated the
 * `[fieldDisplay] Missing or invalid SECTION_METADATA … format text cannot
 * render object Object` warnings that had returned across multiple prior
 * fix attempts.
 *
 * The renderer must:
 *  - Render arrays (current schema shape) for the three list fields cleanly.
 *  - Render legacy comma-separated strings cleanly.
 *  - Render legacy plain-object shapes ({0:"a",1:"b"}) cleanly.
 *  - Never log "[fieldDisplay] Missing or invalid SECTION_METADATA" for those
 *    inputs, even in strict-profile-metadata mode.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { formatFieldValue } from '../../src/utils/fieldDisplay.js'

function captureWarnings(fn) {
  const original = console.warn
  const warnings = []
  console.warn = (...args) => warnings.push(args.map((a) => (typeof a === 'string' ? a : '')).join(' '))
  try {
    const result = fn()
    return { result, warnings }
  } finally {
    console.warn = original
  }
}

test('housing.geographic_designation: array renders as comma-separated list', () => {
  const { result, warnings } = captureWarnings(() =>
    formatFieldValue('housing', 'geographic_designation', ['rural', 'frontier']),
  )
  assert.equal(result, 'rural, frontier')
  assert.equal(
    warnings.filter((w) => w.startsWith('[fieldDisplay] Missing or invalid SECTION_METADATA')).length,
    0,
    'no fieldDisplay metadata warnings should be emitted',
  )
})

test('housing.geographic_designation: empty array renders as em dash without warnings', () => {
  const { result, warnings } = captureWarnings(() =>
    formatFieldValue('housing', 'geographic_designation', []),
  )
  assert.equal(result, '—')
  assert.equal(warnings.filter((w) => w.includes('[fieldDisplay]')).length, 0)
})

test('housing.geographic_designation: legacy comma string renders cleanly', () => {
  const { result, warnings } = captureWarnings(() =>
    formatFieldValue('housing', 'geographic_designation', 'rural, urban'),
  )
  assert.equal(result, 'rural, urban')
  assert.equal(warnings.filter((w) => w.includes('[fieldDisplay]')).length, 0)
})

test('housing.geographic_designation: legacy object shape renders cleanly', () => {
  const { result, warnings } = captureWarnings(() =>
    formatFieldValue('housing', 'geographic_designation', { 0: 'rural', 1: 'urban' }),
  )
  assert.equal(result, 'rural, urban')
  assert.equal(
    warnings.filter((w) => w.startsWith('[fieldDisplay] Missing or invalid SECTION_METADATA')).length,
    0,
    'object-shaped legacy values must not trigger the metadata warning',
  )
})

for (const fieldKey of ['focus_areas', 'interests', 'keywords']) {
  test(`programs_services.${fieldKey}: array renders cleanly without warnings`, () => {
    const { result, warnings } = captureWarnings(() =>
      formatFieldValue('programs_services', fieldKey, ['health', 'youth services']),
    )
    assert.equal(result, 'health, youth services')
    assert.equal(warnings.filter((w) => w.includes('[fieldDisplay]')).length, 0)
  })

  test(`programs_services.${fieldKey}: empty array → em dash`, () => {
    const { result, warnings } = captureWarnings(() =>
      formatFieldValue('programs_services', fieldKey, []),
    )
    assert.equal(result, '—')
    assert.equal(warnings.filter((w) => w.includes('[fieldDisplay]')).length, 0)
  })

  test(`programs_services.${fieldKey}: comma string renders cleanly`, () => {
    const { result, warnings } = captureWarnings(() =>
      formatFieldValue('programs_services', fieldKey, 'mental health, food access'),
    )
    assert.equal(result, 'mental health, food access')
    assert.equal(warnings.filter((w) => w.includes('[fieldDisplay]')).length, 0)
  })

  test(`programs_services.${fieldKey}: object shape renders cleanly`, () => {
    const { result, warnings } = captureWarnings(() =>
      formatFieldValue('programs_services', fieldKey, { 0: 'rural', 1: 'urban' }),
    )
    assert.equal(result, 'rural, urban')
    assert.equal(
      warnings.filter((w) => w.startsWith('[fieldDisplay] Missing or invalid SECTION_METADATA')).length,
      0,
    )
  })
}

test('smoke: rendering a fully populated profile fixture produces zero metadata warnings', async () => {
  // Mirror a "real-shaped" profile-section payload similar to what
  // /api/profiles/:id returns after the read-time normalizer runs. Every
  // historically-noisy field is included so a regression in fieldDisplay
  // (or a new mismatched format) trips this test instead of users.
  const fixture = {
    housing: {
      status: 'stable',
      type: 'rent',
      address: '123 Main St',
      broadband_speed: '25/3 Mbps',
      geographic_designation: ['rural', 'frontier'],
      notes: 'Long-term renter.',
    },
    programs_services: {
      focus_areas: ['workforce', 'health'],
      interests: ['youth services'],
      keywords: ['rural development', 'broadband'],
      notes: 'Cooperative model.',
    },
    demographics: {
      languages: ['English', 'Spanish'],
      geographic_qualifiers: ['rural', 'Appalachian'],
    },
  }

  const { warnings } = captureWarnings(() => {
    for (const [sectionKey, data] of Object.entries(fixture)) {
      for (const [fieldKey, value] of Object.entries(data)) {
        formatFieldValue(sectionKey, fieldKey, value)
      }
    }
  })

  const offenders = warnings.filter((w) =>
    w.startsWith('[fieldDisplay] Missing or invalid SECTION_METADATA'),
  )
  assert.deepEqual(
    offenders,
    [],
    `Expected zero "[fieldDisplay] Missing or invalid SECTION_METADATA" warnings for a populated profile fixture, got:\n${offenders.join('\n')}`,
  )
})

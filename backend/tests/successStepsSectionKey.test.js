/**
 * Success-step deep links are opt-in PER STEP.
 *
 * A broad category mixes profile fields with external actions: "legal" holds
 * an EIN filing (organization_details.ein) and an immigration document (no
 * home on the profile); "planning" holds a sustainability plan (narrative)
 * and a phone call to 211. Routing by category therefore sends the user to an
 * unrelated editor, so the only sources of a link are an explicit archetype
 * `section_key` (with an optional exact `field`) or a per-step
 * ACTION_PATTERNS match in successStepActions.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

import { enrichSuccessStep } from '../config/successStepActions.js'

const SRC = readFileSync(new URL('../routes/matching.js', import.meta.url), 'utf8')
const ACTIONS_SRC = readFileSync(new URL('../config/successStepActions.js', import.meta.url), 'utf8')

describe('success step archetype targets (backend/routes/matching.js)', () => {
  it('passes explicit section_key/field through and never infers one from a category', () => {
    expect(SRC).not.toContain('CATEGORY_TO_SECTION')
    expect(SRC).toContain('section_key: step.section_key ?? null')
    expect(SRC).toContain('field: step.field ?? null')
  })

  it('targets the exact editor field when the profile can record the action', () => {
    expect(SRC).toMatch(/Obtain an EIN[^\n]+section_key: 'organization_details', field: 'ein'/)
    expect(SRC).toMatch(/Register on SAM\.gov'[^\n]+section_key: 'organization_details', field: 'sam_gov_registered'/)
    expect(SRC).toMatch(/Create a Grants\.gov account'[^\n]+section_key: 'organization_details', field: 'grants_gov_account'/)
    expect(SRC).toMatch(/sustainability plan'[^\n]+section_key: 'narrative', field: 'sustainability_plan'/)
  })

  it('leaves external legal and planning actions without an unrelated editor', () => {
    expect(SRC).toMatch(/Obtain employment authorization document \(EAD\)'[^\n]+category: 'legal', why:/)
    expect(SRC).toMatch(/Contact 211 for local emergency assistance programs'[^\n]+category: 'planning', why:/)
    expect(SRC).not.toMatch(/Obtain employment authorization document \(EAD\)'[^\n]+section_key:/)
    expect(SRC).not.toMatch(/Contact 211 for local emergency assistance programs'[^\n]+section_key:/)
  })
})

describe('enrichSuccessStep deep-link resolution', () => {
  it('uses the explicit section_key + field from the archetype', () => {
    const step = enrichSuccessStep({
      label: 'Obtain an EIN (Employer Identification Number)',
      category: 'legal',
      why: 'Required for most business grants',
      section_key: 'organization_details',
      field: 'ein',
    })
    expect(step.profile_section).toBe('organization_details')
    expect(step.profile_field).toBe('ein')
  })

  it('never derives a profile section from the category alone', () => {
    // Same category as the EIN step, but no editor can record an EAD.
    const ead = enrichSuccessStep({
      label: 'Obtain employment authorization document (EAD)',
      category: 'legal',
      why: 'Required before you can work',
    })
    expect(ead.profile_section).toBeNull()
    expect(ead.profile_field).toBeNull()

    const call211 = enrichSuccessStep({
      label: 'Contact 211 for local emergency assistance programs',
      category: 'planning',
      why: 'Dial 211',
    })
    expect(call211.profile_section).toBeNull()

    // Category defaults still supply how/checklist/documents, just no editor.
    expect(typeof ead.how).toBe('string')
    expect(Array.isArray(ead.checklist)).toBe(true)
  })

  it('still honours a per-step ACTION_PATTERNS match without an explicit section_key', () => {
    const npi = enrichSuccessStep({ label: 'Get an NPI', category: 'compliance', why: 'HRSA' })
    expect(npi.profile_section).toBe('organization_details')
    expect(npi.profile_field).toBeNull()
  })

  it('does not carry a field without a section', () => {
    const step = enrichSuccessStep({ label: 'Write a business plan', category: 'planning', field: 'ein' })
    expect(step.profile_section).toBeNull()
    expect(step.profile_field).toBeNull()
  })

  it('category defaults carry no profile_section', () => {
    const start = ACTIONS_SRC.indexOf('const CATEGORY_DEFAULTS = {')
    const end = ACTIONS_SRC.indexOf('function categoryDefault(')
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    expect(ACTIONS_SRC.slice(start, end)).not.toContain('profile_section')
  })
})

/**
 * Success-step deep links are opt-in per step. Broad categories mix profile
 * fields with external actions, so category-level routing is unsafe.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../routes/matching.js', import.meta.url), 'utf8')
const UI = readFileSync(new URL('../../src/pages/SmartMatcher.jsx', import.meta.url), 'utf8')

describe('success step deep-link targets', () => {
  it('does not infer profile sections from categories', () => {
    expect(SRC).not.toContain('CATEGORY_TO_SECTION')
    expect(SRC).toContain('section_key: step.section_key ?? null')
    expect(SRC).toContain('field: step.field ?? null')
  })

  it('targets an exact editor field when the profile can record the action', () => {
    expect(SRC).toMatch(/Obtain an EIN[^\n]+section_key: 'organization_details', field: 'ein'/)
    expect(SRC).toMatch(/Register on SAM\.gov'[^\n]+section_key: 'organization_details', field: 'sam_gov_registered'/)
    expect(SRC).toMatch(/sustainability plan'[^\n]+section_key: 'narrative', field: 'sustainability_plan'/)
  })

  it('leaves external legal and planning actions without unrelated editors', () => {
    expect(SRC).toMatch(/Obtain employment authorization document \(EAD\)'[^\n]+category: 'legal', why:/)
    expect(SRC).toMatch(/Contact 211 for local emergency assistance programs'[^\n]+category: 'planning', why:/)
    expect(SRC).not.toMatch(/Obtain employment authorization document \(EAD\)'[^\n]+section_key:/)
    expect(SRC).not.toMatch(/Contact 211 for local emergency assistance programs'[^\n]+section_key:/)
  })
})

describe('success step UI wiring', () => {
  it('renders links only for steps with an explicit section target', () => {
    expect(UI).toContain('step.section_key ?')
  })

  it('passes the exact optional field to ProfileDetail', () => {
    expect(UI).toContain('section: step.section_key')
    expect(UI).toContain('...(step.field ? { field: step.field } : {})')
  })

  it('keeps untargeted external actions non-clickable', () => {
    expect(UI).toContain('group-hover:text-amber-500')
    expect(UI).toMatch(/step\.section_key \?/)
  })
})

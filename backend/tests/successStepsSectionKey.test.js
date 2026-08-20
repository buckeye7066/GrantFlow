/**
 * "What You Need for Success" cards must be clickable — each step returned by
 * the matching-gaps route must carry a `section_key` that the frontend can use
 * to deep-link into the relevant profile section.
 *
 * Both assertions FAIL if the `section_key` push is removed from
 * `buildSuccessSteps` or if `CATEGORY_TO_SECTION` is deleted.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../routes/matching.js', import.meta.url), 'utf8')

describe('success step section_key wiring', () => {
  it('CATEGORY_TO_SECTION map is defined in matching.js', () => {
    expect(SRC).toContain('const CATEGORY_TO_SECTION')
  })

  it('every step pushed in buildSuccessSteps carries section_key', () => {
    // The push statement must include section_key
    expect(SRC).toContain('section_key: CATEGORY_TO_SECTION[step.category]')
  })

  it('section_key for legal category is organization_details', () => {
    // Extract the CATEGORY_TO_SECTION object literal from the source
    const match = SRC.match(/const CATEGORY_TO_SECTION\s*=\s*\{([^}]+)\}/)
    expect(match).not.toBeNull()
    const body = match[1]
    expect(body).toMatch(/legal\s*:\s*'organization_details'/)
  })

  it('section_key for financial category is financial_information', () => {
    const match = SRC.match(/const CATEGORY_TO_SECTION\s*=\s*\{([^}]+)\}/)
    expect(match).not.toBeNull()
    const body = match[1]
    expect(body).toMatch(/financial\s*:\s*'financial_information'/)
  })

  it('section_key for planning category is narrative', () => {
    const match = SRC.match(/const CATEGORY_TO_SECTION\s*=\s*\{([^}]+)\}/)
    expect(match).not.toBeNull()
    const body = match[1]
    expect(body).toMatch(/planning\s*:\s*'narrative'/)
  })

  it('section_key for documentation category is null (external docs, no profile section)', () => {
    const match = SRC.match(/const CATEGORY_TO_SECTION\s*=\s*\{([^}]+)\}/)
    expect(match).not.toBeNull()
    const body = match[1]
    expect(body).toMatch(/documentation\s*:\s*null/)
  })
})

describe('success step UI wiring (SmartMatcher.jsx)', () => {
  const UI = readFileSync(
    new URL('../../src/pages/SmartMatcher.jsx', import.meta.url),
    'utf8',
  )

  it('renders a Link when step.section_key is present', () => {
    expect(UI).toContain('step.section_key ?')
  })

  it('deep-links to ProfileDetail with section param', () => {
    expect(UI).toContain('createPageUrl("ProfileDetail", { id: selectedProfileId, section: step.section_key })')
  })

  it('renders a plain div when step.section_key is absent', () => {
    // Both branches must exist — clickable and non-clickable
    expect(UI).toMatch(/step\.section_key \?/)
    expect(UI).toContain('group-hover:text-amber-500')
  })
})

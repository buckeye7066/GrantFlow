import { describe, it, expect } from 'vitest'
import {
  detectSpaApplySurface,
  isSpaApplyHubHost,
  isIndividualAwardPath,
  spaApplyHub,
  spaApplyBlockerDetail,
} from '../services/hamilton/spaApplySurface.js'
import { classifyBlocker } from '../services/hamilton/hamiltonBlockerClassifier.js'

// Snapshots below are the ACTUAL shapes captured by a read-only in-container
// probe of bold.org with Robert's valid saved session (2026-08-24): the award
// page renders field_count 0 and "Apply Now" buttons; the /scholarships/ listing
// renders many award links and "Apply to scholarship" buttons.

describe('spaApplySurface — host + path recognition', () => {
  it('recognizes the hub hosts (incl. www + subdomains)', () => {
    expect(isSpaApplyHubHost('https://bold.org/scholarships/x/')).toBe(true)
    expect(isSpaApplyHubHost('https://www.bold.org/scholarships/x/')).toBe(true)
    expect(isSpaApplyHubHost('https://scholarshipowl.com/scholarships/type/housing/')).toBe(true)
    expect(isSpaApplyHubHost('https://fastweb.com/x')).toBe(false)
    expect(isSpaApplyHubHost('https://notbold.org.evil.com/x')).toBe(false)
    expect(spaApplyHub('https://bold.org/x')?.display).toBe('Bold.org')
  })

  it('treats an individual award slug as an award page, and browse trees as listings', () => {
    expect(isIndividualAwardPath('https://bold.org/scholarships/bright-lite-scholarship/')).toBe(true)
    expect(isIndividualAwardPath('https://bold.org/scholarships/dr-noelle-olson-memorial-scholarship/')).toBe(true)
    // bare listing + browse-tree categories are NOT individual award pages
    expect(isIndividualAwardPath('https://bold.org/scholarships/')).toBe(false)
    expect(isIndividualAwardPath('https://bold.org/scholarships/by-state/georgia-scholarships/')).toBe(false)
    expect(isIndividualAwardPath('https://bold.org/scholarships/by-type/no-essay-scholarships/')).toBe(false)
  })
})

describe('spaApplySurface — detection', () => {
  it('flags a bold.org individual award page (field_count 0, "Apply Now" button)', () => {
    const r = detectSpaApplySurface({
      url: 'https://bold.org/scholarships/bright-lite-scholarship/',
      fieldCount: 0,
      buttonTexts: ['Apply Now', 'Apply Now', 'Login', 'Join Bold.org'],
    })
    expect(r.isSpaApply).toBe(true)
    expect(r.hub).toBe('bold.org')
    expect(r.surface).toBe('award')
  })

  it('detects the apply cue from innerText when the button text is not captured', () => {
    const r = detectSpaApplySurface({
      url: 'https://bold.org/scholarships/india-terrell-memorial-scholarship/',
      fieldCount: 0,
      buttonTexts: [],
      text: 'Bright Lite Scholarship Funded by ... Eligibility Requirements ... Apply Now',
    })
    expect(r.isSpaApply).toBe(true)
  })

  it('does NOT flag the /scholarships/ listing page (defers to decomposition)', () => {
    const r = detectSpaApplySurface({
      url: 'https://bold.org/scholarships/',
      fieldCount: 0,
      buttonTexts: ['Apply to scholarship', 'Apply to scholarship'],
    })
    expect(r.isSpaApply).toBe(false)
    expect(r.surface).toBe('listing')
    expect(r.reason).toBe('listing_surface_defer_to_decomposition')
  })

  it('does NOT flag a non-hub host', () => {
    const r = detectSpaApplySurface({
      url: 'https://cpcc.academicworks.com/opportunities/123',
      fieldCount: 0,
      buttonTexts: ['Apply Now'],
    })
    expect(r.isSpaApply).toBe(false)
    expect(r.reason).toBe('not_spa_hub')
  })

  it('does NOT flag a hub page that carries a real native form (leave to fill path)', () => {
    const r = detectSpaApplySurface({
      url: 'https://bold.org/scholarships/some-award/',
      fieldCount: 6,
      buttonTexts: ['Apply Now', 'Submit'],
    })
    expect(r.isSpaApply).toBe(false)
    expect(r.reason).toBe('native_form_present')
  })

  it('does NOT flag a hub award page with no apply cue at all', () => {
    const r = detectSpaApplySurface({
      url: 'https://bold.org/scholarships/some-award/',
      fieldCount: 0,
      buttonTexts: ['View Scholarships', 'Winners', 'About'],
      text: 'Some marketing copy with no call to action',
    })
    expect(r.isSpaApply).toBe(false)
    expect(r.reason).toBe('no_apply_cue')
  })
})

describe('spaApplySurface — blocker wiring', () => {
  it('spa_apply_surface classifies to a known category (never "unknown")', () => {
    const c = classifyBlocker({ kind: 'spa_apply_surface', detail: spaApplyBlockerDetail('Bold.org') })
    expect(c.category).not.toBe('unknown')
    expect(c.source).toBe('engine')
  })

  it('the blocker detail names the hub and the co-browse next step', () => {
    const d = spaApplyBlockerDetail('Bold.org')
    expect(d).toMatch(/Bold\.org/)
    expect(d).toMatch(/co-browse/i)
    expect(d).toMatch(/saved .* session/i)
  })
})

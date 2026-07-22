/**
 * locatorUrlKind.test.js
 *
 * POSITIVE structural classification only — every rule here must be an exact
 * shape claim about a page that is a program locator / benefit portal, never
 * an award. The sharpest tests are the NEGATIVE ones: hosts that MIX real
 * awards with program pages (tn.gov carries the fixed-award HOPE scholarship)
 * must never be host-classified, and a row whose AUTHORITATIVE source_url is a
 * real award page must never be demoted by a secondary locator URL.
 */

import { describe, it, expect } from 'vitest'
import { classifyLocatorKindFromUrl, classifyLocatorKindFromRow } from '../services/sources/locatorUrlKind.js'

describe('classifyLocatorKindFromUrl — fix-cycle-1 shapes', () => {
  it('classifies sam.gov /fal/ assistance listings as DIRECTORY', () => {
    expect(classifyLocatorKindFromUrl('https://sam.gov/fal/008c6d455cbe460eaae30de03524b7c3/view'))
      .toMatchObject({ kind: 'directory' })
  })

  it('classifies listed ssa.gov benefit sections as BENEFIT, unlisted paths not at all', () => {
    expect(classifyLocatorKindFromUrl('https://www.ssa.gov/survivor')).toMatchObject({ kind: 'benefit' })
    expect(classifyLocatorKindFromUrl('https://www.ssa.gov/ssi/eligibility')).toMatchObject({ kind: 'benefit' })
    expect(classifyLocatorKindFromUrl('https://www.ssa.gov/careers')).toBeNull()
  })
})

describe('classifyLocatorKindFromUrl — fix-cycle-3 shapes (prod census 2026-07-22)', () => {
  it('classifies whole-host BENEFIT portals', () => {
    expect(classifyLocatorKindFromUrl('https://studentaid.gov/h/apply-for-aid/fafsa')).toMatchObject({ kind: 'benefit' })
    expect(classifyLocatorKindFromUrl('https://tenncareconnect.tn.gov/')).toMatchObject({ kind: 'benefit' })
    expect(classifyLocatorKindFromUrl('https://fabenefits.dhs.tn.gov/apply')).toMatchObject({ kind: 'benefit' })
  })

  it('classifies whole-host service DIRECTORIES', () => {
    expect(classifyLocatorKindFromUrl('https://tn211.org/search?need=rent')).toMatchObject({ kind: 'directory' })
    expect(classifyLocatorKindFromUrl('https://www.benefitscheckup.org/')).toMatchObject({ kind: 'directory' })
  })

  it('classifies ProPublica nonprofit ORG PROFILES (EIN paths) but nothing else on the host', () => {
    expect(classifyLocatorKindFromUrl('https://projects.propublica.org/nonprofits/organizations/340714585'))
      .toMatchObject({ kind: 'directory' })
    expect(classifyLocatorKindFromUrl('https://projects.propublica.org/nonprofits/')).toBeNull()
  })

  it('classifies scholarships.com BROWSE-TREE category pages but never individual award pages', () => {
    expect(classifyLocatorKindFromUrl(
      'https://www.scholarships.com/financial-aid/college-scholarships/scholarships-by-major/science-scholarships/',
    )).toMatchObject({ kind: 'directory' })
    // An individual scholarship page outside the scholarships-by- facet makes
    // no claim — it may state a real fixed award.
    expect(classifyLocatorKindFromUrl(
      'https://www.scholarships.com/scholarship/the-example-memorial-scholarship/',
    )).toBeNull()
  })

  it('NEVER host-classifies mixed-content hosts (tn.gov carries the fixed-award HOPE scholarship)', () => {
    expect(classifyLocatorKindFromUrl('https://www.tn.gov/collegepays/money-for-college/tn-education-lottery-programs/tennessee-hope-scholarship.html')).toBeNull()
    expect(classifyLocatorKindFromUrl('https://www.tn.gov/aging/our-programs/caregiver-support-program.html')).toBeNull()
    expect(classifyLocatorKindFromUrl('https://www.tnreconnect.gov/')).toBeNull()
  })

  it('lookalike hostnames make no claim', () => {
    expect(classifyLocatorKindFromUrl('https://studentaid.gov.evil.com/fafsa')).toBeNull()
    expect(classifyLocatorKindFromUrl('https://nottn211.org/')).toBeNull()
  })
})

describe('classifyLocatorKindFromRow — the AUTHORITATIVE source_url rule', () => {
  it('a real award source_url is never demoted by a secondary locator URL', () => {
    expect(classifyLocatorKindFromRow({
      source_url: 'https://www.grants.gov/search-results-detail/112354',
      evidence_url: 'https://sam.gov/fal/008c6d455cbe460eaae30de03524b7c3/view',
    })).toBeNull()
  })

  it('falls back to secondary URLs only when there is no source_url', () => {
    expect(classifyLocatorKindFromRow({
      evidence_url: 'https://studentaid.gov/understand-aid/types/grants/pell',
    })).toMatchObject({ kind: 'benefit' })
  })
})

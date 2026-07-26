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
import { classifyLocatorKindFromUrl, classifyLocatorKindFromRow, STATE_GOV_PATH_RULES, ORG_PATH_RULES, LOCATOR_URL_LIKE_PREFILTERS } from '../services/sources/locatorUrlKind.js'

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
    // The load-bearing negative: real fixed-award pages on a state host must
    // stay unclaimed no matter how many PATH rules that host gains (fix-cycle-4
    // added tn.gov path rules; /collegepays/ is deliberately not one of them).
    expect(classifyLocatorKindFromUrl('https://www.tn.gov/collegepays/money-for-college/tn-education-lottery-programs/tennessee-hope-scholarship.html')).toBeNull()
    expect(classifyLocatorKindFromUrl('https://www.tn.gov/collegepays/money-for-college/tn-education-lottery-programs/tennessee-step-up-scholarship.html')).toBeNull()
    expect(classifyLocatorKindFromUrl('https://www.tn.gov/')).toBeNull()
  })

  it('lookalike hostnames make no claim', () => {
    expect(classifyLocatorKindFromUrl('https://studentaid.gov.evil.com/fafsa')).toBeNull()
    expect(classifyLocatorKindFromUrl('https://nottn211.org/')).toBeNull()
  })
})

describe('classifyLocatorKindFromUrl — fix-cycle-4 STATE-GOV path rules (prod census 2026-07-26)', () => {
  it('claims state benefit SUBTREES: TennCare (Medicaid) and TCAD service programs', () => {
    expect(classifyLocatorKindFromUrl('https://www.tn.gov/tenncare/long-term-services-supports/katie-beckett-program.html'))
      .toMatchObject({ kind: 'benefit' })
    expect(classifyLocatorKindFromUrl('https://www.tn.gov/tenncare.html')).toMatchObject({ kind: 'benefit' })
    expect(classifyLocatorKindFromUrl('https://www.tn.gov/aging/our-programs/caregiver-support-program.html'))
      .toMatchObject({ kind: 'benefit' })
  })

  it('a benefit PREFIX is a token, not a substring, and unlisted sections make no claim', () => {
    expect(classifyLocatorKindFromUrl('https://www.tn.gov/tenncareers/apply')).toBeNull()
    expect(classifyLocatorKindFromUrl('https://www.tn.gov/aging/grants-and-contracts/rfp.html')).toBeNull()
  })

  it('claims department homepages / grant-portal INDEX pages as DIRECTORY — exact page only', () => {
    expect(classifyLocatorKindFromUrl('https://www.tn.gov/didd.html')).toMatchObject({ kind: 'directory' })
    expect(classifyLocatorKindFromUrl('https://www.tn.gov/didd/')).toMatchObject({ kind: 'directory' })
    expect(classifyLocatorKindFromUrl('https://www.tn.gov/finance/grants.html')).toMatchObject({ kind: 'directory' })
    // A department SUBPAGE can be a real program (DIDD Family Support pays real
    // dollars) — an exact-page rule must never claim the subtree.
    expect(classifyLocatorKindFromUrl('https://www.tn.gov/didd/for-consumers/family-support-program.html')).toBeNull()
    expect(classifyLocatorKindFromUrl('https://www.tn.gov/finance/grants/opportunity-42.html')).toBeNull()
  })

  it('claims the TN Reconnect and VA benefits hosts as BENEFIT (whole-host, award varies by design)', () => {
    expect(classifyLocatorKindFromUrl('https://tnreconnect.gov/')).toMatchObject({ kind: 'benefit' })
    expect(classifyLocatorKindFromUrl('https://www.benefits.va.gov/homeloans/adaptedhousing.asp')).toMatchObject({ kind: 'benefit' })
  })

  it('every STATE_GOV_PATH_RULES entry derives a LIKE prefilter (a new state cannot be orphaned from the sweeps)', () => {
    for (const rule of STATE_GOV_PATH_RULES) {
      for (const p of [...rule.benefitPrefixes, ...rule.directoryPages]) {
        expect(LOCATOR_URL_LIKE_PREFILTERS, `missing prefilter for ${rule.host}/${p}`).toContain(`%${rule.host}/${p}%`)
      }
    }
    // And the classifier actually claims what each prefilter scans for — the
    // registry cannot drift from the matchers it compiles into.
    for (const rule of STATE_GOV_PATH_RULES) {
      for (const p of rule.benefitPrefixes) {
        expect(classifyLocatorKindFromUrl(`https://www.${rule.host}/${p}/some-program.html`)).toMatchObject({ kind: 'benefit' })
      }
      for (const p of rule.directoryPages) {
        expect(classifyLocatorKindFromUrl(`https://www.${rule.host}/${p}.html`)).toMatchObject({ kind: 'directory' })
      }
    }
  })
})

describe('classifyLocatorKindFromUrl — fix-cycle-5 ORG/aggregator shapes (prod census 2026-07-26)', () => {
  it('SEO listicle aggregators are whole-host DIRECTORIES (pages ABOUT programs, never an award)', () => {
    expect(classifyLocatorKindFromUrl('https://grantsfordisabled.org/grants-for-disabled-people-in-tennessee/'))
      .toMatchObject({ kind: 'directory' })
    expect(classifyLocatorKindFromUrl('https://disabilityincomespecialists.com/disability/maximizing-disability-income-east-cleveland-tn/'))
      .toMatchObject({ kind: 'directory' })
  })

  it('Salvation Army services are BENEFIT sitewide (assistance varies by need, never a fixed award)', () => {
    expect(classifyLocatorKindFromUrl('https://www.salvationarmyusa.org/usn/provide-emergency-assistance/'))
      .toMatchObject({ kind: 'benefit' })
  })

  it('aggregator browse TREES and resource/catalog pages via ORG_PATH_RULES', () => {
    expect(classifyLocatorKindFromUrl('https://scholarshipowl.com/scholarships/type/housing-scholarships'))
      .toMatchObject({ kind: 'directory' })
    expect(classifyLocatorKindFromUrl('https://www.ed.gov/grants-and-programs')).toMatchObject({ kind: 'directory' })
    expect(classifyLocatorKindFromUrl('https://www.aha.org/workforce-strategies')).toMatchObject({ kind: 'directory' })
    expect(classifyLocatorKindFromUrl('https://www.nsc.org/safety-training/first-aid')).toMatchObject({ kind: 'directory' })
  })

  it('org path rules claim only their shapes — the rest of each host keeps its ordinary read', () => {
    expect(classifyLocatorKindFromUrl('https://scholarshipowl.com/about')).toBeNull()
    expect(classifyLocatorKindFromUrl('https://www.ed.gov/grants-and-programs/grant-x/award.html')).toBeNull()
    expect(classifyLocatorKindFromUrl('https://www.aha.org/education-events')).toBeNull()
    expect(classifyLocatorKindFromUrl('https://www.nsc.org/nsc-membership')).toBeNull()
  })

  it('every ORG_PATH_RULES entry derives prefilters and classifies (registry totality)', () => {
    for (const rule of ORG_PATH_RULES) {
      for (const p of [...(rule.benefitPrefixes ?? []), ...(rule.directoryPages ?? []), ...(rule.directoryPrefixes ?? [])]) {
        expect(LOCATOR_URL_LIKE_PREFILTERS, `missing prefilter for ${rule.host}/${p}`).toContain(`%${rule.host}/${p}%`)
      }
      for (const p of rule.directoryPrefixes ?? []) {
        expect(classifyLocatorKindFromUrl(`https://www.${rule.host}/${p}/deep/page`)).toMatchObject({ kind: 'directory' })
      }
      for (const p of rule.directoryPages ?? []) {
        expect(classifyLocatorKindFromUrl(`https://www.${rule.host}/${p}`)).toMatchObject({ kind: 'directory' })
      }
    }
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

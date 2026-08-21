/**
 * A classification must say what it RESTS ON, and the rescue must refuse a
 * page that cannot be an application surface.
 *
 * Both guards exist because production reported a guess in the words of a
 * finding: 38,207 of ~48,700 classification events are the last-resort
 * `url.http` rule rendered as "confidence 0.55", and the URL rescue accepted
 * an encyclopedia article as "the funder's own application page".
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyFundingSource, EVIDENCE_STRENGTH } from '../services/hamilton/hamiltonAutomationClassifier.js'
import {
  classifyNonApplicationSurface,
  isNonApplicationSurface,
} from '../config/applicationSurfaceHosts.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLASSIFIER_SOURCE = fs.readFileSync(
  path.join(here, '..', 'services', 'hamilton', 'hamiltonAutomationClassifier.js'),
  'utf8',
)

describe('classification evidence strength', () => {
  it('declares a strength for EVERY rule the classifier can emit', () => {
    // Read the rules out of the source rather than a hand-typed list, so a new
    // `setAndReturn(...)` cannot ship without a strength (the registry +
    // totality pattern this repo mandates).
    const emitted = [...CLASSIFIER_SOURCE.matchAll(/setAndReturn\(\s*'[a-z_]+'\s*,\s*[^,]+,\s*'([a-z_.]+)'/g)]
      .map((m) => m[1])
    expect(emitted.length).toBeGreaterThan(10)
    const missing = [...new Set(emitted)].filter((rule) => !EVIDENCE_STRENGTH[rule])
    expect(missing).toEqual([])
  })

  it('uses only the four declared strengths', () => {
    for (const [rule, strength] of Object.entries(EVIDENCE_STRENGTH)) {
      expect(['declared', 'inferred', 'guessed', 'none'], rule).toContain(strength)
    }
  })

  it('calls the bare-URL fallback a GUESS, not a measurement', () => {
    const result = classifyFundingSource({
      opportunity: { application_url: 'https://example.org/some-page' },
    })
    expect(result.automation_type).toBe('portal')
    expect(result.confidence).toBeCloseTo(0.55)
    expect(result.deciding_rule).toBe('url.http')
    expect(result.evidence_strength).toBe('guessed')
  })

  it('calls a declared application mode DECLARED', () => {
    const result = classifyFundingSource({
      opportunity: { application_mode: 'portal', application_url: 'https://example.org/apply' },
    })
    expect(result.deciding_rule).toBe('metadata.application_mode')
    expect(result.evidence_strength).toBe('declared')
  })

  it('calls a source with no channel at all NONE', () => {
    const result = classifyFundingSource({ opportunity: { title: 'A grant with nothing on it' } })
    expect(result.automation_type).toBe('unknown')
    expect(result.evidence_strength).toBe('none')
  })
})

describe('pages that can never be an application surface', () => {
  // Every URL below is a verbatim production `url_rescue` event message from
  // 2026-08-21 — each was accepted as "the funder's own application page".
  const ACCEPTED_IN_PRODUCTION_BUT_WRONG = [
    'https://en.wikipedia.org/wiki/NeighborWorks_America',
    'https://www.mjnewellhomes.com/blog/section-8-housing-voucher-program-florida',
    'https://nationaltaxreports.com/property-tax-exemption-for-seniors-in-california/',
    'https://trendsnbest.com/housing-programs-for-single-mothers/',
    'https://www.debt.org/advice/cant-pay-my-utility-bills/',
    'https://www.needhelppayingbills.com/html/disability_grants.html',
    'https://www.keela.co/grants/type/seniors',
  ]

  it.each(ACCEPTED_IN_PRODUCTION_BUT_WRONG)('refuses %s', (url) => {
    const verdict = classifyNonApplicationSurface(url)
    expect(verdict, url).not.toBeNull()
    expect(verdict.reason).toMatch(/^non_application_/)
  })

  it('leaves a real funder application page alone', () => {
    const REAL = [
      'https://studentaid.gov/understand-aid/types/grants/fseog',
      'https://www.questbridge.org/',
      'https://clevelandstatecc.scholarships.ngwebsolutions.com/Scholarships/Search',
      'https://www.grants.gov/search-results-detail/362337',
      'https://www.tn.gov/collegepays/money-for-college/tn-education-lottery-programs/tennessee-hope-aspire-award.html',
      'https://www.jkcf.org/our-scholarships/college-scholarship-program/',
      'https://www.elks.org/scholars/scholarships/mvs.cfm',
      'https://ban-sserv.clevelandstatecc.edu/prod_ssb/bwskalog.P_DispLoginNon',
    ]
    for (const url of REAL) {
      expect(isNonApplicationSurface(url), url).toBe(false)
    }
  })

  it('judges a funder domain on its PATH, so a funder with a blog keeps its portal', () => {
    expect(isNonApplicationSurface('https://goodfunder.org/apply')).toBe(false)
    expect(isNonApplicationSurface('https://goodfunder.org/blog/how-we-fund')).toBe(true)
  })

  it('says nothing about a host it does not recognise', () => {
    // MISSING = NEUTRAL. This file may only ever refuse.
    expect(classifyNonApplicationSurface('https://some-unknown-foundation.org/scholarship')).toBeNull()
  })

  it('ignores anything that is not an http(s) URL', () => {
    for (const value of ['', null, undefined, 'not a url', 'ftp://x.org/blog/a', 'mailto:a@b.org']) {
      expect(isNonApplicationSurface(value)).toBe(false)
    }
  })
})

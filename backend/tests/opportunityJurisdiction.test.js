/**
 * Guard tests for backend/config/opportunityJurisdiction.js — the two scope
 * facts the geography gate never had.
 *
 * The live defects these encode (prod 2026-08-01, GeneMac report):
 *   • "Housing Adaptation Grant for People with a Disability" from "Local
 *     Authorities" (citizensinformation.ie) — the IRISH scheme — reached an
 *     Indiana senior's Funding Sources list. 146 active foreign catalog rows.
 *   • "Polk County, TN — Local assistance programs near you (findhelp)" and 88
 *     other county locators are stored `state = NULL, is_national = 1`, so the
 *     geo gate short-circuits and the geo tier scores them NATIONWIDE. 373
 *     match rows across 37 of 39 profiles; 213 provably out-of-state.
 *
 * REGISTRY + TOTALITY (CLAUDE.md): both sets are enumerable inventories with
 * more than one consumer, so their shape is asserted here.
 */

import { describe, it, expect } from 'vitest'
import {
  FOREIGN_CCTLDS,
  JURISDICTION_NEUTRAL_HOSTS,
  hostnameOf,
  foreignCctldOfHost,
  detectForeignJurisdiction,
  detectForeignOpportunity,
  foreignFunderNameLikePatterns,
  declaredStateFromTitle,
  correctedGeoScopeFromTitle,
} from '../config/opportunityJurisdiction.js'

describe('opportunityJurisdiction — registry totality', () => {
  it('every FOREIGN_CCTLDS member is a lower-case ccTLD suffix (no dots except a 2-label suffix)', () => {
    expect(FOREIGN_CCTLDS.size).toBeGreaterThan(20)
    for (const tld of FOREIGN_CCTLDS) {
      expect(typeof tld).toBe('string')
      expect(tld).toBe(tld.toLowerCase())
      const labels = tld.split('.')
      expect(labels.length).toBeLessThanOrEqual(2)
      expect(labels[labels.length - 1]).toMatch(/^[a-z]{2}$/)
    }
  })

  it('never lists a generic/vanity TLD that US entities use as a domain hack', () => {
    // A ccTLD sold as a generic suffix says nothing about jurisdiction. If one of
    // these is ever added, every .io/.co/.ai funder becomes "foreign" overnight.
    for (const generic of ['io', 'co', 'me', 'tv', 'ly', 'ai', 'fm', 'to', 'gg', 'cc', 'ws']) {
      expect(FOREIGN_CCTLDS.has(generic)).toBe(false)
    }
  })

  it('every JURISDICTION_NEUTRAL_HOSTS member is a bare lower-case hostname', () => {
    expect(JURISDICTION_NEUTRAL_HOSTS.size).toBeGreaterThan(0)
    for (const host of JURISDICTION_NEUTRAL_HOSTS) {
      expect(host).toBe(host.toLowerCase())
      expect(host).not.toMatch(/[/:]/)
      expect(host).toContain('.')
    }
  })
})

describe('opportunityJurisdiction — foreign jurisdiction detection', () => {
  it('flags the real prod rows that reached US profiles', () => {
    const rows = [
      { url: 'https://www.citizensinformation.ie/en/housing/housing-grants-and-schemes/', cctld: 'ie' },
      { url: 'https://www.gov.uk/disabled-facilities-grants', cctld: 'uk' },
      { url: 'https://srd.sassa.gov.za/', cctld: 'za' },
      { url: 'https://dda.gov.in/schemes', cctld: 'in' },
      { url: 'https://www.housingauthority.gov.hk/en/', cctld: 'hk' },
      { url: 'https://www2.gnb.ca/content/gnb/en.html', cctld: 'ca' },
      { url: 'https://edumentors.co.uk/bursaries', cctld: 'co.uk' },
    ]
    for (const { url, cctld } of rows) {
      const verdict = detectForeignJurisdiction({ source_url: url })
      expect(verdict.foreign, url).toBe(true)
      expect(verdict.cctld, url).toBe(cctld)
    }
  })

  it('never flags a US funder', () => {
    for (const url of [
      'https://www.hud.gov/program_offices/fair_housing_equal_opp/fiip',
      'https://www.benefits.gov/benefit-finder',
      'https://fssabenefits.in.gov/', // .gov wins: the registrable suffix is `gov`
      'https://www.grants.gov/search-results-detail/123',
      'https://autismspeaks.org/financial-autism-support',
    ]) {
      expect(detectForeignJurisdiction({ source_url: url }).foreign, url).toBe(false)
    }
  })

  it('a link SHORTENER is never jurisdiction evidence (lnkd.in fronts a US Alaska fellowship in prod)', () => {
    expect(detectForeignJurisdiction({ source_url: 'https://lnkd.in/dC6VRfHD' }).foreign).toBe(false)
    // …and the underlying rule still fires on a real Indian government host.
    expect(detectForeignJurisdiction({ source_url: 'https://www.startupindia.gov.in/' }).foreign).toBe(true)
  })

  it('reads every url field the catalog may carry, and tolerates junk', () => {
    expect(detectForeignJurisdiction({ application_url: 'https://www.seai.ie/grants/' }).foreign).toBe(true)
    expect(detectForeignJurisdiction({ evidence_url: 'https://www.susi.ie/' }).foreign).toBe(true)
    expect(detectForeignJurisdiction({ source_url: 'not a url' }).foreign).toBe(false)
    expect(detectForeignJurisdiction({}).foreign).toBe(false)
    expect(detectForeignJurisdiction(null).foreign).toBe(false)
  })

  it('prefers the LONGEST matching suffix', () => {
    expect(foreignCctldOfHost('family-action.org.uk')).toBe('uk')
    expect(foreignCctldOfHost('statuscheck.co.za')).toBe('za')
    expect(foreignCctldOfHost('edumentors.co.uk')).toBe('co.uk')
  })

  it('hostnameOf normalizes scheme-less and trailing-dot hosts', () => {
    expect(hostnameOf('WWW.Example.IE/x')).toBe('www.example.ie')
    expect(hostnameOf('https://example.ie./x')).toBe('example.ie')
    expect(hostnameOf('')).toBe(null)
  })
})

describe('opportunityJurisdiction — a row that names its own state is not national', () => {
  it('reads the declared state from the machine-minted locator title shape', () => {
    expect(declaredStateFromTitle('Polk County, TN — Local assistance programs near you (findhelp)')).toBe('TN')
    expect(declaredStateFromTitle('Raleigh County, WV — Local housing help — HUD Resource Locator')).toBe('WV')
    expect(declaredStateFromTitle('Cleveland, TN — Local assistance programs near you (findhelp)')).toBe('TN')
    expect(declaredStateFromTitle({ title: 'La Grange County, IN — County & city government assistance programs' })).toBe('IN')
  })

  it('reads the declared state from the "near <City>, XX" locator shape (real out-of-state junk 2026-08-22)', () => {
    // A TN profile carried these at "waiting for review" — the trailing
    // "near <City>, XX" shape (no separator) was invisible to TITLE_STATE_RX.
    expect(declaredStateFromTitle('Community Action Agency near Big Piney, WY')).toBe('WY')
    expect(declaredStateFromTitle('Community Action Agency near Auburn, ME')).toBe('ME')
    expect(declaredStateFromTitle('Community Action Agency near Russellville, AL')).toBe('AL')
    expect(declaredStateFromTitle('United Way near Austin, TX')).toBe('TX')
    // Must NOT fire on a title that merely ends in a two-letter coincidence with
    // no "near <City>," anchor.
    expect(declaredStateFromTitle('Scholarships for students in STEM')).toBe(null)
    expect(declaredStateFromTitle('Rotary Peace Fellowship')).toBe(null)
    expect(declaredStateFromTitle('Society of Women Engineers (SWE) Scholarships')).toBe(null)
  })

  it('does NOT invent a state from a two-letter coincidence (the one-shared-token class)', () => {
    // No `, XX —` declaration: a bare token anywhere in a title is a coincidence.
    expect(declaredStateFromTitle('Local assistance programs near you (findhelp)')).toBe(null)
    expect(declaredStateFromTitle('IN-HOME CARE assistance for seniors')).toBe(null)
    expect(declaredStateFromTitle('Grants to OR nonprofits and libraries')).toBe(null)
    expect(declaredStateFromTitle('Benefits.gov finder — housing benefits')).toBe(null)
    // Not a real state code (prod really does contain "Anytown, SA — …").
    expect(declaredStateFromTitle('Anytown, SA — Local assistance programs near you (findhelp)')).toBe(null)
  })

  it('corrects ONLY a state-less row, and is idempotent', () => {
    const unscoped = { title: 'Polk County, TN — Local housing help', state: null, is_national: 1 }
    expect(correctedGeoScopeFromTitle(unscoped)).toEqual({ state: 'TN', is_national: 0 })

    // The EMPTY state is the trigger, not is_national: prod holds both shapes
    // (the OS bridge writes is_national 0 when the lane emits no geography at
    // all, and a state-less row short-circuits the geo gate either way).
    expect(correctedGeoScopeFromTitle({ ...unscoped, is_national: 0 })).toEqual({ state: 'TN', is_national: 0 })
    expect(correctedGeoScopeFromTitle({ ...unscoped, state: '   ' })).toEqual({ state: 'TN', is_national: 0 })

    // Already scoped → nothing to do (this is what makes the sweep converge).
    expect(correctedGeoScopeFromTitle({ ...unscoped, state: 'TN', is_national: 0 })).toBe(null)
    // A source-supplied state is never overridden, even a different one.
    expect(correctedGeoScopeFromTitle({ ...unscoped, state: 'GA' })).toBe(null)
    // Declares nothing → left alone.
    expect(correctedGeoScopeFromTitle({ title: 'Medicaid and CHIP', state: null, is_national: 1 })).toBe(null)
  })
})

// ── US diplomatic missions abroad (2026-08-03 rescore-pass leak) ─────────────
describe('opportunityJurisdiction — US missions abroad are foreign-by-construction', () => {
  it('detects the verbatim leaked rows (Azerbaijan mission linked to a TN student at 53)', () => {
    for (const row of [
      { title: 'English-Language Program for Disadvantaged Communities Initiatives Program', sponsor: 'U.S. Mission to Azerbaijan' },
      { title: 'U.S. Embassy Luanda Public Diplomacy Grants Program', sponsor: 'U.S. Department of State' },
      { title: 'Small Grants Program', sponsor: 'U.S. Mission to the United Nations-Geneva' },
      { title: 'Cultural Affairs Grants', sponsor: 'U.S. Consulate General Karachi' },
    ]) {
      const verdict = detectForeignOpportunity(row)
      expect(verdict.foreign, `${row.sponsor}: ${row.title}`).toBe(true)
    }
  })

  it('ordinary "mission" language never trips it', () => {
    for (const row of [
      { title: 'Mission-Driven Nonprofit Capacity Grants', sponsor: 'Example Foundation' },
      { title: 'US Mission Statement Essay Contest', sponsor: 'Civic Education Fund' },
      { title: 'Rescue Mission Support Grants', sponsor: 'Nashville Rescue Mission' },
    ]) {
      const verdict = detectForeignOpportunity(row)
      expect(verdict.foreign, `${row.sponsor}: ${row.title}`).toBe(false)
    }
  })

  it('the LIKE superset covers the mission rows (SQL prefilter cannot starve the detector)', () => {
    const patterns = foreignFunderNameLikePatterns()
    const hay = 'small grants program u.s. mission to azerbaijan'
    expect(patterns.some((p) => hay.includes(p.replaceAll('%', '')))).toBe(true)
  })
})

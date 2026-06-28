import { describe, it, expect } from 'vitest'
import {
  grantFingerprint,
  grantFingerprintFromOpportunity,
  chooseGrantUrl,
  grantFamilyKey,
  grantUrlKey,
  GRANT_FINGERPRINT_VERSION,
  likelySameGrantOpportunity,
  normalizeGrantUrl,
} from '../utils/grantFingerprint.js'

describe('grantFingerprint', () => {
  it('is stable across identical identity tuples', () => {
    const a = grantFingerprint({ title: 'Foo', funder: 'Bar', deadline: '2026-12-31', url: 'https://x/y' })
    const b = grantFingerprint({ title: 'Foo', funder: 'Bar', deadline: '2026-12-31', url: 'https://x/y' })
    expect(a).toEqual(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('normalizes casing + whitespace before hashing', () => {
    const a = grantFingerprint({ title: '  Foo   Bar ', funder: 'baz', deadline: null, url: '' })
    const b = grantFingerprint({ title: 'foo bar', funder: 'BAZ', deadline: null, url: null })
    expect(a).toEqual(b)
  })

  it('produces different digests when any identity field changes', () => {
    const base = { title: 'Foo', funder: 'Bar', deadline: '2026-12-31', url: 'https://x/y' }
    const byTitle = grantFingerprint({ ...base, title: 'Foo 2' })
    const byFunder = grantFingerprint({ ...base, funder: 'Bar 2' })
    const byDeadline = grantFingerprint({ ...base, deadline: '2027-01-01' })
    const byUrl = grantFingerprint({ ...base, url: 'https://x/y?page=2' })
    const baseFp = grantFingerprint(base)
    expect(new Set([baseFp, byTitle, byFunder, byDeadline, byUrl]).size).toEqual(5)
  })

  it('exposes a stable version for writers to persist alongside the hash', () => {
    expect(GRANT_FINGERPRINT_VERSION).toBeGreaterThanOrEqual(1)
  })
})

describe('chooseGrantUrl', () => {
  it('prefers url then application_url then source_url then portal_url', () => {
    expect(chooseGrantUrl({ url: 'https://a', application_url: 'https://b', source_url: 'https://c', portal_url: 'https://d' }))
      .toEqual('https://a')
    expect(chooseGrantUrl({ application_url: 'https://b', source_url: 'https://c', portal_url: 'https://d' }))
      .toEqual('https://b')
    expect(chooseGrantUrl({ source_url: 'https://c', portal_url: 'https://d' }))
      .toEqual('https://c')
    expect(chooseGrantUrl({ portal_url: 'https://d' }))
      .toEqual('https://d')
  })

  it('rejects non-http strings and returns null when nothing is usable', () => {
    expect(chooseGrantUrl({ url: 'not-a-url', application_url: 'ftp://blocked' })).toBeNull()
    expect(chooseGrantUrl({})).toBeNull()
  })
})

describe('grant identity helpers', () => {
  it('normalizes grant urls while preserving non-tracking query params', () => {
    expect(normalizeGrantUrl('https://Example.org/apply/?utm_source=x&round=2026'))
      .toEqual('https://example.org/apply?round=2026')
    expect(grantUrlKey({ application_url: 'https://example.org/apply?utm_campaign=x' }))
      .toEqual('https://example.org/apply')
  })

  it('collapses NAEMT scholarship variants as the same grant family', () => {
    const umbrella = {
      title: 'NAEMT Educational Scholarships',
      sponsor: 'National Association of Emergency Medical Technicians',
      description: 'Individual active NAEMT members pursuing EMT-Basic, EMT-Paramedic, or continuing EMS education.',
    }
    const variant = {
      title: 'NAEMT EMT-Paramedic Scholarship',
      sponsor: 'National Association of Emergency Medical Technicians',
      description: 'Active NAEMT members pursuing EMT-Paramedic education.',
    }

    expect(grantFamilyKey(umbrella)).toEqual(grantFamilyKey(variant))
    expect(likelySameGrantOpportunity(umbrella, variant)).toBe(true)
  })

  it('collapses scholarship-family umbrella titles even when a saved pipeline row has no description', () => {
    const savedPipelineRow = {
      title: 'NAEMT Educational Scholarships',
      funder: 'National Association of Emergency Medical Technicians',
    }
    const recrawledVariant = {
      title: 'NAEMT EMT-Paramedic Scholarship',
      sponsor: 'National Association of Emergency Medical Technicians',
      description: 'Active NAEMT members pursuing EMT-Paramedic education.',
    }

    expect(grantFamilyKey(savedPipelineRow)).toEqual(grantFamilyKey(recrawledVariant))
    expect(likelySameGrantOpportunity(savedPipelineRow, recrawledVariant)).toBe(true)
  })

  it('does not collapse distinct same-funder acronym programs', () => {
    const valueAdded = {
      title: 'USDA Value Added Producer Grant',
      sponsor: 'USDA Rural Development',
      description: 'Planning and working capital grants for value-added agricultural products.',
    }
    const reap = {
      title: 'USDA REAP Grant',
      sponsor: 'USDA Rural Development',
      description: 'Renewable energy and energy efficiency assistance.',
    }

    expect(grantFamilyKey(valueAdded)).toEqual(grantFamilyKey(reap))
    expect(likelySameGrantOpportunity(valueAdded, reap)).toBe(false)
  })

  it('does not collapse a generic acronym umbrella title into a distinct program without evidence overlap', () => {
    const genericUmbrella = {
      title: 'USDA Grants',
      sponsor: 'USDA Rural Development',
      description: 'General information about USDA grant programs and application resources.',
    }
    const reap = {
      title: 'USDA REAP Grant',
      sponsor: 'USDA Rural Development',
      description: 'Renewable energy and energy efficiency assistance for rural businesses and producers.',
    }

    expect(grantFamilyKey(genericUmbrella)).toEqual(grantFamilyKey(reap))
    expect(likelySameGrantOpportunity(genericUmbrella, reap)).toBe(false)
  })

  it('does not collapse distinct programs just because they share a landing page URL', () => {
    const stateFund = {
      title: 'Tennessee Emergency Fund',
      sponsor: 'Example Foundation',
      description: 'State emergency assistance for Tennessee residents.',
      source_url: 'https://example.org/grants',
    }
    const nationalFund = {
      title: 'National Emergency Fund',
      sponsor: 'Example Foundation',
      description: 'National emergency assistance program.',
      source_url: 'https://example.org/grants?utm_source=crawler',
    }

    expect(normalizeGrantUrl(stateFund.source_url)).toEqual(normalizeGrantUrl(nationalFund.source_url))
    expect(likelySameGrantOpportunity(stateFund, nationalFund)).toBe(false)
  })

  it('does not collapse numbered awards on the same landing page', () => {
    const first = {
      title: 'Rich OS Grant 1',
      sponsor: 'Foundation',
      source_url: 'https://www.grants.gov/y',
    }
    const second = {
      title: 'Rich OS Grant 2',
      sponsor: 'Foundation',
      source_url: 'https://www.grants.gov/y',
    }

    expect(likelySameGrantOpportunity(first, second)).toBe(false)
  })
})

describe('grantFingerprintFromOpportunity', () => {
  it('maps opportunity.sponsor → funder and uses chooseGrantUrl for the url field', () => {
    const byOpp = grantFingerprintFromOpportunity({
      title: 'Program X',
      sponsor: 'Agency Y',
      deadline: '2026-06-30',
      application_url: 'https://agency.example/apply',
    })
    const direct = grantFingerprint({
      title: 'Program X',
      funder: 'Agency Y',
      deadline: '2026-06-30',
      url: 'https://agency.example/apply',
    })
    expect(byOpp).toEqual(direct)
  })
})

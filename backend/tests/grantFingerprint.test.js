import { describe, it, expect } from 'vitest'
import {
  grantFingerprint,
  grantFingerprintFromOpportunity,
  chooseGrantUrl,
  GRANT_FINGERPRINT_VERSION,
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

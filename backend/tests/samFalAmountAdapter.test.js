/**
 * samFalAmountAdapter.test.js
 *
 * The defect this adapter closes: 43 active-pipeline rows point at
 * `sam.gov/fal/<id>/view` assistance listings — JS shells to the page fetcher,
 * burned `thin_page` forever — while SAM's own listing API publishes each
 * program's "Range and Average of Financial Assistance" as free text
 * (verified live 2026-07-22: 93.867 Vision Research states "$12,400 to
 * $2,178,277"). The sharpest tests here are the EXACT-match floor (a search
 * hit that merely ranks first is a different federal program) and the honest
 * split between "publishes a range", "publishes prose without a figure", and
 * "publishes nothing".
 */

import { describe, it, expect, vi } from 'vitest'
import {
  isSamFalRow,
  extractFalIdFromUrl,
  fetchFalListing,
  enrichAmountViaSamFal,
} from '../services/sources/samFalAmountAdapter.js'

const FAL_ID = '008c6d455cbe460eaae30de03524b7c3'
const FAL_URL = `https://sam.gov/fal/${FAL_ID}/view`

/** Fake fetch serving one SGS search response. */
const sgsFetch = (out) =>
  vi.fn(async (url, init = {}) => {
    if (out?.__networkError) throw new Error('socket hang up')
    // The hal+json Accept header is REQUIRED by the real endpoint (406
    // otherwise) — pin that the adapter always sends it.
    expect(init?.headers?.Accept).toBe('application/hal+json')
    return {
      ok: out.ok ?? true,
      status: out.status ?? 200,
      json: async () => out.json ?? {},
    }
  })

const hits = (results) => ({ json: { _embedded: { results } } })

describe('row identification', () => {
  it('recognizes /fal/ listing URLs on any URL slot', () => {
    expect(isSamFalRow({ source_url: FAL_URL })).toBe(true)
    expect(isSamFalRow({ evidence_url: FAL_URL })).toBe(true)
    expect(extractFalIdFromUrl({ source_url: FAL_URL })).toBe(FAL_ID)
  })

  it('recognizes a sam.gov source carrying an assistance-listing number', () => {
    expect(isSamFalRow({ source: 'sam_gov', source_id: '11.033' })).toBe(true)
    expect(isSamFalRow({ source: 'sam.gov', source_id: '93.867' })).toBe(true)
  })

  it('never claims sam.gov CONTRACT opportunities or other rows', () => {
    expect(isSamFalRow({ source_url: 'https://sam.gov/opp/abc123/view' })).toBe(false)
    expect(isSamFalRow({ source: 'sam_gov', source_id: 'W912DY-25-R-0012' })).toBe(false)
    expect(isSamFalRow({ source: 'grants.gov', source_id: '11.033' })).toBe(false)
    expect(isSamFalRow(null)).toBe(false)
  })
})

describe('fetchFalListing — the exact-match floor', () => {
  it('matches by the exact hex id from the row URL', async () => {
    const f = sgsFetch(hits([
      { _id: 'ffffffffffffffffffffffffffffffff', programNumber: '11.032', title: 'wrong program' },
      { _id: FAL_ID, programNumber: '11.033', title: 'Middle Mile' },
    ]))
    const res = await fetchFalListing({ source_url: FAL_URL, source_id: '11.033' }, { fetchImpl: f })
    expect(res.ok).toBe(true)
    expect(res.hit.title).toBe('Middle Mile')
  })

  it('a near-miss first hit is NEVER taken (different program)', async () => {
    const f = sgsFetch(hits([{ _id: 'ffffffffffffffffffffffffffffffff', programNumber: '11.032' }]))
    const res = await fetchFalListing({ source_url: FAL_URL }, { fetchImpl: f })
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('listing_not_found')
    expect(res.transient).toBe(false)
  })

  it('classifies 403 as ENVIRONMENT and 5xx as transient', async () => {
    const blocked = await fetchFalListing({ source_url: FAL_URL }, { fetchImpl: sgsFetch({ ok: false, status: 403 }) })
    expect(blocked.environment).toBe(true)
    expect(blocked.transient).toBe(true)
    const outage = await fetchFalListing({ source_url: FAL_URL }, { fetchImpl: sgsFetch({ ok: false, status: 503 }) })
    expect(outage.environment).toBeFalsy()
    expect(outage.transient).toBe(true)
  })
})

describe('enrichAmountViaSamFal — honest answer split', () => {
  const listing = (financial) => hits([{ _id: FAL_ID, programNumber: '93.867', financial }])

  it('extracts a real range from the listing financial text', async () => {
    const f = sgsFetch(listing({
      additionalInfo: 'Research Grants (R): $12,400 to $2,178,277; Avg $422,981.',
    }))
    const res = await enrichAmountViaSamFal({ source_url: FAL_URL }, { fetchImpl: f })
    expect(res.found).toBe(true)
    expect(res.page_read).toBe(true)
    expect(res.reason).toBe('sam_fal_api')
    expect(res.amounts.amount_min).toBe(12_400)
    expect(res.amounts.amount_max).toBe(2_178_277)
  })

  it('prose without a figure becomes an honest TEXT label, never a number', async () => {
    const f = sgsFetch(listing({
      additionalInfo: 'Please refer to the Notice of Funding Opportunity once posted on Grants.Gov.',
    }))
    const res = await enrichAmountViaSamFal({ source_url: FAL_URL }, { fetchImpl: f })
    expect(res.found).toBe(false)
    expect(res.page_read).toBe(true)
    expect(res.amount_text).toContain('Notice of Funding Opportunity')
    expect(res.amounts).toBeUndefined()
  })

  it('a listing publishing no financial text at all is an evidenced denial', async () => {
    const f = sgsFetch(listing(undefined))
    const res = await enrichAmountViaSamFal({ source_url: FAL_URL }, { fetchImpl: f })
    expect(res.found).toBe(false)
    expect(res.page_read).toBe(true)
    expect(res.reason).toBe('no_award_amount_published')
  })

  it('an environment block neither answers nor burns (page_read false, environment true)', async () => {
    const res = await enrichAmountViaSamFal({ source_url: FAL_URL }, { fetchImpl: sgsFetch({ ok: false, status: 403 }) })
    expect(res.attempted).toBe(true)
    expect(res.page_read).toBe(false)
    expect(res.environment).toBe(true)
    expect(res.transient).toBe(true)
  })

  it('declines rows it does not own so the caller falls through', async () => {
    const res = await enrichAmountViaSamFal({ source: 'web_search', source_url: 'https://example.org/x' }, { fetchImpl: sgsFetch({}) })
    expect(res.attempted).toBe(false)
  })
})

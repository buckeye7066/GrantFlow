/**
 * federalRegisterAmountAdapter.test.js
 *
 * The defect this adapter closes: 19 active-pipeline federalregister.gov rows
 * burned as unreadable while the FR's keyless API serves every document's FULL
 * plain text (`raw_text_url`) — including the award figures that sit past the
 * page fetcher's 12k-char window. The sharpest tests are the SSRF fence (the
 * API's raw_text_url is followed ONLY back onto federalregister.gov) and the
 * doc-number anchor (never a partial match).
 */

import { describe, it, expect, vi } from 'vitest'
import {
  isFederalRegisterRow,
  extractFrDocNumber,
  fetchFrDocumentText,
  enrichAmountViaFederalRegister,
} from '../services/sources/federalRegisterAmountAdapter.js'

const DOC_URL = 'https://www.federalregister.gov/documents/2025/07/23/2025-13802/some-notice-slug'
const RAW_URL = 'https://www.federalregister.gov/documents/full_text/text/2025/07/23/2025-13802.txt'

/** Fake fetch routing the metadata call and the raw-text call. */
const frFetch = ({ meta, text, metaStatus = 200, textStatus = 200 } = {}) =>
  vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/api/v1/documents/')) {
      return { ok: metaStatus === 200, status: metaStatus, json: async () => meta ?? { raw_text_url: RAW_URL } }
    }
    return { ok: textStatus === 200, status: textStatus, text: async () => text ?? '' }
  })

const LONG_PAD = 'Supplementary information follows. '.repeat(20)

describe('row identification and doc-number anchoring', () => {
  it('recognizes FR document URLs and the federal_register source', () => {
    expect(isFederalRegisterRow({ source_url: DOC_URL })).toBe(true)
    expect(isFederalRegisterRow({ source: 'federal_register' })).toBe(true)
    expect(extractFrDocNumber({ source_url: DOC_URL })).toBe('2025-13802')
    expect(extractFrDocNumber({ source: 'federal_register', source_id: '2025-13802' })).toBe('2025-13802')
  })

  it('never claims other rows and never partial-matches a doc number', () => {
    expect(isFederalRegisterRow({ source_url: 'https://www.grants.gov/search-results-detail/1' })).toBe(false)
    expect(extractFrDocNumber({ source_id: 'not-2025-13802-doc' })).toBeNull()
    expect(extractFrDocNumber({ source_url: 'https://www.federalregister.gov/agencies/irs' })).toBeNull()
  })
})

describe('fetchFrDocumentText — the SSRF fence', () => {
  it('refuses a raw_text_url that points off federalregister.gov', async () => {
    const f = frFetch({ meta: { raw_text_url: 'https://evil.example.com/steal.txt' } })
    const res = await fetchFrDocumentText('2025-13802', { fetchImpl: f })
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('no_raw_text_url')
    // Only the metadata call may have gone out.
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('reads the full text when the pointer stays on federalregister.gov', async () => {
    const f = frFetch({ text: `${LONG_PAD} Awards of up to $25,000 will be made. ${LONG_PAD}` })
    const res = await fetchFrDocumentText('2025-13802', { fetchImpl: f })
    expect(res.ok).toBe(true)
    expect(res.text).toContain('$25,000')
  })

  it('classifies 403 as ENVIRONMENT and 5xx as transient', async () => {
    const blocked = await fetchFrDocumentText('2025-13802', { fetchImpl: frFetch({ metaStatus: 403 }) })
    expect(blocked.environment).toBe(true)
    expect(blocked.transient).toBe(true)
    const outage = await fetchFrDocumentText('2025-13802', { fetchImpl: frFetch({ metaStatus: 503 }) })
    expect(outage.environment).toBeFalsy()
    expect(outage.transient).toBe(true)
  })
})

describe('enrichAmountViaFederalRegister — honest answer split', () => {
  const row = { source_url: DOC_URL }

  it('extracts a per-award figure from deep document text', async () => {
    const f = frFetch({ text: `${LONG_PAD} Individual awards range from $5,000 to $20,000 per recipient. ${LONG_PAD}` })
    const res = await enrichAmountViaFederalRegister(row, { fetchImpl: f })
    expect(res.found).toBe(true)
    expect(res.page_read).toBe(true)
    expect(res.reason).toBe('federal_register_api')
    expect(res.amounts.amount_min).toBe(5_000)
    expect(res.amounts.amount_max).toBe(20_000)
  })

  it('a document stating no per-award figure is an evidenced read, not a burn', async () => {
    const f = frFetch({ text: `${LONG_PAD} The IRS is inviting comments on the information collection request outlined in this notice. ${LONG_PAD}` })
    const res = await enrichAmountViaFederalRegister(row, { fetchImpl: f })
    expect(res.found).toBe(false)
    expect(res.page_read).toBe(true)
    expect(res.reason).toBe('no_per_award_amount_in_document')
  })

  it('an environment block neither answers nor burns', async () => {
    const res = await enrichAmountViaFederalRegister(row, { fetchImpl: frFetch({ metaStatus: 403 }) })
    expect(res.attempted).toBe(true)
    expect(res.page_read).toBe(false)
    expect(res.environment).toBe(true)
  })

  it('declines rows it does not own so the caller falls through', async () => {
    const res = await enrichAmountViaFederalRegister({ source_url: 'https://example.org/x' }, { fetchImpl: frFetch({}) })
    expect(res.attempted).toBe(false)
  })
})

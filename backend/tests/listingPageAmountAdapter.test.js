/**
 * listingPageAmountAdapter — title-anchored amount reads on multi-award
 * LISTING pages (the `unanswered_unreadable` ww5.clevelandstatecc.edu class,
 * Anya report 2026-07-27).
 *
 * The load-bearing assertions:
 *   - a row can NEVER be handed a sibling award's figure (whole-page
 *     extraction on the same fixture DOES return the sibling's $1,000 — the
 *     A/B proves the anchor is what prevents the misattribution);
 *   - a program whose own section states no figure gets an honest
 *     section-scoped answer, never a fabricated number;
 *   - a title the page does not name is a stable NON-denial
 *     (`page_read:false`): a closed portal listing means "we cannot see the
 *     program", not "the funder publishes nothing";
 *   - the fetched URL is always the REGISTRY's live URL, never the row's own
 *     (the row's host is dead — that is the point of the adapter).
 */

import { describe, it, expect, vi } from 'vitest'

import {
  LISTING_PAGES,
  findListingPageEntry,
  isListingPageRow,
  findTitleAnchor,
  extractAnchoredAmounts,
  enrichAmountViaListingPage,
} from '../services/sources/listingPageAmountAdapter.js'
import { findAmountAdapter } from '../services/sources/amountAdapters.js'
import { extractAwardAmountsFromText } from '../services/awardAmountExtractor.js'

// Mirrors the live CSCC portal's geometry (measured 2026-07-27): the umbrella
// Foundation section sits early with NO figure of its own; the sibling
// Presidential Honors section carries its "Award amount: $1,000" within ~430
// chars of its OWN heading but far (>500) from the umbrella's anchor.
const PORTAL_TEXT = [
  'Scholarship Opportunities at Cleveland State.',
  'CSCC Alumni Legacy Scholarship. Cleveland State Foundation Scholarships - The',
  'Cleveland State Foundation offers more than 200 scholarship opportunities to help',
  'students achieve their educational goals. To be considered for Foundation',
  'scholarships, you must first be admitted to Cleveland State Community College.',
  'One Application. Hundreds of Opportunities - Scholarships can help cover tuition,',
  'books, fees, and other educational expenses. Complete the general application to',
  'be matched with the awards you qualify for. Filter by category, review the',
  'minimum requirements for each award, and submit any supplemental materials the',
  'donor asks for before the posted deadline each spring semester.',
  'Presidential Honors Scholarship - The scholarship provides financial support to',
  'academically motivated students by assisting with the cost of books and other',
  'educational expenses. Recipients of the scholarship will join the Honors College',
  'at Cleveland State. Award amount: $1,000 per semester for up to four semesters.',
  'Minimum Requirements: 3.5 GPA.',
].join(' ')

const VARIES_TEXT =
  'Available Scholarships. Foundation Scholarships - Each year the Cleveland State ' +
  'Community College Foundation provides a number of scholarships based on academic ' +
  'achievement and need. Award amounts vary. Minimum Requirements: 2.0 college GPA.'

const UMBRELLA_ROW = Object.freeze({
  title: 'Cleveland State Community College Foundation Scholarships',
  source_url: 'https://ww5.clevelandstatecc.edu/foundation/home/',
  application_url: 'https://ww5.clevelandstatecc.edu/foundation/home/',
})

const okFetcher = (body) => ({ fetch: vi.fn(async () => ({ ok: true, status: 200, body })) })
const asHtml = (text) => `<html><body><main>${text}</main></body></html>`

describe('registry routing', () => {
  it('owns rows on the dead ww5 host AND rows already repaired onto the portal', () => {
    expect(findListingPageEntry(UMBRELLA_ROW)?.id).toBe('cscc_scholarship_portal')
    expect(
      findListingPageEntry({
        source_url: 'https://clevelandstatecc.scholarships.ngwebsolutions.com/Scholarships/Search',
      })?.id,
    ).toBe('cscc_scholarship_portal')
  })

  it('does not own unrelated rows (caller falls through unchanged)', () => {
    expect(findListingPageEntry({ source_url: 'https://www.grants.gov/search-results-detail/1' })).toBeNull()
    expect(isListingPageRow({ source: 'web_search' })).toBe(false)
    expect(findListingPageEntry(null)).toBeNull()
  })

  it('is reachable through the shared AMOUNT_ADAPTERS registry', () => {
    expect(findAmountAdapter(UMBRELLA_ROW)?.id).toBe('listing_page')
  })

  it('every registry entry fetches a frozen https URL of its own (never row data)', () => {
    for (const entry of LISTING_PAGES) {
      expect(entry.fetchUrl, `${entry.id}.fetchUrl`).toMatch(/^https:\/\//)
      expect(entry.matchHosts.length, `${entry.id}.matchHosts`).toBeGreaterThan(0)
    }
  })
})

describe('findTitleAnchor', () => {
  it('anchors a sponsor-prefixed umbrella title at the page\'s own shorter heading', () => {
    const anchor = findTitleAnchor(PORTAL_TEXT, 'Cleveland State Community College Foundation Scholarships')
    expect(anchor).not.toBeNull()
    expect(PORTAL_TEXT.slice(anchor.index, anchor.index + 40)).toMatch(/^Foundation Scholarships/)
  })

  it('matches across punctuation in the title', () => {
    const text = 'The Adrienne Emond/Delta Kappa Gamma Scholarship supports future teachers.'
    expect(findTitleAnchor(text, 'Adrienne Emond/Delta Kappa Gamma Scholarship')).not.toBeNull()
  })

  it('never anchors on an all-generic suffix', () => {
    expect(findTitleAnchor('Scholarships and grants for everyone.', 'The Scholarships')).toBeNull()
  })

  it('returns null when the program is not named on the page', () => {
    expect(findTitleAnchor(PORTAL_TEXT, 'Buddy & Opal Neely Memorial Scholarship')).toBeNull()
  })
})

describe('extractAnchoredAmounts — the misattribution guard', () => {
  it('A/B: whole-page extraction DOES return the sibling\'s $1,000 (the defect)', () => {
    const wholePage = extractAwardAmountsFromText(PORTAL_TEXT)
    expect(wholePage.amount_max).toBe(1000)
  })

  it('the umbrella row is never handed the sibling\'s figure', () => {
    const res = extractAnchoredAmounts(PORTAL_TEXT, UMBRELLA_ROW.title)
    expect(res.anchored).toBe(true)
    expect(res.amounts).toBeUndefined()
  })

  it('the sibling row still gets its OWN nearby figure', () => {
    const res = extractAnchoredAmounts(PORTAL_TEXT, 'Presidential Honors Scholarship')
    expect(res.anchored).toBe(true)
    expect(res.amounts?.amount_max).toBe(1000)
  })

  it('a section stating "Award amounts vary" yields the varies status, not a number', () => {
    const res = extractAnchoredAmounts(VARIES_TEXT, 'Cleveland State Community College Foundation Scholarships')
    expect(res.anchored).toBe(true)
    expect(res.amounts).toBeUndefined()
    expect(res.amount_status).toBe('varies')
    expect(res.amount_text).toMatch(/vary/i)
  })

  it('reports anchored:false when the title is absent', () => {
    expect(extractAnchoredAmounts(PORTAL_TEXT, 'Buddy & Opal Neely Memorial Scholarship').anchored).toBe(false)
  })
})

describe('enrichAmountViaListingPage', () => {
  it('fetches the REGISTRY URL, not the row\'s dead one', async () => {
    const fetcher = okFetcher(asHtml(PORTAL_TEXT))
    await enrichAmountViaListingPage(UMBRELLA_ROW, { fetcher })
    expect(fetcher.fetch).toHaveBeenCalledWith(
      'https://clevelandstatecc.scholarships.ngwebsolutions.com/Scholarships/Search',
    )
  })

  it('returns attempted:false for rows it does not own', async () => {
    const res = await enrichAmountViaListingPage({ source_url: 'https://example.org/x' }, {})
    expect(res.attempted).toBe(false)
  })

  it('anchored numeric figure → found, with the conservative extractor\'s amounts', async () => {
    const res = await enrichAmountViaListingPage(
      { ...UMBRELLA_ROW, title: 'Presidential Honors Scholarship' },
      { fetcher: okFetcher(asHtml(PORTAL_TEXT)) },
    )
    expect(res).toMatchObject({ attempted: true, page_read: true, found: true })
    expect(res.amounts.amount_max).toBe(1000)
  })

  it('umbrella section with no figure → page_read with NO number (never the sibling\'s)', async () => {
    const res = await enrichAmountViaListingPage(UMBRELLA_ROW, { fetcher: okFetcher(asHtml(PORTAL_TEXT)) })
    expect(res).toMatchObject({ attempted: true, page_read: true, found: false })
    expect(res.amounts).toBeUndefined()
  })

  it('"Award amounts vary" section → varies text answer', async () => {
    const res = await enrichAmountViaListingPage(UMBRELLA_ROW, { fetcher: okFetcher(asHtml(VARIES_TEXT)) })
    expect(res).toMatchObject({ attempted: true, page_read: true, found: false, amount_status: 'varies' })
  })

  it('title not on the page → stable NON-denial (page_read stays false)', async () => {
    const res = await enrichAmountViaListingPage(
      { ...UMBRELLA_ROW, title: 'Buddy & Opal Neely Memorial Scholarship' },
      { fetcher: okFetcher(asHtml(PORTAL_TEXT)) },
    )
    expect(res).toMatchObject({
      attempted: true,
      page_read: false,
      transient: false,
      found: false,
      reason: 'listing_title_not_found',
    })
  })

  it('403 → environment (parked, never burned); 500 → transient; thin body → thin_page', async () => {
    const status = (s) => ({ fetch: async () => ({ ok: false, status: s, body: null }) })
    const blocked = await enrichAmountViaListingPage(UMBRELLA_ROW, { fetcher: status(403) })
    expect(blocked).toMatchObject({ attempted: true, environment: true, transient: true, page_read: false })
    const outage = await enrichAmountViaListingPage(UMBRELLA_ROW, { fetcher: status(500) })
    expect(outage).toMatchObject({ attempted: true, transient: true, environment: false })
    const thin = await enrichAmountViaListingPage(UMBRELLA_ROW, { fetcher: okFetcher('<html></html>') })
    expect(thin).toMatchObject({ attempted: true, page_read: false, transient: false, reason: 'thin_page' })
  })

  it('a throwing fetcher is retryable, never fatal', async () => {
    const res = await enrichAmountViaListingPage(UMBRELLA_ROW, {
      fetcher: { fetch: async () => { throw new Error('boom') } },
    })
    expect(res).toMatchObject({ attempted: true, transient: true, found: false })
  })
})

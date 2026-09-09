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

const ETF_ROW = Object.freeze({
  title: 'East Tennessee Foundation',
  source_url: 'https://www.easttennesseefoundation.org/nonprofits/apply-for-grants/',
  application_url: 'https://www.easttennesseefoundation.org/nonprofits/apply-for-grants/',
})

const ETF_TEXT = [
  'APPLY FOR GRANTS',
  'East Tennessee Foundation strengthens communities through grantmaking.',
  'Review the eligibility rules, then continue into the grants portal to see the programs we offer.',
  'GRANTS WE OFFER',
  'Organizations can explore open cycles, deadlines, and application guidance here.',
  'Questions? Contact the foundation for assistance with the portal.',
  'Additional applicant instructions and FAQ are available before you begin the application.',
  'This page lists process guidance only and does not publish one umbrella award amount.',
].join(' ')

const UWF_ROOT = 'https://uwf.edu/admissions/undergraduate/cost-and-financial-aid/awards-and-scholarships/'
const UWF_FRESHMAN_TEXT = [
  'Freshman Scholarships.',
  'Students have opportunities to compete for full tuition, on-campus housing, and meal plans.',
  'Academic merit awards include annual awards from $2,000 through $8,000 depending on the program.',
  'Awards and requirements are subject to change annually.',
  'Review each scholarship program and its eligibility requirements before applying.',
].join(' ')
const UWF_TRANSFER_TEXT = [
  'Transfer Scholarships.',
  'Amounts indicate potential award over two years and range from $2,000 to $4,000 by program.',
  'Phi Theta Kappa members may receive up to $4,000.',
  'Foundation Scholarships. Value: Amounts Vary.',
  'Students should review the separate qualifications for each transfer scholarship opportunity.',
].join(' ')
const OHIO_TRANSFER_TEXT = [
  // Production htmlToText() starts at the page's <main>; the H1
  // "Transfer Scholarships" sits outside it. This is the exact page-owned
  // heading and concatenated heading/body shape observed on 2026-09-09.
  'Opportunities for Transfer StudentsMerit scholarships are available in limited quantity for transfer students.',
  'These awards are competitive and provide from $1,000 to $3,000 toward tuition expenses.',
  'A separate Phi Theta Kappa scholarship provides $3,000 to eligible transfer students.',
  'Awards are applied to tuition after admission and enrollment requirements are confirmed.',
].join(' ')
const HOWARD_TRANSFER_TEXT = [
  'Transfer Scholarships.',
  'Transfer scholarships are allocated for tuition and fees only.',
  'Allocations for Transfer scholarships may change every year.',
  'Transfer scholarships may not be available every year and students should review current financial aid guidance.',
].join(' ')

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
    // Path-prefixed MTSU entry must not steal a random mtsu.edu award page.
    expect(findListingPageEntry({ source_url: 'https://www.mtsu.edu/financial-aid/hope' })).toBeNull()
    expect(findListingPageEntry(null)).toBeNull()
  })

  it('owns the MTSU CS awards page by host+path, never by host alone', () => {
    expect(
      findListingPageEntry({ source_url: 'https://www.mtsu.edu/csc/scholarships/' })?.id,
    ).toBe('mtsu_cs_scholarships')
    expect(
      findListingPageEntry({ source_url: 'https://mtsu.edu/csc/scholarships' })?.id,
    ).toBe('mtsu_cs_scholarships')
  })

  it('owns the exact East Tennessee Foundation landing pages, never a deeper grant subpage', () => {
    expect(findListingPageEntry(ETF_ROW)?.id).toBe('east_tennessee_foundation_grants_index')
    expect(
      findListingPageEntry({ source_url: 'https://www.easttennesseefoundation.org/grants/' })?.id,
    ).toBe('east_tennessee_foundation_grants_index')
    expect(
      findListingPageEntry({ source_url: 'https://www.easttennesseefoundation.org/grants/special-fund/' }),
    ).toBeNull()
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

  it('routes same-URL UWF umbrella rows by exact title and never claims an unrelated title', () => {
    expect(findListingPageEntry({ title: 'Freshman Scholarships', source_url: UWF_ROOT })?.id).toBe(
      'uwf_freshman_scholarships',
    )
    expect(findListingPageEntry({ title: 'Transfer Scholarships', source_url: UWF_ROOT })?.id).toBe(
      'uwf_transfer_scholarships',
    )
    expect(findListingPageEntry({ title: 'Other Scholarships', source_url: UWF_ROOT })).toBeNull()
  })

  it('keeps the replacement UWF transfer URL inside the exact-title adapter', () => {
    expect(
      findListingPageEntry({
        title: 'Transfer Scholarships',
        source_url: 'https://uwf.edu/admissions/transfer/transfer-scholarships/',
      })?.id,
    ).toBe('uwf_transfer_scholarships')
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

  it('known ETF landing page with no per-award figure yields a page_read answer, not unreadable forever', async () => {
    const res = await enrichAmountViaListingPage(ETF_ROW, { fetcher: okFetcher(asHtml(ETF_TEXT)) })
    expect(res).toMatchObject({
      attempted: true,
      page_read: true,
      transient: false,
      found: false,
    })
  })
})

// Verbatim geometry of https://www.mtsu.edu/csc/scholarships/ (fetched 2026-08-18):
// Wahl / Thweatt / Outstanding Student Award state NO figure; S-STEM later on
// the same page states "up to $6000.00 per year". Whole-page extraction would
// hand that sibling figure to any of the three — the Coca-Cola class.
const MTSU_CS_TEXT = [
  'Awards and Scholarships. Computer Science Department Award. The Computer Science',
  'Department Award is given to a senior Computer Science major for high academic',
  'achievement. This involves a monetary award as well as a certificate.',
  'Outstanding Student Award. Each year Computer Science faculty members nominate',
  'and select students they feel are outstanding in their class: Outstanding Freshman,',
  'Sophomore, Junior and Senior. The winners are recognized at the awards ceremony.',
  'The Dr. Nancy Wahl Scholarship has been created through the generosity of Drs.',
  'Nancy and Robert Wahl. Scholarships will be awarded to computer science students',
  'based on academic achievement and need. Please refer to the Scholarships Website',
  'for details and to apply. Female students are especially encouraged to apply.',
  'The Mack Thweatt Scholarship has been created in honor of Professor Emeritus Dr.',
  'Mack Thweatt. To be eligible for consideration for this scholarship, a student must',
  'be a Tennessee resident, enrolled as a full-time student, be a Computer Science',
  'major, and have at least a 3.0 GPA. Please refer to the Scholarships Website for',
  'details and to apply.',
  'A scholarship has been created in honor of Mr. Homer Brown, Professor Emeritus.',
  'Dr. Richard Detmer, Professor Emeritus, has endowed a scholarship to be awarded',
  'annually on the basis of academic excellence, to a Computer Science major who is',
  'a sophomore or junior and who has completed at least 10 hours of computer science',
  'courses at MTSU.',
  'S-STEM Scholarship Program in Computer Science. With funding from the National',
  'Science Foundation Scholarships in Science, Technology, Engineering and Mathematics',
  'program, the NSF S-STEM Scholarship Program is providing support to low-income',
  'students with demonstrated financial need. Be a U.S. citizen or national. Be a full',
  'time student. Be Pell-eligible. Be a Computer Science major. Have a GPA of 2.50 or',
  'higher. Each scholarship recipient will receive up to $6000.00 per year for the first',
  '2 years and up to $3000 for the 3rd year as long as he/she meets the scholarship',
  'criteria each year.',
].join(' ')

const MTSU_CS_ROW = Object.freeze({
  title: 'Dr. Nancy Wahl Scholarship',
  source_url: 'https://www.mtsu.edu/csc/scholarships/',
})

describe('MTSU CS listing — amount_recall_miss titles never inherit S-STEM dollars', () => {
  it('A/B: whole-page extraction DOES return the sibling S-STEM $6,000 (the defect)', () => {
    const wholePage = extractAwardAmountsFromText(MTSU_CS_TEXT)
    expect(wholePage.amount_max).toBe(6000)
  })

  it('Wahl / Thweatt / Outstanding Student Award get no number from the S-STEM section', () => {
    for (const title of [
      'Dr. Nancy Wahl Scholarship',
      'Mack Thweatt Scholarship',
      'Outstanding Student Award',
    ]) {
      const res = extractAnchoredAmounts(MTSU_CS_TEXT, title)
      expect(res.anchored, title).toBe(true)
      expect(res.amounts, title).toBeUndefined()
    }
  })

  it('the S-STEM row still gets its OWN nearby figure', () => {
    const res = extractAnchoredAmounts(MTSU_CS_TEXT, 'S-STEM Scholarship Program in Computer Science')
    expect(res.anchored).toBe(true)
    expect(res.amounts?.amount_max).toBe(6000)
  })

  it('enrichment records a page_read with no figure for Wahl (honest none-published path)', async () => {
    const res = await enrichAmountViaListingPage(MTSU_CS_ROW, { fetcher: okFetcher(asHtml(MTSU_CS_TEXT)) })
    expect(res).toMatchObject({ attempted: true, page_read: true, found: false })
    expect(res.amounts).toBeUndefined()
  })
})

describe('official title-specific pages close the recurring amount-recall gap', () => {
  it.each([
    {
      title: 'Freshman Scholarships',
      sourceUrl: UWF_ROOT,
      expectedFetchUrl: 'https://uwf.edu/admissions/undergraduate/cost-and-financial-aid/awards-and-scholarships/freshman-scholarships/',
      body: UWF_FRESHMAN_TEXT,
    },
    {
      title: 'Transfer Scholarships',
      sourceUrl: UWF_ROOT,
      expectedFetchUrl: 'https://uwf.edu/admissions/transfer/transfer-scholarships/',
      body: UWF_TRANSFER_TEXT,
    },
    {
      title: 'Transfer Scholarships',
      sourceUrl: 'https://financialservices.howard.edu/grants-scholarships-and-other-opportunities',
      expectedFetchUrl: 'https://financialservices.howard.edu/grants-scholarships-and-other-opportunities',
      body: HOWARD_TRANSFER_TEXT,
    },
  ])('$title at $sourceUrl records a source-stated varying amount instead of a sibling number', async ({
    title,
    sourceUrl,
    expectedFetchUrl,
    body,
  }) => {
    const fetcher = okFetcher(asHtml(body))
    const result = await enrichAmountViaListingPage({ title, source_url: sourceUrl }, { fetcher })

    expect(fetcher.fetch).toHaveBeenCalledWith(expectedFetchUrl)
    expect(result).toMatchObject({
      attempted: true,
      page_read: true,
      transient: false,
      found: false,
      amount_status: 'varies',
    })
    expect(result.amounts).toBeUndefined()
  })

  it('extracts Ohio University\'s own published $1,000-$3,000 transfer range', async () => {
    const sourceUrl = 'https://www.ohio.edu/admissions/tuition/transfer-scholarships'
    const result = await enrichAmountViaListingPage(
      { title: 'Transfer Scholarships', source_url: sourceUrl },
      { fetcher: okFetcher(asHtml(OHIO_TRANSFER_TEXT)) },
    )

    expect(result).toMatchObject({ attempted: true, page_read: true, found: true })
    expect(result.amounts).toMatchObject({ amount_min: 1000, amount_max: 3000 })
  })

  it('prefers an evidenced page-owned anchor when the generic row title also appears without an amount', async () => {
    const sourceUrl = 'https://www.ohio.edu/admissions/tuition/transfer-scholarships'
    const bothHeadings = [
      'Transfer Scholarships. General transfer information and navigation.',
      'Overview details '.repeat(80),
      OHIO_TRANSFER_TEXT,
    ].join(' ')
    const result = await enrichAmountViaListingPage(
      { title: 'Transfer Scholarships', source_url: sourceUrl },
      { fetcher: okFetcher(asHtml(bothHeadings)) },
    )

    expect(result).toMatchObject({ attempted: true, page_read: true, found: true })
    expect(result.amounts).toMatchObject({ amount_min: 1000, amount_max: 3000 })
  })

  it('never falls through to sibling numbers when a registered umbrella status marker disappears', async () => {
    const changedPage = UWF_FRESHMAN_TEXT.replace(
      'Awards and requirements are subject to change annually.',
      'Please review the current scholarship catalog for program-specific terms and updates.',
    )
    const result = await enrichAmountViaListingPage(
      { title: 'Freshman Scholarships', source_url: UWF_ROOT },
      { fetcher: okFetcher(asHtml(changedPage)) },
    )

    expect(result).toMatchObject({
      attempted: true,
      page_read: false,
      transient: false,
      found: false,
      reason: 'listing_status_marker_not_found',
    })
    expect(result.amounts).toBeUndefined()
  })
})

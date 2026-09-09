import { describe, expect, it } from 'vitest'
import { enrichAmountViaListingPage } from '../services/sources/listingPageAmountAdapter.js'
import { findAmountAdapter } from '../services/sources/amountAdapters.js'

const scholarship = { title: 'Argo Cyber Emerging Scholars (ACES)', source_url: 'https://uwf.academicworks.com/' }
const stipend = { title: 'Argo Cyber Emerging Scholars Stipend (ACES)', source_url: 'https://uwf.academicworks.com/' }
const page = (title, award, extra = '') => `<main><h3>${title}</h3>
  <p>The scholarship supports students preparing for cybersecurity careers in government.
  Recipients complete a summer internship and participate in professional development.
  For more information contact aces@uwf.edu.</p>
  <dl><dt>Award</dt><dd>${award}</dd></dl>${extra}</main>`
const read = (row, body, expectedUrl) => enrichAmountViaListingPage(row, {
  fetcher: { fetch: async url => {
    expect(url).toBe(expectedUrl)
    return { ok: true, status: 200, body }
  } },
})

describe('AcademicWorks award answers', () => {
  it('reads the named scholarship detail instead of taking a sibling amount from the portal', async () => {
    const result = await read(scholarship, page(scholarship.title, 'Varies',
      '<p>Supplemental question: explain how a $50,000 family income affects your application.</p>'),
    'https://uwf.academicworks.com/opportunities/9039')
    expect(result).toMatchObject({ attempted: true, page_read: true, found: false, amount_status: 'varies' })
    expect(result.amount_text).toBe('Award: Varies')
    expect(result.amounts).toBeUndefined()
  })

  it('retains the source zero display and contact instruction without inventing a stipend', async () => {
    const result = await read(stipend, page(stipend.title, '$0.00'),
      'https://uwf.academicworks.com/opportunities/9430')
    expect(result).toMatchObject({ attempted: true, page_read: true, found: false, amount_status: 'contact_required' })
    expect(result.amount_text).toContain('Award: $0.00')
    expect(result.amount_text).toContain('contact aces@uwf.edu')
    expect(result.amounts).toBeUndefined()
  })

  it('reads a later positive value from the award field only', async () => {
    const result = await read(stipend, page(stipend.title, '$12,000', '<p>Other funding: $50,000 per student.</p>'),
      'https://uwf.academicworks.com/opportunities/9430')
    expect(result).toMatchObject({ page_read: true, found: true,
      amounts: { amount_min: 12000, amount_max: 12000, amount_status: 'known' } })
  })

  it('retains the official description when AcademicWorks places it inside its section header', async () => {
    const body = `<main><header class="section-header main"><h3>${stipend.title}</h3>
      <p>The NSF CyberCorps Scholarship for Service program trains cybersecurity professionals.
      For more information contact <a href="mailto:aces@uwf.edu">aces@uwf.edu</a>.</p></header>
      <dl><dt>Award</dt><dd>$0.00</dd></dl>
      <p>Complete the General Application to be considered. Award recipients must complete
      a government internship and participate in professional development activities.
      Applications require all requested supporting materials before the deadline.</p></main>`
    const result = await read(stipend, body, 'https://uwf.academicworks.com/opportunities/9430')
    expect(result).toMatchObject({ page_read: true, found: false, amount_status: 'contact_required' })
    expect(result.amount_text).toBe('Award: $0.00. For more information contact aces@uwf.edu.')
  })

  it('does not borrow a contact instruction outside the named award description', async () => {
    const body = page(stipend.title, '$0.00')
      .replace(`<h3>${stipend.title}</h3>`, `<header><h3>${stipend.title}</h3></header>`)
    const result = await read(stipend, body, 'https://uwf.academicworks.com/opportunities/9430')
    expect(result).toMatchObject({ page_read: false, found: false, reason: 'structured_award_zero_unresolved' })
    expect(result.amount_status).toBeUndefined()
  })

  it.each([
    ['wrong heading', page('A Different Award', 'Varies', `<p>See ${scholarship.title}.</p>`)],
    ['missing field', page(scholarship.title, 'Varies').replace('<dt>Award</dt>', '<dt>Other</dt>')],
    ['conflicting fields', page(scholarship.title, 'Varies', '<dl><dt>Award</dt><dd>$5,000</dd></dl>')],
    ['unresolved zero', page(scholarship.title, '$0.00').replace('For more information contact aces@uwf.edu.', '')],
  ])('keeps %s unresolved instead of recording a false answer', async (_label, body) => {
    const result = await read(scholarship, body, 'https://uwf.academicworks.com/opportunities/9039')
    expect(result).toMatchObject({ attempted: true, page_read: false, found: false })
    expect(result.amounts).toBeUndefined()
    expect(result.amount_status).toBeUndefined()
  })

  it('keeps ownership on the exact school, title and source paths', () => {
    expect(findAmountAdapter({ ...scholarship, source_url: 'https://uwf.academicworks.com/opportunities/9039' })?.id).toBe('listing_page')
    expect(findAmountAdapter({ ...scholarship, source_url: 'https://another.academicworks.com/' })).toBeNull()
    expect(findAmountAdapter({ ...scholarship, source_url: 'https://uwf.academicworks.com/opportunities/999' })).toBeNull()
    expect(findAmountAdapter({ ...scholarship, title: 'A Different Award' })).toBeNull()
  })
})

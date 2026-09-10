import { describe, expect, it } from 'vitest'
import { enrichOrgContact, extractContactEmails } from '../services/shared/orgContactEnrichment.js'

describe('contact discovery with malformed published mailto links', () => {
  it.each(['%', '%ZZ', '%E0%A4%A', '%FF'])('skips the malformed URI %s without losing valid contacts', (malformed) => {
    const html = `<a href="mailto:broken${malformed}@charity.org">Bad</a><a href="mailto:info%40charity.org">Email</a>`
    expect(extractContactEmails(html)).toEqual(['info@charity.org'])
  })

  it('decodes once without retaining a different, undecoded address', () => {
    expect(extractContactEmails('<a href="mailto:grants%2Bfund@charity.org">Email</a>')).toEqual(['grants+fund@charity.org'])
  })

  it('preserves plain addresses and valid escaped percent characters while rejecting junk', () => {
    const html = '<a href="MAILTO:Grants%25Fund%40charity.org?subject=hello">Email</a> info@charity.org noreply@charity.org logo@2x.png sales@example.com'
    expect(extractContactEmails(html)).toEqual(['grants%fund@charity.org', 'info@charity.org'])
  })

  it('does not retain a regex cursor from a malformed page in the next discovery call', () => {
    expect(extractContactEmails('<a href="mailto:invalid%">Bad</a>')).toEqual([])
    const html = '<a href="mailto:info%40charity.org">Email</a>'
    expect(extractContactEmails(html)).toEqual(['info@charity.org'])
    expect(extractContactEmails(html)).toEqual(['info@charity.org'])
  })

  it('continues to the contact page and retains each discovered field and its evidence URL', async () => {
    const fetched = []
    const result = await enrichOrgContact({ website: 'charity.org' }, {
      paths: ['', '/contact'],
      delayMs: 0,
      fetchImpl: async (url) => {
        fetched.push(url)
        return { ok: true, text: url.endsWith('/contact')
          ? '<a href="mailto:info%40charity.org">Email</a> Executive Director: Jane Smith'
          : '<a href="mailto:broken%ZZ@charity.org">Bad</a><a href="tel:614-555-0190">Call</a>' }
      },
    })
    expect(fetched).toEqual(['https://charity.org', 'https://charity.org/contact'])
    expect(result).toEqual({
      email: 'info@charity.org', phone: '(614) 555-0190',
      contact_name: 'Jane Smith', contact_title: 'Executive Director',
      source_url: 'https://charity.org', email_source_url: 'https://charity.org/contact',
    })
  })

  it('returns null instead of throwing or inventing a contact when every link is malformed', async () => {
    const result = await enrichOrgContact({ website: 'charity.org' }, {
      paths: [''], delayMs: 0,
      fetchImpl: async () => ({ ok: true, text: '<a href="mailto:broken%FF@charity.org">Bad</a>' }),
    })
    expect(result).toBeNull()
  })
})

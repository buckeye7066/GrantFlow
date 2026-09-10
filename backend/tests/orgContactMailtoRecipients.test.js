import { describe, expect, it } from 'vitest'
import { enrichOrgContact, extractContactEmails } from '../services/shared/orgContactEnrichment.js'

describe('mailto recipient boundaries in organization contact evidence', () => {
  it.each([
    ['multiple recipients', '<a href="mailto:info@charity.org,grants%40charity.org">Contact</a>', ['info@charity.org', 'grants@charity.org']],
    ['invalid recipient isolation', '<a href="mailto:broken%ZZ@charity.org,grants%40charity.org">Contact</a>', ['grants@charity.org']],
    ['body is not a recipient', '<a href="mailto:broken%ZZ@charity.org?body=support@vendor.com">Contact</a>', []],
    ['no recipient with header addresses', '<a href="mailto:?body=support@vendor.com&cc=admin@vendor.com">Contact</a>', []],
    ['legitimate recipient with query', '<a href="mailto:info@charity.org?body=support@vendor.com&subject=contact@vendor.com">Contact</a>', ['info@charity.org']],
    ['plain neighboring contact retained', '<a href="mailto:broken%ZZ@charity.org?body=support@vendor.com">Contact</a> info@charity.org', ['info@charity.org']],
    ['encoded comma is not a delimiter', '<a href="mailto:grants%2Cinfo%40charity.org">Contact</a>', []],
  ])('%s', (_name, html, expected) => {
    expect(extractContactEmails(html)).toEqual(expected)
  })

  it('does not persist a message-body vendor address when the actual recipient is malformed', async () => {
    const result = await enrichOrgContact({ website: 'charity.org' }, {
      paths: [''], delayMs: 0,
      fetchImpl: async () => ({ ok: true, text: '<a href="mailto:broken%ZZ@charity.org?body=support@vendor.com">Contact</a>' }),
    })
    expect(result).toBeNull()
  })

  it('retains a valid organization recipient from a multi-recipient contact link', async () => {
    const result = await enrichOrgContact({ website: 'charity.org' }, {
      paths: [''], delayMs: 0,
      fetchImpl: async () => ({ ok: true, text: '<a href="mailto:info@charity.org,grants%40charity.org?body=support@vendor.com">Contact</a>' }),
    })
    expect(result.email).toBe('info@charity.org')
    expect(result.email_source_url).toBe('https://charity.org')
  })
})

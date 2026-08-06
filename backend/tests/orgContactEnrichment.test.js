/**
 * Unit + integration tests for org contact-email enrichment.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  domainOf,
  extractContactEmails,
  pickBestOrgEmail,
  enrichOrgEmail,
  enrichOrgContact,
  extractPhones,
  extractContactName,
} from '../services/shared/orgContactEnrichment.js'
import {
  runYanaWebCrawl,
  registerWebSource,
  _clearWebSources,
} from '../services/yana/yanaWebCrawler.js'

describe('extractContactEmails', () => {
  it('pulls mailto + raw emails and drops junk/noreply/image false-positives', () => {
    const html = `
      <a href="mailto:info@helpinghands.org">Email us</a>
      Reach development@helpinghands.org or noreply@helpinghands.org.
      <img src="logo@2x.png">
      Vendor: sales@example.com
    `
    const emails = extractContactEmails(html)
    expect(emails).toContain('info@helpinghands.org')
    expect(emails).toContain('development@helpinghands.org')
    expect(emails).not.toContain('noreply@helpinghands.org')
    expect(emails).not.toContain('logo@2x.png')
    expect(emails).not.toContain('sales@example.com') // example.com junk domain
  })
})

describe('pickBestOrgEmail', () => {
  it('prefers same-domain, then role addresses', () => {
    const best = pickBestOrgEmail(
      ['person@gmail.com', 'info@helpinghands.org', 'bob@helpinghands.org'],
      { domain: 'helpinghands.org' },
    )
    expect(best).toBe('info@helpinghands.org')
  })
  it('returns null on empty', () => {
    expect(pickBestOrgEmail([], { domain: 'x.org' })).toBeNull()
  })
})

describe('domainOf', () => {
  it('strips scheme + www', () => {
    expect(domainOf('https://www.HelpingHands.org/contact')).toBe('helpinghands.org')
    expect(domainOf('helpinghands.org')).toBe('helpinghands.org')
    expect(domainOf('')).toBeNull()
  })
})

describe('extractPhones', () => {
  it('normalizes US phones from tel: links and text, dropping junk', () => {
    const html = '<a href="tel:+1 (614) 555-0190">call</a> or 614.555.0123. Fax 000-000-0000.'
    const phones = extractPhones(html)
    expect(phones).toContain('(614) 555-0190')
    expect(phones).toContain('(614) 555-0123')
    expect(phones).not.toContain('(000) 000-0000')
  })
})

describe('extractContactName', () => {
  it('reads "Title: Name"', () => {
    expect(extractContactName('<p>Executive Director: Jane Smith</p>')).toEqual({ name: 'Jane Smith', title: 'Executive Director' })
  })
  it('reads "Name, Title"', () => {
    expect(extractContactName('Contact Maria Lopez-Reyes, Development Director today')).toEqual({ name: 'Maria Lopez-Reyes', title: 'Development Director' })
  })
  it('returns null without an explicit role', () => {
    expect(extractContactName('Welcome to our homepage')).toBeNull()
  })
})

describe('enrichOrgContact', () => {
  const noDelay = async () => {}
  it('gathers email + phone + contact person across pages', async () => {
    const fetchImpl = async (url) => {
      if (url.endsWith('/contact')) {
        return { ok: true, text: '<a href="mailto:info@hh.org">email</a> <a href="tel:614-555-0190">call</a> Executive Director: Jane Smith' }
      }
      return { ok: true, text: 'home' }
    }
    const r = await enrichOrgContact({ website: 'hh.org' }, { fetchImpl, delay: noDelay, delayMs: 0 })
    expect(r).toMatchObject({
      email: 'info@hh.org',
      phone: '(614) 555-0190',
      contact_name: 'Jane Smith',
      contact_title: 'Executive Director',
    })
  })
  it('back-compat enrichOrgEmail still returns email only', async () => {
    const fetchImpl = async (u) => (u.endsWith('/contact') ? { ok: true, text: 'mailto:info@hh.org' } : { ok: true, text: 'home' })
    expect(await enrichOrgEmail({ website: 'hh.org' }, { fetchImpl, delay: noDelay, delayMs: 0 })).toMatchObject({ email: 'info@hh.org' })
  })
})

describe('enrichOrgEmail', () => {
  const noDelay = async () => {}

  it('finds a contact email on the org site', async () => {
    const fetchImpl = async (url) => {
      if (url.endsWith('/contact')) return { ok: true, text: '<a href="mailto:info@helpinghands.org">' }
      return { ok: true, text: '<html>home, no email</html>' }
    }
    const r = await enrichOrgEmail({ website: 'helpinghands.org' }, { fetchImpl, delay: noDelay, delayMs: 0 })
    expect(r).toMatchObject({ email: 'info@helpinghands.org' })
    expect(r.source_url).toMatch(/\/contact$/)
  })

  it('returns null when no website or no email found', async () => {
    expect(await enrichOrgEmail({}, { fetchImpl: async () => ({ ok: true, text: '' }) })).toBeNull()
    const r = await enrichOrgEmail({ website: 'x.org' }, { fetchImpl: async () => ({ ok: true, text: 'no contact here' }), delay: noDelay, delayMs: 0 })
    expect(r).toBeNull()
  })

  it('skips pages disallowed by robots', async () => {
    const fetchImpl = async () => ({ ok: true, text: 'mailto:info@x.org' })
    const robotsCheck = async () => ({ allowed: false })
    expect(await enrichOrgEmail({ website: 'x.org' }, { fetchImpl, robotsCheck, delay: noDelay, delayMs: 0 })).toBeNull()
  })
})

describe('crawler integration — enrichment makes a website-only org qualifiable', () => {
  function makeDb() {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE organizations (
      id TEXT PRIMARY KEY, name TEXT, email TEXT, phone TEXT, website TEXT, mission TEXT,
      focus_areas TEXT, program_areas TEXT, applicant_type TEXT, organization_type TEXT,
      ein TEXT, city TEXT, state TEXT, contact_name TEXT, contact_title TEXT, created_by TEXT,
      created_at DATETIME, updated_at DATETIME, deleted_at DATETIME );`)
    return db
  }
  beforeEach(() => { _clearWebSources() })

  it('enriches an org with no email and inserts it with the discovered email', async () => {
    const db = makeDb()
    registerWebSource({
      name: 'stub',
      baseUrl: 'https://dir.example.org',
      async fetchCandidates() {
        return [{ name: 'Helping Hands', website: 'helpinghands.org', applicant_type: 'nonprofit' }] // no email
      },
    })
    const config = { enabled: true, sources: ['stub'], maxPerRun: 50, perDomainDelayMs: 0, enrichEmails: true, userAgent: 'GrantFlow Crawler/1.0' }
    const fetchImpl = async (url) => (url.endsWith('/contact')
      ? { ok: true, text: '<a href="mailto:info@helpinghands.org">email</a> <a href="tel:614-555-0190">call</a> Executive Director: Jane Smith' }
      : { ok: true, text: 'home' })

    const r = await runYanaWebCrawl(db, {
      config,
      fetchImpl,
      headCheck: async () => ({ ok: true }),
      robotsCheck: async () => ({ allowed: true }),
      delay: async () => {},
      logger: { info() {}, warn() {} },
    })
    expect(r.enriched_emails).toBe(1)
    expect(r.enriched_phones).toBe(1)
    expect(r.enriched_contacts).toBe(1)
    expect(r.inserted).toBe(1)
    const row = db.prepare("SELECT email, phone, contact_name, contact_title FROM organizations WHERE name = 'Helping Hands'").get()
    expect(row.email).toBe('info@helpinghands.org')
    expect(row.phone).toBe('(614) 555-0190')
    expect(row.contact_name).toBe('Jane Smith')
    expect(row.contact_title).toBe('Executive Director')
  })
})

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
} from '../services/crawlers/orgContactEnrichment.js'
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
      ['jane.doe@gmail.com', 'info@helpinghands.org', 'bob@helpinghands.org'],
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
      id TEXT PRIMARY KEY, name TEXT, email TEXT, website TEXT, mission TEXT,
      focus_areas TEXT, program_areas TEXT, applicant_type TEXT, organization_type TEXT,
      ein TEXT, city TEXT, state TEXT, created_by TEXT,
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
      ? { ok: true, text: '<a href="mailto:info@helpinghands.org">' }
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
    expect(r.inserted).toBe(1)
    const row = db.prepare("SELECT email FROM organizations WHERE name = 'Helping Hands'").get()
    expect(row.email).toBe('info@helpinghands.org')
  })
})

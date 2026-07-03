/**
 * Guards for Robert's owner-address-graph lead discovery (the Robert→John
 * promo-email pipeline's ONLY lead source):
 *   - extractContactsFromMessages pulls counterparties (from/to/cc) AND
 *     addresses written inside message bodies, skipping the owner's own
 *     mailbox/domain and non-human senders (noreply/postmaster/…).
 *   - runContactScanForRobert merges the Contacts folder + message scan into
 *     robert_source_candidates rows tagged is_client_prospect (what
 *     robertJohnBridge hands to John), idempotently (re-scan updates, never
 *     duplicates), and a failed Contacts.Read consent degrades to
 *     messages-only instead of killing the scan.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'b'.repeat(64)

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const {
  runContactScanForRobert,
  extractContactsFromMessages,
} = await import('../services/robert/robertContactDiscovery.js')

const MAILBOX = 'dr.johnwhite@axiombiolabs.org'

function makeDb() {
  const sqlite = new Database(':memory:')
  sqlite.dialect = 'sqlite'
  sqlite.exec(`
    CREATE TABLE robert_source_candidates (
      id TEXT PRIMARY KEY,
      source_name TEXT,
      source_url TEXT UNIQUE,
      source_domain TEXT,
      source_type TEXT,
      discovered_by TEXT,
      discovered_at TEXT,
      status TEXT,
      evidence_json TEXT
    );
  `)
  return wrapSqlite(sqlite)
}

function graphFetchMock({ contacts = [], messages = [], contactsStatus = 200 } = {}) {
  return async (url) => {
    const u = String(url)
    if (u.includes('/oauth2/v2.0/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }) }
    }
    if (u.includes('/contacts?')) {
      if (contactsStatus !== 200) return { ok: false, status: contactsStatus, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => ({ value: contacts }) }
    }
    if (u.includes('/messages?')) {
      return { ok: true, status: 200, json: async () => ({ value: messages }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
}

const ENV_KEYS = ['MICROSOFT_TENANT_ID', 'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'JOHN_PRIMARY_MAILBOX']
const saved = {}

describe('robert contact discovery (email contacts + message mining)', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k]
    process.env.MICROSOFT_TENANT_ID = 'tenant'
    process.env.MICROSOFT_CLIENT_ID = 'client'
    process.env.MICROSOFT_CLIENT_SECRET = 'secret'
    process.env.JOHN_PRIMARY_MAILBOX = MAILBOX
  })
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('extractContactsFromMessages: counterparties + body addresses, minus self/own-domain/non-human', () => {
    const messages = [
      {
        from: { emailAddress: { address: 'jane@nonprofit.org', name: 'Jane Fund' } },
        toRecipients: [{ emailAddress: { address: MAILBOX, name: 'John' } }],
        ccRecipients: [{ emailAddress: { address: 'noreply@bank.com', name: 'Bank' } }],
        body: { content: '<p>Ask <b>bob@foundation.org</b> — he runs the grants desk.</p>' },
      },
      {
        from: { emailAddress: { address: 'colleague@axiombiolabs.org', name: 'Colleague' } },
        toRecipients: [],
        body: { content: 'internal note, contact mailer-daemon@lists.example.com' },
      },
    ]
    const found = extractContactsFromMessages(messages, { selfMailbox: MAILBOX })
    expect(found.has('jane@nonprofit.org')).toBe(true)
    expect(found.get('jane@nonprofit.org').name).toBe('Jane Fund')
    expect(found.has('bob@foundation.org')).toBe(true) // mined from the body
    expect(found.has(MAILBOX)).toBe(false) // self
    expect(found.has('colleague@axiombiolabs.org')).toBe(false) // own domain
    expect(found.has('noreply@bank.com')).toBe(false) // non-human
    expect(found.has('mailer-daemon@lists.example.com')).toBe(false)
  })

  it('tags contacts + message counterparties as client-prospect leads, idempotently', async () => {
    const db = makeDb()
    const fetchImpl = graphFetchMock({
      contacts: [
        { displayName: 'Carla Contact', jobTitle: 'ED', companyName: 'Carla Org', emailAddresses: [{ address: 'carla@carlaorg.org' }] },
      ],
      messages: [
        {
          from: { emailAddress: { address: 'jane@nonprofit.org', name: 'Jane Fund' } },
          body: { content: 'see also bob@foundation.org' },
        },
      ],
    })

    const first = await runContactScanForRobert(db, { force: true, fetchImpl })
    expect(first.ran).toBe(true)
    expect(first.tagged).toBe(3) // carla + jane + bob
    expect(first.sources.contacts.usable).toBe(1)
    expect(first.sources.messages.extracted).toBe(2)

    const rows = await db.prepare('SELECT source_url, evidence_json FROM robert_source_candidates ORDER BY source_url').all()
    expect(rows.length).toBe(3)
    const carla = rows.find((r) => r.source_url === 'mailto:carla@carlaorg.org')
    expect(JSON.parse(carla.evidence_json).lead.is_client_prospect).toBe(true)
    expect(JSON.parse(carla.evidence_json).lead.organization_name).toBe('Carla Org')

    // Re-scan must UPDATE, never duplicate.
    const second = await runContactScanForRobert(db, { force: true, fetchImpl })
    expect(second.ran).toBe(true)
    const after = await db.prepare('SELECT COUNT(*) AS n FROM robert_source_candidates').get()
    expect(Number(after.n)).toBe(3)
  })

  it('missing Contacts.Read consent degrades to messages-only (does not kill the scan)', async () => {
    const db = makeDb()
    const fetchImpl = graphFetchMock({
      contactsStatus: 403,
      messages: [{ from: { emailAddress: { address: 'jane@nonprofit.org', name: 'Jane' } }, body: { content: '' } }],
    })
    const res = await runContactScanForRobert(db, { force: true, fetchImpl })
    expect(res.ran).toBe(true)
    expect(res.sources.contacts.error).toBeTruthy()
    expect(res.tagged).toBe(1)
  })
})

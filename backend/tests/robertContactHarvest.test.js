/**
 * Robert's owner-contact HARVEST → Yana verification → John eligibility.
 *
 * Owner directive (2026-07-25): Robert reads the owner's four mailboxes for
 * contacts with BOTH a name and an email, files them in YANA's verification
 * lane, and only Yana-VERIFIED contacts become eligible for John through the
 * EXISTING yana→john handoff. Guards here:
 *   - gate OFF by default (ROBERT_CONTACT_HARVEST unset → honest no-op, no writes)
 *   - both-fields-required (no name → dropped, never synthesized)
 *   - exclusion filtering (no-reply / list / excluded-domain / owner-self / own-org)
 *   - cross-account dedupe (address-book name wins, last_seen is max)
 *   - Yana-lane handoff shape (source/status/evidence; NO message bodies stored)
 *   - idempotent re-harvest that never reopens Yana's verdict
 *   - skipped-account honesty (no creds → skipped; reader failure → per-account
 *     error; other accounts unaffected)
 *   - verification verdicts + the only path to John being pushQualifiedToJohn /
 *     makeYanaLeadSource (an unverified candidate never reaches John)
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'b'.repeat(64)

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const {
  runContactHarvestForRobert,
  submitHarvestedToYana,
  foldAccountIntoMap,
  harvestDropReason,
  isUsableName,
  isListAddress,
  HARVEST_SOURCE,
} = await import('../services/robert/robertContactHarvest.js')
const { verifyRobertHarvestLeads, VERIFIED_LEAD_SCORE } = await import(
  '../services/yana/yanaHarvestVerification.js'
)
const { pushQualifiedToJohn, makeYanaLeadSource, _resetYanaSchemaCache } = await import(
  '../services/yana/yanaLeadDiscovery.js'
)
const { fetchLeadsForJohn } = await import('../services/john/johnYanaBridge.js')

const GMAIL = 'buckeye7066@gmail.com'
const YAHOO1 = 'firerookie_74@yahoo.com'
const YAHOO2 = 'jwhiternmba@yahoo.com'
const AXIOM = 'dr.johnwhite@axiombiolabs.org'

function makeDb() {
  const sqlite = new Database(':memory:')
  _resetYanaSchemaCache()
  return wrapSqlite(sqlite)
}

function testReader(account, { contacts = [], messages = [], fail = false } = {}) {
  return {
    account,
    kind: 'test',
    capabilities: { contacts: true, messages: true },
    async listContacts() {
      if (fail) throw new Error('login refused')
      return contacts
    },
    async listMessageHeaders() {
      if (fail) throw new Error('login refused')
      return messages
    },
  }
}

const ENV_KEYS = ['ROBERT_CONTACT_HARVEST', 'YANA_HARVEST_VERIFY_LIMIT']
const saved = {}

describe('robert contact harvest → yana verification lane', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('is gated OFF by default: no env switch → honest no-op, zero writes', async () => {
    const db = makeDb()
    const res = await runContactHarvestForRobert(db, {
      readers: [{ account: GMAIL, reader: testReader(GMAIL, { messages: [{ date: null, from: [{ name: 'A Person', email: 'a@example.net' }], to: [], cc: [] }] }), skipReason: null }],
    })
    expect(res.ran).toBe(false)
    expect(res.reason).toBe('disabled')
    // The Yana lane table was never even created — nothing was written.
    const tables = await db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='yana_lead_candidates'`)
      .all()
    expect(tables.length).toBe(0)
  })

  it('requires BOTH fields: a counterparty without a display name is dropped, never synthesized', async () => {
    process.env.ROBERT_CONTACT_HARVEST = 'true'
    const db = makeDb()
    const res = await runContactHarvestForRobert(db, {
      readers: [
        {
          account: GMAIL,
          reader: testReader(GMAIL, {
            messages: [
              {
                date: '2026-07-20T10:00:00.000Z',
                from: [{ name: 'Jane Fund', email: 'jane@nonprofit.org' }],
                to: [{ name: null, email: 'anon2@realplace.org' }], // no name → drop
                cc: [{ name: 'anonymous', email: 'anonymous@realplace.org' }], // name == local-part echo → drop
              },
            ],
          }),
          skipReason: null,
        },
      ],
    })
    expect(res.ran).toBe(true)
    expect(res.harvested).toBe(1)
    expect(res.dropped.missing_name).toBe(2)
    const rows = await db.prepare('SELECT contact_email, organization_name FROM yana_lead_candidates').all()
    expect(rows.length).toBe(1)
    expect(rows[0].contact_email).toBe('jane@nonprofit.org')
    expect(rows[0].organization_name).toBe('Jane Fund')
  })

  it('drops no-reply/list/excluded-domain/owner-self/own-org addresses with honest reasons', async () => {
    process.env.ROBERT_CONTACT_HARVEST = 'true'
    const db = makeDb()
    const res = await runContactHarvestForRobert(db, {
      readers: [
        {
          account: YAHOO1,
          reader: testReader(YAHOO1, {
            messages: [
              {
                date: '2026-07-19T00:00:00.000Z',
                from: [{ name: 'Real Person', email: 'real@goodorg.org' }],
                to: [
                  { name: 'No Reply', email: 'noreply@bank.com' },
                  { name: 'Grants List', email: 'grants-request@lists.example.org' },
                  { name: 'Comp Etitor', email: 'sales@instrumentl.com' },
                  { name: 'John White', email: GMAIL }, // owner's own address
                  { name: 'Colleague', email: 'colleague@axiombiolabs.org' }, // own org
                ],
                cc: [],
              },
            ],
          }),
          skipReason: null,
        },
      ],
    })
    expect(res.harvested).toBe(1)
    expect(res.dropped.non_human_address).toBe(1)
    expect(res.dropped.list_address).toBe(1)
    expect(res.dropped.excluded_domain).toBe(1)
    expect(res.dropped.owner_self_address).toBe(1)
    expect(res.dropped.own_org_domain).toBe(1)
  })

  it('dedupes across accounts: one row per email, address-book name wins, last_seen is the max', async () => {
    process.env.ROBERT_CONTACT_HARVEST = 'true'
    const db = makeDb()
    const res = await runContactHarvestForRobert(db, {
      readers: [
        {
          account: GMAIL,
          reader: testReader(GMAIL, {
            messages: [
              { date: '2026-07-01T00:00:00.000Z', from: [{ name: 'C. Ontact', email: 'carla@carlaorg.org' }], to: [], cc: [] },
            ],
          }),
          skipReason: null,
        },
        {
          account: AXIOM,
          reader: testReader(AXIOM, {
            contacts: [{ name: 'Carla Contact', email: 'carla@carlaorg.org' }],
            messages: [
              { date: '2026-07-10T00:00:00.000Z', from: [{ name: 'C. Ontact', email: 'carla@carlaorg.org' }], to: [], cc: [] },
            ],
          }),
          skipReason: null,
        },
      ],
    })
    expect(res.harvested).toBe(1)
    const rows = await db.prepare('SELECT * FROM yana_lead_candidates').all()
    expect(rows.length).toBe(1)
    expect(rows[0].organization_name).toBe('Carla Contact') // address book beat the header name
    const evidence = JSON.parse(rows[0].public_evidence_json)
    const prov = evidence.find((e) => e.type === 'harvest_provenance')
    expect(prov.source_accounts.sort()).toEqual([AXIOM, GMAIL].sort())
    expect(prov.last_seen).toBe('2026-07-10T00:00:00.000Z')
  })

  it('lands in Yana\'s lane in the candidate status with no message bodies stored, invisible to John', async () => {
    process.env.ROBERT_CONTACT_HARVEST = 'true'
    const db = makeDb()
    await runContactHarvestForRobert(db, {
      readers: [
        {
          account: YAHOO2,
          reader: testReader(YAHOO2, {
            messages: [{ date: '2026-07-15T12:00:00.000Z', from: [{ name: 'Bob Founder', email: 'bob@foundation.org' }], to: [], cc: [] }],
          }),
          skipReason: null,
        },
      ],
    })
    const row = await db.prepare('SELECT * FROM yana_lead_candidates').get()
    expect(row.source).toBe(HARVEST_SOURCE)
    expect(row.external_id).toBe('bob@foundation.org')
    expect(row.qualification_status).toBe('candidate')
    expect(Number(row.pushed_to_john)).toBe(0)
    // Stored evidence carries ONLY contact + provenance — never a message body.
    const evidence = JSON.parse(row.public_evidence_json)
    expect(evidence.map((e) => e.type).sort()).toEqual(['contact', 'harvest_provenance'])
    // An unverified candidate is NOT pushable and NOT visible to John's bridge.
    const push = await pushQualifiedToJohn(db)
    expect(push.leads_pushed_to_john).toBe(0)
    const { leads, filtered_out } = await fetchLeadsForJohn({
      db: null,
      leadSource: {
        ...makeYanaLeadSource(db),
        listQualifiedLeads: (opts) => makeYanaLeadSource(db).listQualifiedLeads({ ...opts, includeUnqualified: true }),
      },
    })
    expect(leads.length).toBe(0)
    expect(filtered_out.not_qualified_by_yana).toBe(1)
  })

  it('re-harvest is idempotent and never reopens Yana\'s verdict', async () => {
    process.env.ROBERT_CONTACT_HARVEST = 'true'
    const db = makeDb()
    const readers = [
      {
        account: GMAIL,
        reader: testReader(GMAIL, {
          messages: [{ date: '2026-07-15T00:00:00.000Z', from: [{ name: 'Jane Fund', email: 'jane@nonprofit.org' }], to: [], cc: [] }],
        }),
        skipReason: null,
      },
    ]
    const first = await runContactHarvestForRobert(db, { readers })
    expect(first.submitted.inserted).toBe(1)

    // Yana verifies → qualified. A later re-harvest must refresh provenance
    // only, never reset the status back to 'candidate'.
    await verifyRobertHarvestLeads(db)
    const second = await runContactHarvestForRobert(db, { readers })
    expect(second.submitted.inserted).toBe(0)
    expect(second.submitted.refreshed).toBe(1)
    const rows = await db.prepare('SELECT qualification_status FROM yana_lead_candidates').all()
    expect(rows.length).toBe(1)
    expect(rows[0].qualification_status).toBe('qualified')
  })

  it('is honest about skipped and failing accounts, without killing the others', async () => {
    process.env.ROBERT_CONTACT_HARVEST = 'true'
    const db = makeDb()
    const res = await runContactHarvestForRobert(db, {
      readers: [
        { account: GMAIL, reader: null, skipReason: 'no_credentials:ROBERT_GMAIL_APP_PASSWORD' },
        { account: YAHOO1, reader: testReader(YAHOO1, { fail: true }), skipReason: null },
        {
          account: AXIOM,
          reader: testReader(AXIOM, { contacts: [{ name: 'Carla Contact', email: 'carla@carlaorg.org' }] }),
          skipReason: null,
        },
      ],
    })
    expect(res.ran).toBe(true)
    expect(res.accounts[GMAIL].status).toBe('skipped')
    expect(res.accounts[GMAIL].reason).toContain('no_credentials')
    expect(res.accounts[YAHOO1].status).toBe('error')
    expect(res.accounts[YAHOO1].error).toContain('login refused')
    expect(res.accounts[AXIOM].status).toBe('ok')
    expect(res.harvested).toBe(1) // only the real read produced contacts — nothing fabricated
  })

  it('unconfigured env resolves every account to an honest skip (and still no error)', async () => {
    const db = makeDb()
    // Isolated env: gate on, but NO account credentials of any kind.
    const res = await runContactHarvestForRobert(db, { env: { ROBERT_CONTACT_HARVEST: 'true' }, readers: null })
    expect(res.ran).toBe(true)
    expect(res.harvested).toBe(0)
    for (const account of [GMAIL, YAHOO1, YAHOO2, AXIOM]) {
      expect(res.accounts[account].status).toBe('skipped')
      expect(res.accounts[account].reason).toContain('no_credentials')
    }
  })
})

describe('yana verification of harvested contacts', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    process.env.ROBERT_CONTACT_HARVEST = 'true'
  })
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  async function seedCandidate(db, { name, email, evidenceName = name }) {
    await submitHarvestedToYana(db, [
      {
        name: evidenceName ?? name,
        email,
        source_accounts: new Set([GMAIL]),
        last_seen: '2026-07-15T00:00:00.000Z',
        origin: 'message_header',
      },
    ])
  }

  it('verifies a real contact to qualified (clearing John\'s score floor) and rejects the rest with reasons', async () => {
    const db = makeDb()
    db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, primary_email TEXT)')
    db.raw.prepare('INSERT INTO users (id, primary_email) VALUES (?, ?)').run('u1', 'client@already.org')

    await seedCandidate(db, { name: 'Jane Fund', email: 'jane@nonprofit.org' })
    await seedCandidate(db, { name: 'Ex Isting', email: 'client@already.org' })
    // Defense in depth: rows that somehow entered the lane with a bad address
    // or no name are re-checked by Yana independently of Robert's filters.
    await submitHarvestedToYana(db, [
      { name: 'Comp Etitor', email: 'sales@instrumentl.com', source_accounts: new Set([GMAIL]), last_seen: null, origin: 'message_header' },
      { name: '', email: 'nameless@realplace.org', source_accounts: new Set([GMAIL]), last_seen: null, origin: 'message_header' },
    ])

    const res = await verifyRobertHarvestLeads(db)
    expect(res.checked).toBe(4)
    expect(res.verified).toBe(1)
    expect(res.rejected).toBe(3)
    expect(res.reject_reasons.existing_client).toBe(1)
    expect(res.reject_reasons.excluded_domain).toBe(1)
    expect(res.reject_reasons.missing_name).toBe(1)

    const jane = await db.prepare(`SELECT * FROM yana_lead_candidates WHERE contact_email = 'jane@nonprofit.org'`).get()
    expect(jane.qualification_status).toBe('qualified')
    expect(Number(jane.lead_score)).toBe(VERIFIED_LEAD_SCORE)
    expect(JSON.parse(jane.qualification_reasons_json)).toContain('yana_verified_owner_contact')

    const rejected = await db.prepare(`SELECT * FROM yana_lead_candidates WHERE contact_email = 'client@already.org'`).get()
    expect(rejected.qualification_status).toBe('unqualified')
    expect(JSON.parse(rejected.qualification_reasons_json)).toContain('existing_client')
  })

  it('verified contacts reach John ONLY via the existing yana→john handoff, and pass its gates', async () => {
    const db = makeDb()
    await seedCandidate(db, { name: 'Jane Fund', email: 'jane@nonprofit.org' })
    await verifyRobertHarvestLeads(db)

    // The existing capped push marks the lead for John…
    const push = await pushQualifiedToJohn(db)
    expect(push.leads_pushed_to_john).toBe(1)
    const row = await db.prepare('SELECT pushed_to_john FROM yana_lead_candidates').get()
    expect(Number(row.pushed_to_john)).toBe(1)

    // …and John's bridge accepts it through ALL of his default gates
    // (qualified + score floor + evidence + contact source + usable email).
    const { leads, filtered_out } = await fetchLeadsForJohn({ db: null, leadSource: makeYanaLeadSource(db) })
    expect(leads.length).toBe(1)
    expect(leads[0].organization_name).toBe('Jane Fund')
    expect(leads[0].contact_points[0].value).toBe('jane@nonprofit.org')
    expect(Object.keys(filtered_out).length).toBe(0)
  })

  it('respects the batch limit (bounded verification)', async () => {
    const db = makeDb()
    await seedCandidate(db, { name: 'A One', email: 'a1@realorg.org' })
    await seedCandidate(db, { name: 'B Two', email: 'b2@realorg.org' })
    const res = await verifyRobertHarvestLeads(db, { limit: 1 })
    expect(res.checked).toBe(1)
    const remaining = await db
      .prepare(`SELECT COUNT(*) AS c FROM yana_lead_candidates WHERE qualification_status = 'candidate'`)
      .get()
    expect(Number(remaining.c)).toBe(1)
  })
})

describe('harvest helpers', () => {
  it('isUsableName rejects empty/address/local-part-echo names', () => {
    expect(isUsableName('Jane Fund', 'jane@x.org')).toBe(true)
    expect(isUsableName('', 'jane@x.org')).toBe(false)
    expect(isUsableName('jane@x.org', 'jane@x.org')).toBe(false)
    expect(isUsableName('jane.doe', 'jane.doe@x.org')).toBe(false)
    expect(isUsableName('J', 'jane@x.org')).toBe(false)
  })

  it('isListAddress catches list/bulk address shapes', () => {
    expect(isListAddress('dev-request@lists.x.org')).toBe(true)
    expect(isListAddress('owner-lug@x.org')).toBe(false) // leading owner- is a person-ish edge; suffix rule only
    expect(isListAddress('lug-owner@x.org')).toBe(true)
    expect(isListAddress('majordomo@x.org')).toBe(true)
    expect(isListAddress('anything@lists.x.org')).toBe(true)
    expect(isListAddress('jane@x.org')).toBe(false)
  })

  it('harvestDropReason names exactly one honest reason per drop', () => {
    expect(harvestDropReason({ name: 'Jane', email: 'not-an-email' })).toBe('invalid_email')
    expect(harvestDropReason({ name: 'X Y', email: 'noreply@x.org' })).toBe('non_human_address')
    expect(harvestDropReason({ name: 'Jane Fund', email: 'jane@x.org' })).toBe(null)
  })

  it('foldAccountIntoMap merges account sightings without losing the earliest name source', () => {
    const map = new Map()
    const drops = {}
    foldAccountIntoMap(map, GMAIL, {
      messages: [{ date: '2026-07-01T00:00:00.000Z', from: [{ name: 'C. Ontact', email: 'c@x.org' }], to: [], cc: [] }],
    }, drops)
    foldAccountIntoMap(map, AXIOM, { contacts: [{ name: 'Carla Contact', email: 'c@x.org' }] }, drops)
    expect(map.size).toBe(1)
    const entry = map.get('c@x.org')
    expect(entry.name).toBe('Carla Contact')
    expect(entry.origin).toBe('address_book')
    expect(Array.from(entry.source_accounts).sort()).toEqual([AXIOM, GMAIL].sort())
  })
})

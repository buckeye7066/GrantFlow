import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { enforceJohnDraftPlausibility } from '../startup/enforceInvariants.js'

const SCHEMA_PATH = path.resolve(process.cwd(), 'backend', 'db', 'schema.sql')

function makeDb() {
  const db = new Database(':memory:')
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))
  return db
}

function seedDraft(db, { org, email, status = 'created', providerId = 'msg-1' }) {
  const id = crypto.randomUUID()
  db.prepare(
    `INSERT INTO john_email_drafts (id, organization_name, recipient_email, draft_status, provider_draft_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, org, email, status, providerId)
  return id
}

const statusOf = (db, id) => db.prepare('SELECT draft_status FROM john_email_drafts WHERE id = ?').get(id)?.draft_status

afterEach(() => { delete process.env.ENFORCE_JOHN_DRAFT_PLAUSIBILITY })

describe('enforceJohnDraftPlausibility (boot net for wrong-org drafts)', () => {
  // The real 2026-07-15 mailbox: 9 of 10 drafts addressed to an unrelated
  // business. purgeImplausibleDrafts() could already catch these — nothing ever
  // called it, so it sat behind a manual POST while the drafts sat in Drafts.
  const REAL_WRONG = [
    ['Willie Julie Educational Foundation', 'info@willienelson.com'],
    ['Robertson Community Health Foundation', 'rcfh@robertsoncountyfuneralhome.com'],
    ['Ohio Education Foundation', 'admin@worldatlas.com'],
    ['Decatur County Education Foundation', 'info@decaturwatchfest26.com'],
    ['Star News Education Foundation', 'support@help.starz.com'],
    ['Johnson City Area Arts Council', 'dcook@johnson.edu'],
    ['Winton Woods Educational Foundation', 'enquiries@winton.com'],
    ['Smith County Education Foundation', 'khalob@redvanworkshop.com'],
    ['Upper Cumberland Regional Arts Council', 'editor@upperinc.com'],
  ]
  // The one that is genuinely right — Leaders Credit Union runs that foundation.
  const REAL_OK = ['Leaders Education Foundation Inc', 'support@leaderscu.com']

  it('purges every real wrong-org draft and keeps the correct one', async () => {
    const db = makeDb()
    try {
      for (const [org, email] of REAL_WRONG) seedDraft(db, { org, email })
      const okId = seedDraft(db, { org: REAL_OK[0], email: REAL_OK[1] })

      const deleted = []
      const provider = { deleteDraft: async ({ messageId }) => { deleted.push(messageId); return { ok: true } } }
      const res = await enforceJohnDraftPlausibility(db, { provider })

      expect(res.implausible).toBe(REAL_WRONG.length)
      expect(res.repaired).toBe(REAL_WRONG.length)
      expect(deleted.length).toBe(REAL_WRONG.length)
      expect(statusOf(db, okId)).toBe('created') // the correct draft is untouched
    } finally { db.close() }
  })

  it('NEVER judges on a guess: a draft with no org or no recipient is skipped', async () => {
    const db = makeDb()
    try {
      const noOrg = seedDraft(db, { org: null, email: 'someone@somewhere.com' })
      const noEmail = seedDraft(db, { org: 'Some Foundation', email: null })
      const provider = { deleteDraft: async () => ({ ok: true }) }
      const res = await enforceJohnDraftPlausibility(db, { provider })
      expect(res.implausible).toBe(0)
      expect(statusOf(db, noOrg)).toBe('created')
      expect(statusOf(db, noEmail)).toBe('created')
    } finally { db.close() }
  })

  it('leaves the row alone when the mailbox delete is refused (the store must not lie)', async () => {
    const db = makeDb()
    try {
      const id = seedDraft(db, { org: REAL_WRONG[0][0], email: REAL_WRONG[0][1] })
      // Graph refuses: the message is no longer a draft (it was sent).
      const provider = { deleteDraft: async () => ({ ok: false, refused: 'not_a_draft' }) }
      const res = await enforceJohnDraftPlausibility(db, { provider })
      expect(res.failed).toBe(1)
      expect(res.repaired).toBe(0)
      expect(statusOf(db, id)).toBe('created') // NOT archived — mailbox still has it
    } finally { db.close() }
  })

  it('count-only via ENFORCE_JOHN_DRAFT_PLAUSIBILITY=0 — reports, touches nothing', async () => {
    const db = makeDb()
    try {
      const id = seedDraft(db, { org: REAL_WRONG[0][0], email: REAL_WRONG[0][1] })
      process.env.ENFORCE_JOHN_DRAFT_PLAUSIBILITY = '0'
      let deleteCalls = 0
      const provider = { deleteDraft: async () => { deleteCalls++; return { ok: true } } }
      const res = await enforceJohnDraftPlausibility(db, { provider })
      expect(res.implausible).toBe(1)
      expect(res.repaired).toBe(0)
      expect(res.enforced).toBe(false)
      expect(deleteCalls).toBe(0)
      expect(statusOf(db, id)).toBe('created')
    } finally { db.close() }
  })

  it('with NO Outlook provider it reports only — never archives a row whose draft still exists', async () => {
    const db = makeDb()
    try {
      const id = seedDraft(db, { org: REAL_WRONG[0][0], email: REAL_WRONG[0][1] })
      const res = await enforceJohnDraftPlausibility(db, { provider: null, purgeImpl: undefined })
      expect(res.implausible).toBeGreaterThanOrEqual(0)
      expect(statusOf(db, id)).toBe('created')
    } finally { db.close() }
  })

  it('never calls anything that sends mail', async () => {
    const db = makeDb()
    try {
      seedDraft(db, { org: REAL_WRONG[0][0], email: REAL_WRONG[0][1] })
      const forbidden = []
      const provider = new Proxy(
        { deleteDraft: async () => ({ ok: true }) },
        {
          get(target, prop) {
            if (typeof prop === 'string' && /send/i.test(prop)) forbidden.push(prop)
            return target[prop]
          },
        },
      )
      await enforceJohnDraftPlausibility(db, { provider })
      expect(forbidden).toEqual([]) // a boot sweep must never reach a send path
    } finally { db.close() }
  })
})

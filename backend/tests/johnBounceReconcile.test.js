/**
 * Guards for John's bounce (NDR) reconciliation — the answer to "2 of my 11
 * drafts came back undeliverable and nothing happened":
 *   - extractBouncedRecipients only fires on real NDRs (infra sender + bounce
 *     subject) and never extracts our own mailbox/domain or postmaster itself
 *   - reconcileBouncedDrafts suppresses the bounced address in
 *     john_suppression_list AND archives the matching live draft row
 *   - re-running is idempotent (suppression insert ignores duplicates)
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'b'.repeat(64)
process.env.JOHN_PRIMARY_MAILBOX = 'dr.johnwhite@axiombiolabs.org'

const SCHEMA_PATH = path.resolve(process.cwd(), 'backend', 'db', 'schema.sql')
const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const { extractBouncedRecipients, reconcileBouncedDrafts } = await import('../services/john/johnBounceReconcile.js')
const { insertDraft, getDraft } = await import('../services/john/johnRunStore.js')
const { isSuppressedAsync } = await import('../services/john/johnSuppressionService.js')

const MAILBOX = 'dr.johnwhite@axiombiolabs.org'

function ndrMessage(failedEmail) {
  return {
    from: { emailAddress: { address: 'postmaster@outlook.com', name: 'Microsoft Outlook' } },
    subject: `Undeliverable: Education funding options`,
    bodyPreview: `Your message to ${failedEmail} couldn't be delivered.`,
    body: { content: `<p>Delivery has failed to these recipients: <b>${failedEmail}</b>. Sender: ${MAILBOX}</p>` },
  }
}

function makeDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))
  sqlite.pragma('foreign_keys = OFF')
  sqlite.dialect = 'sqlite'
  return wrapSqlite(sqlite)
}

describe('john bounce reconcile', () => {
  let db
  beforeEach(() => {
    db = makeDb()
  })

  it('extracts only real NDR recipients (not self, not postmaster, not ordinary mail)', () => {
    const messages = [
      ndrMessage('dead@nowhere-foundation.org'),
      {
        // Ordinary mail mentioning an email address — NOT an NDR.
        from: { emailAddress: { address: 'jane@nonprofit.org' } },
        subject: 'Re: Education funding options',
        body: { content: 'loop in bob@foundation.org' },
      },
    ]
    const bounced = extractBouncedRecipients(messages, { selfMailbox: MAILBOX })
    expect(bounced.has('dead@nowhere-foundation.org')).toBe(true)
    expect(bounced.has('bob@foundation.org')).toBe(false)
    expect(bounced.has(MAILBOX)).toBe(false)
    expect(bounced.has('postmaster@outlook.com')).toBe(false)
  })

  it('suppresses the bounced address and archives its live draft row, idempotently', async () => {
    const draftId = await insertDraft(db, {
      yana_lead_id: 'lead-1',
      run_id: 'run-1',
      organization_name: 'Nowhere Foundation',
      recipient_email: 'dead@nowhere-foundation.org',
      subject: 'Education funding options',
      draft_status: 'created',
    })

    const provider = {
      listInboxMessages: async () => ({ ok: true, messages: [ndrMessage('dead@nowhere-foundation.org')] }),
    }

    const summary = await reconcileBouncedDrafts({ db, provider, logger: { info() {}, warn() {} } })
    expect(summary.ndr_recipients).toBe(1)
    expect(summary.suppressed).toBe(1)
    expect(summary.drafts_archived).toBe(1)

    expect(await isSuppressedAsync(db, { type: 'email', value: 'dead@nowhere-foundation.org' })).toBe(true)
    const row = await getDraft(db, draftId)
    expect(row.draft_status).toBe('archived')
    expect(row.archived_reason).toBe('bounced')

    // Second pass: no live drafts left, suppression already present — no throw.
    const again = await reconcileBouncedDrafts({ db, provider, logger: { info() {}, warn() {} } })
    expect(again.suppressed).toBe(1) // insert is duplicate-tolerant
    expect(again.drafts_archived).toBe(0)
  })
})

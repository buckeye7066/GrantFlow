/**
 * Purging drafts addressed to the WRONG organization.
 *
 * PROD CONTEXT (2026-07-15): Yana's enricher accepted any homepage the search
 * returned and scraped that stranger's email; John then drafted real outreach to
 * it. 113 of 190 lead-linked drafts (59%) carried an implausible recipient —
 * rcfh@robertsoncountyfuneralhome.com for "Robertson Community Health
 * Foundation", claimsinquiry@allianzassistance.com for an arts council,
 * person@gmail.com scraped off a template. The owner had hand-deleted 95.
 *
 * The enrichment gate (#937) stops new ones; this removes the residue. These
 * tests pin the safety properties that make an automated mailbox deletion
 * defensible.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import {
  purgeImplausibleDrafts,
  draftRecipientIsImplausible,
  PURGE_REASON,
} from '../services/john/johnDraftPlausibilityPurge.js'
import { insertDraft, hasDraftForLead } from '../services/john/johnRunStore.js'

const JOHN_MIGRATION = fileURLToPath(new URL('../db/migrations/083_john_tables.sql', import.meta.url))

let db
beforeEach(() => {
  db = new Database(':memory:')
  db.exec(readFileSync(JOHN_MIGRATION, 'utf8'))
})

/** Real prod pairs (verified against the live gate, not eyeballed). */
const WRONG = {
  id: 'd-wrong',
  yana_lead_id: 'lead-1',
  organization_name: 'Westmoreland Council Of The Arts',
  recipient_email: 'claimsinquiry@allianzassistance.com',
  provider_draft_id: 'msg-wrong',
  draft_status: 'created',
}
const RIGHT = {
  id: 'd-right',
  yana_lead_id: 'lead-2',
  organization_name: 'Knox Education Foundation',
  recipient_email: 'info@knoxed.org',
  provider_draft_id: 'msg-right',
  draft_status: 'created',
}

function fakeProvider(overrides = {}) {
  const deleted = []
  return {
    deleted,
    async deleteDraft({ messageId }) { deleted.push(messageId); return { ok: true } },
    ...overrides,
  }
}

describe('draftRecipientIsImplausible', () => {
  it('flags the real prod mismatches', () => {
    expect(draftRecipientIsImplausible(WRONG)).toBe(true)
    expect(draftRecipientIsImplausible({ organization_name: 'Holliday Education Foundation', recipient_email: 'person@gmail.com' })).toBe(true)
    expect(draftRecipientIsImplausible({ organization_name: 'Weakley County Education Foundation', recipient_email: 'x@crash2.zhihu.com' })).toBe(true)
    expect(draftRecipientIsImplausible({ organization_name: 'Rockbridge Community Health Foundation', recipient_email: 'info@bookwidgets.com' })).toBe(true)
  })

  it('leaves a matching recipient alone', () => {
    expect(draftRecipientIsImplausible(RIGHT)).toBe(false)
  })

  it('flags a coincidental token match the org name cannot explain', () => {
    // This case was previously pinned as an intentional FALSE NEGATIVE: the
    // domain contains the org's distinctive token (the county name), so the
    // one-token gate "could not prove it wrong and must not guess".
    //
    // It could. The draft went out to a FUNERAL HOME, and the proof was sitting
    // in the hostname: once "robertson" (and every other word of the org's name)
    // is accounted for, "countyfuneralhome" is left over — text the org's name
    // cannot explain. That is evidence, not a hunch. Sharing a county name is a
    // coincidence; naming yourself a funeral home is an identity.
    //
    // The conservatism this replaces was aimed the wrong way. Archiving is
    // reversible (ARCHIVED is re-draft-eligible in hasDraftForLead, so the lead
    // gets a correct draft once it earns a real address); mailing a bereaved
    // family's funeral home a pitch for a health foundation is not.
    expect(draftRecipientIsImplausible({
      organization_name: 'Robertson Community Health Foundation',
      recipient_email: 'rcfh@robertsoncountyfuneralhome.com',
    })).toBe(true)
  })

  it('STILL never purges on a mere token coincidence when the host adds nothing', () => {
    // The real conservatism bar: "leaderscu.com" for the "Leaders Education
    // Foundation" leaves only "cu" once the name is accounted for — a plausible
    // abbreviation (Leaders Credit Union runs that foundation in Jackson, TN).
    // Nothing contradicts the org, so the gate must not touch it.
    expect(draftRecipientIsImplausible({
      organization_name: 'Leaders Education Foundation Inc',
      recipient_email: 'support@leaderscu.com',
    })).toBe(false)
  })

  it('never judges on missing data (no org or no email = never purge)', () => {
    expect(draftRecipientIsImplausible({ organization_name: null, recipient_email: 'a@b.com' })).toBe(false)
    expect(draftRecipientIsImplausible({ organization_name: 'X Foundation', recipient_email: null })).toBe(false)
  })
})

describe('purgeImplausibleDrafts', () => {
  it('purges ONLY the wrong draft and never touches the right one', async () => {
    await insertDraft(db, WRONG)
    await insertDraft(db, RIGHT)
    const provider = fakeProvider()

    const res = await purgeImplausibleDrafts(db, { provider })
    expect(res.implausible).toBe(1)
    expect(res.purged).toBe(1)
    expect(provider.deleted).toEqual(['msg-wrong']) // the right draft's message is untouched

    const wrong = db.prepare('SELECT * FROM john_email_drafts WHERE id = ?').get('d-wrong')
    const right = db.prepare('SELECT * FROM john_email_drafts WHERE id = ?').get('d-right')
    expect(wrong.draft_status).toBe('archived')
    expect(wrong.archived_reason).toBe(PURGE_REASON)
    expect(right.draft_status).toBe('created')
  })

  it('archives rather than claiming the OWNER deleted it (honest status)', async () => {
    await insertDraft(db, WRONG)
    await purgeImplausibleDrafts(db, { provider: fakeProvider() })
    const row = db.prepare('SELECT * FROM john_email_drafts WHERE id = ?').get('d-wrong')
    // deleted_by_user means "the owner curated this away" — a lie here.
    expect(row.draft_status).not.toBe('deleted_by_user')
    expect(row.draft_status).toBe('archived')
  })

  it('leaves the lead RE-DRAFTABLE, so a corrected address gets a real email', async () => {
    await insertDraft(db, WRONG)
    expect(await hasDraftForLead(db, 'lead-1')).toBe(true)
    await purgeImplausibleDrafts(db, { provider: fakeProvider() })
    // 'archived' is deliberately outside hasDraftForLead's exclusion set.
    expect(await hasDraftForLead(db, 'lead-1')).toBe(false)
  })

  it('dryRun reports the targets and changes nothing', async () => {
    await insertDraft(db, WRONG)
    const provider = fakeProvider()
    const res = await purgeImplausibleDrafts(db, { provider, dryRun: true })
    expect(res.implausible).toBe(1)
    expect(res.purged).toBe(0)
    expect(res.items[0]).toMatchObject({ organization_name: WRONG.organization_name, recipient_email: WRONG.recipient_email })
    expect(provider.deleted).toEqual([])
    expect(db.prepare('SELECT draft_status FROM john_email_drafts WHERE id = ?').get('d-wrong').draft_status).toBe('created')
  })

  it('keeps the row live when the mailbox delete FAILS (store never lies)', async () => {
    await insertDraft(db, WRONG)
    const provider = fakeProvider({ async deleteDraft() { return { ok: false, refused: 'not_a_draft' } } })
    const res = await purgeImplausibleDrafts(db, { provider })
    expect(res.failed).toBe(1)
    expect(res.purged).toBe(0)
    // Still 'created' — the draft IS still in the mailbox, so the row says so.
    expect(db.prepare('SELECT draft_status FROM john_email_drafts WHERE id = ?').get('d-wrong').draft_status).toBe('created')
  })

  it('treats an already-gone message as success (idempotent)', async () => {
    await insertDraft(db, WRONG)
    const provider = fakeProvider({ async deleteDraft() { return { ok: true, alreadyGone: true } } })
    const res = await purgeImplausibleDrafts(db, { provider })
    expect(res.purged).toBe(1)
    expect(res.mailbox_deleted).toBe(0)
    // Second run finds nothing live to purge.
    expect((await purgeImplausibleDrafts(db, { provider })).implausible).toBe(0)
  })

  it('ignores terminal rows — only live mailbox drafts are in scope', async () => {
    await insertDraft(db, { ...WRONG, id: 'd-arch', draft_status: 'archived' })
    await insertDraft(db, { ...WRONG, id: 'd-del', draft_status: 'deleted_by_user' })
    const provider = fakeProvider()
    const res = await purgeImplausibleDrafts(db, { provider })
    expect(res.implausible).toBe(0)
    expect(provider.deleted).toEqual([])
  })
})

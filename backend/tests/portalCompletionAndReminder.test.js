/**
 * Tests for the portal MERGE/COMPLETION lifecycle + the Monday unmerged-portal
 * reminder selection.
 *
 * Covers owner requirements (b) + (c):
 *   (b) marking a funding-source portal "complete" (but NOT "merged"), the
 *       distinct states, and that a completed signal never regresses a merged
 *       portal; plus the detector recognizing a completed FAFSA link.
 *   (c) selectUnmergedPortals — which portals are due for the Monday reminder
 *       (unmerged + complete are due; merged is excluded).
 */

import { describe, it, expect, beforeEach } from 'vitest'

process.env.RUNTIME_SECRETS_KEY = 'a'.repeat(64)

const Database = (await import('better-sqlite3')).default
const {
  PORTAL_STATUS,
  ensurePortalCompletionSchema,
  setPortalStatus,
  markPortalComplete,
  markPortalMerged,
  getPortalStatus,
  getPortalStatusMap,
  recordReminderSent,
  _resetPortalCompletionSchemaCache,
} = await import('../services/hamilton/portalCompletionStore.js')
const { detectAndMarkCompletedApplications } = await import('../services/hamilton/portalCompletionDetector.js')
const { selectUnmergedPortals } = await import('../services/hamilton/mondayPortalReminder.js')

function makeDb() {
  const db = new Database(':memory:')
  // Minimal schema profilePortalIndex (read by the detector + reminder) touches.
  db.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, display_name TEXT, status TEXT, updated_at DATETIME);
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, profile_id TEXT, title TEXT,
      application_url TEXT, portal_url TEXT, source_url TEXT, url TEXT,
      application_method TEXT,
      contact_name TEXT, contact_email TEXT, contact_phone TEXT,
      funder_fax TEXT, funder_address TEXT,
      funding_opportunity_id TEXT
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, name TEXT,
      application_url TEXT, apply_url TEXT, apply_guidelines_url TEXT
    );
  `)
  return db
}

describe('portalCompletionStore — complete vs merged lifecycle', () => {
  let db
  beforeEach(async () => {
    _resetPortalCompletionSchemaCache()
    db = makeDb()
    db.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run('p1', 'Test')
    await ensurePortalCompletionSchema(db)
  })

  it('marks a portal complete-but-NOT-merged (distinct states)', async () => {
    const row = await markPortalComplete(db, { profileId: 'p1', portalHost: 'studentaid.gov', source: 'document_upload' })
    expect(row.status).toBe(PORTAL_STATUS.COMPLETE)
    expect(row.status).not.toBe(PORTAL_STATUS.MERGED)
    expect(row.completed_at).toBeTruthy()
    expect(row.merged_at).toBeFalsy()
  })

  it('a "complete" signal NEVER regresses a merged portal', async () => {
    // A truthful merge requires explicit confirmation (owner: "ensure when the
    // merge happens, it is true"); a bare unconfirmed merge is refused.
    await markPortalMerged(db, { profileId: 'p1', portalHost: 'studentaid.gov', confirmed: true })
    const after = await markPortalComplete(db, { profileId: 'p1', portalHost: 'studentaid.gov' })
    expect(after.status).toBe(PORTAL_STATUS.MERGED)
  })

  it('REFUSES an unconfirmed merge (truthful-merge guard)', async () => {
    const refused = await markPortalMerged(db, { profileId: 'p1', portalHost: 'unconfirmed.org' })
    expect(refused).toBeNull()
    const row = await getPortalStatus(db, 'p1', 'unconfirmed.org')
    expect(row === null || row.status !== PORTAL_STATUS.MERGED).toBe(true)
  })

  it('keys on registrable host so a sub-host and full URL collapse to one row', async () => {
    await markPortalComplete(db, { profileId: 'p1', portalHost: 'https://studentaid.gov/fafsa/confirmation' })
    const byBareHost = await getPortalStatus(db, 'p1', 'fafsa.studentaid.gov')
    expect(byBareHost?.status).toBe(PORTAL_STATUS.COMPLETE)
  })

  it('rejects an invalid status', async () => {
    const row = await setPortalStatus(db, { profileId: 'p1', portalHost: 'x.gov', status: 'bogus' })
    expect(row).toBeNull()
  })

  it('records reminder timestamp idempotently (creates a row if none exists)', async () => {
    await recordReminderSent(db, 'p1', 'studentaid.gov')
    const row = await getPortalStatus(db, 'p1', 'studentaid.gov')
    expect(row.last_reminded_at).toBeTruthy()
    expect(row.status).toBe(PORTAL_STATUS.UNMERGED)
  })
})

describe('portalCompletionDetector — completed FAFSA recognition', () => {
  let db
  beforeEach(async () => {
    _resetPortalCompletionSchemaCache()
    db = makeDb()
    db.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run('p1', 'Student')
    await ensurePortalCompletionSchema(db)
  })

  it('marks FAFSA complete when a completed-FAFSA artifact is uploaded', async () => {
    const out = await detectAndMarkCompletedApplications(db, {
      profileId: 'p1',
      documentId: 'd1',
      importUrl: 'https://studentaid.gov/fafsa-app/confirmation',
      text: 'Your FAFSA application has been submitted. Student Aid Index (SAI) is 4200.',
      fileName: 'FAFSA confirmation.pdf',
    })
    expect(out.marked.map((m) => m.host)).toContain('studentaid.gov')
    const status = await getPortalStatus(db, 'p1', 'studentaid.gov')
    expect(status.status).toBe(PORTAL_STATUS.COMPLETE)
  })

  it('does NOT mark complete for a bare login link with no completion signal', async () => {
    const out = await detectAndMarkCompletedApplications(db, {
      profileId: 'p1',
      importUrl: 'https://studentaid.gov/fafsa-app/login',
      text: 'Log in to start your FAFSA.',
      fileName: 'fafsa-login.html',
    })
    expect(out.marked).toEqual([])
    expect(out.reason).toBe('no_completion_signal')
  })

  it('does NOT mark a non-funding host even with a completion cue', async () => {
    const out = await detectAndMarkCompletedApplications(db, {
      profileId: 'p1',
      importUrl: 'https://example.com/some/confirmation',
      text: 'Your application has been submitted.',
      fileName: 'receipt.pdf',
    })
    expect(out.marked).toEqual([])
  })
})

describe('mondayPortalReminder — selectUnmergedPortals (which portals are due)', () => {
  let db
  beforeEach(async () => {
    _resetPortalCompletionSchemaCache()
    db = makeDb()
    db.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run('p1', 'Test')
    await ensurePortalCompletionSchema(db)
  })

  it('includes unmerged + complete, excludes merged', async () => {
    // Three status rows: one merged (excluded), one complete (due), one unmerged (due).
    await markPortalMerged(db, { profileId: 'p1', portalHost: 'merged-portal.org', confirmed: true })
    await markPortalComplete(db, { profileId: 'p1', portalHost: 'studentaid.gov' })
    await setPortalStatus(db, { profileId: 'p1', portalHost: 'unfinished.org', status: PORTAL_STATUS.UNMERGED })

    const due = await selectUnmergedPortals(db, 'p1')
    const hosts = due.map((d) => d.host)
    expect(hosts).toContain('studentaid.gov')
    expect(hosts).toContain('unfinished.org')
    expect(hosts).not.toContain('merged-portal.org')
  })

  it('a completed-but-not-merged portal still surfaces as due (completed != merged)', async () => {
    await markPortalComplete(db, { profileId: 'p1', portalHost: 'studentaid.gov' })
    const due = await selectUnmergedPortals(db, 'p1')
    const fafsa = due.find((d) => d.host === 'studentaid.gov')
    expect(fafsa).toBeTruthy()
    expect(fafsa.status).toBe(PORTAL_STATUS.COMPLETE)
  })

  it('merged hosts are always excluded from the due set', async () => {
    // (A bare profile may still surface relevance-gated PROCESS portals — FAFSA/
    // 211/SSA — as unmerged; the contract under test is that any host we marked
    // MERGED never appears in the due set, regardless of those.)
    await markPortalMerged(db, { profileId: 'p1', portalHost: 'a.org', confirmed: true })
    await markPortalMerged(db, { profileId: 'p1', portalHost: 'b.org', confirmed: true })
    const due = await selectUnmergedPortals(db, 'p1')
    const hosts = due.map((d) => d.host)
    expect(hosts).not.toContain('a.org')
    expect(hosts).not.toContain('b.org')
    // None of the surfaced portals are in the merged state.
    expect(due.every((d) => d.status !== PORTAL_STATUS.MERGED)).toBe(true)
  })
})

/**
 * Portal sync → TRUE merge lifecycle.
 *
 * A successful two-way portal-sync READ that genuinely pulled the portal's
 * data into the profile IS the "merged" state the lifecycle store defines —
 * previously runPortalSync never recorded it, so the weekly "unmerged portals"
 * reminder nagged forever about portals whose data was already in.
 *
 * Pins:
 *   - shouldMarkMergedAfterRead: merged only when data was truly written (or
 *     deliberately dismissed) AND nothing failed to persist;
 *   - finalizeReadMerge records the terminal merged row with the sync run as
 *     auditable evidence, and the merged host drops out of the weekly
 *     unmerged-portal selection;
 *   - an empty or partially-failed read never claims a merge.
 */
import { describe, it, expect, beforeEach } from 'vitest'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'a'.repeat(64)

const Database = (await import('better-sqlite3')).default
const { shouldMarkMergedAfterRead, finalizeReadMerge } = await import('../services/hamilton/portalSync/index.js')
const {
  getPortalStatus,
  _resetPortalCompletionSchemaCache,
} = await import('../services/hamilton/portalCompletionStore.js')

const CLEAN = { fieldsWritten: 2, fieldsRejected: [], awardsWritten: 1, awardsDismissed: 0, awardsFailed: [] }

describe('shouldMarkMergedAfterRead', () => {
  it('merges only a read that truly pulled data in, cleanly', () => {
    expect(shouldMarkMergedAfterRead(CLEAN)).toBe(true)
    // Dismissals are NOT pulled data: a run that wrote nothing because the
    // user had dismissed everything is a no-op read — marking it terminally
    // `merged` silenced the weekly reminder off pure suppression
    // (2026-07-28 audit; this assertion previously encoded the defect).
    expect(shouldMarkMergedAfterRead({ ...CLEAN, fieldsWritten: 0, awardsWritten: 0, awardsDismissed: 1 })).toBe(false)
    // …but dismissals alongside real writes never BLOCK the merge.
    expect(shouldMarkMergedAfterRead({ ...CLEAN, awardsDismissed: 3 })).toBe(true)
  })

  it('refuses an empty read (nothing pulled → still unmerged, still reminded)', () => {
    expect(shouldMarkMergedAfterRead({ fieldsWritten: 0, fieldsRejected: [], awardsWritten: 0, awardsDismissed: 0, awardsFailed: [] })).toBe(false)
  })

  it('refuses a partially-failed persist (silent data loss must not look merged)', () => {
    expect(shouldMarkMergedAfterRead({ ...CLEAN, awardsFailed: [{ title: 'x', reason: 'boom' }] })).toBe(false)
    expect(shouldMarkMergedAfterRead({ ...CLEAN, fieldsRejected: [{ field: 'x', reason: 'guard' }] })).toBe(false)
  })

  it('refuses garbage input', () => {
    expect(shouldMarkMergedAfterRead(null)).toBe(false)
    expect(shouldMarkMergedAfterRead({})).toBe(false)
  })
})

describe('finalizeReadMerge', () => {
  let db
  beforeEach(() => {
    db = new Database(':memory:')
    db.dialect = 'sqlite'
    _resetPortalCompletionSchemaCache()
  })

  it('records the terminal merged state with the sync run as evidence', async () => {
    const merged = await finalizeReadMerge(db, { profileId: 'p1', host: 'mtsu.edu', runId: 'run-42', persisted: CLEAN })
    expect(merged).toBe(true)
    const status = await getPortalStatus(db, 'p1', 'mtsu.edu')
    expect(status.status).toBe('merged')
    expect(status.merged_at).toBeTruthy()
    expect(status.evidence).toBe('portal_sync_run:run-42')
    expect(status.source).toBe('portal_sync')
  })

  it('does not record a merge for an empty read', async () => {
    const merged = await finalizeReadMerge(db, {
      profileId: 'p1', host: 'mtsu.edu', runId: 'run-43',
      persisted: { fieldsWritten: 0, fieldsRejected: [], awardsWritten: 0, awardsDismissed: 0, awardsFailed: [] },
    })
    expect(merged).toBe(false)
    expect(await getPortalStatus(db, 'p1', 'mtsu.edu')).toBeNull()
  })

  it('still merges (with timestamp evidence) when run bookkeeping was degraded', async () => {
    const merged = await finalizeReadMerge(db, { profileId: 'p1', host: 'mtsu.edu', runId: null, persisted: CLEAN })
    expect(merged).toBe(true)
    const status = await getPortalStatus(db, 'p1', 'mtsu.edu')
    expect(status.status).toBe('merged')
    expect(String(status.evidence)).toMatch(/^portal_sync_read:/)
  })
})

/**
 * AnyaHealth catalog dedup — collision-aware grant reassignment.
 *
 * Regression guard for the recurring prod warning
 *   "[AnyaHealth] dedup reassign grants failed:
 *    duplicate key value violates unique constraint ux_grants_profile_opportunity"
 * (seen repeatedly on "Tennessee Student Assistance Award Program"): the old
 * blanket UPDATE re-pointed every dependent grant at the kept opportunity, so a
 * profile that already held the kept opportunity — or held grants on TWO dupes —
 * violated the partial unique index and the WHOLE group was skipped forever.
 *
 * The fix reassigns only non-colliding grants and DETACHES colliders
 * (funding_opportunity_id = NULL) so the user's pipeline rows are never touched
 * beyond the link, and the duplicate catalog rows actually get deleted.
 */
import { describe, it, expect, beforeEach } from 'vitest'

const Database = (await import('better-sqlite3')).default
const { dedupGlobalCatalogOpportunities } = await import('../services/anyaHealthService.js')

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT,
      sponsor TEXT,
      state TEXT,
      profile_id TEXT,
      application_url TEXT
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      funding_opportunity_id TEXT
    );
    CREATE UNIQUE INDEX ux_grants_profile_opportunity
      ON grants(profile_id, funding_opportunity_id)
      WHERE profile_id IS NOT NULL AND funding_opportunity_id IS NOT NULL;
  `)
  return db
}

function seedOpp(db, { id, title = 'TN Student Assistance Award', sponsor = 'TSAC', state = 'TN', url = 'https://tn.gov/apply' }) {
  db.prepare(`INSERT INTO funding_opportunities (id, title, sponsor, state, profile_id, application_url) VALUES (?,?,?,?,NULL,?)`)
    .run(id, title, sponsor, state, url)
}
function seedGrant(db, { id, profileId, oppId }) {
  db.prepare(`INSERT INTO grants (id, profile_id, funding_opportunity_id) VALUES (?,?,?)`).run(id, profileId, oppId)
}

describe('dedupGlobalCatalogOpportunities — collision-aware reassignment', () => {
  let db
  beforeEach(() => { db = makeDb() })

  it('merges dupes and reassigns non-colliding grants to the kept opportunity', async () => {
    seedOpp(db, { id: 'keep' })
    seedOpp(db, { id: 'z-dupe' })
    seedGrant(db, { id: 'g1', profileId: 'pA', oppId: 'z-dupe' })
    const r = await dedupGlobalCatalogOpportunities(db)
    expect(r.removed).toBe(1)
    expect(db.prepare(`SELECT COUNT(*) c FROM funding_opportunities`).get().c).toBe(1)
    expect(db.prepare(`SELECT funding_opportunity_id f FROM grants WHERE id='g1'`).get().f).toBe('keep')
  })

  it('DETACHES a collider (profile already holds the kept opportunity) instead of throwing and skipping the group', async () => {
    seedOpp(db, { id: 'keep' })
    seedOpp(db, { id: 'z-dupe' })
    seedGrant(db, { id: 'g-keep', profileId: 'pA', oppId: 'keep' })
    seedGrant(db, { id: 'g-dupe', profileId: 'pA', oppId: 'z-dupe' }) // would violate ux on blanket reassign
    const r = await dedupGlobalCatalogOpportunities(db)
    expect(r.removed).toBe(1) // the group is no longer skipped
    const gDupe = db.prepare(`SELECT funding_opportunity_id f FROM grants WHERE id='g-dupe'`).get()
    expect(gDupe.f).toBeNull() // detached, row preserved
    expect(db.prepare(`SELECT funding_opportunity_id f FROM grants WHERE id='g-keep'`).get().f).toBe('keep')
    expect(db.prepare(`SELECT COUNT(*) c FROM grants`).get().c).toBe(2) // no pipeline row auto-purged
  })

  it('handles a profile holding grants on TWO dupes (snapshot case): one reassigned, one detached', async () => {
    seedOpp(db, { id: 'keep' })
    seedOpp(db, { id: 'z-dupe1' })
    seedOpp(db, { id: 'z-dupe2' })
    seedGrant(db, { id: 'g1', profileId: 'pA', oppId: 'z-dupe1' })
    seedGrant(db, { id: 'g2', profileId: 'pA', oppId: 'z-dupe2' })
    const r = await dedupGlobalCatalogOpportunities(db)
    expect(r.removed).toBe(2)
    const links = db.prepare(`SELECT funding_opportunity_id f FROM grants ORDER BY id`).all().map((x) => x.f)
    expect(links.filter((f) => f === 'keep')).toHaveLength(1)
    expect(links.filter((f) => f === null)).toHaveLength(1)
  })

  it('profile-less grants always reassign (partial index ignores them)', async () => {
    seedOpp(db, { id: 'keep' })
    seedOpp(db, { id: 'z-dupe' })
    seedGrant(db, { id: 'g1', profileId: null, oppId: 'z-dupe' })
    seedGrant(db, { id: 'g2', profileId: null, oppId: 'z-dupe' })
    const r = await dedupGlobalCatalogOpportunities(db)
    expect(r.removed).toBe(1)
    const links = db.prepare(`SELECT funding_opportunity_id f FROM grants`).all().map((x) => x.f)
    expect(links).toEqual(['keep', 'keep'])
  })

  it('never touches profile-scoped catalog records', async () => {
    db.prepare(`INSERT INTO funding_opportunities (id, title, sponsor, state, profile_id, application_url) VALUES ('p-1','Same Title','TSAC','TN','pA','u')`).run()
    db.prepare(`INSERT INTO funding_opportunities (id, title, sponsor, state, profile_id, application_url) VALUES ('p-2','Same Title','TSAC','TN','pB','u')`).run()
    const r = await dedupGlobalCatalogOpportunities(db)
    expect(r.groups_found).toBe(0)
    expect(db.prepare(`SELECT COUNT(*) c FROM funding_opportunities`).get().c).toBe(2)
  })
})

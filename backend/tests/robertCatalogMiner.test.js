/**
 * Tests for Robert's DB-mining capability (robertCatalogMiner) and the email
 * feed connection (robertEmailFeedBridge) wired into Robert's cycle.
 *
 * Directive coverage:
 *   1. Robert's DB-mining matches an EXISTING catalog row to a fitting profile
 *      and creates a recommendation (using the canonical matcher via injection,
 *      pipelineExclusion, and the relevance floor).
 *   2. It EXCLUDES a catalog row that is already in the profile's pipeline.
 *   3. The email feeder is invoked in Robert's normal cycle (mocked) — proving
 *      email-sourced opportunities flow into the same match+recommend path.
 *
 * Uses better-sqlite3 in-memory (the enforceInvariants.test.js pattern): the
 * raw synchronous handle stands in for the async prod wrapper because awaiting
 * a non-promise resolves to its value.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import crypto from 'crypto'

import {
  mineCatalogForProfiles,
  effectiveFloorFor,
  fetchCatalogForProfile,
} from '../services/robert/robertCatalogMiner.js'
import { runEmailFeedForRobert } from '../services/robert/robertEmailFeedBridge.js'
import { runRobert } from '../services/robert/robertAgent.js'

// ---------------------------------------------------------------------------
// DB harness
// ---------------------------------------------------------------------------
function makeDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      display_name TEXT,
      state TEXT,
      county TEXT,
      status TEXT DEFAULT 'active',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      title TEXT NOT NULL,
      funder TEXT,
      sponsor TEXT,
      source TEXT,
      source_url TEXT,
      record_origin TEXT,
      description TEXT,
      is_national INTEGER DEFAULT 0,
      state TEXT,
      geo_county TEXT,
      is_active INTEGER DEFAULT 1,
      is_hidden INTEGER DEFAULT 0,
      application_url TEXT,
      url TEXT
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      funding_opportunity_id TEXT,
      title TEXT,
      funder TEXT,
      status TEXT DEFAULT 'discovered',
      fingerprint TEXT,
      url TEXT,
      application_url TEXT,
      deadline TEXT
    );
    CREATE TABLE profile_sections (
      profile_id TEXT,
      section_key TEXT,
      data TEXT
    );
    CREATE TABLE robert_runs (
      id TEXT PRIMARY KEY,
      mode TEXT,
      trigger TEXT,
      status TEXT DEFAULT 'running',
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      profiles_considered INTEGER DEFAULT 0,
      sources_considered INTEGER DEFAULT 0,
      urls_fetched INTEGER DEFAULT 0,
      candidates_found INTEGER DEFAULT 0,
      candidates_verified INTEGER DEFAULT 0,
      opportunities_ingested INTEGER DEFAULT 0,
      opportunities_matched INTEGER DEFAULT 0,
      recommendations_created INTEGER DEFAULT 0,
      recommendations_delivered INTEGER DEFAULT 0,
      recommendations_accepted INTEGER DEFAULT 0,
      recommendations_declined INTEGER DEFAULT 0,
      zero_result_profiles_helped INTEGER DEFAULT 0,
      summary_json TEXT DEFAULT '{}',
      error TEXT,
      created_by_user_id TEXT
    );
    CREATE TABLE robert_profile_recommendations (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      opportunity_id TEXT,
      robert_run_id TEXT,
      recommendation_status TEXT NOT NULL DEFAULT 'pending',
      delivery_status TEXT NOT NULL DEFAULT 'queued',
      match_score REAL,
      match_decision TEXT,
      match_reasons_json TEXT DEFAULT '[]',
      missing_profile_fields_json TEXT DEFAULT '[]',
      why_found TEXT,
      search_query_used TEXT,
      source_candidate_id TEXT,
      opportunity_candidate_id TEXT,
      toast_title TEXT,
      toast_body TEXT,
      toast_priority TEXT DEFAULT 'normal',
      toast_shown_at DATETIME,
      viewed_at DATETIME,
      accepted_at DATETIME,
      declined_at DATETIME,
      last_delivered_at DATETIME,
      delivery_attempts INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)
  return raw
}

function insertProfile(db, p) {
  db.prepare(
    'INSERT INTO profiles (id, organization_id, display_name, state, county, status) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(p.id, p.organization_id ?? p.id, p.display_name ?? 'Profile', p.state ?? null, p.county ?? null, p.status ?? 'active')
}

function insertOpp(db, o) {
  const id = o.id || crypto.randomUUID()
  db.prepare(
    `INSERT INTO funding_opportunities
       (id, title, funder, source, source_url, record_origin, description, is_national, state, geo_county, is_active, is_hidden, application_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    o.title ?? 'Opportunity',
    o.funder ?? null,
    o.source ?? null,
    o.source_url ?? null,
    o.record_origin ?? 'curated_catalog',
    o.description ?? null,
    o.is_national ?? 0,
    o.state ?? null,
    o.geo_county ?? null,
    o.is_active ?? 1,
    o.is_hidden ?? 0,
    o.application_url ?? 'https://example.org/apply',
  )
  return id
}

function insertGrant(db, g) {
  db.prepare(
    'INSERT INTO grants (id, profile_id, funding_opportunity_id, title, funder, status) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(g.id || crypto.randomUUID(), g.profile_id, g.funding_opportunity_id ?? null, g.title ?? 'Grant', g.funder ?? null, g.status ?? 'saved')
}

// A deterministic stand-in for the canonical matcher. The miner calls it through
// robertMatchBridge.scoreOpportunityForProfile, so the bridge contract (which
// reads .score/.decision/.reasons) is exercised for real; only the scoring
// numbers are made deterministic. Score keys off opportunity.title so the test
// controls accept/reject precisely.
function fakeMatcher(profile, opportunity) {
  const title = String(opportunity?.title || '')
  if (/reject/i.test(title)) {
    return { score: 0, decision: 'REJECT', reasons: ['not eligible'], eligible: false, missingEligibilityFields: [] }
  }
  if (/weak/i.test(title)) {
    return { score: 30, decision: 'REVIEW', reasons: ['marginal'], eligible: 'maybe', missingEligibilityFields: [] }
  }
  return { score: 88, decision: 'ACCEPT', reasons: ['strong fit on needs'], eligible: true, missingEligibilityFields: [] }
}

function makeCtx(db) {
  return async (database, profileId) => {
    const profile = database.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId)
    if (!profile) return null
    return { profile, sections: {}, signals: { state: profile.state, county: profile.county } }
  }
}

describe('robertCatalogMiner — effectiveFloorFor', () => {
  it('uses the trusted floor (40) for vetted record origins', () => {
    expect(effectiveFloorFor({ record_origin: 'curated_catalog' }, 'ACCEPT')).toBe(40)
    expect(effectiveFloorFor({ record_origin: 'scholarship_crawler' }, 'REVIEW')).toBe(40)
  })
  it('uses the full floor (55) for open-web origins', () => {
    expect(effectiveFloorFor({ record_origin: 'live_crawl' }, 'ACCEPT')).toBe(55)
    expect(effectiveFloorFor({ record_origin: null }, 'ACCEPT')).toBe(55)
  })
  it('blocks any REJECT decision regardless of origin', () => {
    expect(effectiveFloorFor({ record_origin: 'curated_catalog' }, 'REJECT')).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('robertCatalogMiner — fetchCatalogForProfile', () => {
  let db
  beforeEach(() => { db = makeDb() })

  it('returns national + in-state rows and excludes out-of-state, inactive, hidden', async () => {
    insertOpp(db, { id: 'nat', title: 'National Grant', is_national: 1 })
    insertOpp(db, { id: 'tn', title: 'TN Grant', state: 'TN' })
    insertOpp(db, { id: 'ca', title: 'CA Grant', state: 'CA' })
    insertOpp(db, { id: 'inactive', title: 'Old Grant', state: 'TN', is_active: 0 })
    insertOpp(db, { id: 'hidden', title: 'Hidden Grant', state: 'TN', is_hidden: 1 })

    const rows = await fetchCatalogForProfile(db, { state: 'TN' }, 100)
    const ids = rows.map((r) => r.id).sort()
    expect(ids).toContain('nat')
    expect(ids).toContain('tn')
    expect(ids).not.toContain('ca')
    expect(ids).not.toContain('inactive')
    expect(ids).not.toContain('hidden')
  })
})

describe('robertCatalogMiner — mineCatalogForProfiles', () => {
  let db
  beforeEach(() => {
    db = makeDb()
    insertProfile(db, { id: 'p1', display_name: 'Hope House', state: 'TN' })
  })

  it('matches an existing catalog row to a fitting profile and creates a recommendation', async () => {
    const oppId = insertOpp(db, { id: 'o-strong', title: 'TN Family Support Grant', state: 'TN', record_origin: 'curated_catalog' })

    const errors = []
    const matched = []
    const recommendations = []
    const result = await mineCatalogForProfiles({
      db,
      profileIds: ['p1'],
      getCtx: makeCtx(db),
      config: {},
      runId: 'run-1',
      computeMatchDecision: fakeMatcher,
      errors,
      matched,
      recommendations,
    })

    expect(errors).toEqual([])
    expect(result.matched).toBe(1)
    expect(result.recommendations_created).toBe(1)
    expect(recommendations[0].opportunity_id).toBe(oppId)

    const rec = db.prepare('SELECT * FROM robert_profile_recommendations WHERE profile_id = ?').get('p1')
    expect(rec).toBeTruthy()
    expect(rec.opportunity_id).toBe(oppId)
    expect(rec.match_decision).toBe('ACCEPT')
    expect(rec.why_found).toMatch(/funding catalog/i)
  })

  it('excludes a catalog row that is already in the profile pipeline', async () => {
    const inPipeline = insertOpp(db, { id: 'o-saved', title: 'TN Already Saved Grant', state: 'TN' })
    const fresh = insertOpp(db, { id: 'o-fresh', title: 'TN Fresh Grant', state: 'TN' })
    // user already saved the first one
    insertGrant(db, { profile_id: 'p1', funding_opportunity_id: inPipeline, title: 'TN Already Saved Grant', status: 'saved' })

    const result = await mineCatalogForProfiles({
      db,
      profileIds: ['p1'],
      getCtx: makeCtx(db),
      config: {},
      computeMatchDecision: fakeMatcher,
    })

    expect(result.excluded_pipeline).toBe(1)
    const recs = db.prepare('SELECT opportunity_id FROM robert_profile_recommendations').all().map((r) => r.opportunity_id)
    expect(recs).toContain(fresh)
    expect(recs).not.toContain(inPipeline)
  })

  it('drops below-floor and REJECT rows, never fabricating recommendations', async () => {
    insertOpp(db, { id: 'o-weak', title: 'TN Weak Match Grant', state: 'TN', record_origin: 'live_crawl' }) // score 30 < 55
    insertOpp(db, { id: 'o-reject', title: 'TN Reject Grant', state: 'TN' })                                  // REJECT
    insertOpp(db, { id: 'o-good', title: 'TN Good Grant', state: 'TN' })                                      // ACCEPT 88

    const result = await mineCatalogForProfiles({
      db,
      profileIds: ['p1'],
      getCtx: makeCtx(db),
      config: {},
      computeMatchDecision: fakeMatcher,
    })

    expect(result.recommendations_created).toBe(1)
    const recs = db.prepare('SELECT opportunity_id FROM robert_profile_recommendations').all().map((r) => r.opportunity_id)
    expect(recs).toEqual(['o-good'])
  })
})

describe('robertEmailFeedBridge — runEmailFeedForRobert', () => {
  it('invokes the injected feeder and reports it ran', async () => {
    let called = false
    const fakeFeed = async (_db, opts) => {
      called = true
      return { ok: true, candidates: 2, summary: { imported: 2 } }
    }
    const res = await runEmailFeedForRobert({ db: {}, runOutlookGrantFeed: fakeFeed })
    expect(called).toBe(true)
    expect(res.ran).toBe(true)
    expect(res.result.summary.imported).toBe(2)
  })

  it('reports a no-op (does not throw) when the feeder says outlook is not configured', async () => {
    const notConfigured = async () => ({ ok: false, reason: 'outlook_not_configured' })
    const res = await runEmailFeedForRobert({ db: {}, runOutlookGrantFeed: notConfigured })
    expect(res.ran).toBe(false)
    expect(res.reason).toBe('outlook_not_configured')
  })

  it('respects EMAIL_GRANTS_SYNC_ENABLED=false', async () => {
    const prev = process.env.EMAIL_GRANTS_SYNC_ENABLED
    process.env.EMAIL_GRANTS_SYNC_ENABLED = 'false'
    try {
      let called = false
      const res = await runEmailFeedForRobert({ db: {}, runOutlookGrantFeed: async () => { called = true; return { ok: true } } })
      expect(called).toBe(false)
      expect(res.reason).toBe('email_feed_disabled')
    } finally {
      if (prev === undefined) delete process.env.EMAIL_GRANTS_SYNC_ENABLED
      else process.env.EMAIL_GRANTS_SYNC_ENABLED = prev
    }
  })
})

describe('runRobert cycle — email feed invoked + catalog mined', () => {
  let db
  beforeEach(() => {
    db = makeDb()
    insertProfile(db, { id: 'p1', display_name: 'Hope House', state: 'TN' })
    insertOpp(db, { id: 'o-good', title: 'TN Good Grant', state: 'TN', record_origin: 'curated_catalog' })
  })

  it('invokes the (mocked) email feeder during a recommend-mode cycle and produces catalog-mined recommendations', async () => {
    let feedCalls = 0
    const fakeFeed = async () => {
      feedCalls += 1
      return { ok: true, candidates: 1, summary: { imported: 1 } }
    }

    const result = await runRobert({
      db,
      mode: 'recommend',
      trigger: 'manual',
      deps: {
        configOverride: { enabled: true, persistCandidates: false },
        loadProfileContext: async (_d, id) => {
          const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id)
          return profile ? { profile, sections: {}, signals: { state: profile.state } } : null
        },
        listActiveProfileIds: async () => ['p1'],
        computeMatchDecision: fakeMatcher,
        runOutlookGrantFeed: fakeFeed,
      },
    })

    expect(result.status).toBe('completed')
    // Email feed was invoked in the cycle.
    expect(feedCalls).toBe(1)
    expect(result.summary.email_feed?.ran).toBe(true)
    // Catalog mining produced a real recommendation for the existing row.
    expect(result.summary.catalog_mine?.recommendations_created).toBe(1)
    const rec = db.prepare('SELECT * FROM robert_profile_recommendations WHERE profile_id = ?').get('p1')
    expect(rec?.opportunity_id).toBe('o-good')
  })
})

/**
 * POST /api/discovery/comprehensiveMatch — the Discover page's result feed —
 * has ONE selector (selectProfileOsResults, shared with GET /discover-grants).
 *
 * Until 2026-09-17 the route carried a second, catalog-wide live-scoring
 * selector behind the persisted-match branch. It was unreachable in production
 * (every request with a profile id returned above it; every request without
 * one was refused), and it discarded the engine decision — so had it ever run,
 * the zero-result ladder's REJECT filter would have had nothing to read. These
 * tests pin the consolidated behavior against the sanitized production capture.
 */
import express from 'express'
import request from 'supertest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeEach } from 'vitest'

import discoveryRouter from '../routes/discovery.js'
import { qualifiesForDisplay } from '../config/matchSurfacing.js'
import { loadRegressionFixture, FIXTURE_PROFILE_ID, CASE_IDS } from './fixtures/regression/tn-student-2026-09-17/index.js'

const fixture = loadRegressionFixture()

const OPPORTUNITY_COLUMNS = [...new Set([
  ...fixture.opportunities.flatMap((o) => Object.keys(o)),
  'id', 'title', 'funder', 'sponsor', 'source', 'record_origin', 'categories', 'state', 'is_national',
  'is_active', 'is_hidden', 'profile_id', 'application_url', 'apply_url', 'source_url', 'evidence_url',
  'opportunity_kind', 'source_trust_tier', 'reality_status', 'deadline', 'amount_min', 'amount_max',
  'updated_at', 'created_at',
])]

function sqlValue(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'object') return JSON.stringify(value)
  return value
}

function makeDb() {
  const db = new Database(':memory:')
  // Untyped columns (NONE affinity) so fixture values keep their JS types.
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, display_name, user_id, created_by, state, tags DEFAULT '[]',
      organization_id, primary_type, interests, status, created_at, updated_at
    );
    CREATE TABLE profile_sections (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      profile_id NOT NULL, section_key NOT NULL, data NOT NULL,
      UNIQUE(profile_id, section_key)
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, profile_id, funding_opportunity_id, title, funder, deadline, url, application_url, fingerprint
    );
    CREATE TABLE funding_opportunities (
      ${OPPORTUNITY_COLUMNS.map((c) => (c === 'id' ? 'id TEXT PRIMARY KEY' : c)).join(', ')}
    );
    CREATE TABLE profile_opportunity_matches (
      id TEXT PRIMARY KEY, profile_id NOT NULL, opportunity_id NOT NULL,
      match_score, match_confidence, match_decision, match_explanation, match_reasons,
      match_explain_json, matcher_version, source_query, discovered_via,
      computed_at, updated_at, evaluated_at,
      UNIQUE(profile_id, opportunity_id)
    );
  `)
  return db
}

function seedProfile(db) {
  db.prepare(
    `INSERT INTO profiles (id, display_name, primary_type, status, tags, organization_id)
     VALUES (?, 'Student', ?, 'active', '[]', NULL)`,
  ).run(FIXTURE_PROFILE_ID, fixture.profile.primary_type)
  const insertSection = db.prepare(
    `INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)`,
  )
  for (const section of fixture.sections) {
    insertSection.run(FIXTURE_PROFILE_ID, section.section_key, JSON.stringify(section.data))
  }
}

function seedOpportunity(db, row) {
  const cols = OPPORTUNITY_COLUMNS.filter((c) => row[c] !== undefined)
  db.prepare(
    `INSERT INTO funding_opportunities (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  ).run(...cols.map((c) => sqlValue(row[c])))
}

function seedMatch(db, match) {
  db.prepare(
    `INSERT INTO profile_opportunity_matches
       (id, profile_id, opportunity_id, match_score, match_confidence, match_decision, match_explanation,
        match_reasons, match_explain_json, matcher_version, computed_at, updated_at, evaluated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    match.id ?? `${match.profile_id}:${match.opportunity_id}`,
    match.profile_id,
    match.opportunity_id,
    sqlValue(match.match_score),
    sqlValue(match.match_confidence),
    match.match_decision,
    match.match_explanation ?? null,
    sqlValue(match.match_reasons ?? []),
    sqlValue(match.match_explain_json),
    match.matcher_version,
    match.computed_at ?? '2026-09-17T00:00:00.000Z',
    match.updated_at ?? '2026-09-17T00:00:00.000Z',
    match.evaluated_at ?? '2026-09-17T00:00:00.000Z',
  )
}

function seedCapture(db) {
  seedProfile(db)
  for (const opp of fixture.opportunities) seedOpportunity(db, { ...opp, is_active: 1, is_hidden: 0 })
  for (const match of fixture.matches) seedMatch(db, match)
}

/**
 * A canonical REJECT in a surfaced lane with a high score and an otherwise
 * complete proof. The opportunity is a CLONE of a real, verified, trusted
 * catalog row from the capture (new id, same URLs/trust/reality), so the only
 * thing the funnel can refuse it for is the decision — a synthetic URL would
 * be dropped for trust first and the test would prove nothing about rejects.
 */
function seedHighScoreReject(db) {
  const template = fixture.matchByOpportunityId(CASE_IDS.jacksonvilleNoGeo)
  const explain = fixture.parseExplain(template)
  explain.canonical_decision = 'REJECT'
  if (explain.four_truth_proof?.relatable) {
    explain.four_truth_proof.relatable.canonical_decision = 'REJECT'
    explain.four_truth_proof.relatable.passed = false
  }
  seedOpportunity(db, {
    ...fixture.opportunityById(CASE_IDS.jacksonvilleNoGeo),
    id: 'opp-reject-80',
    title: 'Cloned verified row carrying a canonical REJECT',
    canonical_opportunity_key: 'test:cloned-reject-80',
    is_active: 1,
    is_hidden: 0,
  })
  seedMatch(db, {
    profile_id: FIXTURE_PROFILE_ID,
    opportunity_id: 'opp-reject-80',
    match_score: 80,
    match_confidence: 90,
    match_decision: 'reject',
    match_explanation: 'Requires veteran status',
    match_reasons: ['Requires veteran status'],
    match_explain_json: JSON.stringify(explain),
    matcher_version: 'crawler-os',
  })
}

function makeApp(db, { admin = true } = {}) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = db
    req.user = admin
      ? { role: 'admin', id: 'admin-1', userId: 'admin-1' }
      : { role: 'user', id: 'user-1', userId: 'user-1' }
    req.ctx = { isAdmin: admin, userId: req.user.userId }
    next()
  })
  app.use('/api/discovery', discoveryRouter)
  return app
}

const post = (app, body) => request(app).post('/api/discovery/comprehensiveMatch').send(body)

describe('POST /comprehensiveMatch — one selector, reject-proof', () => {
  let db
  beforeEach(() => {
    db = makeDb()
    seedCapture(db)
  })

  it('never returns a canonical reject, however high its persisted score, and accounts for it', async () => {
    seedHighScoreReject(db)
    const res = await post(makeApp(db), { profile_json: FIXTURE_PROFILE_ID })
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    const ids = res.body.opportunities.map((o) => o.id)
    expect(ids).not.toContain('opp-reject-80')
    for (const row of res.body.opportunities) {
      expect(String(row.match_decision).toLowerCase()).toBe('accept')
      expect(qualifiesForDisplay(row, res.body.threshold_used)).toBe(true)
    }
    const ledger = res.body.removal_ledger
    expect(ledger.reconciles, JSON.stringify(ledger)).toBe(true)
    expect(ledger.loaded).toBe(fixture.matches.length + 1)
    // The reject must be accounted for BY ITS DECISION — the canonical funnel
    // (rejectHardIneligible → dropReason 'decision') or the display gate
    // ('rejected') — never silently, and never under an unrelated reason.
    const rejectAccounted = (ledger.removed.canonical.decision ?? 0) + (ledger.removed.display.rejected ?? 0)
    expect(rejectAccounted, JSON.stringify(ledger)).toBeGreaterThanOrEqual(1)
  })

  it('returns persisted proven accepts with their decision and explain provenance (2026-09-17 reality)', async () => {
    const res = await post(makeApp(db), { profile_json: FIXTURE_PROFILE_ID })
    expect(res.status).toBe(200)
    const provenAccepts = fixture.matches
      .filter((m) => m.match_decision === 'accept')
      .map((m) => m.opportunity_id)
    const returned = res.body.opportunities.map((o) => o.id)
    // The known-bad accepts (no eligibility text / no location / international-only)
    // are persisted with all_passed proofs on the deployed commit. This route is
    // a reader, not a judge: they surface until the engine PRs re-score them.
    expect(returned.filter((id) => provenAccepts.includes(id)).length).toBeGreaterThanOrEqual(1)
    for (const row of res.body.opportunities) {
      expect(row.match_explain_json).toBeTruthy()
      expect(row.engine).toBe('crawler-os')
    }
    expect(res.body.removal_ledger.reconciles).toBe(true)
    expect(res.body.removal_ledger.returned).toBe(res.body.opportunities.length)
    expect(res.body.total_evaluated).toBeGreaterThanOrEqual(res.body.opportunities.length)
  })

  it('G2: zero qualified rows runs the recovery ladder and reports it honestly instead of a bare empty set', async () => {
    const only = makeDb()
    seedProfile(only)
    seedOpportunity(only, { ...fixture.opportunityById(CASE_IDS.ecfParent), is_active: 1, is_hidden: 0 })
    seedMatch(only, fixture.matchByOpportunityId(CASE_IDS.ecfParent)) // review 10
    const res = await post(makeApp(only), { profile_json: FIXTURE_PROFILE_ID })
    expect(res.status).toBe(200)
    // A REVIEW row is a research lead, never direct funding: the ladder
    // re-admits it, the four-truth boundary removes it again, and the ledger
    // shows both movements rather than an unexplained zero.
    expect(res.body.opportunities).toEqual([])
    expect(res.body.zero_result).toBe(true)
    expect(res.body.relaxation?.applied).toBe(true)
    expect(res.body.result_tier).toBeTruthy()
    const ledger = res.body.removal_ledger
    expect(ledger.loaded).toBe(1)
    expect(ledger.removed.display.review_not_accept).toBe(1)
    expect(ledger.recovery.readmitted).toBe(1)
    expect(ledger.removed.truth_boundary).toBe(1)
    expect(ledger.reconciles).toBe(true)
  })

  it('refuses requests that cannot name a match store', async () => {
    expect((await post(makeApp(db), {})).status).toBe(400)
    const nonAdminObject = await post(makeApp(db, { admin: false }), { profile_json: { id: 'inline' } })
    expect(nonAdminObject.status).toBe(403)
    const adminObject = await post(makeApp(db), { profile_json: { id: 'inline' } })
    expect(adminObject.status).toBe(400)
    expect(adminObject.body.error).toBe('profile_required')
    const unknown = await post(makeApp(db), { profile_json: 'no-such-profile' })
    expect([403, 404]).toContain(unknown.status)
    expect(unknown.body.success).toBe(false)
  })

  it('has exactly one selector in source: the live-scoring fallback and its relaxation constants are gone', () => {
    const source = readFileSync(new URL('../routes/discovery.js', import.meta.url), 'utf8')
    // Imports and calls, not prose: the route's doc comment records the
    // removed fallback by name so the next reader knows why it is gone.
    expect(source).not.toMatch(/import\s*\{[^}]*\b(FALLBACK_TOP_N|RELAX_THRESHOLDS|scoreOpportunity)\b/)
    expect(source).not.toMatch(/\bscoreOpportunity\(/)
    expect(source).not.toMatch(/\.slice\(0,\s*FALLBACK_TOP_N\)/)
    expect(source.match(/router\.post\('\/comprehensiveMatch'/g)).toHaveLength(1)
    expect((source.match(/selectProfileOsResults\(/g) || []).length).toBeGreaterThanOrEqual(3)
  })
})

it('the discovery HTTP response preserves the selected application URL when catalog aliases disagree', async () => {
  const db=makeDb()
  try {
    seedCapture(db)
    const before=await post(makeApp(db),{profile_json:FIXTURE_PROFILE_ID})
    const selected=before.body.opportunities.find((row)=>row.application_url && !row.is_directory)
    expect(selected).toBeTruthy()
    const validTarget=selected.application_url
    db.prepare('UPDATE funding_opportunities SET apply_url=?,application_url=? WHERE id=?')
      .run(validTarget,'https://alpha.grantable.co/login?ref=apply',selected.id)
    const after=await post(makeApp(db),{profile_json:FIXTURE_PROFILE_ID})
    expect(after.status).toBe(200)
    const returned=after.body.opportunities.find((row)=>row.id===selected.id)
    expect(returned).toBeTruthy()
    expect(returned.apply_url).toBe(validTarget)
    expect(returned.application_url).toBe(validTarget)
    expect(returned.url).toBe(validTarget)
  } finally {db.close()}
})

it('the discovery HTTP formatter never promotes a source-only URL to an application alias', async () => {
  const db=makeDb()
  try {
    seedCapture(db)
    const before=await post(makeApp(db),{profile_json:FIXTURE_PROFILE_ID})
    const selected=before.body.opportunities.find(row=>row.application_url && !row.is_directory)
    expect(selected).toBeTruthy()
    db.prepare('UPDATE funding_opportunities SET apply_url=NULL,application_url=NULL WHERE id=?').run(selected.id)
    const after=await post(makeApp(db),{profile_json:FIXTURE_PROFILE_ID})
    expect(after.status).toBe(200)
    const row=after.body.opportunities.find(item=>item.id===selected.id)
    // A preserved historical result can still be informative, not apply-now.
    if(row) { expect(row.application_url).toBeNull(); expect(row.source_url || row.url).toBeTruthy() }
    expect(after.body.opportunities.some(item=>item.id===selected.id && item.application_url)).toBe(false)
  } finally {db.close()}
})

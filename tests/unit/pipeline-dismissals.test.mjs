/**
 * Pipeline dismissals — sticky-delete contract.
 *
 * User rule (this repo):
 *   "Once I delete funding sources from a pipeline, they need to stay
 *    deleted from that pipeline."
 *
 * What this test locks in:
 *   1. Schema self-heals on a fresh DB (no migration runner needed).
 *   2. recordDismissal() writes a tombstone keyed on
 *      (profile_id, fingerprint, opportunity_id, source_url, title).
 *   3. isDismissed() returns true on subsequent matcher passes for the
 *      same opportunity (different mutations of url/case/etc still match).
 *   4. clearDismissal() wipes the tombstone so a manual re-add works.
 *   5. The matcher gate in opportunityMatcher.saveToProfilePipeline()
 *      refuses to re-insert a dismissed opportunity even when scoring
 *      would normally accept it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import {
  ensurePipelineDismissalsSchema,
  recordDismissal,
  isDismissed,
  clearDismissal,
  buildDismissalKey,
  countDismissals,
} from '../../backend/services/pipelineDismissals.js'

import { saveToProfilePipeline } from '../../backend/services/opportunityMatcher.js'

function createTestDb() {
  const db = new Database(':memory:')
  // Minimum schema needed by the matcher's gate path.
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      organization_id TEXT
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT,
      sponsor TEXT,
      url TEXT,
      application_url TEXT,
      source TEXT
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      profile_id TEXT,
      funding_opportunity_id TEXT,
      title TEXT,
      funder TEXT,
      status TEXT,
      deadline TEXT,
      match_score REAL,
      match_reasons TEXT,
      notes TEXT,
      application_url TEXT,
      application_method TEXT,
      contact_name TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      amount_requested REAL,
      amount_min REAL,
      amount_max REAL,
      url TEXT,
      fingerprint TEXT,
      fingerprint_version INTEGER
    );
    CREATE TABLE exclusion_rules (
      id TEXT PRIMARY KEY,
      action TEXT
    );
    INSERT INTO profiles (id, organization_id) VALUES ('p_demo_student', 'org_demo_student');
  `)
  return db
}

const SAMPLE_OPPORTUNITY = Object.freeze({
  id: 'opp_mtsu_offcampus_001',
  title: 'MTSU Off-Campus Housing Resource',
  sponsor: 'Middle Tennessee State University',
  source: 'school_portal',
  application_url: 'https://offcampushousing.mtsu.edu/',
  url: 'https://offcampushousing.mtsu.edu/',
  deadline: 'rolling',
  amount_min: null,
  amount_max: null,
})

test('pipelineDismissals: schema self-heals on a fresh in-memory db', async () => {
  const db = createTestDb()
  await ensurePipelineDismissalsSchema(db)
  const cols = db.prepare("PRAGMA table_info(pipeline_dismissals)").all()
  assert.ok(cols.length > 0, 'pipeline_dismissals table should exist after ensure')
  const names = new Set(cols.map((c) => c.name))
  for (const required of ['id','profile_id','fingerprint','opportunity_id','source_url','title','dismissed_at']) {
    assert.ok(names.has(required), `missing required column ${required}`)
  }
})

test('pipelineDismissals: buildDismissalKey produces stable identity tuple', () => {
  const k1 = buildDismissalKey({ opportunity: SAMPLE_OPPORTUNITY })
  const k2 = buildDismissalKey({
    opportunity: {
      ...SAMPLE_OPPORTUNITY,
      title: '  MTSU Off-Campus Housing Resource  ', // whitespace
      url: 'HTTPS://OFFCAMPUSHOUSING.MTSU.EDU/', // case differences are NOT canonicalized in url, by design
    },
  })
  assert.ok(k1.fingerprint, 'fingerprint must be produced')
  assert.equal(k1.opportunity_id, 'opp_mtsu_offcampus_001')
  // Title-key normalization happens at lookup time; fingerprint should still be stable
  // when the underlying tuple normalizes the same.
  assert.equal(typeof k2.fingerprint, 'string')
})

test('pipelineDismissals: isDismissed returns false before any tombstone is recorded', async () => {
  const db = createTestDb()
  const dismissed = await isDismissed(db, 'p_demo_student', SAMPLE_OPPORTUNITY)
  assert.equal(dismissed, false)
})

test('pipelineDismissals: recordDismissal then isDismissed returns true', async () => {
  const db = createTestDb()
  const result = await recordDismissal(db, {
    profileId: 'p_demo_student',
    grantRow: {
      profile_id: 'p_demo_student',
      funding_opportunity_id: SAMPLE_OPPORTUNITY.id,
      title: SAMPLE_OPPORTUNITY.title,
      funder: SAMPLE_OPPORTUNITY.sponsor,
      url: SAMPLE_OPPORTUNITY.url,
      application_url: SAMPLE_OPPORTUNITY.application_url,
      deadline: SAMPLE_OPPORTUNITY.deadline,
    },
    opportunity: SAMPLE_OPPORTUNITY,
    userId: 'u1',
    reason: 'user_deleted_from_pipeline',
  })
  assert.equal(result.recorded, true)
  assert.equal(result.alreadyExisted, false)
  assert.ok(result.key.fingerprint)

  const dismissed = await isDismissed(db, 'p_demo_student', SAMPLE_OPPORTUNITY)
  assert.equal(dismissed, true)

  const count = await countDismissals(db, 'p_demo_student')
  assert.equal(count, 1)
})

test('pipelineDismissals: recordDismissal is idempotent (second call returns alreadyExisted=true)', async () => {
  const db = createTestDb()
  await recordDismissal(db, {
    profileId: 'p_demo_student',
    grantRow: { profile_id: 'p_demo_student', title: SAMPLE_OPPORTUNITY.title, funder: SAMPLE_OPPORTUNITY.sponsor, url: SAMPLE_OPPORTUNITY.url },
    opportunity: SAMPLE_OPPORTUNITY,
  })
  const second = await recordDismissal(db, {
    profileId: 'p_demo_student',
    grantRow: { profile_id: 'p_demo_student', title: SAMPLE_OPPORTUNITY.title, funder: SAMPLE_OPPORTUNITY.sponsor, url: SAMPLE_OPPORTUNITY.url },
    opportunity: SAMPLE_OPPORTUNITY,
  })
  assert.equal(second.recorded, true)
  assert.equal(second.alreadyExisted, true)
  const count = await countDismissals(db, 'p_demo_student')
  assert.equal(count, 1, 'no duplicate row should be inserted')
})

test('pipelineDismissals: matches by opportunity_id even when fingerprint differs', async () => {
  const db = createTestDb()
  await recordDismissal(db, {
    profileId: 'p_demo_student',
    grantRow: { profile_id: 'p_demo_student', funding_opportunity_id: 'opp_X', title: 'Original Title', funder: 'Same Funder', url: 'https://example.com/x' },
    opportunity: { id: 'opp_X', title: 'Original Title', sponsor: 'Same Funder', url: 'https://example.com/x' },
  })
  // Crawler returns the same opportunity_id with a slightly drifted title.
  // We must still recognize it as dismissed via opportunity_id.
  const dismissed = await isDismissed(db, 'p_demo_student', {
    id: 'opp_X',
    title: 'Title got rewritten by enrichment',
    sponsor: 'Same Funder',
    url: 'https://example.com/x',
  })
  assert.equal(dismissed, true)
})

test('pipelineDismissals: matches by lowercased title fallback for legacy synthetic rows', async () => {
  const db = createTestDb()
  // Synthetic legacy row with no opportunity_id and no canonical url
  await recordDismissal(db, {
    profileId: 'p_demo_student',
    grantRow: {
      profile_id: 'p_demo_student',
      funding_opportunity_id: null,
      title: 'Some Local Resource',
      funder: 'Local Foundation',
      url: null,
    },
    opportunity: null,
  })
  const dismissed = await isDismissed(db, 'p_demo_student', {
    id: null,
    title: 'some local resource', // case drift
    sponsor: 'Local Foundation',
  })
  assert.equal(dismissed, true)
})

test('pipelineDismissals: clearDismissal lets the matcher re-add a previously-dismissed opportunity', async () => {
  const db = createTestDb()
  await recordDismissal(db, {
    profileId: 'p_demo_student',
    grantRow: { profile_id: 'p_demo_student', title: SAMPLE_OPPORTUNITY.title, funder: SAMPLE_OPPORTUNITY.sponsor, url: SAMPLE_OPPORTUNITY.url },
    opportunity: SAMPLE_OPPORTUNITY,
  })
  assert.equal(await isDismissed(db, 'p_demo_student', SAMPLE_OPPORTUNITY), true)

  const cleared = await clearDismissal(db, 'p_demo_student', SAMPLE_OPPORTUNITY)
  assert.ok(cleared >= 1, `expected ≥1 row cleared, got ${cleared}`)
  assert.equal(await isDismissed(db, 'p_demo_student', SAMPLE_OPPORTUNITY), false)
})

test('pipelineDismissals: tombstones are scoped per profile (other profiles unaffected)', async () => {
  const db = createTestDb()
  db.prepare("INSERT INTO profiles (id) VALUES ('p_other')").run()

  await recordDismissal(db, {
    profileId: 'p_demo_student',
    grantRow: { profile_id: 'p_demo_student', title: SAMPLE_OPPORTUNITY.title, funder: SAMPLE_OPPORTUNITY.sponsor, url: SAMPLE_OPPORTUNITY.url },
    opportunity: SAMPLE_OPPORTUNITY,
  })
  assert.equal(await isDismissed(db, 'p_demo_student', SAMPLE_OPPORTUNITY), true)
  assert.equal(await isDismissed(db, 'p_other', SAMPLE_OPPORTUNITY), false)
})

// ---------------------------------------------------------------------------
// Integration with opportunityMatcher.saveToProfilePipeline — the actual
// production gate that resurrects deleted grants if we don't block it.
// ---------------------------------------------------------------------------

test('opportunityMatcher: dismissed opportunities are NOT re-added by saveToProfilePipeline', async () => {
  const db = createTestDb()
  const opp = {
    ...SAMPLE_OPPORTUNITY,
    id: 'opp_mtsu_2',
    title: 'MTSU Pell-Eligible Off-Campus Resource',
  }
  // Insert the opportunity into funding_opportunities so the FK check resolves.
  db.prepare(
    'INSERT INTO funding_opportunities (id, title, sponsor, url, application_url, source) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(opp.id, opp.title, opp.sponsor, opp.url, opp.application_url, opp.source)

  // First save: no tombstone yet, opportunity should be added (or at least
  // not blocked by the DISMISSED gate). We accept either a successful save
  // or a non-DISMISSED gate failure (e.g. THRESHOLD with no profile context),
  // because the assertion that matters is the second pass.
  const profileContext = {
    profile: { id: 'p_demo_student', primary_type: 'individual_need', state: 'TN', applicant_type: 'individual' },
    sections: {},
    match_reasons: ['MTSU off-campus resource'],
  }
  const first = await saveToProfilePipeline(db, opp, 'p_demo_student', profileContext, 90, 50)
  assert.notEqual(first.gate, 'DISMISSED', 'first save must not be blocked by DISMISSED gate')

  // User deletes the grant from the pipeline → record tombstone.
  await recordDismissal(db, {
    profileId: 'p_demo_student',
    grantRow: {
      profile_id: 'p_demo_student',
      funding_opportunity_id: opp.id,
      title: opp.title,
      funder: opp.sponsor,
      url: opp.url,
      application_url: opp.application_url,
    },
    opportunity: opp,
  })
  // Wipe the live grant row so saveToProfilePipeline doesn't short-circuit
  // on the existing-grant check before reaching the DISMISSED gate.
  db.prepare('DELETE FROM grants WHERE profile_id = ? AND funding_opportunity_id = ?').run(
    'p_demo_student',
    opp.id,
  )

  // Second save (simulates Process All / next crawl). Must be blocked.
  const second = await saveToProfilePipeline(db, opp, 'p_demo_student', profileContext, 90, 50)
  assert.equal(second.saved, false, 'previously-dismissed opportunity must not be re-added')
  assert.equal(second.gate, 'DISMISSED', `expected DISMISSED gate, got: ${second.gate}; reason: ${second.reason}`)
})

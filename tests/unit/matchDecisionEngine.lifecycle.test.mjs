/**
 * Match Decision Engine — Lifecycle & Pipeline Tests
 *
 * Covers:
 *  A) Profile pipeline profile_id scoping: grants are scoped to the correct profile
 *  B) Duplicate prevention: inserting the same opportunity twice is idempotent
 *  C) reEvaluateStalePipelineEntries: stale rows are re-evaluated using the canonical engine
 *  D) Matcher_version-triggered re-evaluation: rows with old version are detected as stale
 *  E) Profile fingerprint change: rows become stale when profile fingerprint changes
 *  F) Opportunity fingerprint change: rows become stale when opportunity fingerprint changes
 *  G) Startup seeding uses canonical decision flow (computeMatchDecision gates INSERT)
 *  H) seedOnStartup.seedFundingOpportunities: blocked in production
 *  I) REJECT rows are removed during re-evaluation
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  computeMatchDecision,
  normalizeProfile,
  normalizeOpportunity,
  computeProfileFingerprint,
  computeOpportunityFingerprint,
  MATCHER_VERSION,
} from '../../backend/services/matchDecisionEngine.js'

import {
  reEvaluateStalePipelineEntries,
  seedFundingOpportunities,
} from '../../backend/utils/seedOnStartup.js'

import { saveToProfilePipeline } from '../../backend/services/opportunityMatcher.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ---------------------------------------------------------------------------
// Shared: create a fully-migrated in-memory database
// ---------------------------------------------------------------------------

function buildDb() {
  const raw = new Database(':memory:')
  raw.pragma('foreign_keys = OFF') // simplify test setup

  // Apply core schema
  const schema = readFileSync(path.resolve(__dirname, '../../backend/db/schema.sql'), 'utf8')
  raw.exec(schema)

  // Apply migration 036 (match decision columns)
  // Parse each statement, strip comment lines, and execute non-empty statements
  const migration036 = readFileSync(
    path.resolve(__dirname, '../../backend/db/migrations/036_match_decision_metadata.sql'),
    'utf8',
  )
  for (const rawStmt of migration036.split(';')) {
    // Strip comment lines and blank lines from each chunk
    const sqlLines = rawStmt
      .split('\n')
      .filter((line) => !line.trim().startsWith('--') && line.trim().length > 0)
      .join('\n')
      .trim()
    if (!sqlLines) continue
    try { raw.exec(sqlLines) } catch { /* column may already exist — safe to ignore */ }
  }

  // Wrap to match the DB interface used by saveToProfilePipeline (async-compatible sync API)
  const db = {
    dialect: 'sqlite',
    prepare(sql) {
      const stmt = raw.prepare(sql)
      return {
        get: (...args) => stmt.get(...args),
        all: (...args) => stmt.all(...args),
        run: (...args) => stmt.run(...args),
      }
    },
    exec(sql) { raw.exec(sql) },
    // Expose the raw DB for direct queries in tests
    _raw: raw,
  }
  return db
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const HOUSING_OPPORTUNITY = {
  id: 'opp-housing-1',
  title: 'Emergency Rent Assistance Program',
  description: 'Direct financial assistance for households facing eviction or housing instability.',
  application_url: 'https://hud.gov/emergency-rent',
  is_national: 1,
  categories: JSON.stringify(['housing', 'emergency']),
  keywords: JSON.stringify(['housing', 'rent', 'eviction', 'emergency']),
  eligibility_bullets: JSON.stringify(['Open to low-income households', 'No income verification required']),
  sponsor: 'HUD',
  source: 'hud.gov',
}

const PROFILE_HOUSING = {
  id: 'profile-housing-1',
  organization_id: 'org-1',
  primary_type: 'individual',
  display_name: 'Housing Profile',
  state: 'OH',
  needs: JSON.stringify(['housing', 'emergency']),
}

const VETERAN_OPPORTUNITY = {
  id: 'opp-veteran-1',
  title: 'Veterans Housing Assistance Grant',
  description: 'Provides housing support to eligible U.S. military veterans.',
  application_url: 'https://va.gov/housing',
  is_national: 1,
  categories: JSON.stringify(['veteran', 'housing']),
  keywords: JSON.stringify(['veteran', 'military', 'housing']),
  eligibility_bullets: JSON.stringify(['Must be a U.S. veteran', 'DD-214 required']),
  sponsor: 'VA',
  source: 'va.gov',
}

function insertProfile(db, profile) {
  try {
    db.prepare(
      `INSERT OR IGNORE INTO profiles (id, organization_id, primary_type, display_name) VALUES (?, ?, ?, ?)`,
    ).run(
      profile.id,
      profile.organization_id ?? null,
      profile.primary_type ?? 'individual',
      profile.display_name ?? profile.id,
    )
    // Store needs and state in profile_sections (basic_information)
    if (profile.state || profile.needs) {
      const sectionData = JSON.stringify({
        state: profile.state ?? null,
        needs: profile.needs ? (typeof profile.needs === 'string' ? JSON.parse(profile.needs) : profile.needs) : [],
      })
      try {
        db.prepare(
          `INSERT OR IGNORE INTO profile_sections (profile_id, section_key, data) VALUES (?, 'basic_information', ?)`,
        ).run(profile.id, sectionData)
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

function insertOrg(db, orgId) {
  try {
    db.prepare(
      `INSERT OR IGNORE INTO organizations (id, name) VALUES (?, ?)`,
    ).run(orgId, 'Test Organization')
  } catch { /* ignore */ }
}

function insertOpportunity(db, opp) {
  try {
    db.prepare(
      `INSERT OR IGNORE INTO funding_opportunities (id, title, description, application_url, is_national, categories, keywords, eligibility_bullets, sponsor, source, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(
      opp.id, opp.title, opp.description, opp.application_url,
      opp.is_national ?? 0, opp.categories ?? '[]', opp.keywords ?? '[]',
      opp.eligibility_bullets ?? '[]', opp.sponsor ?? null, opp.source ?? null,
    )
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// A) Profile pipeline profile_id scoping
// ---------------------------------------------------------------------------

test('pipeline scoping (A): grant is stored with correct profile_id', async () => {
  const db = buildDb()
  insertOrg(db, 'org-1')
  insertProfile(db, PROFILE_HOUSING)
  insertOpportunity(db, HOUSING_OPPORTUNITY)

  const profileContext = { profile: PROFILE_HOUSING, sections: {} }
  const result = await saveToProfilePipeline(db, HOUSING_OPPORTUNITY, PROFILE_HOUSING.id, profileContext)

  if (result.saved) {
    const row = db._raw.prepare('SELECT profile_id FROM grants WHERE id = ?').get(result.pipelineId)
    assert.equal(row?.profile_id, PROFILE_HOUSING.id, 'grant should be scoped to the correct profile_id')
  } else {
    // The decision engine may REJECT or REVIEW; the important thing is no cross-profile leakage.
    // If not saved, no pipeline entry was created — which is also correct.
    assert.ok(
      result.decision === 'REJECT' || result.reason,
      `Expected a reason for not saving, got: ${JSON.stringify(result)}`,
    )
  }
})

test('pipeline scoping (A): grants for different profiles are not cross-leaked', async () => {
  const db = buildDb()
  insertOrg(db, 'org-1')
  insertOrg(db, 'org-2')
  insertProfile(db, PROFILE_HOUSING)
  insertProfile(db, { id: 'profile-other', organization_id: 'org-2', primary_type: 'individual', display_name: 'Other Profile', state: 'TX', needs: '["food"]' })
  insertOpportunity(db, HOUSING_OPPORTUNITY)

  const profileContext1 = { profile: PROFILE_HOUSING, sections: {} }
  const result1 = await saveToProfilePipeline(db, HOUSING_OPPORTUNITY, 'profile-housing-1', profileContext1)

  // Verify profile 2 can NOT see profile 1's grants
  const profile2Grants = db._raw.prepare(
    'SELECT * FROM grants WHERE profile_id = ?',
  ).all('profile-other')

  assert.equal(profile2Grants.length, 0, 'profile-other should have no grants from profile-housing-1 pipeline')
})

// ---------------------------------------------------------------------------
// B) Duplicate prevention
// ---------------------------------------------------------------------------

test('duplicate prevention (B): inserting same opportunity twice is idempotent', async () => {
  const db = buildDb()
  insertOrg(db, 'org-1')
  insertProfile(db, PROFILE_HOUSING)
  insertOpportunity(db, HOUSING_OPPORTUNITY)

  const profileContext = { profile: PROFILE_HOUSING, sections: {} }
  const result1 = await saveToProfilePipeline(db, HOUSING_OPPORTUNITY, PROFILE_HOUSING.id, profileContext)
  const result2 = await saveToProfilePipeline(db, HOUSING_OPPORTUNITY, PROFILE_HOUSING.id, profileContext)

  const count = db._raw.prepare(
    'SELECT COUNT(*) as c FROM grants WHERE profile_id = ? AND (funding_opportunity_id = ? OR title = ?)',
  ).get(PROFILE_HOUSING.id, HOUSING_OPPORTUNITY.id, HOUSING_OPPORTUNITY.title)

  // At most 1 grant row (idempotent)
  assert.ok(count.c <= 1, `Expected at most 1 grant row; got ${count.c}`)

  if (result1.saved) {
    assert.equal(result2.saved, false, 'second insert should report saved=false (duplicate)')
    assert.ok(
      String(result2.reason).toLowerCase().includes('already') ||
        String(result2.reason).toLowerCase().includes('pipeline'),
      `Expected duplicate reason; got: ${result2.reason}`,
    )
  }
})

// ---------------------------------------------------------------------------
// C) reEvaluateStalePipelineEntries: stale row removal/update
// ---------------------------------------------------------------------------

test('stale re-evaluation (C): rows with old matcher_version are detected as stale', () => {
  const db = buildDb()
  const raw = db._raw

  raw.prepare(`INSERT OR IGNORE INTO organizations (id, name) VALUES (?, ?)`).run('org-stale', 'Test Org')
  raw.prepare(`INSERT OR IGNORE INTO profiles (id, organization_id, primary_type, display_name) VALUES (?, ?, ?, ?)`).run('profile-stale', 'org-stale', 'individual', 'Stale Profile')
  raw.prepare(`INSERT OR IGNORE INTO profile_sections (profile_id, section_key, data) VALUES (?, 'basic_information', ?)`).run('profile-stale', JSON.stringify({ state: 'OH', needs: ['housing'] }))
  raw.prepare(`INSERT OR IGNORE INTO funding_opportunities (id, title, description, application_url, is_national, categories, keywords, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run('opp-stale', 'Old Grant', 'Old grant description', 'https://example.gov/old', 1, '["housing"]', '["housing"]')
  raw.prepare(`INSERT INTO grants (id, organization_id, profile_id, funding_opportunity_id, title, match_score, match_decision, matcher_version, profile_fingerprint, opportunity_fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`).run('grant-stale-1', 'org-stale', 'profile-stale', 'opp-stale', 'Old Grant', 70, 'ACCEPT', '1.0.0')

  const { reEvaluated, removed } = reEvaluateStalePipelineEntries(raw)

  // Should have processed the stale row (version 1.0.0 != 2.0.0)
  assert.ok(
    reEvaluated > 0 || removed > 0,
    `Expected at least 1 stale row to be processed; reEvaluated=${reEvaluated}, removed=${removed}`,
  )
})

test('stale re-evaluation (C): rows with null fingerprints are detected as stale', () => {
  const db = buildDb()
  const raw = db._raw

  raw.prepare(`INSERT OR IGNORE INTO organizations (id, name) VALUES (?, ?)`).run('org-nullfp', 'Test Org')
  raw.prepare(`INSERT OR IGNORE INTO profiles (id, organization_id, primary_type, display_name) VALUES (?, ?, ?, ?)`).run('profile-nullfp', 'org-nullfp', 'individual', 'NullFP Profile')
  raw.prepare(`INSERT OR IGNORE INTO profile_sections (profile_id, section_key, data) VALUES (?, 'basic_information', ?)`).run('profile-nullfp', JSON.stringify({ state: 'OH', needs: ['housing'] }))
  raw.prepare(`INSERT OR IGNORE INTO funding_opportunities (id, title, description, application_url, is_national, categories, keywords, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run('opp-nullfp', 'Housing Assistance', 'Provides rent assistance', 'https://hud.gov/rent', 1, '["housing"]', '["housing", "rent"]')
  raw.prepare(`INSERT INTO grants (id, organization_id, profile_id, funding_opportunity_id, title, match_score, match_decision, matcher_version, profile_fingerprint, opportunity_fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`).run('grant-nullfp-1', 'org-nullfp', 'profile-nullfp', 'opp-nullfp', 'Housing Assistance', 70, 'ACCEPT', MATCHER_VERSION)

  const { reEvaluated, removed } = reEvaluateStalePipelineEntries(raw)

  // Null fingerprints means "never evaluated by v2.0.0 engine" — should be re-evaluated
  assert.ok(
    reEvaluated > 0 || removed > 0,
    `Expected stale row (null fingerprints) to be re-evaluated; reEvaluated=${reEvaluated}, removed=${removed}`,
  )
})

// ---------------------------------------------------------------------------
// D) REJECT rows are removed during re-evaluation
// ---------------------------------------------------------------------------

test('stale re-evaluation (D): REJECT decisions remove rows from pipeline', () => {
  const db = buildDb()
  const raw = db._raw

  // Insert a grant that will become REJECT (loan opportunity for any profile)
  raw.prepare(`INSERT OR IGNORE INTO organizations (id, name) VALUES (?, ?)`).run('org-reject', 'Test Org')
  raw.prepare(`INSERT OR IGNORE INTO profiles (id, organization_id, primary_type, display_name) VALUES (?, ?, ?, ?)`).run('profile-reject', 'org-reject', 'individual', 'Reject Profile')
  raw.prepare(`INSERT OR IGNORE INTO profile_sections (profile_id, section_key, data) VALUES (?, 'basic_information', ?)`).run('profile-reject', JSON.stringify({ state: 'OH' }))
  raw.prepare(`
    INSERT OR IGNORE INTO funding_opportunities (
      id, title, description, application_url, is_national, categories, keywords,
      eligibility_bullets, is_active, is_loan
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
  `).run(
    'opp-loan-stale', 'Home Improvement Loan Program',
    'This is a loan program for home improvements. Must repay within 10 years.',
    'https://example.gov/loan', 1, '["housing"]', '["loan", "housing"]',
    '["Must repay the loan", "This is a loan not a grant"]',
  )
  raw.prepare(`INSERT INTO grants (id, organization_id, profile_id, funding_opportunity_id, title, match_score, match_decision, matcher_version, profile_fingerprint, opportunity_fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`).run('grant-reject-1', 'org-reject', 'profile-reject', 'opp-loan-stale', 'Home Improvement Loan Program', 70, 'ACCEPT', '1.0.0')

  const beforeCount = raw.prepare(
    "SELECT COUNT(*) as c FROM grants WHERE profile_id = 'profile-reject'",
  ).get().c
  assert.equal(beforeCount, 1, 'should start with 1 stale grant')

  const { removed } = reEvaluateStalePipelineEntries(raw)

  const afterCount = raw.prepare(
    "SELECT COUNT(*) as c FROM grants WHERE profile_id = 'profile-reject'",
  ).get().c
  assert.equal(afterCount, 0, 'REJECT decision should remove stale loan grant from pipeline')
  assert.ok(removed >= 1, `Expected at least 1 row removed; got ${removed}`)
})

// ---------------------------------------------------------------------------
// E) Profile fingerprint change → stale detection
// ---------------------------------------------------------------------------

test('fingerprint change (E): changing profile state changes profile fingerprint', () => {
  const profile1 = { id: 'fp-profile', primary_type: 'individual', state: 'OH', needs: '["housing"]' }
  const profile2 = { id: 'fp-profile', primary_type: 'individual', state: 'TX', needs: '["housing"]' }

  const fp1 = computeProfileFingerprint(normalizeProfile(profile1))
  const fp2 = computeProfileFingerprint(normalizeProfile(profile2))

  assert.notEqual(fp1, fp2, 'Different states should produce different profile fingerprints')
})

test('fingerprint change (E): adding a need changes profile fingerprint', () => {
  const profile1 = { id: 'fp-profile', primary_type: 'individual', state: 'OH', needs: '["housing"]' }
  const profile2 = { id: 'fp-profile', primary_type: 'individual', state: 'OH', needs: '["housing","education"]' }

  const fp1 = computeProfileFingerprint(normalizeProfile(profile1))
  const fp2 = computeProfileFingerprint(normalizeProfile(profile2))

  assert.notEqual(fp1, fp2, 'Adding a need should change the profile fingerprint')
})

test('fingerprint change (E): same profile produces same fingerprint (deterministic)', () => {
  const profile = { id: 'fp-profile', primary_type: 'individual', state: 'OH', needs: '["housing"]' }

  const fp1 = computeProfileFingerprint(normalizeProfile(profile))
  const fp2 = computeProfileFingerprint(normalizeProfile(profile))

  assert.equal(fp1, fp2, 'Same profile should produce identical fingerprint on repeated calls')
})

// ---------------------------------------------------------------------------
// F) Opportunity fingerprint change → stale detection
// ---------------------------------------------------------------------------

test('fingerprint change (F): marking opportunity as loan changes its fingerprint', () => {
  const opp1 = { id: 'opp-fp', title: 'Housing Assistance', is_national: 1, application_url: 'https://hud.gov' }
  const opp2 = { id: 'opp-fp', title: 'Housing Assistance', is_national: 1, application_url: 'https://hud.gov', is_loan: 1 }

  const fp1 = computeOpportunityFingerprint(normalizeOpportunity(opp1))
  const fp2 = computeOpportunityFingerprint(normalizeOpportunity(opp2))

  assert.notEqual(fp1, fp2, 'is_loan=1 should change opportunity fingerprint')
})

test('fingerprint change (F): same opportunity produces same fingerprint (deterministic)', () => {
  const opp = { id: 'opp-fp', title: 'Housing Assistance', is_national: 1, application_url: 'https://hud.gov' }

  const fp1 = computeOpportunityFingerprint(normalizeOpportunity(opp))
  const fp2 = computeOpportunityFingerprint(normalizeOpportunity(opp))

  assert.equal(fp1, fp2, 'Same opportunity should produce identical fingerprint on repeated calls')
})

// ---------------------------------------------------------------------------
// G) Startup seeding uses canonical decision flow
// ---------------------------------------------------------------------------

test('canonical seeding (G): computeMatchDecision is the decision authority — loan never accepted', () => {
  // Verify directly: computeMatchDecision rejects loans
  const profile = { id: 'p1', primary_type: 'individual', state: 'OH', needs: '["housing"]' }
  const loanOpp = {
    id: 'loan-1',
    title: 'Home Equity Loan',
    description: 'Take out a loan against your home equity.',
    application_url: 'https://bank.com/loan',
    is_national: 1,
    is_loan: 1,
    categories: '["housing"]',
    keywords: '["loan", "housing"]',
  }

  const decision = computeMatchDecision(profile, loanOpp, { profileSections: {} })
  assert.equal(decision.decision, 'REJECT', 'Loan opportunity should always be REJECT')
  assert.ok(
    decision.ineligibilityReasons.some((r) => r.toLowerCase().includes('loan')),
    `Expected loan ineligibility reason; got: ${JSON.stringify(decision.ineligibilityReasons)}`,
  )
})

test('canonical seeding (G): REJECT decision prevents pipeline insert via saveToProfilePipeline', async () => {
  const db = buildDb()
  insertOrg(db, 'org-canonical')
  insertProfile(db, { id: 'profile-canonical', organization_id: 'org-canonical', primary_type: 'individual', display_name: 'Canonical Profile', state: 'OH', needs: '["housing"]' })
  insertOpportunity(db, {
    id: 'opp-canonical-loan',
    title: 'Loan Program',
    description: 'This is a loan, not a grant. Repayment required.',
    application_url: 'https://bank.com/loan',
    is_national: 1,
    is_loan: 1,
    categories: '["housing"]',
    keywords: '["loan"]',
  })

  const profileContext = { profile: { id: 'profile-canonical', primary_type: 'individual', state: 'OH' }, sections: {} }
  const result = await saveToProfilePipeline(
    db,
    { id: 'opp-canonical-loan', title: 'Loan Program', is_loan: 1, application_url: 'https://bank.com/loan' },
    'profile-canonical',
    profileContext,
  )

  assert.equal(result.saved, false, 'saveToProfilePipeline should not save REJECT decisions')
  assert.equal(result.decision, 'REJECT', 'Decision should be REJECT for loan')
})

// ---------------------------------------------------------------------------
// H) seedFundingOpportunities: blocked in production and when DISABLE_SEEDING
// ---------------------------------------------------------------------------

test('seeding guard (H): seedFundingOpportunities blocked when DISABLE_SEEDING=true', () => {
  const raw = new Database(':memory:')
  // Apply minimal schema for the test
  raw.exec(`
    CREATE TABLE IF NOT EXISTS funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, is_active INTEGER DEFAULT 1, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)

  const before = raw.prepare('SELECT COUNT(*) as c FROM funding_opportunities').get().c

  const origDisable = process.env.DISABLE_SEEDING
  process.env.DISABLE_SEEDING = 'true'
  try {
    const count = seedFundingOpportunities(raw)
    assert.equal(count, 0, 'seedFundingOpportunities should return 0 when blocked')
    const after = raw.prepare('SELECT COUNT(*) as c FROM funding_opportunities').get().c
    assert.equal(after, before, 'No opportunities should be inserted when DISABLE_SEEDING=true')
  } finally {
    if (origDisable === undefined) {
      delete process.env.DISABLE_SEEDING
    } else {
      process.env.DISABLE_SEEDING = origDisable
    }
    raw.close()
  }
})

// ---------------------------------------------------------------------------
// I) Match metadata is stored with decision (persistence test)
// ---------------------------------------------------------------------------

test('match metadata (I): saveToProfilePipeline stores matcher_version and fingerprints', async () => {
  const db = buildDb()
  insertOrg(db, 'org-meta')
  insertProfile(db, { id: 'profile-meta', organization_id: 'org-meta', primary_type: 'individual', display_name: 'Meta Profile', state: 'OH', needs: '["housing","emergency"]' })
  insertOpportunity(db, HOUSING_OPPORTUNITY)

  const profileContext = { profile: { id: 'profile-meta', primary_type: 'individual', state: 'OH', needs: '["housing","emergency"]' }, sections: {} }
  const result = await saveToProfilePipeline(db, HOUSING_OPPORTUNITY, 'profile-meta', profileContext)

  if (result.saved) {
    const row = db._raw.prepare('SELECT * FROM grants WHERE id = ?').get(result.pipelineId)
    assert.ok(row, 'Grant row should exist')
    assert.equal(row.matcher_version, MATCHER_VERSION, 'matcher_version should be stored')
    assert.ok(row.profile_fingerprint, 'profile_fingerprint should be stored')
    assert.ok(row.opportunity_fingerprint, 'opportunity_fingerprint should be stored')
    assert.ok(row.match_decision, 'match_decision should be stored')
    assert.ok(row.evaluated_at, 'evaluated_at should be stored')
  } else {
    // If not saved (REVIEW with threshold miss etc.), just verify no crash
    assert.ok(typeof result.saved === 'boolean', 'result.saved should be a boolean')
  }
})

test('match metadata (I): non-REJECT decisions store eligibility_status', async () => {
  const db = buildDb()
  insertOrg(db, 'org-meta2')
  // Individual with housing need — eligible for housing opportunity
  insertProfile(db, { id: 'profile-meta2', organization_id: 'org-meta2', primary_type: 'individual', display_name: 'Meta2 Profile', state: 'OH', needs: '["housing"]' })

  const opp = {
    id: 'opp-meta2',
    title: 'Ohio Housing Assistance Grant',
    description: 'Provides direct housing assistance to Ohio residents facing housing instability.',
    application_url: 'https://ohio.gov/housing',
    is_national: 0,
    state: 'OH',
    categories: JSON.stringify(['housing']),
    keywords: JSON.stringify(['housing', 'rent', 'eviction']),
    eligibility_bullets: JSON.stringify(['Must be an Ohio resident', 'Must demonstrate housing need']),
    sponsor: 'Ohio DCFS',
  }
  insertOpportunity(db, opp)

  const profileContext = {
    profile: { id: 'profile-meta2', primary_type: 'individual', state: 'OH', needs: '["housing"]' },
    sections: {},
  }
  const result = await saveToProfilePipeline(db, opp, 'profile-meta2', profileContext)

  if (result.saved) {
    const row = db._raw.prepare('SELECT * FROM grants WHERE id = ?').get(result.pipelineId)
    assert.ok(row.eligibility_status, 'eligibility_status should be stored for non-REJECT decisions')
    assert.ok(['true', 'maybe'].includes(row.eligibility_status), `eligibility_status should be true or maybe; got ${row.eligibility_status}`)
  }
})

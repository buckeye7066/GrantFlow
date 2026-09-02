import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'd'.repeat(64)

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const { enforcePipelinePrecision } = await import('../startup/enforceInvariants.js')
const {
  ensureApplicationTask, updateApplicationTask, getApplicationTask, _resetSchemaCache,
} = await import('../services/hamilton/applicationTaskStore.js')

const PROFILE = 'live-task-reconciliation-profile'

function makeDb() {
  const sqlite = new Database(':memory:')
  sqlite.dialect = 'sqlite'
  sqlite.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, display_name TEXT, applicant_type TEXT, primary_type TEXT,
      status TEXT, tags TEXT, deleted_at DATETIME
    );
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, sponsor TEXT, description TEXT,
      eligibility_text TEXT, eligibility_bullets TEXT, entity_types_allowed TEXT,
      need_types_supported TEXT, categories TEXT, keywords TEXT,
      opportunity_kind TEXT, opportunity_type TEXT, funding_category TEXT,
      source TEXT, record_origin TEXT, source_url TEXT, application_url TEXT, apply_url TEXT,
      final_url TEXT, evidence_url TEXT, external_id TEXT, state TEXT,
      is_national INTEGER, deadline TEXT, deadline_type TEXT,
      amount_min REAL, amount_max REAL, amount_text REAL, is_active INTEGER,
      link_status TEXT, canonical_opportunity_key TEXT
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, profile_id TEXT, funding_opportunity_id TEXT, title TEXT,
      funder TEXT, status TEXT, deadline TEXT, application_url TEXT, url TEXT,
      amount_requested REAL, amount_awarded REAL, match_score REAL, match_decision TEXT,
      eligibility_status TEXT, ineligibility_reasons TEXT, matcher_version TEXT,
      pipeline_category TEXT, fingerprint TEXT, updated_at DATETIME
    );
    CREATE TABLE profile_opportunity_matches (
      profile_id TEXT, opportunity_id TEXT, match_score REAL, match_decision TEXT,
      match_explanation TEXT, matcher_version TEXT, updated_at DATETIME, computed_at DATETIME
    );
    CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME);
  `)
  const db = wrapSqlite(sqlite)
  _resetSchemaCache()
  return { sqlite, db }
}

async function seed() {
  const { sqlite, db } = makeDb()
  sqlite.prepare('INSERT INTO profiles (id, display_name, primary_type, status, tags) VALUES (?, ?, ?, ?, ?)')
    .run(PROFILE, 'Live Reconciliation Student', 'college_student', 'active', '[]')
  sqlite.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
    .run(PROFILE, 'basic_information', JSON.stringify({ state: 'TN', profile_category: 'college_student' }))
  sqlite.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
    .run(PROFILE, 'financial_information', JSON.stringify({ needs: ['education', 'housing'] }))

  const opportunities = [
    ['good', 'Tennessee Direct Student Scholarship', 'TN Student Foundation', ['student'], ['education'], 'direct', 'TN'],
    ['saved', 'NSF Institutional Infrastructure Grant', 'U.S. National Science Foundation', ['nonprofit', 'school'], ['education'], 'direct', null],
    ['interested', 'Alaska Emergency Rental Assistance Program', 'Alaska Housing Finance Corporation', ['individual', 'family'], ['housing'], 'direct', 'AK'],
    ['portal', 'Middle Tennessee State University Institutional Research Portal', 'Middle Tennessee State University', ['school', 'university'], ['education'], 'direct', 'TN'],
    ['submitted', 'HUD Institutional Grant Programs', 'HUD', ['government', 'nonprofit'], ['housing'], 'direct', null],
  ]
  const fo = sqlite.prepare(`INSERT INTO funding_opportunities
    (id, title, sponsor, description, entity_types_allowed, need_types_supported, categories,
     opportunity_kind, source, record_origin, source_url, application_url, state, is_active, link_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test_lane', 'live_crawl', ?, ?, ?, 1, 'ok')`)
  const g = sqlite.prepare(`INSERT INTO grants
    (id, profile_id, funding_opportunity_id, title, funder, status, application_url, url,
     match_score, match_decision, eligibility_status, ineligibility_reasons, matcher_version, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 90, 'ACCEPT', 'eligible', '[]', 'crawler-os', CURRENT_TIMESTAMP)`)
  const m = sqlite.prepare(`INSERT INTO profile_opportunity_matches
    (profile_id, opportunity_id, match_score, match_decision, match_explanation, matcher_version, updated_at, computed_at)
    VALUES (?, ?, 90, 'accept', 'fixture', 'crawler-os', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)

  const grantStatuses = { good: 'saved', saved: 'saved', interested: 'interested', portal: 'portal', submitted: 'submitted' }
  for (const [id, title, sponsor, entities, needs, kind, state] of opportunities) {
    const url = `https://example.org/${id}/apply`
    fo.run(`fo-${id}`, title, sponsor, 'Apply through the official program.', JSON.stringify(entities), JSON.stringify(needs), JSON.stringify(needs), kind, url, url, state)
    g.run(`g-${id}`, PROFILE, `fo-${id}`, title, sponsor, grantStatuses[id], url, url)
    m.run(PROFILE, `fo-${id}`)
    const task = await ensureApplicationTask(db, {
      profileId: PROFILE, opportunityId: `fo-${id}`, grantId: `g-${id}`,
      automationType: 'portal', initialStatus: 'queued',
    })
    const taskStatus = id === 'good' ? 'ready_to_start'
      : id === 'interested' ? 'ready_to_start'
        : 'waiting_for_review'
    await updateApplicationTask(db, task.id, { status: taskStatus, allowAutoSubmit: true, autoSubmitEnabled: true })
  }
  return { sqlite, db }
}

const grantIds = (sqlite) => sqlite.prepare('SELECT id FROM grants ORDER BY id').all().map((r) => r.id)

describe('pipeline precision reconciles live Hamilton tasks with four-gate truth', () => {
  it('removes machine-progressed bad grants, cancels their tasks, removes match truth, and preserves only valid/submitted history', async () => {
    const { sqlite, db } = await seed()
    const result = await enforcePipelinePrecision(db)
    expect(result.ok).toBe(true)
    expect(result.failed).toBe(0)
    expect(result.removed).toBeGreaterThanOrEqual(2)
    expect(result.relabeled).toBeGreaterThanOrEqual(1)
    expect(result.tasksCancelled).toBeGreaterThanOrEqual(3)
    expect(result.matchesRemoved).toBeGreaterThanOrEqual(3)

    const remaining = sqlite.prepare('SELECT id, status, eligibility_status, match_decision FROM grants ORDER BY id').all()
    const remainingIds = remaining.map((row) => row.id)
    expect(remainingIds).toContain('g-good')
    expect(remainingIds).toContain('g-submitted')
    const submitted = remaining.find((row) => row.id === 'g-submitted')
    expect(submitted.status).toBe('submitted')
    expect(submitted.eligibility_status).toBe('ineligible')
    expect(submitted.match_decision).toBe('REJECT')

    const matches = sqlite.prepare('SELECT opportunity_id FROM profile_opportunity_matches ORDER BY opportunity_id').all()
    const matchOpps = matches.map((row) => row.opportunity_id)
    expect(matchOpps).toContain('fo-good')

    const tasks = sqlite.prepare('SELECT grant_id, opportunity_id, status, allow_auto_submit FROM application_tasks ORDER BY grant_id').all()
    // Debug snapshot to verify reconciliation outcomes
    // console.log('TASKS_AFTER:', tasks)
    for (const task of tasks.filter((row) => row.grant_id !== 'g-good')) {
      expect(task.status).toBe('cancelled')
      expect(Boolean(task.allow_auto_submit)).toBe(false)
    }
    expect(tasks.find((row) => row.grant_id === 'g-good')?.status).toBe('ready_to_start')

    const tombstones = sqlite.prepare('SELECT opportunity_id FROM pipeline_dismissals WHERE profile_id = ? ORDER BY opportunity_id').all(PROFILE)
    const tsOpps = tombstones.map((row) => row.opportunity_id)
    expect(tsOpps).toContain('fo-portal')
    expect(tsOpps).toContain('fo-saved')

    const summary = JSON.parse(sqlite.prepare("SELECT value FROM system_kv WHERE key = 'pipeline_precision_last_run'").get().value)
    expect(summary.tasksCancelled).toBeGreaterThanOrEqual(3)
    expect(summary.matchesRemoved).toBeGreaterThanOrEqual(3)
    expect(summary.truncated).toBe(false)
  })
})

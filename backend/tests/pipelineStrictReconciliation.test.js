import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'e'.repeat(64)

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const { runStrictPipelineReconciliation } = await import('../services/pipelineStrictReconciliation.js')
const {
  ensureApplicationTask,
  updateApplicationTask,
  _resetSchemaCache,
} = await import('../services/hamilton/applicationTaskStore.js')

const PROFILE_ID = 'strict-live-profile'

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
      id TEXT PRIMARY KEY, profile_id TEXT, title TEXT, sponsor TEXT, description TEXT,
      eligibility_text TEXT, eligibility_bullets TEXT, entity_types_allowed TEXT,
      need_types_supported TEXT, categories TEXT, keywords TEXT,
      opportunity_kind TEXT, opportunity_type TEXT, funding_category TEXT,
      source TEXT, record_origin TEXT, source_url TEXT, application_url TEXT,
      apply_url TEXT, final_url TEXT, evidence_url TEXT, external_id TEXT,
      state TEXT, is_national INTEGER, deadline TEXT, deadline_type TEXT,
      amount_min REAL, amount_max REAL, amount_text TEXT, is_active INTEGER,
      link_status TEXT, canonical_opportunity_key TEXT
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, profile_id TEXT, funding_opportunity_id TEXT, title TEXT,
      funder TEXT, status TEXT, deadline TEXT, application_url TEXT, url TEXT,
      amount_requested REAL, amount_awarded REAL, match_score REAL,
      match_decision TEXT, eligibility_status TEXT, ineligibility_reasons TEXT,
      matcher_version TEXT, pipeline_category TEXT, fingerprint TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_opportunity_matches (
      profile_id TEXT, opportunity_id TEXT, match_score REAL, match_decision TEXT,
      match_explanation TEXT, matcher_version TEXT, updated_at DATETIME,
      computed_at DATETIME
    );
    CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME);
  `)
  _resetSchemaCache()
  return { sqlite, db: wrapSqlite(sqlite) }
}

async function seed() {
  const { sqlite, db } = makeDb()
  sqlite.prepare(
    'INSERT INTO profiles (id, display_name, primary_type, status, tags) VALUES (?, ?, ?, ?, ?)',
  ).run(PROFILE_ID, 'Strict Live Student', 'college_student', 'active', '[]')
  sqlite.prepare(
    'INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)',
  ).run(
    PROFILE_ID,
    'basic_information',
    JSON.stringify({ state: 'TN', profile_category: 'college_student' }),
  )
  sqlite.prepare(
    'INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)',
  ).run(PROFILE_ID, 'financial_information', JSON.stringify({ needs: ['education', 'housing'] }))

  const opportunities = [
    {
      id: 'good',
      title: 'Tennessee Direct Student Scholarship',
      sponsor: 'Tennessee Student Foundation',
      entities: ['student'],
      needs: ['education'],
      state: 'TN',
      grantStatus: 'saved',
      taskStatus: 'ready_to_start',
    },
    {
      id: 'saved',
      title: 'NSF Institutional Infrastructure Grant',
      sponsor: 'U.S. National Science Foundation',
      entities: ['nonprofit', 'school'],
      needs: ['education'],
      state: null,
      grantStatus: 'saved',
      taskStatus: 'waiting_for_review',
    },
    {
      id: 'interested',
      title: 'Alaska Emergency Rental Assistance Program',
      sponsor: 'Alaska Housing Finance Corporation',
      entities: ['individual', 'family'],
      needs: ['housing'],
      state: 'AK',
      grantStatus: 'interested',
      taskStatus: 'filling_portal',
    },
    {
      id: 'portal',
      title: 'Middle Tennessee State University Institutional Research Portal',
      sponsor: 'Middle Tennessee State University',
      entities: ['school', 'university'],
      needs: ['education'],
      state: 'TN',
      grantStatus: 'portal',
      taskStatus: 'waiting_for_review',
    },
    {
      id: 'submitted',
      title: 'HUD Institutional Grant Programs',
      sponsor: 'U.S. Department of Housing and Urban Development',
      entities: ['government', 'nonprofit'],
      needs: ['housing'],
      state: null,
      grantStatus: 'submitted',
      taskStatus: 'waiting_for_review',
    },
  ]

  const insertOpportunity = sqlite.prepare(`
    INSERT INTO funding_opportunities (
      id, title, sponsor, description, entity_types_allowed,
      need_types_supported, categories, opportunity_kind, source,
      record_origin, source_url, application_url, state, is_active, link_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'direct', 'test_lane', 'live_crawl', ?, ?, ?, 1, 'ok')
  `)
  const insertGrant = sqlite.prepare(`
    INSERT INTO grants (
      id, profile_id, funding_opportunity_id, title, funder, status,
      application_url, url, match_score, match_decision, eligibility_status,
      ineligibility_reasons, matcher_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 90, 'ACCEPT', 'eligible', '[]', 'crawler-os')
  `)
  const insertMatch = sqlite.prepare(`
    INSERT INTO profile_opportunity_matches (
      profile_id, opportunity_id, match_score, match_decision,
      match_explanation, matcher_version, updated_at, computed_at
    ) VALUES (?, ?, 90, 'accept', 'fixture', 'crawler-os', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `)

  for (const item of opportunities) {
    const opportunityId = `fo-${item.id}`
    const grantId = `g-${item.id}`
    const url = `https://example.org/${item.id}/apply`
    insertOpportunity.run(
      opportunityId,
      item.title,
      item.sponsor,
      'Apply through the official program.',
      JSON.stringify(item.entities),
      JSON.stringify(item.needs),
      JSON.stringify(item.needs),
      url,
      url,
      item.state,
    )
    insertGrant.run(
      grantId,
      PROFILE_ID,
      opportunityId,
      item.title,
      item.sponsor,
      item.grantStatus,
      url,
      url,
    )
    insertMatch.run(PROFILE_ID, opportunityId)

    const task = await ensureApplicationTask(db, {
      profileId: PROFILE_ID,
      opportunityId,
      grantId,
      automationType: 'portal',
      initialStatus: 'queued',
    })
    await updateApplicationTask(db, task.id, {
      status: item.taskStatus,
      allowAutoSubmit: true,
      autoSubmitEnabled: true,
    })
  }

  return { sqlite, db }
}

describe('strict production pipeline reconciliation', () => {
  it('cancels bad active work and refuses status/name labels as proof of eligibility', async () => {
    const { sqlite, db } = await seed()
    const result = await runStrictPipelineReconciliation(db)

    expect(result.failed).toBe(0)
    expect(result.truncated).toBe(false)
    expect(result.kept).toBe(1)
    expect(result.removed).toBe(3)
    expect(result.relabeled).toBe(1)
    expect(result.tasksCancelled).toBe(4)
    expect(result.matchesRemoved).toBe(4)

    const grants = sqlite.prepare(
      'SELECT id, status, eligibility_status, match_decision FROM grants ORDER BY id',
    ).all()
    expect(grants.map((grant) => grant.id)).toEqual(['g-good', 'g-submitted'])
    expect(grants.find((grant) => grant.id === 'g-submitted')).toMatchObject({
      status: 'submitted',
      eligibility_status: 'ineligible',
      match_decision: 'REJECT',
    })

    const matches = sqlite.prepare(
      'SELECT opportunity_id FROM profile_opportunity_matches ORDER BY opportunity_id',
    ).all()
    expect(matches.map((row) => row.opportunity_id)).toEqual(['fo-good'])

    const tasks = sqlite.prepare(
      'SELECT grant_id, status, allow_auto_submit FROM application_tasks ORDER BY grant_id',
    ).all()
    expect(tasks.find((task) => task.grant_id === 'g-good').status).toBe('ready_to_start')
    for (const task of tasks.filter((row) => row.grant_id !== 'g-good')) {
      expect(task.status).toBe('cancelled')
      expect(Boolean(task.allow_auto_submit)).toBe(false)
    }

    const tombstones = sqlite.prepare(
      'SELECT opportunity_id FROM pipeline_dismissals WHERE profile_id = ? ORDER BY opportunity_id',
    ).all(PROFILE_ID)
    expect(tombstones.map((row) => row.opportunity_id)).toEqual([
      'fo-interested',
      'fo-portal',
      'fo-saved',
    ])

    const summary = JSON.parse(
      sqlite.prepare("SELECT value FROM system_kv WHERE key = 'pipeline_precision_last_run'").get().value,
    )
    expect(summary.tasksCancelled).toBe(4)
    expect(summary.matchesRemoved).toBe(4)
  })
})

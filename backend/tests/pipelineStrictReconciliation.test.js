import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'e'.repeat(64)

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const {
  runStrictPipelineReconciliation,
  cancelInvalidActiveHamiltonTasks,
  auditUnfinishedHamiltonTasks,
  refreshHamiltonTaskTruthAfterLinkVerification,
} = await import('../services/pipelineStrictReconciliation.js')
const {
  persistHamiltonTaskTruthSnapshot,
  readHamiltonTaskTruthSnapshot,
} = await import('../services/hamilton/hamiltonTaskTruthSnapshot.js')
const {
  ensureApplicationTask,
  ensureApplicationTaskSchema,
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
      link_status TEXT, last_verified_at TEXT, canonical_opportunity_key TEXT
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
      isNational: false,
      grantStatus: 'saved',
      taskStatus: 'waiting_for_login',
    },
    {
      id: 'saved',
      title: 'NSF Institutional Infrastructure Grant',
      sponsor: 'U.S. National Science Foundation',
      entities: ['nonprofit', 'school'],
      needs: ['education'],
      state: null,
      isNational: true,
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
      isNational: false,
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
      isNational: false,
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
      isNational: true,
      grantStatus: 'submitted',
      taskStatus: 'submitted',
    },
    {
      id: 'news',
      title: 'MTSU School of Nursing News — Student Spotlight',
      sponsor: 'Middle Tennessee State University',
      entities: ['student'],
      needs: ['education'],
      state: 'TN',
      isNational: false,
      grantStatus: 'saved',
      taskStatus: 'waiting_for_login',
    },
    {
      id: 'funder',
      title: 'Community Foundation of Cleveland and Bradley County',
      sponsor: 'Community Foundation of Cleveland and Bradley County',
      entities: ['student'],
      needs: ['education'],
      state: 'TN',
      isNational: false,
      grantStatus: 'saved',
      taskStatus: 'waiting_for_review',
    },
  ]

  const insertOpportunity = sqlite.prepare(`
    INSERT INTO funding_opportunities (
      id, title, sponsor, description, entity_types_allowed,
      need_types_supported, categories, opportunity_kind, source,
      record_origin, source_url, application_url, state, is_national, is_active,
      link_status, last_verified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'direct', 'test_lane', 'live_crawl', ?, ?, ?, ?, 1, 'ok', CURRENT_TIMESTAMP)
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
    const url = ({
      good: 'https://www.mtsu.edu/financial-aid/scholarships/apply',
      saved: 'https://www.nsf.gov/funding/opportunities/infrastructure/apply',
      interested: 'https://www.ahfc.us/tenants/rental-assistance/apply',
      portal: 'https://www.mtsu.edu/research/funding-portal',
      submitted: 'https://www.hud.gov/grants/institutional-programs',
      news: 'https://www.mtsu.edu/nursing/news/student-spotlight.php',
      funder: 'https://grantable.co/funders/community-foundation-cleveland-bradley',
    })[item.id]
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
      item.isNational ? 1 : 0,
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
    if (item.id === 'funder') {
      // Reconstruct the live stale-task shape: the task predates a later
      // classifier correction that identified the aggregator funder page as a
      // discovery directory rather than a leaf application.
      sqlite.prepare("UPDATE funding_opportunities SET opportunity_kind = 'directory' WHERE id = ?").run(opportunityId)
    }
  }

  // A completed research lead is terminal history, not unfinished work. It is
  // deliberately opportunity-only so the fleet reconciliation cannot erase
  // its source by processing a grant row.
  insertOpportunity.run(
    'fo-research-history',
    'BigFuture Scholarship Search Directory',
    'College Board',
    'Search thousands of scholarships.',
    JSON.stringify(['student']),
    JSON.stringify(['education']),
    JSON.stringify(['education']),
    'https://bigfuture.collegeboard.org/scholarship-search',
    'https://bigfuture.collegeboard.org/scholarship-search',
    null,
    1,
  )
  sqlite.prepare("UPDATE funding_opportunities SET opportunity_kind = 'directory' WHERE id = 'fo-research-history'").run()
  sqlite.prepare(`
    INSERT INTO application_tasks (id, profile_id, opportunity_id, status, automation_type)
    VALUES ('task-research-history', ?, 'fo-research-history', 'completed', 'research_lead')
  `).run(PROFILE_ID)

  return { sqlite, db }
}

describe('strict production pipeline reconciliation', () => {
  it('cancels bad active work and refuses status/name labels as proof of eligibility', async () => {
    const { sqlite, db } = await seed()
    const before = await auditUnfinishedHamiltonTasks(db, { enforce: false })
    expect(before).toMatchObject({ scanned: 6, valid: 1, invalid: 5, failed: 0, truncated: false })
    expect(before.byBucket).toEqual({ needs_you: 4, working: 1 })

    const result = await runStrictPipelineReconciliation(db)

    expect(result.failed).toBe(0)
    expect(result.truncated).toBe(false)
    expect(result.kept).toBe(1)
    expect(result.removed).toBe(5)
    expect(result.relabeled).toBe(1)
    expect(result.tasksCancelled).toBe(5)
    expect(result.matchesRemoved).toBe(6)

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
      'SELECT grant_id, opportunity_id, status, allow_auto_submit FROM application_tasks ORDER BY grant_id',
    ).all()
    expect(tasks.find((task) => task.grant_id === 'g-good').status).toBe('waiting_for_login')
    expect(tasks.find((task) => task.grant_id === 'g-submitted').status).toBe('submitted')
    expect(tasks.find((task) => task.opportunity_id === 'fo-research-history').status).toBe('completed')
    for (const task of tasks.filter((row) => row.grant_id && !['g-good', 'g-submitted'].includes(row.grant_id))) {
      expect(task.status).toBe('cancelled')
      expect(Boolean(task.allow_auto_submit)).toBe(false)
    }

    const tombstones = sqlite.prepare(
      'SELECT opportunity_id FROM pipeline_dismissals WHERE profile_id = ? ORDER BY opportunity_id',
    ).all(PROFILE_ID)
    expect(tombstones.map((row) => row.opportunity_id)).toEqual([
      'fo-funder',
      'fo-interested',
      'fo-news',
      'fo-portal',
      'fo-saved',
    ])

    const summary = JSON.parse(
      sqlite.prepare("SELECT value FROM system_kv WHERE key = 'pipeline_precision_last_run'").get().value,
    )
    expect(summary.tasksCancelled).toBe(5)
    expect(summary.matchesRemoved).toBe(6)

    const after = await auditUnfinishedHamiltonTasks(db, { enforce: false })
    expect(after).toMatchObject({ scanned: 1, valid: 1, invalid: 0, failed: 0, truncated: false })
  })

  it('keeps an unrestricted scholarship the applicant-type gate PASSES — pass means pass, never applicant_type:pass', async () => {
    // Prod 2026-09-02: the QUALIFIES proof demanded the single reason
    // `explicit_applicant_types_match`, so a row with NO applicant restriction
    // (decision `pass`, reason null) was tombstoned as `applicant_type:pass` —
    // 172 live rows (Tennessee Promise, Gates, TN Reconnect, Federal SEOG…).
    const { sqlite, db } = await seed()
    const url = 'https://www.tn.gov/collegepays/money-for-college/tennessee-promise/apply'
    sqlite.prepare(`
      INSERT INTO funding_opportunities (
        id, title, sponsor, description, entity_types_allowed,
        need_types_supported, categories, opportunity_kind, source,
        record_origin, source_url, application_url, state, is_national, is_active,
        link_status, last_verified_at
      ) VALUES ('fo-unrestricted', 'Tennessee Promise', 'Tennessee Student Assistance Corporation',
        'Last-dollar scholarship for Tennessee students. Apply through the official program.', '[]',
        '["education"]', '["education"]', 'direct', 'test_lane', 'live_crawl', ?, ?, 'TN', 0, 1, 'ok', CURRENT_TIMESTAMP)
    `).run(url, url)
    sqlite.prepare(`
      INSERT INTO grants (
        id, profile_id, funding_opportunity_id, title, funder, status,
        application_url, url, match_score, match_decision, eligibility_status,
        ineligibility_reasons, matcher_version
      ) VALUES ('g-unrestricted', ?, 'fo-unrestricted', 'Tennessee Promise', 'Tennessee Student Assistance Corporation',
        'saved', ?, ?, 90, 'ACCEPT', 'eligible', '[]', 'crawler-os')
    `).run(PROFILE_ID, url, url)
    sqlite.prepare(`
      INSERT INTO profile_opportunity_matches (
        profile_id, opportunity_id, match_score, match_decision,
        match_explanation, matcher_version, updated_at, computed_at
      ) VALUES (?, 'fo-unrestricted', 90, 'accept', 'fixture', 'crawler-os', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(PROFILE_ID)

    const result = await runStrictPipelineReconciliation(db)

    expect(result.failed).toBe(0)
    expect(result.kept).toBe(2)
    expect(Object.keys(result.byReason).some((tag) => tag.includes('applicant_type:pass'))).toBe(false)
    const kept = sqlite.prepare('SELECT id FROM grants ORDER BY id').all().map((row) => row.id)
    expect(kept).toEqual(['g-good', 'g-submitted', 'g-unrestricted'])
    const tombstoned = sqlite.prepare(
      'SELECT opportunity_id, reason FROM pipeline_dismissals WHERE profile_id = ?',
    ).all(PROFILE_ID)
    expect(tombstoned.map((row) => row.opportunity_id)).not.toContain('fo-unrestricted')
    expect(tombstoned.some((row) => String(row.reason).includes('applicant_type:pass'))).toBe(false)
  })

  it('cancels active tasks whose grant disappeared in an earlier partial reconciliation', async () => {
    const { sqlite, db } = await seed()
    sqlite.prepare("DELETE FROM grants WHERE id = 'g-good'").run()

    const cancelled = await cancelInvalidActiveHamiltonTasks(db)
    expect(cancelled).toBe(1)

    const task = sqlite.prepare(
      "SELECT status, allow_auto_submit, auto_submit_enabled FROM application_tasks WHERE grant_id = 'g-good'",
    ).get()
    expect(task.status).toBe('cancelled')
    expect(Boolean(task.allow_auto_submit)).toBe(false)
    expect(Boolean(task.auto_submit_enabled)).toBe(false)
  })

  it('audits opportunity-only tasks and cancels a URL-carrying directory despite stale stored ACCEPT', async () => {
    const { sqlite, db } = makeDb()
    sqlite.prepare(
      'INSERT INTO profiles (id, display_name, primary_type, status, tags) VALUES (?, ?, ?, ?, ?)',
    ).run(PROFILE_ID, 'Strict Live Student', 'college_student', 'active', '[]')
    sqlite.prepare(
      'INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)',
    ).run(PROFILE_ID, 'financial_information', JSON.stringify({ needs: ['education'] }))
    sqlite.prepare(`
      INSERT INTO funding_opportunities (
        id, title, sponsor, description, entity_types_allowed, need_types_supported,
        categories, opportunity_kind, source, record_origin, source_url,
        application_url, is_national, is_active, link_status, last_verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'directory', 'test_lane', 'live_crawl', ?, ?, 1, 1, 'ok', CURRENT_TIMESTAMP)
    `).run(
      'fo-directory',
      'BigFuture Scholarship Search Directory',
      'College Board',
      'Search thousands of scholarships.',
      JSON.stringify(['student']),
      JSON.stringify(['education']),
      JSON.stringify(['education']),
      'https://bigfuture.collegeboard.org/scholarship-search',
      'https://bigfuture.collegeboard.org/scholarship-search',
    )
    sqlite.prepare(`
      INSERT INTO profile_opportunity_matches (
        profile_id, opportunity_id, match_score, match_decision,
        match_explanation, matcher_version, updated_at, computed_at
      ) VALUES (?, 'fo-directory', 99, 'accept', 'stale fixture', 'crawler-os', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(PROFILE_ID)
    await ensureApplicationTaskSchema(db)
    sqlite.prepare(`
      INSERT INTO application_tasks (id, profile_id, opportunity_id, status, automation_type)
      VALUES ('task-directory', ?, 'fo-directory', 'waiting_for_window', 'portal')
    `).run(PROFILE_ID)

    const report = await auditUnfinishedHamiltonTasks(db, { enforce: false })
    expect(report).toMatchObject({ scanned: 1, valid: 0, invalid: 1, failed: 0, truncated: false })
    expect(report.byGate.relatable).toBe(1)

    const applied = await auditUnfinishedHamiltonTasks(db, { enforce: true })
    expect(applied.tasksCancelled).toBe(1)
    expect(sqlite.prepare("SELECT status FROM application_tasks WHERE id = 'task-directory'").get().status).toBe('cancelled')
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM profile_opportunity_matches WHERE opportunity_id = 'fo-directory'").get().n).toBe(0)
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM pipeline_dismissals WHERE opportunity_id = 'fo-directory'").get().n).toBe(1)
  })

  it('reports an unavailable live evaluator without cancelling or deleting durable work', async () => {
    const { sqlite, db } = await seed()

    const report = await auditUnfinishedHamiltonTasks(db, {
      enforce: true,
      assess: async () => ({
        ok: false,
        unavailable: true,
        code: 'funding_source_policy_unavailable',
        reasons: ['canonical_engine_unavailable'],
      }),
    })

    expect(report).toMatchObject({ scanned: 6, valid: 0, invalid: 0, failed: 6 })
    expect(report.tasksCancelled).toBe(0)
    expect(report.grantsRemoved).toBe(0)
    expect(report.matchesRemoved).toBe(0)
    expect(sqlite.prepare("SELECT status FROM application_tasks WHERE grant_id = 'g-saved'").get().status).toBe('waiting_for_review')
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM grants WHERE profile_id = ?").get(PROFILE_ID).n).toBe(7)
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM profile_opportunity_matches WHERE profile_id = ?").get(PROFILE_ID).n).toBe(7)
  })

  it('defers stale positive liveness evidence without cancelling or deleting it', async () => {
    const { sqlite, db } = await seed()
    sqlite.prepare(
      "UPDATE funding_opportunities SET last_verified_at = '2026-07-01T00:00:00.000Z' WHERE id = 'fo-good'",
    ).run()

    const report = await auditUnfinishedHamiltonTasks(db, {
      enforce: true,
      now: new Date('2026-09-02T00:00:00.000Z'),
    })

    expect(report).toMatchObject({
      scanned: 6,
      valid: 0,
      invalid: 5,
      deferred: 1,
      failed: 0,
      repairFailed: 0,
      truncated: false,
      tasksCancelled: 5,
    })
    expect(report.byReason['real:link_reverification_required']).toBe(1)
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM grants WHERE id = 'g-good'").get().n).toBe(1)
    expect(sqlite.prepare("SELECT status FROM application_tasks WHERE grant_id = 'g-good'").get().status).toBe('waiting_for_login')
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM profile_opportunity_matches WHERE opportunity_id = 'fo-good'").get().n).toBe(1)
  })

  it('refreshes a pending boot snapshot after the recurring link verifier supplies fresh evidence', async () => {
    const { sqlite, db } = await seed()
    const initialRepair = await auditUnfinishedHamiltonTasks(db, {
      enforce: true,
      now: new Date('2026-09-02T00:00:00.000Z'),
    })
    expect(initialRepair).toMatchObject({ tasksCancelled: 5, failed: 0, repairFailed: 0 })
    sqlite.prepare(
      "UPDATE funding_opportunities SET last_verified_at = '2026-07-01T00:00:00.000Z' WHERE id = 'fo-good'",
    ).run()
    const pendingAudit = {
      scanned: 1,
      valid: 0,
      invalid: 0,
      deferred: 1,
      protected: 0,
      failed: 0,
      repairFailed: 0,
      truncated: false,
      byGate: { real: 1 },
      byBucket: { needs_you: 1 },
    }
    await persistHamiltonTaskTruthSnapshot(db, {
      timestamp: '2026-09-02T00:00:00.000Z',
      status: 'pending_reverification',
      scanned: 1,
      kept: 1,
      removed: 0,
      relabeled: 0,
      deferred: 1,
      tasksCancelled: 0,
      matchesRemoved: 0,
      failed: 0,
      truncated: false,
      profiles: 1,
      profilesAffected: 0,
      byGate: { real: 1 },
      taskRepairAudit: pendingAudit,
      taskAudit: pendingAudit,
      verificationTaskAudit: pendingAudit,
    })
    sqlite.prepare(
      "UPDATE funding_opportunities SET last_verified_at = '2026-09-02T00:00:00.000Z' WHERE id = 'fo-good'",
    ).run()

    const refreshed = await refreshHamiltonTaskTruthAfterLinkVerification(db, {
      now: new Date('2026-09-02T00:00:01.000Z'),
    })
    const truth = await readHamiltonTaskTruthSnapshot(db)

    expect(refreshed.status).toBe('verified')
    expect(truth).toMatchObject({ available: true, healthy: true, queueReadable: true, status: 'verified' })
    expect(truth.verification).toMatchObject({ invalid: 0, deferred: 0, failed: 0, truncated: false })
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM grants WHERE id = 'g-good'").get().n).toBe(1)
  })

  it('preserves every trace for submission-uncertain work while relabeling its grant', async () => {
    const { sqlite, db } = await seed()
    sqlite.prepare(
      "UPDATE application_tasks SET status = 'submit_attempt_started' WHERE grant_id = 'g-saved'",
    ).run()

    const result = await runStrictPipelineReconciliation(db)

    expect(result).toMatchObject({
      kept: 1,
      removed: 4,
      relabeled: 2,
      tasksCancelled: 4,
      matchesRemoved: 5,
      failed: 0,
      truncated: false,
    })
    expect(result.taskAudit).toMatchObject({ protected: 1, repairFailed: 0, failed: 0 })
    expect(sqlite.prepare("SELECT status FROM application_tasks WHERE grant_id = 'g-saved'").get().status).toBe('submit_attempt_started')
    expect(sqlite.prepare("SELECT eligibility_status, match_decision FROM grants WHERE id = 'g-saved'").get()).toEqual({
      eligibility_status: 'ineligible',
      match_decision: 'REJECT',
    })
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM profile_opportunity_matches WHERE opportunity_id = 'fo-saved'").get().n).toBe(1)
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM pipeline_dismissals WHERE opportunity_id = 'fo-saved'").get().n).toBe(0)
  })

  it('never cancels a submission-uncertain task whose grant is temporarily missing', async () => {
    const { sqlite, db } = await seed()
    sqlite.prepare(
      "UPDATE application_tasks SET status = 'submission_verification_required' WHERE grant_id = 'g-good'",
    ).run()
    sqlite.prepare("DELETE FROM grants WHERE id = 'g-good'").run()

    expect(await cancelInvalidActiveHamiltonTasks(db)).toBe(0)
    expect(sqlite.prepare("SELECT status FROM application_tasks WHERE grant_id = 'g-good'").get().status)
      .toBe('submission_verification_required')
  })

})

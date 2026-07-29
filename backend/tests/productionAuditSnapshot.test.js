import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'

import { BOOT_ID } from '../config/bootId.js'
import {
  buildProductionAuditSnapshot,
  normalizeAuditMatchLimit,
  normalizeAuditProfileIds,
  summarizeAmyAuditState,
} from '../services/productionAuditSnapshot.js'

function createDb() {
  const db = new Database(':memory:')
  db.dialect = 'sqlite'
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      primary_type TEXT,
      deleted_at TEXT
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT,
      sponsor TEXT,
      source TEXT,
      source_id TEXT,
      opportunity_kind TEXT,
      opportunity_type TEXT,
      type TEXT,
      result_kind TEXT,
      is_active INTEGER DEFAULT 1,
      is_hidden INTEGER DEFAULT 0,
      updated_at TEXT
    );
    CREATE TABLE profile_opportunity_matches (
      profile_id TEXT,
      opportunity_id TEXT,
      match_score REAL,
      match_decision TEXT,
      matcher_version TEXT,
      match_explain_json TEXT,
      updated_at TEXT
    );
    CREATE TABLE application_tasks (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      status TEXT,
      current_step TEXT,
      automation_type TEXT,
      allow_auto_submit INTEGER DEFAULT 0,
      auto_submit_enabled INTEGER DEFAULT 0,
      updated_at TEXT
    );
    CREATE TABLE application_missing_info (
      task_id TEXT,
      kind TEXT,
      key TEXT,
      resolved INTEGER DEFAULT 0,
      created_at TEXT
    );
    CREATE TABLE portal_sync_runs (
      profile_id TEXT,
      portal_host TEXT,
      direction TEXT,
      status TEXT,
      started_at TEXT
    );
    CREATE TABLE system_kv (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT
    );
  `)
  return db
}

function insertOpportunity(db, {
  id,
  title,
  sponsor = 'Sponsor',
  kind = 'direct',
  active = 1,
  hidden = 0,
}) {
  db.prepare(`
    INSERT INTO funding_opportunities (
      id, title, sponsor, source, source_id, opportunity_kind,
      opportunity_type, type, result_kind, is_active, is_hidden, updated_at
    ) VALUES (?, ?, ?, 'test', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    title,
    sponsor,
    id,
    kind,
    kind,
    kind === 'directory' ? 'DIRECTORY' : 'OPPORTUNITY',
    kind,
    active,
    hidden,
    '2026-07-29T17:00:00.000Z',
  )
}

function insertMatch(db, {
  profileId = 'p1',
  opportunityId,
  score = 80,
  decision = 'ACCEPT',
  canonicalDecision = null,
  matcherVersion = 'crawler-os',
}) {
  db.prepare(`
    INSERT INTO profile_opportunity_matches (
      profile_id, opportunity_id, match_score, match_decision,
      matcher_version, match_explain_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    profileId,
    opportunityId,
    score,
    decision,
    matcherVersion,
    canonicalDecision ? JSON.stringify({ canonical_decision: canonicalDecision }) : '{}',
    '2026-07-29T17:05:00.000Z',
  )
}

function kvSet(db, key, value) {
  db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, JSON.stringify(value), '2026-07-29T17:10:00.000Z')
}

function seedTruth(db) {
  db.prepare('INSERT INTO profiles (id, display_name, primary_type) VALUES (?, ?, ?)')
    .run('p1', 'Profile One', 'individual')
  db.prepare('INSERT INTO profiles (id, display_name, primary_type) VALUES (?, ?, ?)')
    .run('p2', 'Profile Two', 'nonprofit')

  insertOpportunity(db, { id: 'accept', title: 'Medical Assistance Grant' })
  insertMatch(db, { opportunityId: 'accept', score: 91, decision: 'ACCEPT' })

  insertOpportunity(db, { id: 'direct-reject', title: 'Wrong Profession Award' })
  insertMatch(db, { opportunityId: 'direct-reject', score: 4, decision: 'REJECT' })

  insertOpportunity(db, { id: 'directory-bad', title: 'Community Resource Directory', kind: 'directory' })
  insertMatch(db, { opportunityId: 'directory-bad', score: 36, decision: 'ACCEPT' })

  insertOpportunity(db, { id: 'canonical-reject', title: 'Unrelated School Scholarship' })
  insertMatch(db, {
    opportunityId: 'canonical-reject',
    score: 25,
    decision: 'REVIEW',
    canonicalDecision: 'REJECT',
  })

  insertOpportunity(db, { id: 'dup-a', title: 'Community Grants', sponsor: 'County Foundation' })
  insertMatch(db, { opportunityId: 'dup-a', score: 72, decision: 'ACCEPT' })
  insertOpportunity(db, { id: 'dup-b', title: 'Community Grant', sponsor: 'County Foundation' })
  insertMatch(db, { opportunityId: 'dup-b', score: 70, decision: 'ACCEPT', matcherVersion: 'web-llm' })

  insertOpportunity(db, { id: 'hidden-reject', title: 'Hidden Rejected Program', hidden: 1 })
  insertMatch(db, { opportunityId: 'hidden-reject', score: 0, decision: 'REJECT' })

  insertOpportunity(db, { id: 'p2-good', title: 'Nonprofit Capacity Grant' })
  insertMatch(db, { profileId: 'p2', opportunityId: 'p2-good', score: 88, decision: 'ACCEPT' })

  const task = db.prepare(`
    INSERT INTO application_tasks (
      id, profile_id, status, current_step, automation_type,
      allow_auto_submit, auto_submit_enabled, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  task.run('task-1', 'p1', 'running', 'preflight', 'portal', 1, 0, '2026-07-29T17:12:00.000Z')
  task.run('task-2', 'p1', 'queued', 'preflight', 'pdf_docx', 0, 0, '2026-07-29T17:11:00.000Z')
  task.run('task-3', 'p2', 'completed', 'done', 'pdf_docx', 0, 0, '2026-07-29T17:10:00.000Z')

  const missing = db.prepare(`
    INSERT INTO application_missing_info (task_id, kind, key, resolved, created_at)
    VALUES (?, 'field', 'basic_information.income', 0, ?)
  `)
  missing.run('task-1', '2026-07-29T17:12:00.000Z')
  missing.run('task-2', '2026-07-29T17:12:00.000Z')

  db.prepare(`
    INSERT INTO portal_sync_runs (profile_id, portal_host, direction, status, started_at)
    VALUES ('p1', 'portal.example.edu', 'pull', 'completed', '2026-07-29T17:00:00.000Z')
  `).run()

  kvSet(db, 'automation_posture', {
    allow_auto_submit: false,
    browser_automation: true,
    run_on_schedule: false,
    tailored_approval_gate: true,
    boot_id: BOOT_ID,
    captured_at: '2026-07-29T17:10:00.000Z',
  })
  kvSet(db, 'amy_last_report', {
    run_id: 'amy-run-1',
    started_at: '2026-07-29T16:00:00.000Z',
    completed_at: '2026-07-29T17:00:00.000Z',
    improve_enabled: true,
    crawler_events: { profiles: 2, created: 2, crawled: 2, skipped: 0, errored: 0 },
    cohort: { profiles: 2, clean: 1, issues: 1 },
    metrics: { before: { quality_score: 70 }, after: { quality_score: 75 } },
    amy: {
      handoff: {
        findings: [
          { type: 'institution_recall_miss', severity: 'medium', detail: 'not exposed' },
          { type: 'institution_recall_miss', severity: 'medium', detail: 'not exposed' },
        ],
      },
    },
    fleet_gap_learning: {
      scoreboard: {
        generated_at: '2026-07-29T16:55:00.000Z',
        profiles_scanned: 12,
        gap_classes: 1,
        adapter_wishlist: [{ secret_detail: 'must not be returned' }],
      },
    },
    archetype_metrics: { individual: {}, nonprofit: {} },
    archetype_learning: { update: { individual: {} } },
  })
  kvSet(db, 'amy_recent_runs', [
    { run_id: 'amy-run-1', completed_at: '2026-07-29T17:00:00.000Z', summary: { clean: 1 } },
  ])
  kvSet(db, 'amy_flywheel_cohort', {
    days: {
      '2026-07-29': {
        day: '2026-07-29',
        target: 2,
        evaluated: 2,
        clean: 1,
        issues: 1,
        finding_types: { institution_recall_miss: 1 },
        runs: ['amy-run-1'],
        complete: true,
        all_clean: false,
        issue_examples: [{ scenario: 'hidden from snapshot' }],
      },
    },
    goal_notified_at: null,
    updated_at: '2026-07-29T17:00:00.000Z',
  })
}

describe('production audit snapshot', () => {
  it('returns persisted match truth, Hamilton scope, Amy aggregates, and no raw sensitive payloads', async () => {
    const db = createDb()
    try {
      seedTruth(db)
      const snapshot = await buildProductionAuditSnapshot(db, {
        profileIds: ['p1', 'p2'],
        matchLimitPerProfile: 50,
      })

      expect(snapshot.ok).toBe(true)
      expect(snapshot.contract).toBe('production-audit-snapshot-v1')
      expect(snapshot.safety).toMatchObject({
        admin_only: true,
        transaction_read_only: 'select_only_code_path',
        query_model: 'hardcoded_selects_only',
        sensitive_tables_read: false,
      })
      expect(snapshot.scope.missing_profile_ids).toEqual([])
      expect(snapshot.matches.totals).toMatchObject({
        visible_direct_rejects: 1,
        visible_resource_non_review: 1,
        canonical_reject_relabelled: 1,
        duplicate_groups: 1,
      })
      expect(snapshot.matches.integrity_by_profile.p1.visible_rows).toBe(6)
      expect(snapshot.matches.integrity_by_profile.p1.duplicate_groups).toBe(1)
      expect(snapshot.matches.rows.find((row) => row.opportunity_id === 'accept')).toMatchObject({
        match_score: 91,
        match_decision: 'accept',
        matcher_version: 'crawler-os',
      })
      expect(snapshot.hamilton.cross_scope_task_rows).toBe(0)
      expect(snapshot.hamilton.integrity_by_profile.p1).toMatchObject({
        tasks: 2,
        open_tasks: 2,
        autosubmit_flagged: 1,
        repeated_missing_fields: 1,
      })
      expect(snapshot.automation_posture).toMatchObject({
        allow_auto_submit: false,
        matches_current_boot: true,
      })
      expect(snapshot.amy.latest).toMatchObject({
        run_id: 'amy-run-1',
        finding_counts: {
          total: 2,
          by_type: { institution_recall_miss: 2 },
          by_severity: { medium: 2 },
        },
        archetypes_measured: 2,
        archetypes_learned: 1,
      })
      expect(snapshot.amy.flywheel.latest_day).toMatchObject({
        target: 2,
        evaluated: 2,
        clean: 1,
        issues: 1,
        complete: true,
        all_clean: false,
      })

      const serialized = JSON.stringify(snapshot)
      expect(serialized).not.toContain('secret_detail')
      expect(serialized).not.toContain('not exposed')
      expect(serialized).not.toContain('issue_examples')
      expect(serialized).not.toContain('password')
      expect(serialized).not.toContain('ciphertext')
    } finally {
      db.close()
    }
  })

  it('deduplicates profile ids and enforces bounded inputs', () => {
    expect(normalizeAuditProfileIds('p1,p1,p2')).toEqual(['p1', 'p2'])
    expect(() => normalizeAuditProfileIds('')).toThrow(/At least one profile id/)
    expect(() => normalizeAuditProfileIds('bad id')).toThrow(/malformed/)
    expect(() => normalizeAuditProfileIds(Array.from({ length: 11 }, (_, index) => `p${index}`)))
      .toThrow(/At most 10/)
    expect(normalizeAuditMatchLimit(undefined)).toBe(500)
    expect(normalizeAuditMatchLimit(0)).toBe(1)
    expect(normalizeAuditMatchLimit(50000)).toBe(1000)
  })

  it('summarizes Amy without returning raw findings or issue examples', () => {
    const summary = summarizeAmyAuditState({
      latestReport: {
        run_id: 'amy-2',
        amy: { handoff: { findings: [{ type: 'zero_result', severity: 'high', body: 'private' }] } },
      },
      history: [{ run_id: 'amy-2', summary: { clean: 0 } }],
      flywheel: {
        days: {
          '2026-07-29': {
            target: 1,
            evaluated: 1,
            clean: 0,
            issues: 1,
            finding_types: { zero_result: 1 },
            issue_examples: [{ body: 'private' }],
          },
        },
      },
    })
    expect(summary.latest.finding_counts).toEqual({
      total: 1,
      by_type: { zero_result: 1 },
      by_severity: { high: 1 },
    })
    expect(JSON.stringify(summary)).not.toContain('private')
    expect(JSON.stringify(summary)).not.toContain('issue_examples')
  })

  it('contains no credential, session, profile-section, or ciphertext table reads', () => {
    const source = fs.readFileSync('backend/services/productionAuditSnapshot.js', 'utf8')
    const forbidden = [
      'hamilton_portal_credentials',
      'hamilton_credential_sessions',
      'user_sessions',
      'user_credentials',
      'profile_sections',
      'app_runtime_secrets',
      'value_ciphertext',
      'password_hash',
    ]
    for (const token of forbidden) expect(source).not.toContain(token)
    expect(source).toContain("SET TRANSACTION READ ONLY")
    expect(source).toContain("SHOW transaction_read_only")
    expect(source).toContain("query_model: 'hardcoded_selects_only'")
  })
})

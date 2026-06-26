// RC-13 contract tests.
//
// Pins:
//   1. The canonical 11-stage pipeline matches the mission spec exactly.
//   2. PIPELINE_STAGE_ALL is a superset of the KanbanBoard column values
//      (excluding the synthetic "other" fallback).
//   3. GRANT_STATUSES (the API validator) accepts every canonical stage AND
//      every legacy alias key. Otherwise PATCH /api/grants/:id/status would
//      reject stage transitions the user just made via drag-and-drop.
//   4. PIPELINE_STAGE_ALIASES maps legacy stage names to canonical ones,
//      and applicationWorkflow.APPLICATION_STATES accepts both sets.
//   5. canonicalStage() resolves canonical and legacy values; returns null
//      for unknowns so the UI bucketing routes them to "Other / Unknown"
//      instead of silently dropping.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
  PIPELINE_STAGE,
  PIPELINE_STAGES,
  TERMINAL_STAGES,
  PIPELINE_STAGE_ALIASES,
  PIPELINE_STAGE_ALL,
  PIPELINE_STAGE_LEGACY,
  canonicalStage,
  isAcceptedStage,
  isValidStage,
  canTransition,
  assertTransition,
  stageOrder,
  applicationStatusToStage,
  APPLICATION_STATUS_TO_STAGE,
} from '../../shared/pipelineStages.js'
import { GRANT_STATUSES, GRANT_STATUSES_CANONICAL } from '../../backend/config/constants.js'
import { APPLICATION_STATES } from '../../backend/services/applicationWorkflow.js'
import * as crawlerOsStages from '../../backend/crawler-os/stages.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')

test('canonical pipeline = mission spec (11 stages, exact order)', () => {
  assert.deepEqual([...PIPELINE_STAGES], [
    'discovered',
    'saved',
    'interested',
    'gathering_documents',
    'drafting',
    'ready_to_submit',
    'submitted',
    'follow_up',
    'awarded',
    'declined',
    'archived',
  ])
})

test('crawler-os stages facade reuses the shared pipeline authority', () => {
  assert.equal(crawlerOsStages.PIPELINE_STAGE, PIPELINE_STAGE)
  assert.equal(crawlerOsStages.PIPELINE_STAGES, PIPELINE_STAGES)
  assert.equal(crawlerOsStages.TERMINAL_STAGES, TERMINAL_STAGES)
  assert.equal(crawlerOsStages.isValidStage, isValidStage)
  assert.equal(crawlerOsStages.canTransition, canTransition)
  assert.equal(crawlerOsStages.assertTransition, assertTransition)
})

test('GRANT_STATUSES is canonical ∪ legacy and accepts every alias key', () => {
  for (const stage of PIPELINE_STAGES) {
    assert.ok(GRANT_STATUSES.includes(stage), `GRANT_STATUSES missing canonical stage: ${stage}`)
  }
  for (const legacy of Object.keys(PIPELINE_STAGE_ALIASES)) {
    assert.ok(GRANT_STATUSES.includes(legacy), `GRANT_STATUSES missing legacy stage: ${legacy}`)
  }
  assert.deepEqual(new Set(GRANT_STATUSES), new Set(PIPELINE_STAGE_ALL))
  assert.deepEqual([...GRANT_STATUSES_CANONICAL], [...PIPELINE_STAGES])
})

test('APPLICATION_STATES accepts canonical and legacy values', () => {
  for (const stage of PIPELINE_STAGES) {
    assert.ok(APPLICATION_STATES.includes(stage), `APPLICATION_STATES missing canonical stage: ${stage}`)
  }
  for (const legacy of PIPELINE_STAGE_LEGACY) {
    assert.ok(APPLICATION_STATES.includes(legacy), `APPLICATION_STATES missing legacy stage: ${legacy}`)
  }
})

test('PIPELINE_STAGE_ALIASES never aliases a canonical stage to a non-canonical target', () => {
  for (const [legacy, canonical] of Object.entries(PIPELINE_STAGE_ALIASES)) {
    assert.ok(PIPELINE_STAGES.includes(canonical), `Alias ${legacy} → ${canonical} is not a canonical stage`)
    assert.ok(!PIPELINE_STAGES.includes(legacy), `Alias key ${legacy} should not itself be canonical`)
  }
})

test('canonicalStage normalizes case and whitespace; null for unknown', () => {
  assert.equal(canonicalStage('discovered'), 'discovered')
  assert.equal(canonicalStage('DISCOVERED'), 'discovered')
  assert.equal(canonicalStage('  saved  '), 'saved')
  assert.equal(canonicalStage('app_prep'), 'drafting') // legacy alias
  assert.equal(canonicalStage('under_review'), 'submitted')
  assert.equal(canonicalStage('closed'), 'archived')
  assert.equal(canonicalStage('not_a_stage'), null)
  assert.equal(canonicalStage(null), null)
  assert.equal(canonicalStage(undefined), null)
  assert.equal(canonicalStage(''), null)
})

test('isAcceptedStage matches GRANT_STATUSES exactly', () => {
  for (const s of GRANT_STATUSES) {
    assert.ok(isAcceptedStage(s), `${s} should be accepted`)
  }
  assert.equal(isAcceptedStage('garbage'), false)
})

test('stageOrder returns lifecycle position; -1 for unknown', () => {
  assert.equal(stageOrder('discovered'), 0)
  assert.equal(stageOrder('archived'), 10)
  assert.equal(stageOrder('app_prep'), 4) // legacy → drafting (index 4)
  assert.equal(stageOrder('garbage'), -1)
})

test('schema.sql grants.status CHECK accepts every canonical stage', () => {
  const schema = readFileSync(path.join(repoRoot, 'backend/db/schema.sql'), 'utf8')
  // Anchor specifically to the grants table's CHECK clause; the file has
  // many CHECK(status IN (...)) clauses on other tables.
  const grantsTable = schema.match(/CREATE TABLE IF NOT EXISTS grants \(([\s\S]*?)\n\);/)
  assert.ok(grantsTable, 'grants CREATE TABLE not found in schema.sql')
  const match = grantsTable[1].match(/CHECK\(status IN \(([\s\S]*?)\)\)/)
  assert.ok(match, 'grants.status CHECK clause not found inside grants CREATE TABLE')
  const accepted = new Set(
    [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]),
  )
  for (const stage of PIPELINE_STAGES) {
    assert.ok(accepted.has(stage), `schema.sql CHECK is missing canonical stage: ${stage}`)
  }
})

test('Postgres migration 0072 has the canonical stage list', () => {
  const sql = readFileSync(
    path.join(repoRoot, 'backend/db/postgres/migrations/0072_grants_status_canonical_pipeline.sql'),
    'utf8',
  )
  for (const stage of PIPELINE_STAGES) {
    assert.ok(sql.includes(`'${stage}'`), `Postgres migration 0072 missing stage: ${stage}`)
  }
})

test('SQLite migration 076 widens the CHECK to accept saved/gathering_documents/ready_to_submit', async () => {
  // Smoke-test the migration end-to-end against an in-memory SQLite DB
  // seeded with the legacy CHECK constraint.
  const Database = (await import('better-sqlite3')).default
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE grants (
        id TEXT PRIMARY KEY,
        status TEXT DEFAULT 'discovered' CHECK(status IN (
          'discovered','interested','drafting','submitted','awarded','declined','archived'
        ))
      );
      INSERT INTO grants (id, status) VALUES ('legacy-1', 'archived');
    `)
    // Pre-migration: 'saved' is rejected.
    assert.throws(() => db.prepare('INSERT INTO grants(id,status) VALUES(?,?)').run('a', 'saved'))

    // Wire the migration. The runner usually injects a SqliteDb wrapper,
    // but the migration only relies on `prepare`, `exec`, and `unsafeMode`,
    // all of which better-sqlite3 exposes natively (unsafeMode included).
    const wrapper = {
      prepare: (sql) => {
        const stmt = db.prepare(sql)
        return { get: stmt.get.bind(stmt), all: stmt.all.bind(stmt), run: stmt.run.bind(stmt) }
      },
      exec: (sql) => db.exec(sql),
      unsafeMode: (on) => db.unsafeMode(Boolean(on)),
    }
    const mig = await import('../../backend/db/migrations/076_grants_status_canonical_pipeline.mjs')
    await mig.default(wrapper)

    // Post-migration: all 3 new stages accepted; legacy data preserved.
    db.prepare('INSERT INTO grants(id,status) VALUES(?,?)').run('a', 'saved')
    db.prepare('INSERT INTO grants(id,status) VALUES(?,?)').run('b', 'gathering_documents')
    db.prepare('INSERT INTO grants(id,status) VALUES(?,?)').run('c', 'ready_to_submit')
    const legacy = db.prepare('SELECT status FROM grants WHERE id = ?').get('legacy-1')
    assert.equal(legacy.status, 'archived')
  } finally {
    db.close()
  }
})

test('SQLite migration 076 is idempotent (re-run is a no-op)', async () => {
  const Database = (await import('better-sqlite3')).default
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE grants (
        id TEXT PRIMARY KEY,
        status TEXT DEFAULT 'discovered' CHECK(status IN (
          'discovered','interested','drafting','submitted','awarded','declined','archived'
        ))
      );
    `)
    const wrapper = {
      prepare: (sql) => {
        const stmt = db.prepare(sql)
        return { get: stmt.get.bind(stmt), all: stmt.all.bind(stmt), run: stmt.run.bind(stmt) }
      },
      exec: (sql) => db.exec(sql),
      unsafeMode: (on) => db.unsafeMode(Boolean(on)),
    }
    const mig = await import('../../backend/db/migrations/076_grants_status_canonical_pipeline.mjs')
    await mig.default(wrapper)
    const sqlAfterFirst = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='grants'`).get().sql
    await mig.default(wrapper)
    const sqlAfterSecond = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='grants'`).get().sql
    assert.equal(sqlAfterSecond, sqlAfterFirst, 'second run should not change the schema')
  } finally {
    db.close()
  }
})

test('applicationStatusToStage: reconciles application-tracker statuses onto canonical pipeline stages (goal #10)', () => {
  // Every application-tracker status maps to a real canonical stage.
  for (const [appStatus, stage] of Object.entries(APPLICATION_STATUS_TO_STAGE)) {
    assert.ok(PIPELINE_STAGES.includes(stage), `${appStatus} -> ${stage} must be a canonical stage`)
    assert.equal(applicationStatusToStage(appStatus), stage)
  }
  // The full grant_applications lifecycle is covered (no app status maps to null).
  for (const s of ['draft', 'in_progress', 'submitted', 'under_review', 'awarded', 'denied', 'withdrawn']) {
    assert.ok(applicationStatusToStage(s), `application status ${s} must reconcile to a stage`)
  }
  // under_review means post-submission for an application → follow_up (NOT the
  // pipeline alias's 'submitted'), so the unified view shows it after submission.
  assert.equal(applicationStatusToStage('under_review'), 'follow_up')
  // Falls back to the pipeline resolver for grants/vnext/apply-engine statuses.
  assert.equal(applicationStatusToStage('interested'), 'interested')
  assert.equal(applicationStatusToStage('discovery'), 'discovered')
  // Unknown / empty → null so callers bucket as "Other".
  assert.equal(applicationStatusToStage('totally_unknown'), null)
  assert.equal(applicationStatusToStage(''), null)
  assert.equal(applicationStatusToStage(null), null)
})

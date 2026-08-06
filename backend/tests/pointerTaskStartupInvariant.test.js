import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'

import {
  enforcePointerTaskReclassification,
} from '../startup/enforceInvariants.js'
import {
  _resetSchemaCache,
  ensureApplicationTaskSchema,
} from '../services/hamilton/applicationTaskStore.js'

const PROFILE_ID = 'profile-pointer-startup'
const savedEnv = {
  enforce: process.env.ENFORCE_POINTER_TASK_RECLASS,
  limit: process.env.POINTER_TASK_RECLASS_LIMIT,
  scanLimit: process.env.POINTER_TASK_RECLASS_SCAN_LIMIT,
}

async function makeDb() {
  _resetSchemaCache()
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      title TEXT,
      opportunity_kind TEXT,
      application_url TEXT,
      apply_url TEXT,
      source_url TEXT,
      url TEXT,
      evidence_url TEXT
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      funding_opportunity_id TEXT,
      title TEXT,
      application_url TEXT,
      apply_url TEXT,
      source_url TEXT,
      url TEXT,
      evidence_url TEXT
    );
  `)
  await ensureApplicationTaskSchema(db)
  db.exec(`
    INSERT INTO funding_opportunities (id, title, opportunity_kind)
      VALUES ('pointer-no-url', 'County Referral Directory', 'referral');
    INSERT INTO application_tasks
      (id, profile_id, opportunity_id, automation_type, status, current_step,
       output_document_id, auto_submit_enabled, allow_auto_submit,
       audit_summary_json, created_at, updated_at)
    VALUES
      ('legacy-pointer-task', '${PROFILE_ID}', 'pointer-no-url', 'portal', 'queued', 'queued',
       'retained-packet', 1, 1, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  `)
  return db
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

describe('pointer task startup invariant', () => {
  beforeEach(() => {
    delete process.env.ENFORCE_POINTER_TASK_RECLASS
    delete process.env.POINTER_TASK_RECLASS_LIMIT
    delete process.env.POINTER_TASK_RECLASS_SCAN_LIMIT
  })

  afterEach(() => {
    restoreEnv('ENFORCE_POINTER_TASK_RECLASS', savedEnv.enforce)
    restoreEnv('POINTER_TASK_RECLASS_LIMIT', savedEnv.limit)
    restoreEnv('POINTER_TASK_RECLASS_SCAN_LIMIT', savedEnv.scanLimit)
  })

  it('runs the conservative repair as a named invariant and preserves task evidence', async () => {
    const db = await makeDb()

    const result = await enforcePointerTaskReclassification(db)

    expect(result).toMatchObject({
      name: 'pointer_task_reclassification',
      ok: true,
      enforced: true,
      scanned: 1,
      non_applyable: 1,
      would_repair: 1,
      repaired: 1,
    })
    const task = db.prepare(
      'SELECT status, automation_type, current_step, output_document_id, auto_submit_enabled, allow_auto_submit FROM application_tasks WHERE id = ?',
    ).get('legacy-pointer-task')
    expect(task).toMatchObject({
      status: 'blocked',
      automation_type: 'research_lead',
      current_step: 'no_application_surface',
      output_document_id: 'retained-packet',
      auto_submit_enabled: 0,
      allow_auto_submit: 0,
    })
  })

  it('honors count-only mode and forwards independent write and scan bounds', async () => {
    process.env.ENFORCE_POINTER_TASK_RECLASS = '0'
    process.env.POINTER_TASK_RECLASS_LIMIT = '7'
    process.env.POINTER_TASK_RECLASS_SCAN_LIMIT = '23'
    const calls = []

    const result = await enforcePointerTaskReclassification({}, {
      repairLegacyPointerApplicationTasks: async (_db, options) => {
        calls.push(options)
        return { scanned: 9, would_repair: 4, repaired: 0, deferred_by_limit: 0 }
      },
    })

    expect(result).toMatchObject({
      name: 'pointer_task_reclassification',
      ok: true,
      enforced: false,
      scanned: 9,
      would_repair: 4,
      repaired: 0,
    })
    expect(calls).toEqual([{
      limit: 7,
      scanLimit: 23,
      dryRun: true,
      actorRole: 'system',
    }])
  })

  it('is present in the ordered startup invariant sequence', () => {
    const source = readFileSync(new URL('../startup/enforceInvariants.js', import.meta.url), 'utf8')
    expect(source).toContain('steps.push(await enforcePointerTaskReclassification(db))')
  })
})

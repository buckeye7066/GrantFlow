/**
 * Guard tests for the running process's Hamilton automation posture.
 *
 * The posture is a safety control: it records profile-scoped submission
 * authority and a boot id so the production audit can prove it came from the
 * process currently serving traffic. A retired process-wide flag must neither
 * appear in the record nor change that authority.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { BOOT_ID } from '../config/bootId.js'
import {
  buildAutomationPosture,
  recordAutomationPosture,
  AUTOMATION_POSTURE_KV_KEY,
} from '../startup/recordAutomationPosture.js'

function makeDb({ withKv = true } = {}) {
  const raw = new Database(':memory:')
  if (withKv) {
    raw.exec(`
      CREATE TABLE system_kv (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT
      );
    `)
  }
  // better-sqlite3 is synchronous; the recorder awaits its results, and
  // awaiting a non-promise resolves to its value — same stand-in the
  // enforceInvariants suite uses.
  return raw
}

function readPosture(db) {
  const row = db.prepare('SELECT value FROM system_kv WHERE key = ?').get(AUTOMATION_POSTURE_KV_KEY)
  return row ? JSON.parse(row.value) : null
}

const RETIRED_AUTOSUBMIT_KEY = ['HAMILTON', 'ALLOW', 'AUTOSUBMIT'].join('_')

const ENV_KEYS = [
  RETIRED_AUTOSUBMIT_KEY,
  'HAMILTON_ENABLE_BROWSER_AUTOMATION',
  'HAMILTON_RUN_ON_SCHEDULE',
  'HAMILTON_TAILORED_APPROVAL_GATE',
]

describe('buildAutomationPosture', () => {
  const saved = {}

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('records profile authorization as the only submission authority', () => {
    const posture = buildAutomationPosture()
    expect(posture.submission_authority).toBe('profile_authorization')
    expect(posture.profile_authorization_required).toBe(true)
    expect(posture.external_submission_possible).toBe(true)
    expect(posture).not.toHaveProperty('allow_auto_submit')
  })

  it('ignores the retired HAMILTON_ALLOW_AUTOSUBMIT environment variable', () => {
    process.env[RETIRED_AUTOSUBMIT_KEY] = 'false'
    const disabled = buildAutomationPosture()
    process.env[RETIRED_AUTOSUBMIT_KEY] = 'true'
    const enabled = buildAutomationPosture()
    expect(disabled.submission_authority).toBe('profile_authorization')
    expect(enabled.submission_authority).toBe('profile_authorization')
    expect(disabled).not.toHaveProperty('allow_auto_submit')
    expect(enabled).not.toHaveProperty('allow_auto_submit')
    delete process.env[RETIRED_AUTOSUBMIT_KEY]
  })

  // Absence means the approval gate is ON (tailoredNarrative.js). Reading an
  // unset variable as "off" would invert the safe default.
  it('treats an UNSET tailored approval gate as ON', () => {
    expect(buildAutomationPosture().tailored_approval_gate).toBe(true)
  })

  it('treats an explicit "false" tailored approval gate as OFF', () => {
    process.env.HAMILTON_TAILORED_APPROVAL_GATE = 'false'
    expect(buildAutomationPosture().tailored_approval_gate).toBe(false)
  })

  it('carries this process’s boot id so the reader can prove provenance', () => {
    expect(buildAutomationPosture().boot_id).toBe(BOOT_ID)
    expect(BOOT_ID).toMatch(/^[0-9a-f-]{36}$/i)
  })
})

describe('recordAutomationPosture', () => {
  it('INSERTs the posture when no row exists yet', async () => {
    const db = makeDb()
    await recordAutomationPosture(db, { logger: { warn() {} } })
    const posture = readPosture(db)
    expect(posture).not.toBeNull()
    expect(posture.boot_id).toBe(BOOT_ID)
    expect(posture.submission_authority).toBe('profile_authorization')
    expect(posture.profile_authorization_required).toBe(true)
  })

  it('UPDATEs in place rather than accumulating rows', async () => {
    const db = makeDb()
    await recordAutomationPosture(db, { logger: { warn() {} } })
    await recordAutomationPosture(db, { logger: { warn() {} } })
    const { n } = db
      .prepare('SELECT count(*) AS n FROM system_kv WHERE key = ?')
      .get(AUTOMATION_POSTURE_KV_KEY)
    expect(n).toBe(1)
  })

  // A boot must not fail because an observability write failed. The audit side
  // treats a missing row as "cannot verify" -> abort, so this degrades to a
  // REFUSED audit, never a permitted one.
  it('never throws when system_kv is missing, and reports failure honestly', async () => {
    const db = makeDb({ withKv: false })
    const result = await recordAutomationPosture(db, { logger: { warn() {} } })
    expect(result).toBeNull()
  })
})

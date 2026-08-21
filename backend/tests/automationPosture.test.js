/**
 * Guard tests for backend/startup/recordAutomationPosture.js.
 *
 * This record is a SAFETY CONTROL, not telemetry: the production-audit bridge
 * refuses to open a browser against production unless it can read
 * `allow_auto_submit: false` out of it. So the failure that matters is the
 * quiet one — a posture that reports "disabled" while the gate it describes is
 * actually armed. Every test below is written to fail if that drift is
 * possible, which is why the armed case is asserted as explicitly as the
 * disabled one (a recorder hardcoded to `false` would pass a disabled-only
 * test and be catastrophically wrong).
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

const ENV_KEYS = [
  'HAMILTON_ALLOW_AUTOSUBMIT',
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

  // SUPERSEDED DEFAULT. This case used to assert `false` for an unset flag,
  // matching isAutoSubmitGloballyEnabled()'s old `|| 'false'` default. The
  // owner flipped that default ON on 2026-08-20 ("full automation means full
  // automation"; docs/agent-sync/2026-08-20-hamilton-real-portal-submit.md),
  // so an unset flag now means ARMED. The posture must say so — this record is
  // a safety control, and reporting "disabled" for an armed process is exactly
  // the drift the file exists to prevent. Note the direction of the risk: this
  // makes the production-audit bridge REFUSE by default, never proceed.
  it('reports allow_auto_submit TRUE when the flag is unset (default is now ARMED)', () => {
    expect(buildAutomationPosture().allow_auto_submit).toBe(true)
  })

  it('reports allow_auto_submit FALSE when the flag is explicitly "false"', () => {
    process.env.HAMILTON_ALLOW_AUTOSUBMIT = 'false'
    expect(buildAutomationPosture().allow_auto_submit).toBe(false)
  })

  // The load-bearing case. A recorder hardcoded to `false` would silently
  // authorize an audit against an ARMED production; this and the unset case
  // above are what catch that, while the explicit-"false" case above catches a
  // recorder hardcoded to `true`. Both directions must stay covered.
  it('reports allow_auto_submit TRUE when the flag is armed', () => {
    process.env.HAMILTON_ALLOW_AUTOSUBMIT = 'true'
    expect(buildAutomationPosture().allow_auto_submit).toBe(true)
  })

  it('is case-insensitive about the armed value, matching the real gate', () => {
    process.env.HAMILTON_ALLOW_AUTOSUBMIT = 'TRUE'
    expect(buildAutomationPosture().allow_auto_submit).toBe(true)
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
    expect(typeof posture.allow_auto_submit).toBe('boolean')
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

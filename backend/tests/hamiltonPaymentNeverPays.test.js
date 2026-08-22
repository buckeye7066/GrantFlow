/**
 * Owner rule (2026-08-22): grants and funding sources never require a payment to
 * apply, and there is no payment envelope. The resolver must NEVER charge and
 * must NEVER ask the owner to authorize a payment — a fee-demanding source is
 * flagged for review and left unsubmitted.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../../tests/helpers/sqliteTestDb.mjs'
import { resolveBlocker } from '../services/hamilton/hamiltonHardStopResolver.js'

describe('payment_required is flag-and-skip, never a charge', () => {
  let db
  const PROFILE = 'p-pay'
  beforeAll(async () => {
    const sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT, display_name TEXT, name TEXT);
      CREATE TABLE users (id TEXT PRIMARY KEY, is_admin INTEGER DEFAULT 0);
      CREATE TABLE notifications (id TEXT PRIMARY KEY, user_id TEXT, type TEXT, title TEXT, message TEXT, severity TEXT, data TEXT, read INTEGER DEFAULT 0, resolved INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    `)
    db = wrapSqlite(sqlite)
    await db.prepare('INSERT INTO profiles (id, user_id, display_name) VALUES (?, ?, ?)').run(PROFILE, 'u1', 'Jane Q. Applicant')
    await db.prepare('INSERT INTO users (id) VALUES (?)').run('u1')
  })

  it('never charges and never asks to authorize an envelope (even under full automation)', async () => {
    const d = await resolveBlocker(
      db,
      { taskId: 't1', profileId: PROFILE, userId: 'u1', portalUrl: 'https://portal.example.org/apply', fullAutomation: true },
      { kind: 'payment', text: 'Application fee $50.00 required', context: { amount_cents: 5000, category: 'application_fee' } },
    )
    expect(d.strategy).toBe('payment_not_supported')
    expect(d.payload?.charged).toBe(false)
    expect(d.strategy).not.toBe('charge_within_pre_authorization')
    expect(d.strategy).not.toBe('ask_user_to_authorize_payment')
  })
})

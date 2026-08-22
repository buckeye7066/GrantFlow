/**
 * Condition 4 (owner 2026-08-22): a login wall for an account the applicant
 * ALREADY has (identity-bound host like FAFSA, or an "account already exists"
 * signal) becomes an ASK for that existing login — never a second account.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../../tests/helpers/sqliteTestDb.mjs'
import {
  isIdentityBoundAccountHost, requiresExistingExternalLogin, buildExistingLoginAsk,
  pageSignalsExistingAccount,
} from '../services/hamilton/hamiltonExistingAccountPolicy.js'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'a'.repeat(64)

describe('hamiltonExistingAccountPolicy', () => {
  it('recognises identity-bound hosts (FAFSA / federal / identity providers), incl. subdomains', () => {
    for (const h of ['studentaid.gov', 'fafsa.gov', 'fafsa.ed.gov', 'sa.www4.irs.gov', 'secure.ssa.gov', 'id.me', 'login.gov']) {
      expect(isIdentityBoundAccountHost(h)).toBe(true)
    }
  })
  it('does NOT treat an ordinary scholarship portal as identity-bound', () => {
    for (const h of ['apply.somefunder.org', 'scholarships.example.edu', 'bold.org']) {
      expect(isIdentityBoundAccountHost(h)).toBe(false)
    }
  })
  it('detects an "account already exists" page signal', () => {
    expect(pageSignalsExistingAccount('An account with this email already exists.')).toBe(true)
    expect(pageSignalsExistingAccount('That username is already taken.')).toBe(true)
    expect(pageSignalsExistingAccount('Create your free account today.')).toBe(false)
  })
  it('requiresExistingExternalLogin: identity host, already-exists signup, or page signal → ask', () => {
    expect(requiresExistingExternalLogin({ host: 'studentaid.gov' })).toMatchObject({ ask: true, reason: 'identity_bound_host' })
    expect(requiresExistingExternalLogin({ host: 'apply.x.org', signupOutcome: 'already_exists' })).toMatchObject({ ask: true, reason: 'account_already_exists' })
    expect(requiresExistingExternalLogin({ host: 'apply.x.org', pageText: 'email already registered' })).toMatchObject({ ask: true, reason: 'account_already_exists' })
    // A plain portal with no existing account → NOT an ask (Hamilton creates one).
    expect(requiresExistingExternalLogin({ host: 'apply.x.org', pageText: 'Sign in or create an account' })).toEqual({ ask: false, reason: null })
  })
  it('buildExistingLoginAsk is a login-kind ask keyed per host, never a fabricated value', () => {
    const ask = buildExistingLoginAsk({ host: 'studentaid.gov', reason: 'identity_bound_host' })
    expect(ask).toMatchObject({ kind: 'login', key: 'portal_login:studentaid.gov', required: true })
    expect(ask.description).toMatch(/never creates|will NOT create|does not create|Hamilton never/i)
  })
})

// ── resolver behaviour ──────────────────────────────────────────────────────
let db, resolveBlocker
const PROFILE = 'p-login'
beforeEach(async () => {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT, display_name TEXT, name TEXT);
    CREATE TABLE users (id TEXT PRIMARY KEY, is_admin INTEGER DEFAULT 0);
    CREATE TABLE notifications (id TEXT PRIMARY KEY, user_id TEXT, type TEXT, title TEXT, message TEXT, severity TEXT, data TEXT, read INTEGER DEFAULT 0, resolved INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE hamilton_authorizations (id TEXT PRIMARY KEY, user_id TEXT, profile_id TEXT, scope TEXT, authorization_type TEXT, funding_source_id TEXT, task_id TEXT, authorization_text TEXT, authorization_version TEXT, options_json TEXT, metadata_json TEXT, accepted_at DATETIME, revoked_at DATETIME, revoked_reason TEXT, created_at DATETIME, updated_at DATETIME);
  `)
  db = wrapSqlite(sqlite)
  await db.prepare('INSERT INTO profiles (id, user_id) VALUES (?, ?)').run(PROFILE, 'u1')
  await db.prepare('INSERT INTO users (id) VALUES (?)').run('u1')
  resolveBlocker = (await import('../services/hamilton/hamiltonHardStopResolver.js')).resolveBlocker
})

describe('resolveLogin — condition 4 wiring', () => {
  const ctx = (portalUrl) => ({ taskId: 't1', profileId: PROFILE, userId: 'u1', portalUrl })

  it('an identity-bound portal (FAFSA) → ask_user_for_existing_login + records a login ask', async () => {
    const d = await resolveBlocker(db, ctx('https://studentaid.gov/fsa-id/sign-in'), { kind: 'login', text: 'Sign in' })
    expect(d.outcome).toBe('escalated')
    expect(d.strategy).toBe('ask_user_for_existing_login')
    const mi = await db.prepare(`SELECT kind, key FROM application_missing_info WHERE task_id='t1'`).get()
    expect(mi).toMatchObject({ kind: 'login', key: 'portal_login:studentaid.gov' })
  })

  it('an ordinary portal with no existing-account signal → the generic session ask (Hamilton may create an account)', async () => {
    const d = await resolveBlocker(db, ctx('https://apply.somefunder.org/login'), { kind: 'login', text: 'Sign in or create an account' })
    expect(d.outcome).toBe('escalated')
    expect(d.strategy).toBe('ask_user_for_session')
  })
})

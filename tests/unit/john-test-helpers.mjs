/**
 * Shared helpers for John unit tests.
 *
 * Provides an in-memory better-sqlite3 database wrapped in the same
 * `{ dialect, prepare, exec }` shape that backend/db/index.js exposes for
 * sqlite. Tests can then call johnRunStore / johnSuppressionService etc
 * exactly like in production.
 *
 * The helper applies the SQLite migration directly so tests run against
 * the real schema. No network, no env mutation outside the explicit
 * `applyEnv()` helper.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')
const MIGRATION_PATH = path.join(
  REPO_ROOT,
  'backend',
  'db',
  'migrations',
  '083_john_tables.sql'
)

export function makeJohnDb() {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  const sql = readFileSync(MIGRATION_PATH, 'utf8')
  sqlite.exec(sql)

  const db = {
    dialect: 'sqlite',
    _raw: sqlite,
    prepare(text) {
      const stmt = sqlite.prepare(text)
      return {
        async get(...args) { return stmt.get(...args) },
        async all(...args) { return stmt.all(...args) },
        async run(...args) { return stmt.run(...args) },
      }
    },
    exec(text) { return sqlite.exec(text) },
    close() { sqlite.close() },
  }
  return db
}

/**
 * Set JOHN_* env vars for a test, returning a restore function.
 */
export function applyEnv(patch) {
  const previous = {}
  for (const [k, v] of Object.entries(patch || {})) {
    previous[k] = process.env[k]
    if (v == null) delete process.env[k]
    else process.env[k] = String(v)
  }
  return function restore() {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/**
 * Default JOHN env that satisfies the safety classifier — qualified leads
 * with public evidence, contact source, opt-out language present, etc.
 * Tests can call this once at the start to get reproducible defaults.
 */
export function applyDefaultJohnEnv() {
  return applyEnv({
    JOHN_ENABLED: 'true',
    JOHN_DRAFT_ONLY: 'true',
    JOHN_ALLOW_SEND: 'false',
    JOHN_REQUIRE_HUMAN_REVIEW: 'true',
    JOHN_MAX_DRAFTS_PER_24H: '50',
    JOHN_MAX_DRAFTS_PER_RUN: '50',
    JOHN_MAX_DRAFTS_PER_HOUR: '10',
    JOHN_MIN_LEAD_SCORE: '70',
    JOHN_REQUIRE_YANA_QUALIFIED: 'true',
    JOHN_REQUIRE_PUBLIC_EVIDENCE: 'true',
    JOHN_REQUIRE_CONTACT_SOURCE: 'true',
    JOHN_SUPPRESSION_ENABLED: 'true',
    JOHN_OPT_OUT_LANGUAGE_REQUIRED: 'true',
    JOHN_PHYSICAL_ADDRESS_REQUIRED: 'true',
    JOHN_PHYSICAL_ADDRESS: '123 Mission Way, Anywhere, USA',
    // Deterministic copy path: force the template composer (no live LLM call)
    // and pin the self-serve prospect link the email invites recipients to.
    JOHN_AI_DRAFTING: 'off',
    JOHN_PROSPECT_LINK: 'https://app.axiombiolabs.org/start',
    JOHN_PRIMARY_MAILBOX: 'dr.johnwhite@axiombiolabs.org',
    JOHN_FROM_ALIAS: 'GrantFlow@axiombiolabs.org',
    JOHN_REPLY_TO: 'GrantFlow@axiombiolabs.org',
    JOHN_DISPLAY_NAME: 'Dr. John White | GrantFlow',
    JOHN_TEST_RECIPIENT: 'dr.johnwhite@axiombiolabs.org',
    JOHN_ALLOW_PRIMARY_MAILBOX_FALLBACK_DRAFTS: 'true',
    JOHN_REQUIRE_ALIAS_REVIEW_IF_FALLBACK: 'true',
    MICROSOFT_TENANT_ID: 'tenant-123',
    MICROSOFT_CLIENT_ID: 'client-123',
    MICROSOFT_CLIENT_SECRET: 'secret-***',
  })
}

/**
 * Build a fully-qualified Yana lead packet that should pass safety checks.
 */
export function makeQualifiedLead(overrides = {}) {
  return {
    lead_id: overrides.lead_id || `lead-${Math.random().toString(36).slice(2, 8)}`,
    organization_name: overrides.organization_name || 'Riverbend Volunteer Fire Department',
    organization_type: overrides.organization_type || 'volunteer fire department',
    website_url: overrides.website_url || 'https://riverbendvfd.example.org',
    location: overrides.location || 'Riverbend, OH',
    contact_points: overrides.contact_points || [
      { type: 'email', value: 'chief@riverbendvfd.example.org', name: 'Chief Allen', role: 'Fire Chief', confidence: 0.85 },
    ],
    public_evidence: overrides.public_evidence || [
      {
        summary: 'replacing 25-year-old SCBA gear',
        source_url: 'https://riverbendvfd.example.org/news/scba-2026',
        specificity: 'high',
      },
    ],
    funding_need_summary: overrides.funding_need_summary || 'Need ~$120k to replace expired SCBA equipment.',
    grantflow_fit_summary: overrides.grantflow_fit_summary || 'AFG, state fire grants, county safety grants.',
    lead_score: typeof overrides.lead_score === 'number' ? overrides.lead_score : 82,
    contact_confidence: typeof overrides.contact_confidence === 'number' ? overrides.contact_confidence : 0.85,
    urgency_score: typeof overrides.urgency_score === 'number' ? overrides.urgency_score : 70,
    recommended_outreach_angle: overrides.recommended_outreach_angle || 'AFG/state fire grants',
    recommended_channel: overrides.recommended_channel || 'email',
    suggested_persona: overrides.suggested_persona || 'fire_chief',
    do_not_contact_flags: overrides.do_not_contact_flags || [],
    compliance_notes: overrides.compliance_notes || null,
    source_urls: overrides.source_urls || ['https://riverbendvfd.example.org/about'],
    discovered_at: overrides.discovered_at || new Date().toISOString(),
    qualified: overrides.qualified === undefined ? true : overrides.qualified,
    status: overrides.status || 'queued_for_john',
  }
}

/**
 * In-memory provider that mimics johnOutlookProvider.createDraft. The
 * `aliasMode` toggle controls whether the fake provider "accepts" alias
 * sends. Defaults to alias_set=true.
 */
export function makeFakeOutlookProvider({
  aliasMode = 'accept', // 'accept' | 'reject' | 'fail-token' | 'fail-create'
  failOnce = false,
} = {}) {
  const calls = []
  let failNextOnce = failOnce
  return {
    ready: aliasMode !== 'not-configured',
    notConfigured: aliasMode === 'not-configured',
    missing: aliasMode === 'not-configured' ? 'MICROSOFT_TENANT_ID' : null,
    calls,
    async verifyMailbox() {
      if (aliasMode === 'not-configured') return { ok: false, reason: 'not_configured' }
      if (aliasMode === 'fail-token') return { ok: false, reason: 'token_failed' }
      return { ok: true, primary_mailbox: 'dr.johnwhite@axiombiolabs.org' }
    },
    async createDraft(args) {
      calls.push(args)
      if (failNextOnce) {
        failNextOnce = false
        const err = new Error('simulated transient failure')
        err.code = 'FAKE_TRANSIENT'
        throw err
      }
      if (aliasMode === 'fail-create') {
        const err = new Error('simulated provider failure')
        err.code = 'JOHN_OUTLOOK_DRAFT_FAILED'
        throw err
      }
      const id = `draft-${calls.length}-${Math.random().toString(36).slice(2, 6)}`
      const aliasSet = aliasMode === 'accept' && !!args.requestedFromAlias
      return {
        ok: true,
        provider_draft_id: id,
        provider_message_id: `msg-${id}`,
        alias_attempted: !!args.requestedFromAlias,
        alias_set: aliasSet,
        actual_from: aliasSet ? args.requestedFromAlias : 'dr.johnwhite@axiombiolabs.org',
        reply_to: args.replyTo || null,
        raw: { id, simulated: true },
      }
    },
  }
}

/**
 * hamiltonPortalPolicyRegistry.js
 *
 * Per-host policy registry: tells Hamilton whether automation is permitted
 * on a given portal, what the lawful fallback path is when it isn't,
 * and (if available) the official API to use instead of the browser.
 *
 * Hamilton NEVER ignores an explicit terms-prohibit-automation rule. When
 * a portal disallows automation she switches to the fallback_path —
 * pdf_docx packet, mail, fax, email, manual instructions, or API.
 *
 * Seed entries cover the well-known portals; per-host overrides live
 * in the `hamilton_portal_policies` table and win over the seed.
 */

import crypto from 'node:crypto'
import { normalizeHost } from './hamiltonCredentialSessionService.js'

// Per-db schema cache (WeakMap), not a process-global boolean: node:test runs a
// file's top-level suites concurrently, each with its own in-memory db, and a
// shared boolean races (one suite marks ready, a sibling's fresh db then skips
// schema creation). Keying by db keeps each db independent; prod (one db) is
// unchanged. Mirrors agentControlStore.
let schemaReady = new WeakMap()
export function _resetPortalPolicySchemaCache() { schemaReady = new WeakMap() }

/**
 * IDENTITY-PROOFED hosts: portals that gate account creation behind real
 * identity verification (SSN match, government ID, knowledge-based auth, ID.me /
 * Login.gov IAL2 proofing, FSA ID). Hamilton may ATTEMPT them, but she must NOT
 * fabricate identity / SSN / government-ID proofing (keep-me-legal). When
 * registration hits one of these walls she hands off to the human session-capture
 * flow and marks the portal "needs you" — a graceful handoff, not a failure.
 *
 * Matched on registrable domain via isIdentityProofedHost (so id.me, login.gov,
 * any *.studentaid.gov, etc. are covered). The list is intentionally
 * conservative — when in doubt the registration engine ALSO treats any
 * identity-proofing wall surfaced at runtime (via hamiltonBlockerClassifier) the
 * same way, so unlisted proofing portals still fall back gracefully.
 */
export const IDENTITY_PROOFED_HOSTS = Object.freeze([
  'studentaid.gov', // FSA ID — SSN + identity match
  'login.gov',      // federal shared sign-in, IAL2 identity proofing
  'id.me',          // identity verification provider (gov / VA / IRS)
  'irs.gov',        // ID.me / KBA identity proofing
  'ssa.gov',        // Social Security — KBA identity proofing
  'va.gov',         // VA — Login.gov / ID.me proofing
  'medicare.gov',   // identity-proofed account creation
  'healthcare.gov', // identity verification for marketplace accounts
  'sam.gov',        // entity / Login.gov IAL2 proofing
  'connect.gov',
])

/**
 * Is this host an identity-proofed portal (account creation needs real identity
 * verification)? Registrable-domain match so subdomains are covered.
 */
export function isIdentityProofedHost(portalHost) {
  const host = normalizeHost(portalHost)
  if (!host) return false
  return IDENTITY_PROOFED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
}

const SEED_POLICIES = Object.freeze([
  Object.freeze({
    portal_host: 'studentaid.gov',
    automation_allowed: false,           // FSA-ID terms forbid agent automation
    agent_submission_allowed: false,
    scraping_allowed: false,
    api_available: false,
    manual_only: true,
    identity_proofed: true,
    fallback_path: 'manual',
    source_of_policy: 'https://studentaid.gov/help/terms-of-service',
    notes: 'Hamilton never types an FSA ID or submits FAFSA on behalf of the student. Use saved authenticated session only when the user authorized session reuse, otherwise produce a manual checklist.',
  }),
  Object.freeze({
    portal_host: 'commonapp.org',
    automation_allowed: false,
    agent_submission_allowed: false,
    scraping_allowed: false,
    api_available: false,
    manual_only: true,
    fallback_path: 'manual',
    source_of_policy: 'https://www.commonapp.org/terms-of-use',
    notes: 'Common App ToS forbids third-party agent submission. Hamilton produces a printable preparation packet only.',
  }),
  Object.freeze({
    portal_host: 'tn.gov',
    automation_allowed: true,
    agent_submission_allowed: true,
    scraping_allowed: false,
    api_available: false,
    manual_only: false,
    fallback_path: 'pdf_docx',
    source_of_policy: 'https://www.tn.gov/about-tn/policies.html',
    notes: 'Public scholarship application form. Standard form completion only.',
  }),
  Object.freeze({
    // TSAC's CollegePays portal moved from tn.gov to the "College for TN"
    // (collegefortn.org) site run by THEC. Same public scholarship/aid
    // application surface, same policy as the legacy tn.gov entry.
    portal_host: 'collegefortn.org',
    automation_allowed: true,
    agent_submission_allowed: true,
    scraping_allowed: false,
    api_available: false,
    manual_only: false,
    fallback_path: 'pdf_docx',
    source_of_policy: 'https://www.collegefortn.org/',
    notes: 'Public TSAC / College for TN scholarship application surface. Standard form completion only.',
  }),
  Object.freeze({
    portal_host: 'mtsu.edu',
    automation_allowed: true,
    agent_submission_allowed: true,
    scraping_allowed: false,
    api_available: false,
    manual_only: false,
    fallback_path: 'pdf_docx',
    notes: 'University SSO required; rely on saved session when reuse is authorized.',
  }),
  Object.freeze({
    // Mirrors the mtsu.edu school entry. Cleveland State Community College
    // uses portal SSO; policy specifics should be re-verified against the
    // live CSCC portal once a session is captured.
    portal_host: 'clevelandstatecc.edu',
    automation_allowed: true,
    agent_submission_allowed: true,
    scraping_allowed: false,
    api_available: false,
    manual_only: false,
    fallback_path: 'pdf_docx',
    notes: 'Community college SSO required; rely on saved session when reuse is authorized.',
  }),
])

async function ensureSchema(db) {
  if (!db || schemaReady.has(db) || typeof db.prepare !== 'function') return
  const isPostgres = db?.dialect === 'postgres'
  const idDefault = isPostgres ? '(gen_random_uuid()::text)' : '(lower(hex(randomblob(16))))'
  const tsType = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME'
  const nowFn = isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'
  const boolType = isPostgres ? 'BOOLEAN' : 'INTEGER'
  const trueDef = isPostgres ? 'TRUE' : '1'
  const falseDef = isPostgres ? 'FALSE' : '0'
  const jsonType = isPostgres ? 'JSONB' : 'TEXT'
  const emptyObj = isPostgres ? `'{}'::jsonb` : `'{}'`
  await db.exec(`
    CREATE TABLE IF NOT EXISTS hamilton_portal_policies (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      portal_host TEXT NOT NULL UNIQUE,
      automation_allowed ${boolType} NOT NULL DEFAULT ${trueDef},
      agent_submission_allowed ${boolType} NOT NULL DEFAULT ${trueDef},
      scraping_allowed ${boolType} NOT NULL DEFAULT ${falseDef},
      api_available ${boolType} NOT NULL DEFAULT ${falseDef},
      manual_only ${boolType} NOT NULL DEFAULT ${falseDef},
      fallback_path TEXT,
      source_of_policy TEXT,
      last_checked_at ${tsType},
      notes TEXT,
      metadata_json ${jsonType} NOT NULL DEFAULT ${emptyObj},
      created_at ${tsType} DEFAULT ${nowFn},
      updated_at ${tsType} DEFAULT ${nowFn}
    );
    CREATE INDEX IF NOT EXISTS idx_hamilton_policy_host ON hamilton_portal_policies(portal_host);
  `)
  schemaReady.set(db, true)
}

function rowToPolicy(row) {
  if (!row) return null
  return {
    portal_host: row.portal_host,
    automation_allowed: !!row.automation_allowed,
    agent_submission_allowed: !!row.agent_submission_allowed,
    scraping_allowed: !!row.scraping_allowed,
    api_available: !!row.api_available,
    manual_only: !!row.manual_only,
    // Identity-proofed = account creation needs real identity verification. A DB
    // override can't currently store this flag, so OR it with the canonical host
    // list — a host on IDENTITY_PROOFED_HOSTS is always identity-proofed.
    identity_proofed: !!row.identity_proofed || isIdentityProofedHost(row.portal_host),
    fallback_path: row.fallback_path || null,
    source_of_policy: row.source_of_policy || null,
    last_checked_at: row.last_checked_at || null,
    notes: row.notes || null,
  }
}

/**
 * Find the policy that matches `portalHost`. Tries an exact host
 * match first, then walks up the registered domain (mtsu.edu →
 * tn.gov fallback, etc.). Falls back to the seed catalogue if there's
 * no DB row, then returns a permissive default if nothing matches.
 */
export async function getPolicyFor(db, portalHost) {
  const host = normalizeHost(portalHost)
  if (!host) return defaultPolicy(null)
  if (db) {
    await ensureSchema(db)
    const row = await db.prepare('SELECT * FROM hamilton_portal_policies WHERE portal_host = ? LIMIT 1').get(host)
    if (row) return rowToPolicy(row)
    // Suffix match: "wwww.mtsu.edu" should match "mtsu.edu".
    const parts = host.split('.')
    for (let i = 1; i < parts.length - 1; i += 1) {
      const suffix = parts.slice(i).join('.')
      const r = await db.prepare('SELECT * FROM hamilton_portal_policies WHERE portal_host = ? LIMIT 1').get(suffix)
      if (r) return rowToPolicy(r)
    }
  }
  // Seed catalogue.
  const seed = SEED_POLICIES.find((p) => p.portal_host === host)
    || SEED_POLICIES.find((p) => host.endsWith(`.${p.portal_host}`))
  if (seed) return { ...seed, identity_proofed: !!seed.identity_proofed || isIdentityProofedHost(host) }
  return defaultPolicy(host)
}

function defaultPolicy(host) {
  return {
    portal_host: host,
    automation_allowed: true,
    agent_submission_allowed: true,
    scraping_allowed: false,
    api_available: false,
    manual_only: false,
    // Even with no host-specific policy row, a canonical identity-proofed host
    // is still flagged so the autopilot identity engine hands off gracefully.
    identity_proofed: isIdentityProofedHost(host),
    fallback_path: 'pdf_docx',
    source_of_policy: null,
    last_checked_at: null,
    notes: 'Default permissive policy — no host-specific entry on file.',
  }
}

/**
 * Upsert a policy row. Used by admins (and the resolver when it
 * detects "automation forbidden" text on a portal it has not seen
 * before) to record what we observed.
 */
export async function upsertPolicy(db, {
  portalHost,
  automationAllowed = true,
  agentSubmissionAllowed = true,
  scrapingAllowed = false,
  apiAvailable = false,
  manualOnly = false,
  fallbackPath = null,
  sourceOfPolicy = null,
  notes = null,
  metadata = {},
} = {}) {
  if (!db) throw new Error('db required')
  const host = normalizeHost(portalHost)
  if (!host) throw new Error('portalHost required')
  await ensureSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const existing = await db.prepare('SELECT id FROM hamilton_portal_policies WHERE portal_host = ? LIMIT 1').get(host)
  if (existing) {
    await db.prepare(
      `UPDATE hamilton_portal_policies SET
          automation_allowed = ?, agent_submission_allowed = ?, scraping_allowed = ?,
          api_available = ?, manual_only = ?, fallback_path = ?, source_of_policy = ?,
          notes = ?, last_checked_at = ${nowFn}, metadata_json = ?, updated_at = ${nowFn}
        WHERE id = ?`,
    ).run(
      automationAllowed ? 1 : 0, agentSubmissionAllowed ? 1 : 0, scrapingAllowed ? 1 : 0,
      apiAvailable ? 1 : 0, manualOnly ? 1 : 0, fallbackPath, sourceOfPolicy,
      notes, JSON.stringify(metadata || {}), existing.id,
    )
  } else {
    await db.prepare(
      `INSERT INTO hamilton_portal_policies
          (id, portal_host, automation_allowed, agent_submission_allowed, scraping_allowed,
           api_available, manual_only, fallback_path, source_of_policy, notes,
           last_checked_at, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${nowFn}, ?, ${nowFn}, ${nowFn})`,
    ).run(
      crypto.randomUUID(), host,
      automationAllowed ? 1 : 0, agentSubmissionAllowed ? 1 : 0, scrapingAllowed ? 1 : 0,
      apiAvailable ? 1 : 0, manualOnly ? 1 : 0, fallbackPath, sourceOfPolicy, notes,
      JSON.stringify(metadata || {}),
    )
  }
  return await getPolicyFor(db, host)
}

export async function listPolicies(db) {
  if (!db) return SEED_POLICIES.map((p) => ({ ...p }))
  await ensureSchema(db)
  const rows = await db.prepare('SELECT * FROM hamilton_portal_policies ORDER BY portal_host').all()
  const overrides = new Map((rows || []).map((r) => [r.portal_host, rowToPolicy(r)]))
  const merged = SEED_POLICIES.map((seed) => overrides.get(seed.portal_host) || { ...seed })
  return merged.concat([...overrides.values()].filter((o) => !SEED_POLICIES.find((s) => s.portal_host === o.portal_host)))
}

export const SEED_PORTAL_POLICIES = SEED_POLICIES

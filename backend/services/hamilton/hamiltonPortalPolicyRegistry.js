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

let ensured = false
export function _resetPortalPolicySchemaCache() { ensured = false }

const SEED_POLICIES = Object.freeze([
  Object.freeze({
    portal_host: 'studentaid.gov',
    automation_allowed: false,           // FSA-ID terms forbid agent automation
    agent_submission_allowed: false,
    scraping_allowed: false,
    api_available: false,
    manual_only: true,
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
    portal_host: 'mtsu.edu',
    automation_allowed: true,
    agent_submission_allowed: true,
    scraping_allowed: false,
    api_available: false,
    manual_only: false,
    fallback_path: 'pdf_docx',
    notes: 'University SSO required; rely on saved session when reuse is authorized.',
  }),
])

async function ensureSchema(db) {
  if (!db || ensured || typeof db.prepare !== 'function') return
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
  ensured = true
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
  if (seed) return { ...seed }
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

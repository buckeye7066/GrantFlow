// backend/db/scopedQuery.js
//
// Enforces per-tenant data isolation at the SQL layer.
//
// Any query that touches a profile-scoped table (allowlist below) MUST filter
// by profile_id. When a profile context is active in AsyncLocalStorage and a
// scoped query is issued without a profile_id predicate, we throw
// ProfileScopeError. Production may temporarily opt back into warn-only mode
// with PROFILE_SCOPE_MODE=warn while a legacy query is being retired.
//
// This module exposes two surfaces:
//   * runProfileContext(ctx, fn)              — set context for a request/tool
//   * getProfileContext()                     — read current context
//   * analyzeProfileScope(sql)                — pure string analysis helper
//   * assertProfileScopedSql(sql, opts)       — throws/logs when unscoped
//
// The backend/db/index.js `prepare()` wrapper invokes assertProfileScopedSql()
// on every SQL statement so every call site is guarded at the contract layer.

import { AsyncLocalStorage } from 'async_hooks'

const storage = new AsyncLocalStorage()

/** Tables that hold tenant-owned rows. Access to these requires profile scope. */
export const PROFILE_SCOPED_TABLES = new Set([
  'grants',
  'opportunities',
  'saved_grants',
  'applications',
  'application_steps',
  'application_events',
  'documents',
  'matches',
  'decisions',
  'profile_needs',
  'profile_sections',
  'profile_section_answers',
  'anya_sessions',
  'anya_brain_memory',
  'anya_tool_usage',
  'anya_tool_registry_snapshot',
])

/**
 * Dual-scope tables: rows with profile_id IS NULL are the shared/global catalog
 * (crawl results visible to everyone); rows with a non-NULL profile_id are
 * private to that profile. Canonical visible-set clause:
 *   (profile_id IS NULL OR profile_id = ?)
 *
 * Enforcement chosen after auditing all ~255 call sites (2026-07-02 pass):
 *   - READS  : catalog-wide SELECTs without any profile/row predicate are the
 *              product's current intentional behavior (opportunities browse,
 *              matching scans), so an unscoped read under a tenant claim is
 *              logged/counted (profile_bleed) — NOT blocked — unless
 *              PROFILE_SCOPE_FUNDING_READS=strict opts in after drift retires.
 *   - WRITES : every legitimate wholesale UPDATE/DELETE writer (deadline expiry,
 *              Anya health dedup, remove-loans, min-national backfill) runs from
 *              boot/background/admin contexts, so a wholesale write under a
 *              non-admin tenant claim is a bug → strict (throws by default).
 *              Row-targeted writes (id/fingerprint/source_id/profile_id
 *              predicates, or profile_id IS NULL global-maintenance filters)
 *              pass.
 *   - INSERTS: allowed — crawl ingestion legitimately writes global rows even
 *              inside request-initiated discovery contexts.
 */
export const DUAL_SCOPE_TABLES = new Set(['funding_opportunities'])

/**
 * Organization-scoped tables: organizations has NO profile_id column — tenancy
 * links through profiles.organization_id / user_organizations. The scope key is
 * therefore the org row itself. Under a non-admin tenant claim, SELECT/UPDATE/
 * DELETE must be row-targeted (id = ? / id IN (...)) or reached through the
 * owning-row linkage (an organization_id equality/join). INSERTs (org creation)
 * read nothing and are allowed. All request-path queries audited 2026-07-02
 * already satisfy this, so this tier is strict by default.
 */
export const ORG_SCOPED_TABLES = new Set(['organizations'])

/**
 * Profile-scoped tables that ALSO carry a first-class organization_id tenant
 * key. Org pipelines are shared across the org's profiles by design (the
 * matching/grants org branch, org grant lists, org pipeline-$ cards), and the
 * enforceNoCrossProfileBleed() boot invariant keeps grants.organization_id
 * consistent with the owning profile's org — so a param-bound organization_id
 * predicate is equivalent tenant isolation for these tables. Without this,
 * every org-branch read under a claimed profile throws ProfileScopeError
 * (prod: GET /api/matching/profile/:id/grants, 2026-07-13).
 */
export const ORG_KEYED_PROFILE_TABLES = new Set(['grants', 'documents'])

/** Admins can read/write across tenants; readers of this role bypass the guard. */
const ADMIN_ROLES = new Set(['admin', 'admin_global', 'service', 'service_role', 'health_check'])

/** Role safe-lists: per-role bypass of specific tables (e.g. system tables). */
const ROLE_TABLE_BYPASS = {
  admin_global: new Set([...PROFILE_SCOPED_TABLES]),
  service: new Set([...PROFILE_SCOPED_TABLES]),
}

export class ProfileScopeError extends Error {
  constructor(message, meta = {}) {
    super(message)
    this.name = 'ProfileScopeError'
    this.code = 'PROFILE_SCOPE_VIOLATION'
    Object.assign(this, meta)
  }
}

export function runProfileContext(ctx, fn) {
  return storage.run(ctx || {}, fn)
}

export function getProfileContext() {
  return storage.getStore() || null
}

/**
 * Lightweight SQL token analysis. Returns:
 *   { isScoped: bool, tables: string[], hasProfilePredicate: bool, op: 'SELECT'|'UPDATE'|... }
 *
 * We do not ship a full SQL parser for two reasons:
 *   1. Our queries are authored in-house and use parameter placeholders only.
 *   2. A regex-and-token pass is safe enough because we are matching against
 *      a known allowlist; when in doubt we flag for human review.
 */
export function analyzeProfileScope(sql) {
  const raw = String(sql || '')
  const empty = {
    isScoped: false,
    tables: [],
    hasProfilePredicate: false,
    hasOrgKeyPredicate: false,
    op: null,
    dualScopeTables: [],
    orgScopedTables: [],
    fundingReadViolation: false,
    fundingWriteViolation: false,
    orgViolation: false,
  }
  if (!raw.trim()) return empty

  // Strip comments and string literals to avoid false positives inside text.
  const stripped = raw
    .replace(/--[^\n]*\n?/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""')

  const upper = stripped.toUpperCase()
  const opMatch = upper.match(/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH|REPLACE|PRAGMA|CREATE|ALTER|DROP|EXPLAIN|VACUUM|BEGIN|COMMIT|ROLLBACK|ATTACH|DETACH)\b/)
  const op = opMatch ? opMatch[1] : null

  // DDL and pragma never carry row-level scope.
  if (!op || ['CREATE', 'ALTER', 'DROP', 'PRAGMA', 'EXPLAIN', 'VACUUM', 'BEGIN', 'COMMIT', 'ROLLBACK', 'ATTACH', 'DETACH'].includes(op)) {
    return { ...empty, op }
  }

  const tables = []
  const dualScopeTables = []
  const orgScopedTables = []
  const tableRegex = /\b(FROM|JOIN|INTO|UPDATE)\s+(?:ONLY\s+)?["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?/g
  let m
  while ((m = tableRegex.exec(upper)) !== null) {
    const tbl = m[2].toLowerCase()
    if (PROFILE_SCOPED_TABLES.has(tbl) && !tables.includes(tbl)) {
      tables.push(tbl)
    }
    if (DUAL_SCOPE_TABLES.has(tbl) && !dualScopeTables.includes(tbl)) {
      dualScopeTables.push(tbl)
    }
    if (ORG_SCOPED_TABLES.has(tbl) && !orgScopedTables.includes(tbl)) {
      orgScopedTables.push(tbl)
    }
  }

  if (tables.length === 0 && dualScopeTables.length === 0 && orgScopedTables.length === 0) {
    return { ...empty, op }
  }

  // Acceptable predicates:
  //   profile_id = ?
  //   profile_id = $N
  //   profile_id IN (...)
  //   profile_id IS NULL        <- only for admin-only diagnostic queries; normally not acceptable
  //   t.profile_id = ?
  //   WHERE 1=0   <- empty-set guard, safe
  //   INSERT INTO ... (profile_id, ...) VALUES (...)
  const hasEqPredicate =
    /\bPROFILE_ID\s*=\s*(\?|\$\d+|:[A-Z_][A-Z0-9_]*|@[A-Z_][A-Z0-9_]*)/.test(upper) ||
    /\.\s*PROFILE_ID\s*=\s*(\?|\$\d+|:[A-Z_][A-Z0-9_]*|@[A-Z_][A-Z0-9_]*)/.test(upper)
  const hasInPredicate = /\bPROFILE_ID\s+IN\s*\(/.test(upper)
  const insertHasColumn =
    op === 'INSERT' && /\bINSERT\s+INTO\s+[A-Z_][A-Z0-9_]*\s*\([^)]*\bPROFILE_ID\b/.test(upper)
  const emptySet = /\bWHERE\s+1\s*=\s*0\b/.test(upper)
  const hasProfilePredicate = hasEqPredicate || hasInPredicate || insertHasColumn || emptySet

  // Tier-specific predicates (dual-scope + org-scoped tables).
  const PARAM = '(\\?|\\$\\d+|:[A-Z_][A-Z0-9_]*|@[A-Z_][A-Z0-9_]*)'
  // \bID does not match inside FOO_ID (the "_" is a word char), so this only
  // matches the bare `id` column (optionally alias-qualified: fo.id = ?).
  const idTargeted =
    new RegExp(`\\bID\\s*=\\s*${PARAM}`).test(upper) || /\bID\s+IN\s*\(/.test(upper)
  const rowKeyTargeted = new RegExp(
    `\\b(FINGERPRINT|SOURCE_ID|CANONICAL_OPPORTUNITY_KEY)\\s*=\\s*${PARAM}`,
  ).test(upper)
  const profileIdIsNull = /\bPROFILE_ID\s+IS\s+NULL\b/.test(upper)
  const orgLinkage = /\bORGANIZATION_ID\b/.test(upper)

  // Org-keyed profile tables: a PARAM-BOUND organization_id equality/IN is an
  // equivalent tenant key (stricter than the organizations-tier presence check
  // above — a literal or bare mention does not qualify). Only satisfied when
  // EVERY profile-scoped table in the query carries the org key, so a join
  // that smuggles in e.g. anya_sessions still requires a profile_id predicate.
  const orgKeyPredicate =
    new RegExp(`\\bORGANIZATION_ID\\s*=\\s*${PARAM}`).test(upper) ||
    /\bORGANIZATION_ID\s+IN\s*\(/.test(upper)
  const hasOrgKeyPredicate =
    orgKeyPredicate &&
    tables.length > 0 &&
    tables.every((t) => ORG_KEYED_PROFILE_TABLES.has(t))

  const isWrite = op === 'UPDATE' || op === 'DELETE'
  const fundingRowScoped =
    hasEqPredicate || hasInPredicate || profileIdIsNull || idTargeted || rowKeyTargeted || emptySet
  const fundingReadViolation =
    dualScopeTables.length > 0 && !isWrite && op !== 'INSERT' && !fundingRowScoped
  const fundingWriteViolation =
    dualScopeTables.length > 0 && isWrite && !fundingRowScoped
  const orgViolation =
    orgScopedTables.length > 0 && op !== 'INSERT' && !(idTargeted || orgLinkage || emptySet)

  return {
    isScoped: tables.length > 0,
    tables,
    hasProfilePredicate,
    hasOrgKeyPredicate,
    op,
    dualScopeTables,
    orgScopedTables,
    fundingReadViolation,
    fundingWriteViolation,
    orgViolation,
  }
}

/**
 * Check `sql` against the current AsyncLocalStorage profile context.
 *
 * Behaviour:
 *   - No active profile context → pass (system/boot/admin CLIs unaffected).
 *   - Admin role → pass (admins legitimately span tenants).
 *   - Scoped table + missing predicate:
 *       * default → throw ProfileScopeError.
 *       * PROFILE_SCOPE_MODE=warn → emit a `profile_bleed` warning + count on
 *         the context so the caller can aggregate drift signals for admin diagnostics.
 *
 * Returns the (possibly unchanged) SQL; callers never need to branch on result.
 */
export function assertProfileScopedSql(sql, opts = {}) {
  const ctx = getProfileContext()
  // No context → module is being used from a boot script, migration, or job.
  if (!ctx) return sql
  if (ctx.bypass === true) return sql
  const role = String(ctx.actorRole || ctx.role || '').toLowerCase()
  if (ADMIN_ROLES.has(role)) return sql
  if (role && ROLE_TABLE_BYPASS[role]) return sql

  const analysis = analyzeProfileScope(sql)

  // Collect violations across the three tiers.
  //   blocking  — throws in strict mode (default when a profile is claimed)
  //   warn-only — observability tier (never throws unless explicitly opted in)
  const coreViolation =
    analysis.isScoped && !analysis.hasProfilePredicate && !analysis.hasOrgKeyPredicate
  const fundingReadsStrict =
    String(process.env.PROFILE_SCOPE_FUNDING_READS || '').trim().toLowerCase() === 'strict'
  const blockingViolations = []
  const warnViolations = []
  if (coreViolation) blockingViolations.push({ tier: 'profile', tables: analysis.tables })
  if (analysis.orgViolation) blockingViolations.push({ tier: 'organizations', tables: ['organizations'] })
  if (analysis.fundingWriteViolation) blockingViolations.push({ tier: 'funding_write', tables: analysis.dualScopeTables })
  if (analysis.fundingReadViolation) {
    const v = { tier: 'funding_read', tables: analysis.dualScopeTables }
    if (fundingReadsStrict) blockingViolations.push(v)
    else warnViolations.push(v)
  }
  if (blockingViolations.length === 0 && warnViolations.length === 0) return sql

  // Strict mode fires when a profile is actually claimed. Otherwise the request
  // is a system/boot/admin path and should be logged (not blocked). Warn-only
  // mode exists as a short-lived deployment escape hatch, not the default.
  const hasClaim = Boolean(ctx.profileId)
  const mode = String(process.env.PROFILE_SCOPE_MODE || '').trim().toLowerCase()
  const legacyStrict = String(process.env.PROFILE_SCOPE_STRICT || '').trim().toLowerCase()
  const warnOnly = mode === 'warn' || mode === 'warning' || legacyStrict === '0' || legacyStrict === 'false'
  const strict = hasClaim && !warnOnly

  const allViolations = [...blockingViolations, ...warnViolations]
  const detail = {
    tiers: allViolations.map((v) => v.tier),
    tables: [...new Set(allViolations.flatMap((v) => v.tables))],
    op: analysis.op,
    sql: String(sql).slice(0, 400),
    profileId: ctx.profileId || null,
    userId: ctx.userId || null,
    route: opts.route || ctx.route || null,
  }

  if (strict && blockingViolations.length > 0) {
    const first = blockingViolations[0]
    throw new ProfileScopeError(
      `Profile-scoped ${analysis.op} on [${first.tables.join(', ')}] without required scope predicate (tier: ${first.tier})`,
      detail,
    )
  }

  // Soft-warn: keep a running count on the context so diagnostics can report.
  ctx.profileBleed = (ctx.profileBleed || 0) + 1
  ctx.profileBleedSamples = (ctx.profileBleedSamples || [])
  if (ctx.profileBleedSamples.length < 20) ctx.profileBleedSamples.push(detail)

  emitBleedWarning(detail)
  return sql
}

// Warn-log deduplication: hot read paths (catalog browse, matching scans) hit
// the funding_read observability tier on every request; log each unique
// route+op+tier signature once per process so prod logs stay readable while
// per-request counts remain available on ctx.profileBleed / profileBleedSamples.
const seenBleedSignatures = new Set()
function emitBleedWarning(detail) {
  try {
    const routeSig = String(detail.route || detail.sql.slice(0, 120)).split('?')[0]
    const sig = `${detail.tiers.join('+')}|${detail.op}|${routeSig}`
    if (seenBleedSignatures.has(sig)) return
    if (seenBleedSignatures.size < 500) seenBleedSignatures.add(sig)
    // Soft emit so the existing audit log pipeline sees it.

    console.warn('[profile_bleed] unscoped SQL', JSON.stringify(detail))
  } catch {
    /* noop */
  }
}

export default {
  PROFILE_SCOPED_TABLES,
  DUAL_SCOPE_TABLES,
  ORG_SCOPED_TABLES,
  ORG_KEYED_PROFILE_TABLES,
  ProfileScopeError,
  runProfileContext,
  getProfileContext,
  analyzeProfileScope,
  assertProfileScopedSql,
}

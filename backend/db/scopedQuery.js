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
  'organizations',
  'anya_sessions',
  'anya_brain_memory',
  'anya_tool_usage',
  'anya_tool_registry_snapshot',
])

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
  if (!raw.trim()) return { isScoped: false, tables: [], hasProfilePredicate: false, op: null }

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
    return { isScoped: false, tables: [], hasProfilePredicate: false, op }
  }

  const tables = []
  const tableRegex = /\b(FROM|JOIN|INTO|UPDATE)\s+(?:ONLY\s+)?["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?/g
  let m
  while ((m = tableRegex.exec(upper)) !== null) {
    const tbl = m[2].toLowerCase()
    if (PROFILE_SCOPED_TABLES.has(tbl) && !tables.includes(tbl)) {
      tables.push(tbl)
    }
  }

  if (tables.length === 0) {
    return { isScoped: false, tables: [], hasProfilePredicate: false, op }
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

  return { isScoped: true, tables, hasProfilePredicate, op }
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
  if (!analysis.isScoped) return sql
  if (analysis.hasProfilePredicate) return sql

  // Strict mode fires when a profile is actually claimed. Otherwise the request
  // is a system/boot/admin path and should be logged (not blocked). Warn-only
  // mode exists as a short-lived deployment escape hatch, not the default.
  const hasClaim = Boolean(ctx.profileId)
  const mode = String(process.env.PROFILE_SCOPE_MODE || '').trim().toLowerCase()
  const legacyStrict = String(process.env.PROFILE_SCOPE_STRICT || '').trim().toLowerCase()
  const warnOnly = mode === 'warn' || mode === 'warning' || legacyStrict === '0' || legacyStrict === 'false'
  const strict = hasClaim && !warnOnly

  const detail = {
    tables: analysis.tables,
    op: analysis.op,
    sql: String(sql).slice(0, 400),
    profileId: ctx.profileId || null,
    userId: ctx.userId || null,
    route: opts.route || ctx.route || null,
  }

  if (strict) {
    throw new ProfileScopeError(
      `Profile-scoped ${analysis.op} on [${analysis.tables.join(', ')}] without profile_id predicate`,
      detail,
    )
  }

  // Soft-warn: keep a running count on the context so diagnostics can report.
  ctx.profileBleed = (ctx.profileBleed || 0) + 1
  ctx.profileBleedSamples = (ctx.profileBleedSamples || [])
  if (ctx.profileBleedSamples.length < 20) ctx.profileBleedSamples.push(detail)

  try {
    // Soft emit so the existing audit log pipeline sees it.
     
    console.warn('[profile_bleed] unscoped SQL', JSON.stringify(detail))
  } catch {
    /* noop */
  }
  return sql
}

export default {
  PROFILE_SCOPED_TABLES,
  ProfileScopeError,
  runProfileContext,
  getProfileContext,
  analyzeProfileScope,
  assertProfileScopedSql,
}

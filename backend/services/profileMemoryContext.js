/**
 * Canonical read projection for reusable profile memory.
 *
 * Consumers must use this projection instead of reading the memory tables
 * directly. It exposes only the current revision of active, non-expired,
 * non-redacted entries and always scopes the read to one exact profile.
 */

export const PROFILE_MEMORY_CONTEXT_CONTRACT = Object.freeze({
  version: 'profile-memory-context-v1',
  scope: 'One exact profile; organization membership never widens the read.',
  currency: 'Only the current revision of active, non-expired entries is returned.',
  privacy: 'Redacted payloads are never projected.',
})

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 250

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return fallback
  }
}

function normalizeAt(value) {
  const at = value instanceof Date ? value : new Date(value ?? Date.now())
  if (!Number.isFinite(at.getTime())) throw new TypeError('at must be a valid date')
  return at
}

function normalizeLimit(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_LIMIT
  return Math.max(1, Math.min(Math.trunc(numeric), MAX_LIMIT))
}

function isRedacted(value) {
  return value === true || Number(value) === 1 || String(value).toLowerCase() === 'true'
}

function isExpired(row, at) {
  if (row.retention_policy !== 'until_date') return false
  const until = new Date(row.retention_until)
  // A malformed expiry cannot be proven current, so keep it out of reusable
  // context even if a permissive SQLite text comparison returned the row.
  return !Number.isFinite(until.getTime()) || until.getTime() <= at.getTime()
}

function projectRow(row) {
  return {
    id: row.id,
    profile_id: row.profile_id,
    organization_id: row.organization_id ?? null,
    memory_key: row.memory_key,
    kind: row.kind,
    title: row.title,
    value: parseJson(row.value_json, null),
    current_revision: Number(row.current_revision),
    revision_id: row.revision_id,
    source: {
      kind: row.source_kind,
      ref: row.source_ref ?? null,
      provenance: parseJson(row.provenance_json, {}),
    },
    retention_policy: row.retention_policy,
    retention_until: row.retention_until ?? null,
    revision_created_at: row.revision_created_at,
    updated_at: row.updated_at,
  }
}

export async function loadActiveProfileMemoryContext(db, {
  profileId,
  at = new Date(),
  limit = DEFAULT_LIMIT,
} = {}) {
  const normalizedProfileId = String(profileId ?? '').trim()
  if (!normalizedProfileId) throw new TypeError('profileId is required')
  const normalizedAt = normalizeAt(at)
  const boundedLimit = normalizeLimit(limit)
  const notRedacted = db?.dialect === 'postgres' ? false : 0

  const rows = await db.prepare(
    `SELECT e.id, e.profile_id, e.organization_id, e.memory_key, e.kind,
            e.title, e.retention_policy, e.retention_until,
            e.current_revision, e.updated_at,
            r.id AS revision_id, r.value_json, r.source_kind, r.source_ref,
            r.provenance_json, r.payload_redacted,
            r.created_at AS revision_created_at
       FROM profile_memory_entries e
       JOIN profile_memory_revisions r
         ON r.entry_id = e.id AND r.revision_number = e.current_revision
      WHERE e.profile_id = ?
        AND e.status = 'active'
        AND (
          e.retention_policy <> 'until_date'
          OR e.retention_until IS NULL
          OR e.retention_until > ?
        )
        AND r.payload_redacted = ?
      ORDER BY e.memory_key ASC, e.id ASC
      LIMIT ?`,
  ).all(normalizedProfileId, normalizedAt.toISOString(), notRedacted, boundedLimit)

  // The SQL predicates are authoritative. These checks are defense in depth
  // for malformed legacy rows and test doubles that do not execute SQL.
  return (rows ?? [])
    .filter((row) => row?.profile_id === normalizedProfileId)
    .filter((row) => !isRedacted(row.payload_redacted) && !isExpired(row, normalizedAt))
    .map(projectRow)
}

export default {
  loadActiveProfileMemoryContext,
}

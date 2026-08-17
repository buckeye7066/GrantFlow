/**
 * Canonical durable memory store for applicant profiles and their linked
 * organizations. Every content change appends a revision. An erasure keeps
 * only content-free revision metadata, so "durable history" never defeats a
 * user's deletion request.
 */
import crypto from 'crypto'

export const PROFILE_MEMORY_KINDS = Object.freeze([
  'fact',
  'preference',
  'outcome',
  'relationship',
  'narrative',
])
export const PROFILE_MEMORY_RETENTION_POLICIES = Object.freeze([
  'profile_lifetime',
  'until_date',
  'legal_hold',
])
export const PROFILE_MEMORY_SOURCE_KINDS = Object.freeze(['user', 'document', 'import', 'system'])

export const PROFILE_MEMORY_CONTRACT = Object.freeze({
  version: 'profile-memory-v1',
  purpose: 'Reuse applicant and organization facts in discovery, drafting, and lifecycle work.',
  revision_policy: 'Every create and edit appends a numbered revision; in-place content edits are forbidden.',
  deletion_policy:
    'Deletion redacts every stored value and provenance payload, then appends a content-free tombstone revision.',
  retention_governance:
    'Only an administrator verified from users.is_admin may create, change, or release a non-default retention policy.',
  profile_deletion:
    'Profile deletion must first pass the memory retention check. Foreign-key cascade removes the redacted audit chain.',
  policies: {
    profile_lifetime: 'May be erased by the profile owner and is removed with the profile.',
    until_date: 'Cannot be erased before retention_until; it is eligible for expiry on or after that date.',
    legal_hold: 'Cannot be erased until an authorized legal-hold workflow releases it.',
  },
})

const MAX_VALUE_BYTES = 100_000
const MAX_PROVENANCE_BYTES = 20_000

export class ProfileMemoryError extends Error {
  constructor(code, message, details = null) {
    super(message)
    this.name = 'ProfileMemoryError'
    this.code = code
    this.details = details
  }
}

export function isProfileMemorySchemaUnavailableError(error) {
  const code = String(error?.code ?? '').toUpperCase()
  const message = String(error?.message ?? error ?? '')
  return code === '42P01' || /no such table:\s*profile_memory_|relation ["']?profile_memory_.*does not exist/i.test(message)
}

function assertNonEmptyString(value, field, maxLength) {
  const normalized = String(value ?? '').trim()
  if (!normalized) throw new ProfileMemoryError('MEMORY_VALIDATION', `${field} is required`)
  if (normalized.length > maxLength) {
    throw new ProfileMemoryError('MEMORY_VALIDATION', `${field} must be ${maxLength} characters or fewer`)
  }
  return normalized
}

function normalizeMemoryKey(value) {
  const key = assertNonEmptyString(value, 'memory_key', 120).toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(key)) {
    throw new ProfileMemoryError(
      'MEMORY_VALIDATION',
      'memory_key may contain lowercase letters, numbers, periods, underscores, and hyphens',
    )
  }
  return key
}

function assertEnum(value, field, allowed, fallback = null) {
  const normalized = String(value ?? fallback ?? '').trim().toLowerCase()
  if (!allowed.includes(normalized)) {
    throw new ProfileMemoryError('MEMORY_VALIDATION', `${field} must be one of: ${allowed.join(', ')}`)
  }
  return normalized
}

function jsonString(value, field, maxBytes) {
  if (value === undefined) throw new ProfileMemoryError('MEMORY_VALIDATION', `${field} is required`)
  let encoded
  try {
    encoded = JSON.stringify(value)
  } catch {
    throw new ProfileMemoryError('MEMORY_VALIDATION', `${field} must be JSON serializable`)
  }
  if (encoded === undefined) {
    throw new ProfileMemoryError('MEMORY_VALIDATION', `${field} must be JSON serializable`)
  }
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) {
    throw new ProfileMemoryError('MEMORY_VALIDATION', `${field} exceeds the ${maxBytes}-byte limit`)
  }
  return encoded
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return fallback
  }
}

// pg receives JSON payloads as strings through normalizePostgresParams. Make
// the target type explicit so INSERT/UPDATE parameter inference is identical
// across pg versions; SQLite keeps its ordinary positional placeholder.
function jsonPlaceholder(db) {
  return db?.dialect === 'postgres' ? 'CAST(? AS JSONB)' : '?'
}

function normalizeIsoDate(value, field) {
  if (value === null || value === undefined || value === '') return null
  const parsed = new Date(String(value))
  if (!Number.isFinite(parsed.getTime())) {
    throw new ProfileMemoryError('MEMORY_VALIDATION', `${field} must be a valid date`)
  }
  return parsed.toISOString()
}

function normalizeRetention(
  { retentionPolicy, retentionUntil, legalHoldReason },
  { actorIsAdmin = false } = {},
) {
  const policy = assertEnum(
    retentionPolicy,
    'retention_policy',
    PROFILE_MEMORY_RETENTION_POLICIES,
    'profile_lifetime',
  )
  const until = normalizeIsoDate(retentionUntil, 'retention_until')
  const holdReason = legalHoldReason === null || legalHoldReason === undefined
    ? null
    : assertNonEmptyString(legalHoldReason, 'legal_hold_reason', 500)

  if (policy === 'until_date' && !until) {
    throw new ProfileMemoryError('MEMORY_VALIDATION', 'retention_until is required for until_date')
  }
  if (policy === 'legal_hold' && !holdReason) {
    throw new ProfileMemoryError('MEMORY_VALIDATION', 'legal_hold_reason is required for legal_hold')
  }
  if (policy !== 'profile_lifetime' && !actorIsAdmin) {
    throw new ProfileMemoryError(
      'MEMORY_ADMIN_REQUIRED',
      'Only a database-verified administrator may set a retention policy',
    )
  }
  return {
    policy,
    until: policy === 'until_date' ? until : null,
    holdReason: policy === 'legal_hold' ? holdReason : null,
  }
}

function hydrateRevision(row) {
  if (!row) return null
  const redacted = row.payload_redacted === true || Number(row.payload_redacted) === 1
  return {
    id: row.revision_id ?? row.id,
    revision_number: Number(row.revision_number),
    title: row.revision_title ?? row.title,
    kind: row.revision_kind ?? row.kind,
    value: redacted ? null : parseJson(row.value_json, null),
    source_kind: row.source_kind,
    source_ref: redacted ? null : row.source_ref,
    provenance: redacted ? { redacted: true } : parseJson(row.provenance_json, {}),
    change_kind: row.change_kind,
    payload_redacted: redacted,
    created_by_user_id: row.revision_created_by_user_id ?? row.created_by_user_id ?? null,
    created_at: row.revision_created_at ?? row.created_at,
  }
}

function hydrateEntry(row) {
  if (!row) return null
  return {
    id: row.id,
    profile_id: row.profile_id,
    organization_id: row.organization_id ?? null,
    memory_key: row.memory_key,
    kind: row.kind,
    title: row.title,
    status: row.status,
    retention_policy: row.retention_policy,
    retention_until: row.retention_until ?? null,
    legal_hold_reason: row.legal_hold_reason ?? null,
    current_revision: Number(row.current_revision),
    value: hydrateRevision({
      ...row,
      id: row.current_revision_id,
      revision_id: row.current_revision_id,
      revision_number: row.current_revision,
      revision_title: row.title,
      revision_kind: row.kind,
      created_at: row.current_revision_created_at,
      revision_created_at: row.current_revision_created_at,
      created_by_user_id: row.current_revision_created_by_user_id,
      revision_created_by_user_id: row.current_revision_created_by_user_id,
    })?.value ?? null,
    source: row.current_revision_id
      ? {
          kind: row.source_kind,
          ref: row.payload_redacted ? null : row.source_ref ?? null,
          provenance: row.payload_redacted ? { redacted: true } : parseJson(row.provenance_json, {}),
        }
      : null,
    created_by_user_id: row.created_by_user_id ?? null,
    updated_by_user_id: row.updated_by_user_id ?? null,
    deleted_by_user_id: row.deleted_by_user_id ?? null,
    deletion_reason: row.deletion_reason ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at ?? null,
  }
}

const ENTRY_WITH_CURRENT_REVISION_SQL = `
  SELECT e.*,
         r.id AS current_revision_id,
         r.value_json,
         r.source_kind,
         r.source_ref,
         r.provenance_json,
         r.change_kind,
         r.payload_redacted,
         r.created_by_user_id AS current_revision_created_by_user_id,
         r.created_at AS current_revision_created_at
    FROM profile_memory_entries e
    JOIN profile_memory_revisions r
      ON r.entry_id = e.id AND r.revision_number = e.current_revision
`

async function withTransaction(db, work) {
  if (typeof db?.withTransaction === 'function') return db.withTransaction(work)
  return work(db)
}

function retentionBlock(row, at = new Date()) {
  if (row.retention_policy === 'legal_hold') {
    return { reason: 'legal_hold', until: null, detail: row.legal_hold_reason ?? null }
  }
  if (row.retention_policy === 'until_date' && row.retention_until) {
    const until = new Date(row.retention_until)
    if (Number.isFinite(until.getTime()) && until.getTime() > at.getTime()) {
      return { reason: 'until_date', until: until.toISOString(), detail: null }
    }
  }
  return null
}

export async function getProfileMemoryEntry(db, { profileId, entryId }) {
  const row = await db
    .prepare(`${ENTRY_WITH_CURRENT_REVISION_SQL} WHERE e.id = ? AND e.profile_id = ?`)
    .get(String(entryId), String(profileId))
  return hydrateEntry(row)
}

export async function listProfileMemory(db, { profileId, includeDeleted = false, limit = 100 } = {}) {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 250))
  const rows = await db
    .prepare(
      `${ENTRY_WITH_CURRENT_REVISION_SQL}
       WHERE e.profile_id = ? ${includeDeleted ? '' : "AND e.status = 'active'"}
       ORDER BY e.updated_at DESC, e.id ASC
       LIMIT ?`,
    )
    .all(String(profileId), boundedLimit)
  return (rows ?? []).map(hydrateEntry)
}

export async function listProfileMemoryRevisions(db, { profileId, entryId, limit = 100 } = {}) {
  const entry = await db
    .prepare('SELECT id FROM profile_memory_entries WHERE id = ? AND profile_id = ?')
    .get(String(entryId), String(profileId))
  if (!entry) return null
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 250))
  const rows = await db
    .prepare(
      `SELECT * FROM profile_memory_revisions
        WHERE entry_id = ?
        ORDER BY revision_number DESC
        LIMIT ?`,
    )
    .all(String(entryId), boundedLimit)
  return (rows ?? []).map(hydrateRevision)
}

export async function createProfileMemory(db, input) {
  const profileId = assertNonEmptyString(input?.profileId, 'profile_id', 200)
  const memoryKey = normalizeMemoryKey(input?.memoryKey)
  const title = assertNonEmptyString(input?.title, 'title', 200)
  const kind = assertEnum(input?.kind, 'kind', PROFILE_MEMORY_KINDS, 'fact')
  const sourceKind = assertEnum(input?.sourceKind, 'source_kind', PROFILE_MEMORY_SOURCE_KINDS, 'user')
  const sourceRef = input?.sourceRef === null || input?.sourceRef === undefined
    ? null
    : assertNonEmptyString(input.sourceRef, 'source_ref', 1000)
  const valueJson = jsonString(input?.value, 'value', MAX_VALUE_BYTES)
  const provenanceJson = jsonString(input?.provenance ?? {}, 'provenance', MAX_PROVENANCE_BYTES)
  const retention = normalizeRetention(input ?? {}, {
    actorIsAdmin: input?.actorIsAdmin === true,
  })
  const actorUserId = input?.actorUserId ? String(input.actorUserId) : null
  const entryId = crypto.randomUUID()
  const revisionId = crypto.randomUUID()

  await withTransaction(db, async (tx) => {
    const profile = await tx
      .prepare("SELECT id, organization_id FROM profiles WHERE id = ? AND COALESCE(status, 'active') <> 'deleted'")
      .get(profileId)
    if (!profile) throw new ProfileMemoryError('MEMORY_PROFILE_NOT_FOUND', 'Profile not found')

    const duplicate = await tx
      .prepare("SELECT id FROM profile_memory_entries WHERE profile_id = ? AND memory_key = ? AND status = 'active'")
      .get(profileId, memoryKey)
    if (duplicate) {
      throw new ProfileMemoryError('MEMORY_KEY_CONFLICT', 'An active memory entry already uses this memory_key', {
        entry_id: duplicate.id,
      })
    }

    await tx
      .prepare(
        `INSERT INTO profile_memory_entries (
           id, profile_id, organization_id, memory_key, kind, title, status,
           retention_policy, retention_until, legal_hold_reason, current_revision,
           created_by_user_id, updated_by_user_id
         ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        entryId,
        profileId,
        profile.organization_id ?? null,
        memoryKey,
        kind,
        title,
        retention.policy,
        retention.until,
        retention.holdReason,
        actorUserId,
        actorUserId,
      )
    await tx
      .prepare(
        `INSERT INTO profile_memory_revisions (
           id, entry_id, revision_number, title, kind, value_json, source_kind,
           source_ref, provenance_json, change_kind, payload_redacted, created_by_user_id
         ) VALUES (?, ?, 1, ?, ?, ${jsonPlaceholder(tx)}, ?, ?, ${jsonPlaceholder(tx)}, 'create', ?, ?)`,
      )
      .run(
        revisionId,
        entryId,
        title,
        kind,
        valueJson,
        sourceKind,
        sourceRef,
        provenanceJson,
        tx?.dialect === 'postgres' ? false : 0,
        actorUserId,
      )
  })

  return getProfileMemoryEntry(db, { profileId, entryId })
}

export async function reviseProfileMemory(db, input) {
  const profileId = assertNonEmptyString(input?.profileId, 'profile_id', 200)
  const entryId = assertNonEmptyString(input?.entryId, 'entry_id', 200)
  const actorUserId = input?.actorUserId ? String(input.actorUserId) : null

  await withTransaction(db, async (tx) => {
    const existing = await tx
      .prepare('SELECT * FROM profile_memory_entries WHERE id = ? AND profile_id = ?')
      .get(entryId, profileId)
    if (!existing || existing.status !== 'active') {
      throw new ProfileMemoryError('MEMORY_NOT_FOUND', 'Active memory entry not found')
    }

    const title = input?.title === undefined
      ? existing.title
      : assertNonEmptyString(input.title, 'title', 200)
    const kind = input?.kind === undefined
      ? existing.kind
      : assertEnum(input.kind, 'kind', PROFILE_MEMORY_KINDS)
    const sourceKind = assertEnum(input?.sourceKind, 'source_kind', PROFILE_MEMORY_SOURCE_KINDS, 'user')
    const sourceRef = input?.sourceRef === null || input?.sourceRef === undefined
      ? null
      : assertNonEmptyString(input.sourceRef, 'source_ref', 1000)
    const valueJson = jsonString(input?.value, 'value', MAX_VALUE_BYTES)
    const provenanceJson = jsonString(input?.provenance ?? {}, 'provenance', MAX_PROVENANCE_BYTES)
    const nextRevision = Number(existing.current_revision) + 1

    await tx
      .prepare(
        `INSERT INTO profile_memory_revisions (
           id, entry_id, revision_number, title, kind, value_json, source_kind,
           source_ref, provenance_json, change_kind, payload_redacted, created_by_user_id
         ) VALUES (?, ?, ?, ?, ?, ${jsonPlaceholder(tx)}, ?, ?, ${jsonPlaceholder(tx)}, 'update', ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        entryId,
        nextRevision,
        title,
        kind,
        valueJson,
        sourceKind,
        sourceRef,
        provenanceJson,
        tx?.dialect === 'postgres' ? false : 0,
        actorUserId,
      )
    await tx
      .prepare(
        `UPDATE profile_memory_entries
            SET title = ?, kind = ?, current_revision = ?, updated_by_user_id = ?,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND profile_id = ? AND status = 'active'`,
      )
      .run(title, kind, nextRevision, actorUserId, entryId, profileId)
  })

  return getProfileMemoryEntry(db, { profileId, entryId })
}

export async function setProfileMemoryRetention(db, input) {
  const profileId = assertNonEmptyString(input?.profileId, 'profile_id', 200)
  const entryId = assertNonEmptyString(input?.entryId, 'entry_id', 200)
  const actorUserId = input?.actorUserId ? String(input.actorUserId) : null
  const actorIsAdmin = input?.actorIsAdmin === true
  const retention = normalizeRetention(input ?? {}, { actorIsAdmin })

  await withTransaction(db, async (tx) => {
    const existing = await tx
      .prepare('SELECT * FROM profile_memory_entries WHERE id = ? AND profile_id = ?')
      .get(entryId, profileId)
    if (!existing || existing.status !== 'active') {
      throw new ProfileMemoryError('MEMORY_NOT_FOUND', 'Active memory entry not found')
    }
    if (!actorIsAdmin) {
      throw new ProfileMemoryError(
        'MEMORY_ADMIN_REQUIRED',
        'Only a database-verified administrator may change or release a retention policy',
      )
    }

    const samePolicy = existing.retention_policy === retention.policy
    const sameUntil = String(existing.retention_until ?? '') === String(retention.until ?? '')
    const sameReason = String(existing.legal_hold_reason ?? '') === String(retention.holdReason ?? '')
    if (samePolicy && sameUntil && sameReason) return

    const current = await tx
      .prepare(
        `SELECT * FROM profile_memory_revisions
          WHERE entry_id = ? AND revision_number = ?`,
      )
      .get(entryId, Number(existing.current_revision))
    if (!current) throw new ProfileMemoryError('MEMORY_NOT_FOUND', 'Current memory revision not found')

    const nextRevision = Number(existing.current_revision) + 1
    const provenance = {
      ...parseJson(current.provenance_json, {}),
      retention_change: {
        from: existing.retention_policy,
        to: retention.policy,
        changed_at: new Date().toISOString(),
      },
    }
    await tx
      .prepare(
        `INSERT INTO profile_memory_revisions (
           id, entry_id, revision_number, title, kind, value_json, source_kind,
           source_ref, provenance_json, change_kind, payload_redacted, created_by_user_id
         ) VALUES (?, ?, ?, ?, ?, ${jsonPlaceholder(tx)}, ?, ?, ${jsonPlaceholder(tx)}, 'retention', ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        entryId,
        nextRevision,
        existing.title,
        existing.kind,
        typeof current.value_json === 'string' ? current.value_json : JSON.stringify(current.value_json ?? {}),
        current.source_kind,
        current.source_ref ?? null,
        jsonString(provenance, 'provenance', MAX_PROVENANCE_BYTES),
        current.payload_redacted,
        actorUserId,
      )
    await tx
      .prepare(
        `UPDATE profile_memory_entries
            SET retention_policy = ?, retention_until = ?, legal_hold_reason = ?,
                current_revision = ?, updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND profile_id = ? AND status = 'active'`,
      )
      .run(
        retention.policy,
        retention.until,
        retention.holdReason,
        nextRevision,
        actorUserId,
        entryId,
        profileId,
      )
  })

  return getProfileMemoryEntry(db, { profileId, entryId })
}

export async function deleteProfileMemoryEntry(db, input) {
  const profileId = assertNonEmptyString(input?.profileId, 'profile_id', 200)
  const entryId = assertNonEmptyString(input?.entryId, 'entry_id', 200)
  const actorUserId = input?.actorUserId ? String(input.actorUserId) : null
  const requestedReason = assertNonEmptyString(input?.reason ?? 'user_requested', 'reason', 500)
  // Deletion metadata must remain content-free too. Preserve only the two
  // operational reason codes used by the retention/profile-deletion paths;
  // arbitrary user text could itself contain the PII being erased.
  const reason = input?.expired
    ? 'retention_period_elapsed'
    : requestedReason === 'profile_deleted'
      ? 'profile_deleted'
      : 'user_requested'
  const changeKind = input?.expired ? 'expire' : 'delete'
  const nextStatus = input?.expired ? 'expired' : 'deleted'
  const at = input?.at ? new Date(input.at) : new Date()
  if (!Number.isFinite(at.getTime())) throw new ProfileMemoryError('MEMORY_VALIDATION', 'at must be a valid date')
  if (input?.actorIsAdmin !== true && input?.actorIsOwner !== true && input?.systemAuthorized !== true) {
    throw new ProfileMemoryError('MEMORY_OWNER_REQUIRED', 'Only the profile owner or an administrator may erase memory')
  }

  await withTransaction(db, async (tx) => {
    const existing = await tx
      .prepare('SELECT * FROM profile_memory_entries WHERE id = ? AND profile_id = ?')
      .get(entryId, profileId)
    if (!existing || existing.status !== 'active') {
      throw new ProfileMemoryError('MEMORY_NOT_FOUND', 'Active memory entry not found')
    }
    const block = retentionBlock(existing, at)
    if (block && !(input?.expired && block.reason === 'until_date' && block.until <= at.toISOString())) {
      throw new ProfileMemoryError('MEMORY_RETENTION_HOLD', 'Memory entry cannot be erased under its retention policy', {
        entry_id: entryId,
        ...block,
      })
    }

    const redactedFlag = tx?.dialect === 'postgres' ? true : 1
    const tombstoneTitle = 'Deleted memory'
    const tombstoneKind = 'fact'
    const tombstoneKey = `deleted-${entryId}`.toLowerCase().slice(0, 120)
    await tx
      .prepare(
        `UPDATE profile_memory_revisions
            SET title = ?, kind = ?, value_json = ${jsonPlaceholder(tx)},
                source_kind = 'system', source_ref = NULL,
                provenance_json = ${jsonPlaceholder(tx)}, payload_redacted = ?
          WHERE entry_id = ?`,
      )
      .run(tombstoneTitle, tombstoneKind, '{}', '{"redacted":true}', redactedFlag, entryId)

    const nextRevision = Number(existing.current_revision) + 1
    await tx
      .prepare(
        `INSERT INTO profile_memory_revisions (
           id, entry_id, revision_number, title, kind, value_json, source_kind,
           source_ref, provenance_json, change_kind, payload_redacted, created_by_user_id
         ) VALUES (?, ?, ?, ?, ?, ${jsonPlaceholder(tx)}, 'system', NULL,
                   ${jsonPlaceholder(tx)}, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        entryId,
        nextRevision,
        tombstoneTitle,
        tombstoneKind,
        '{}',
        '{"redacted":true}',
        changeKind,
        redactedFlag,
        actorUserId,
      )
    await tx
      .prepare(
        `UPDATE profile_memory_entries
            SET memory_key = ?, title = ?, kind = ?, status = ?,
                retention_policy = 'profile_lifetime', retention_until = NULL, legal_hold_reason = NULL,
                current_revision = ?, deleted_at = ?, deleted_by_user_id = ?, deletion_reason = ?,
                updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND profile_id = ?`,
      )
      .run(
        tombstoneKey,
        tombstoneTitle,
        tombstoneKind,
        nextStatus,
        nextRevision,
        at.toISOString(),
        actorUserId,
        reason,
        actorUserId,
        entryId,
        profileId,
      )
  })

  return getProfileMemoryEntry(db, { profileId, entryId })
}

export async function getProfileMemoryDeletionReadiness(db, { profileId, at = new Date() }) {
  const effectiveAt = at instanceof Date ? at : new Date(at)
  if (!Number.isFinite(effectiveAt.getTime())) {
    throw new ProfileMemoryError('MEMORY_VALIDATION', 'at must be a valid date')
  }
  const rows = await db
    .prepare(
      `SELECT id, memory_key, title, retention_policy, retention_until, legal_hold_reason
         FROM profile_memory_entries
        WHERE profile_id = ? AND status = 'active'
        ORDER BY created_at ASC`,
    )
    .all(String(profileId))
  const blocks = (rows ?? [])
    .map((row) => ({ row, block: retentionBlock(row, effectiveAt) }))
    .filter(({ block }) => Boolean(block))
    .map(({ row, block }) => ({
      entry_id: row.id,
      memory_key: row.memory_key,
      title: row.title,
      ...block,
    }))
  return {
    profile_id: String(profileId),
    checked_at: effectiveAt.toISOString(),
    can_delete: blocks.length === 0,
    active_entries: (rows ?? []).length,
    blocks,
    contract_version: PROFILE_MEMORY_CONTRACT.version,
  }
}

export async function redactProfileMemoryForProfile(
  db,
  {
    profileId,
    actorUserId = null,
    actorIsAdmin = false,
    actorIsOwner = false,
    reason = 'profile_deleted',
  },
) {
  let readiness
  try {
    readiness = await getProfileMemoryDeletionReadiness(db, { profileId })
  } catch (error) {
    // Rolling deploy safety: old databases cannot contain memory rows before
    // migration 170/0175 exists. Treat that exact missing-table state as an
    // empty store; all other schema/write errors fail closed.
    if (isProfileMemorySchemaUnavailableError(error)) {
      return {
        profile_id: String(profileId),
        redacted: 0,
        skipped: 'schema_unavailable',
        contract_version: PROFILE_MEMORY_CONTRACT.version,
      }
    }
    throw error
  }
  if (!readiness.can_delete) {
    throw new ProfileMemoryError('MEMORY_RETENTION_HOLD', 'Profile memory retention blocks profile deletion', readiness)
  }
  const active = await db
    .prepare("SELECT id FROM profile_memory_entries WHERE profile_id = ? AND status = 'active' ORDER BY created_at ASC")
    .all(String(profileId))
  for (const row of active ?? []) {
    await deleteProfileMemoryEntry(db, {
      profileId,
      entryId: row.id,
      actorUserId,
      actorIsAdmin,
      actorIsOwner,
      reason,
    })
  }
  return { profile_id: String(profileId), redacted: (active ?? []).length, contract_version: PROFILE_MEMORY_CONTRACT.version }
}

export async function expireDueProfileMemory(db, { at = new Date(), limit = 100, actorUserId = 'system:retention' } = {}) {
  const effectiveAt = at instanceof Date ? at : new Date(at)
  if (!Number.isFinite(effectiveAt.getTime())) {
    throw new ProfileMemoryError('MEMORY_VALIDATION', 'at must be a valid date')
  }
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 500))
  const rows = await db
    .prepare(
      `SELECT id, profile_id
         FROM profile_memory_entries
        WHERE status = 'active'
          AND retention_policy = 'until_date'
          AND retention_until IS NOT NULL
          AND retention_until <= ?
        ORDER BY retention_until ASC, id ASC
        LIMIT ?`,
    )
    .all(effectiveAt.toISOString(), boundedLimit)
  const expired = []
  for (const row of rows ?? []) {
    await deleteProfileMemoryEntry(db, {
      profileId: row.profile_id,
      entryId: row.id,
      actorUserId,
      reason: 'retention_period_elapsed',
      expired: true,
      at: effectiveAt,
      systemAuthorized: true,
    })
    expired.push(row.id)
  }
  return { checked_at: effectiveAt.toISOString(), expired }
}

export default {
  createProfileMemory,
  reviseProfileMemory,
  setProfileMemoryRetention,
  deleteProfileMemoryEntry,
  getProfileMemoryEntry,
  listProfileMemory,
  listProfileMemoryRevisions,
  getProfileMemoryDeletionReadiness,
  redactProfileMemoryForProfile,
  expireDueProfileMemory,
}

/**
 * tailoredApplicationStore.js — persistence for Hamilton's per-funder
 * tailored-application records.
 *
 * ONE record per (profile × pipeline grant / portal card). It carries the
 * funding-source-specific application narrative Hamilton drafted (reworded to
 * an MBA level, tailored to what THAT funder asks for, grounded strictly in the
 * profile's essays/mission/facts), the review state (pending → approved/edited),
 * the funder requirements Hamilton extracted, and any missing questions the
 * applicant must answer before the card can be submitted.
 *
 * The auto-submit gate (see tailoredNarrative.evaluateAutoSubmitGate) consults
 * this row as the single choke point before Hamilton submits a card. Portal
 * cards key on `grant_id` (grants = the pipeline/portal card table), so the
 * UNIQUE constraint is (profile_id, grant_id).
 *
 * Dialect-aware (sqlite for local/test, postgres in prod). The table DDL is
 * shared with the schema-invariant self-heal step so a boot always re-asserts
 * the shape regardless of whether the numbered migration applied.
 */

import crypto from 'node:crypto'

export const TAILORED_APPLICATION_STATUSES = Object.freeze(['pending', 'approved', 'edited'])

/**
 * Idempotent DDL for the tailored_applications table. Shared verbatim by:
 *   - backend/db/schema.sql (sqlite base schema),
 *   - the numbered migrations (sqlite + postgres), and
 *   - ensureSchemaInvariants (boot self-heal).
 */
export function tailoredApplicationsDdl({ isPg = false } = {}) {
  const ts = isPg ? 'TIMESTAMPTZ DEFAULT now()' : 'DATETIME DEFAULT CURRENT_TIMESTAMP'
  const tsNull = isPg ? 'TIMESTAMPTZ' : 'DATETIME'
  return `
    CREATE TABLE IF NOT EXISTS tailored_applications (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      grant_id TEXT,
      opportunity_id TEXT,
      fields_json TEXT,
      status TEXT DEFAULT 'pending',
      approved_by TEXT,
      approved_at ${tsNull},
      missing_questions_json TEXT,
      funder_requirements_json TEXT,
      generated_from_hash TEXT,
      matcher_version TEXT,
      generator_version TEXT,
      created_at ${ts},
      updated_at ${ts},
      UNIQUE(profile_id, grant_id)
    );
  `
}

/**
 * Create the table + supporting index on a live db (both dialects). Safe to
 * re-run. Never throws — returns false on failure so callers can degrade.
 */
export async function ensureTailoredApplicationsTable(db) {
  if (!db) return false
  const isPg = db.dialect === 'postgres'
  try {
    await db.exec(tailoredApplicationsDdl({ isPg }))
    await db.exec(
      'CREATE INDEX IF NOT EXISTS idx_tailored_applications_profile ON tailored_applications(profile_id, grant_id)',
    )
    return true
  } catch {
    return false
  }
}

function nowIso() {
  return new Date().toISOString()
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}

/**
 * Shape a raw DB row into the canonical record consumers use — JSON columns
 * parsed, arrays/maps guaranteed.
 */
export function shapeTailoredApplication(row) {
  if (!row) return null
  return {
    id: row.id,
    profile_id: row.profile_id,
    grant_id: row.grant_id ?? null,
    opportunity_id: row.opportunity_id ?? null,
    fields: parseJson(row.fields_json, {}),
    status: row.status || 'pending',
    approved_by: row.approved_by ?? null,
    approved_at: row.approved_at ?? null,
    missing_questions: parseJson(row.missing_questions_json, []),
    funder_requirements: parseJson(row.funder_requirements_json, {}),
    generated_from_hash: row.generated_from_hash ?? null,
    matcher_version: row.matcher_version ?? null,
    generator_version: row.generator_version ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  }
}

/**
 * Fetch the tailored application for a (profile, grant) portal card.
 * @returns {Promise<object|null>} shaped record or null
 */
export async function getTailoredApplication(db, { profileId, grantId }) {
  if (!db || !profileId || !grantId) return null
  await ensureTailoredApplicationsTable(db)
  try {
    const row = await db
      .prepare('SELECT * FROM tailored_applications WHERE profile_id = ? AND grant_id = ? LIMIT 1')
      .get(String(profileId), String(grantId))
    return shapeTailoredApplication(row)
  } catch {
    return null
  }
}

/**
 * Insert or replace the tailored application for a (profile, grant). Generation
 * always writes status='pending' with a fresh hash; approval/edit go through
 * the dedicated helpers so the approver stamp is never lost.
 *
 * @returns {Promise<object>} shaped record
 */
export async function upsertTailoredApplication(db, {
  profileId,
  grantId,
  opportunityId = null,
  fields = {},
  status = 'pending',
  missingQuestions = [],
  funderRequirements = {},
  generatedFromHash = null,
  matcherVersion = null,
  generatorVersion = null,
}) {
  if (!db) throw new Error('db required')
  if (!profileId || !grantId) throw new Error('profileId and grantId required')
  await ensureTailoredApplicationsTable(db)

  const existing = await getTailoredApplication(db, { profileId, grantId })
  const fieldsJson = JSON.stringify(fields || {})
  const missingJson = JSON.stringify(Array.isArray(missingQuestions) ? missingQuestions : [])
  const reqJson = JSON.stringify(funderRequirements || {})
  const now = nowIso()

  if (existing) {
    await db
      .prepare(
        `UPDATE tailored_applications
            SET opportunity_id = ?, fields_json = ?, status = ?,
                approved_by = NULL, approved_at = NULL,
                missing_questions_json = ?, funder_requirements_json = ?,
                generated_from_hash = ?, matcher_version = ?, generator_version = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(
        opportunityId ? String(opportunityId) : null,
        fieldsJson, status, missingJson, reqJson,
        generatedFromHash, matcherVersion, generatorVersion, now,
        existing.id,
      )
    return getTailoredApplication(db, { profileId, grantId })
  }

  const id = crypto.randomUUID()
  await db
    .prepare(
      `INSERT INTO tailored_applications
         (id, profile_id, grant_id, opportunity_id, fields_json, status,
          missing_questions_json, funder_requirements_json, generated_from_hash,
          matcher_version, generator_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id, String(profileId), String(grantId), opportunityId ? String(opportunityId) : null,
      fieldsJson, status, missingJson, reqJson, generatedFromHash,
      matcherVersion, generatorVersion, now, now,
    )
  return getTailoredApplication(db, { profileId, grantId })
}

/**
 * Mark the record approved. Caller must have verified missing_questions is
 * empty (routes enforce this) — this is the persistence primitive only.
 */
export async function approveTailoredApplication(db, { profileId, grantId, approvedBy }) {
  if (!db || !profileId || !grantId) return null
  await ensureTailoredApplicationsTable(db)
  await db
    .prepare(
      `UPDATE tailored_applications
          SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ?
        WHERE profile_id = ? AND grant_id = ?`,
    )
    .run(approvedBy || null, nowIso(), nowIso(), String(profileId), String(grantId))
  return getTailoredApplication(db, { profileId, grantId })
}

/**
 * Save applicant/owner edits to the tailored text and mark the record
 * `edited` (= approved-as-edited). Merges the supplied field map over the
 * stored fields so a partial edit keeps the rest of the draft.
 */
export async function saveTailoredApplicationEdit(db, {
  profileId, grantId, fields = {}, approvedBy,
}) {
  if (!db || !profileId || !grantId) return null
  await ensureTailoredApplicationsTable(db)
  const existing = await getTailoredApplication(db, { profileId, grantId })
  if (!existing) return null
  const mergedFields = { ...(existing.fields || {}), ...(fields || {}) }
  await db
    .prepare(
      `UPDATE tailored_applications
          SET fields_json = ?, status = 'edited', approved_by = ?, approved_at = ?, updated_at = ?
        WHERE profile_id = ? AND grant_id = ?`,
    )
    .run(
      JSON.stringify(mergedFields), approvedBy || null, nowIso(), nowIso(),
      String(profileId), String(grantId),
    )
  return getTailoredApplication(db, { profileId, grantId })
}

/**
 * Force a record back to `pending` (used when the generation inputs changed —
 * essays/funder snapshot hash mismatch — so a stale approval can't ride an
 * outdated narrative into submission). Clears the approver stamp.
 */
export async function resetTailoredApplicationToPending(db, { profileId, grantId }) {
  if (!db || !profileId || !grantId) return null
  await ensureTailoredApplicationsTable(db)
  await db
    .prepare(
      `UPDATE tailored_applications
          SET status = 'pending', approved_by = NULL, approved_at = NULL, updated_at = ?
        WHERE profile_id = ? AND grant_id = ? AND status <> 'pending'`,
    )
    .run(nowIso(), String(profileId), String(grantId))
  return getTailoredApplication(db, { profileId, grantId })
}

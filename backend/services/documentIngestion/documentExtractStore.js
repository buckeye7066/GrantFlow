import crypto from 'node:crypto'

// The document_extracts.source_type CHECK constraint
// (document_extracts_source_type_check) only permits these values. This Set is
// the single application-code source of truth that MUST stay in lockstep with
// the CHECK in backend/db/schema.sql + migrations 016/0020. Any other detector
// output (e.g. 'html'/'url' from a web/URL import, or 'unknown' for an
// unrecognized mime) would violate the constraint and abort the insert.
//
// The constraint's intent is "which readable bucket did this extract come from",
// NOT an exhaustive mime taxonomy — so web/text-ish content legitimately belongs
// in the 'text' bucket (a stored extract is readable text by nature). We
// therefore REMAP (not widen the constraint) at this write choke point so no
// upstream code path can ever trip the constraint again.
export const ALLOWED_SOURCE_TYPES = Object.freeze(['docx', 'pdf', 'image', 'text'])
const ALLOWED_SOURCE_TYPE_SET = new Set(ALLOWED_SOURCE_TYPES)

// Sources that legitimately produce a readable-text extract and so map to 'text'
// rather than being rejected. URL/web imports arrive here as html/url/unknown.
const TEXT_BUCKET_SOURCE_TYPES = new Set(['html', 'htm', 'url', 'web', 'text', 'unknown', ''])

/**
 * Is `value` one of the exact values the CHECK constraint accepts? (NULL is
 * allowed by the constraint and is treated as valid here too.)
 */
export function isValidSourceType(value) {
  if (value === null || value === undefined || String(value).trim() === '') return true
  return ALLOWED_SOURCE_TYPE_SET.has(String(value).toLowerCase().trim())
}

/**
 * Validate a source_type BEFORE insert, throwing a friendly, non-leaky error for
 * a genuinely unmappable value. Web/text-ish values are mapped to 'text' (see
 * normalizeSourceType) rather than rejected, so this only ever throws for an
 * unexpected token — yielding a controlled error instead of a raw DB CHECK
 * violation. Returns the normalized, constraint-safe value.
 */
export function assertValidSourceType(value) {
  const normalized = normalizeSourceType(value)
  if (!isValidSourceType(normalized)) {
    // Friendly + non-leaky: never echoes the constraint name or SQL.
    throw new Error("Couldn't import or parse this source.")
  }
  return normalized
}

function normalizeSourceType(value) {
  // Preserve NULL: the CHECK constraint permits NULL, and callers hydrate the
  // real type later via COALESCE(source_type, ?). Only a NON-NULL invalid value
  // (e.g. 'html'/'url'/'unknown') trips the constraint — map those to 'text'.
  if (value === null || value === undefined || String(value).trim() === '') return null
  const v = String(value).toLowerCase().trim()
  if (ALLOWED_SOURCE_TYPE_SET.has(v)) return v
  // Web/text-ish or unrecognized: a stored extract is readable text by nature.
  if (TEXT_BUCKET_SOURCE_TYPES.has(v)) return 'text'
  // Anything else is also coerced to 'text' so we never trip the CHECK; the
  // caller that wants a hard rejection should use assertValidSourceType().
  return 'text'
}

export { normalizeSourceType }

function jsonOrNull(value) {
  if ((value === null || value === undefined)) return null
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

function isPostgres(db) {
  return String(db?.dialect || '').toLowerCase() === 'postgres'
}

export async function getDocumentExtract(db, documentId) {
  if (!documentId) return null
  const stmt = db.prepare('SELECT * FROM document_extracts WHERE document_id = ? LIMIT 1')
  return isPostgres(db) ? await stmt.get(documentId) : await Promise.resolve(stmt.get(documentId))
}

export async function ensureDocumentExtract(db, {
  documentId,
  sourceType = null,
  fileHash = null,
} = {}) {
  if (!documentId) throw new Error('documentId is required')
  // Validate against the CHECK-constraint allowed set BEFORE any insert so an
  // invalid source_type yields a controlled, friendly error instead of a raw
  // Postgres constraint violation leaking to the UI. Web/text-ish values are
  // remapped to 'text' here (not rejected).
  sourceType = assertValidSourceType(sourceType)
  if (!fileHash) {
    console.warn('[documentExtractStore] ensureDocumentExtract called without fileHash for document', documentId, '— hash-reuse will be unavailable')
  }

  const existing = await getDocumentExtract(db, documentId)
  if (existing) {
    // Best-effort: hydrate missing metadata (common when rows were created by older code paths).
    const shouldUpdate =
      (sourceType && !existing.source_type) || (fileHash && !existing.file_hash)
    if (shouldUpdate) {
      await db
        .prepare(
          `
            UPDATE document_extracts
            SET source_type = COALESCE(source_type, ?),
                file_hash = COALESCE(file_hash, ?),
                updated_at = ${isPostgres(db) ? 'NOW()' : 'CURRENT_TIMESTAMP'}
            WHERE document_id = ?
          `,
        )
        .run(sourceType, fileHash, documentId)
    }
    return getDocumentExtract(db, documentId)
  }

  const id = crypto.randomUUID()
  const pg = isPostgres(db)

  if (pg) {
    const stmt = db.prepare(
      `
        INSERT INTO document_extracts (
          id, document_id, status, source_type, methods_used, warnings, confidence, file_hash, ocr_used
        ) VALUES (
          ?, ?, 'pending', ?, '[]'::jsonb, '[]'::jsonb, 0.0, ?, false
        )
        ON CONFLICT (document_id) DO NOTHING
      `,
    )
    await stmt.run(id, documentId, sourceType, fileHash)
  } else {
    const stmt = db.prepare(
      `
        INSERT INTO document_extracts (
          id, document_id, status, source_type, methods_used, warnings, confidence, file_hash, ocr_used
        ) VALUES (
          ?, ?, 'pending', ?, '[]', '[]', 0.0, ?, 0
        )
        ON CONFLICT (document_id) DO NOTHING
      `,
    )
    await Promise.resolve(stmt.run(id, documentId, sourceType, fileHash))
  }

  return getDocumentExtract(db, documentId)
}

export async function markDocumentExtractProcessing(db, documentId, startedAtIso) {
  const pg = isPostgres(db)
  const started = startedAtIso || new Date().toISOString()
  if (pg) {
    await db.prepare(
      `
        UPDATE document_extracts
        SET status = 'processing',
            started_at = ?::timestamptz,
            updated_at = NOW()
        WHERE document_id = ?
      `,
    ).run(started, documentId)
  } else {
    await db.prepare(
      `
        UPDATE document_extracts
        SET status = 'processing',
            started_at = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE document_id = ?
      `,
    ).run(started, documentId)
  }
}

export async function markDocumentExtractFailed(db, documentId, {
  warnings = [],
  finishedAtIso,
} = {}) {
  const pg = isPostgres(db)
  const finished = finishedAtIso || new Date().toISOString()
  const warningsJson = jsonOrNull(Array.isArray(warnings) ? warnings : [String(warnings || '')]) || '[]'

  if (pg) {
    await db.prepare(
      `
        UPDATE document_extracts
        SET status = 'failed',
            warnings = ?::jsonb,
            finished_at = ?::timestamptz,
            updated_at = NOW()
        WHERE document_id = ?
      `,
    ).run(warningsJson, finished, documentId)
  } else {
    await db.prepare(
      `
        UPDATE document_extracts
        SET status = 'failed',
            warnings = ?,
            finished_at = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE document_id = ?
      `,
    ).run(warningsJson, finished, documentId)
  }
}

export async function saveDocumentExtractResult(db, documentId, result) {
  const pg = isPostgres(db)
  const meta = result?.meta || {}

  const methodsJson = jsonOrNull(meta.methods_used || []) || '[]'
  const warningsJson = jsonOrNull(meta.warnings || []) || '[]'
  const provenanceJson = jsonOrNull(meta.provenance || null)
  const finishedAt = meta.finished_at || new Date().toISOString()
  const startedAt = meta.started_at || null

  const charCount = Number(meta.char_count ?? 0) || 0
  const wordCount = Number(meta.word_count ?? 0) || 0
  const pages = (meta.pages === null || meta.pages === undefined) ? null : Number(meta.pages)
  const confidence = typeof result?.confidence === 'number' && Number.isFinite(result.confidence) ? result.confidence : 0.0
  const ocrUsed = Boolean(meta.ocr_used)

  const text = typeof result?.text === 'string' ? result.text : ''
  const ocrText = typeof result?.ocr_text === 'string' ? result.ocr_text : null

  if (pg) {
    await db.prepare(
      `
        UPDATE document_extracts
        SET status = 'ready',
            source_type = ?,
            methods_used = ?::jsonb,
            pages = ?,
            char_count = ?,
            word_count = ?,
            text = ?,
            ocr_text = ?,
            warnings = ?::jsonb,
            confidence = ?,
            provenance = ?::jsonb,
            ocr_used = ?,
            started_at = COALESCE(started_at, ?::timestamptz),
            finished_at = ?::timestamptz,
            updated_at = NOW()
        WHERE document_id = ?
      `,
    ).run(
      normalizeSourceType(meta.source_type),
      methodsJson,
      pages,
      charCount,
      wordCount,
      text,
      ocrText,
      warningsJson,
      confidence,
      provenanceJson,
      ocrUsed,
      startedAt || finishedAt,
      finishedAt,
      documentId,
    )
  } else {
    await db.prepare(
      `
        UPDATE document_extracts
        SET status = 'ready',
            source_type = ?,
            methods_used = ?,
            pages = ?,
            char_count = ?,
            word_count = ?,
            text = ?,
            ocr_text = ?,
            warnings = ?,
            confidence = ?,
            provenance = ?,
            ocr_used = ?,
            started_at = COALESCE(started_at, ?),
            finished_at = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE document_id = ?
      `,
    ).run(
      normalizeSourceType(meta.source_type),
      methodsJson,
      pages,
      charCount,
      wordCount,
      text,
      ocrText,
      warningsJson,
      confidence,
      provenanceJson,
      ocrUsed ? 1 : 0,
      startedAt || finishedAt,
      finishedAt,
      documentId,
    )
  }
}

export async function tryReuseExtractByHash(db, { fileHash, documentId } = {}) {
  if (!fileHash || !documentId) return null
  const pg = isPostgres(db)

  // Look for any ready extract with this hash and reuse its content.
  // NOTE: This intentionally ignores document_id uniqueness by copying content into the current row.
  let existing = null
  try {
    existing = pg
      ? await db
          .prepare(
            `
              SELECT *
              FROM document_extracts
              WHERE file_hash = ?
                AND status = 'ready'
              ORDER BY finished_at DESC NULLS LAST, updated_at DESC
              LIMIT 1
            `,
          )
          .get(fileHash)
      : await db
          .prepare(
            `
              SELECT *
              FROM document_extracts
              WHERE file_hash = ?
                AND status = 'ready'
              ORDER BY COALESCE(finished_at, updated_at) DESC, updated_at DESC
              LIMIT 1
            `,
          )
          .get(fileHash)
  } catch (err) {
    console.warn('[documentExtractStore] tryReuseExtractByHash lookup failed:', err?.message)
    return null
  }

  if (!existing) return null

  // Copy across fields.
  if (pg) {
    await db.prepare(
      `
        UPDATE document_extracts
        SET status = 'ready',
            source_type = ?,
            methods_used = ?::jsonb,
            pages = ?,
            char_count = ?,
            word_count = ?,
            text = ?,
            ocr_text = ?,
            warnings = ?::jsonb,
            confidence = ?,
            provenance = ?::jsonb,
            ocr_used = ?,
            started_at = COALESCE(started_at, NOW()),
            finished_at = NOW(),
            updated_at = NOW()
        WHERE document_id = ?
      `,
    ).run(
      existing.source_type ?? null,
      typeof existing.methods_used === 'string' ? existing.methods_used : JSON.stringify(existing.methods_used ?? []),
      existing.pages ?? null,
      existing.char_count ?? 0,
      existing.word_count ?? 0,
      existing.text ?? '',
      existing.ocr_text ?? null,
      typeof existing.warnings === 'string' ? existing.warnings : JSON.stringify(existing.warnings ?? []),
      existing.confidence ?? 0,
      (existing.provenance === null || existing.provenance === undefined) ? null : (typeof existing.provenance === 'string' ? existing.provenance : JSON.stringify(existing.provenance)),
      Boolean(existing.ocr_used),
      documentId,
    )
  } else {
    await db.prepare(
      `
        UPDATE document_extracts
        SET status = 'ready',
            source_type = ?,
            methods_used = ?,
            pages = ?,
            char_count = ?,
            word_count = ?,
            text = ?,
            ocr_text = ?,
            warnings = ?,
            confidence = ?,
            provenance = ?,
            ocr_used = ?,
            started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
            finished_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE document_id = ?
      `,
    ).run(
      existing.source_type ?? null,
      typeof existing.methods_used === 'string' ? existing.methods_used : JSON.stringify(existing.methods_used ?? []),
      existing.pages ?? null,
      existing.char_count ?? 0,
      existing.word_count ?? 0,
      existing.text ?? '',
      existing.ocr_text ?? null,
      typeof existing.warnings === 'string' ? existing.warnings : JSON.stringify(existing.warnings ?? []),
      existing.confidence ?? 0,
      (existing.provenance === null || existing.provenance === undefined) ? null : (typeof existing.provenance === 'string' ? existing.provenance : JSON.stringify(existing.provenance)),
      existing.ocr_used ? 1 : 0,
      documentId,
    )
  }

  return getDocumentExtract(db, documentId)
}


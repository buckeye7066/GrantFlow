/**
 * Ingestion provenance & quality layer.
 *
 * Three concerns, all in the ingest/gate path:
 *
 *   1. PER-RESULT EVIDENCE SNIPPETS — persist the source text (title +
 *      matched description / eligibility text) and the source URL that
 *      justify each stored opportunity, into `opportunity_evidence`.
 *
 *   2. REJECTION LOG — whenever an opportunity is rejected by any gate,
 *      write a structured row to `rejection_log` (source, source_url, title,
 *      reason, stage, raw_meta). Visible to admins via
 *      GET /api/admin/rejections.
 *
 *   3. MANDATORY SOURCE-REGISTRY / PROVENANCE CHECK — every ingest must
 *      validate provenance against the canonical allowlists before storing.
 *      Unknown / untrusted provenance is rejected + logged rather than
 *      silently stored.
 *
 * ALL writes here are BEST-EFFORT: they catch their own errors and never
 * throw, so they can never block or break the ingest path. The tables are
 * created by schema.sql (fresh DBs) and ensureSchemaInvariants.js (prod
 * boot heal); a missing table is silently tolerated.
 */

import { evaluatePipelineSource } from '../config/pipelineAllowedSources.js'
import { ALLOWED_RECORD_ORIGINS } from '../utils/recordOrigins.js'

/**
 * Decide whether an opportunity's provenance is trusted enough to store.
 *
 * Mirrors the existing allowlists so legitimate crawler origins still pass:
 *   - evaluatePipelineSource() accepts a trusted record_origin (live_crawl,
 *     curated_*, grants_gov, geo_crawl, web_search, seeded, imported, …) OR a
 *     recognised `source` label (federal APIs, funding-domain labels, vetted
 *     scholarship platforms).
 *   - As an additional accept path, a record_origin in the canonical
 *     ALLOWED_RECORD_ORIGINS set is trusted even if evaluatePipelineSource is
 *     conservative about the source label.
 *
 * Returns { allowed, reason } where reason is 'untrusted_origin' (explicit
 * synthetic/untrusted origin), 'unknown_source' (no recognised provenance at
 * all), or a trusted reason on accept.
 *
 * @param {{source?: string|null, record_origin?: string|null} | null} opportunity
 * @returns {{ allowed: boolean, reason: string }}
 */
export function evaluateProvenance(opportunity) {
  const verdict = evaluatePipelineSource(opportunity)
  if (verdict.allowed) {
    return { allowed: true, reason: verdict.reason }
  }

  // Second accept path: a canonical record_origin is trusted provenance even
  // when the source label is unrecognised (e.g. a curated origin paired with a
  // brand-name source that has no funding-domain token).
  const origin = opportunity?.record_origin
  if (typeof origin === 'string' && ALLOWED_RECORD_ORIGINS.has(origin)) {
    // 'synthetic'/'manual' are in ALLOWED_RECORD_ORIGINS for write-validation
    // reasons but are untrusted provenance for the catalog — keep them rejected.
    if (origin !== 'synthetic' && origin !== 'manual') {
      return { allowed: true, reason: 'trusted_origin' }
    }
  }

  // Normalise the rejection reason to the canonical taxonomy.
  if (verdict.reason === 'untrusted_origin' || verdict.reason === 'denied_source') {
    return { allowed: false, reason: 'untrusted_origin' }
  }
  return { allowed: false, reason: 'unknown_source' }
}

function toJsonOrNull(value) {
  if (value === null || value === undefined) return null
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

/**
 * Append-only write to the rejection_log. Best-effort: swallows missing-table
 * and any other error so the ingest path is never blocked.
 *
 * @param {object} db
 * @param {object} entry
 * @param {string} [entry.source]
 * @param {string} [entry.source_url]
 * @param {string} [entry.title]
 * @param {string} entry.reason  Structured reason code.
 * @param {string} entry.stage   One of policy|validation|reviewer|reality|quality|provenance|dedupe|url|ingest
 * @param {object} [entry.raw_meta]
 */
export async function recordRejection(db, entry = {}) {
  if (!db || typeof db.prepare !== 'function') return
  try {
    const stmt = db.prepare(`
      INSERT INTO rejection_log (source, source_url, title, reason, stage, raw_meta)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    await stmt.run(
      entry.source ?? null,
      entry.source_url ?? null,
      entry.title ?? null,
      entry.reason ?? null,
      entry.stage ?? null,
      toJsonOrNull(entry.raw_meta),
    )
  } catch (err) {
    const msg = String(err?.message || err)
    if (msg.includes('no such table') || msg.includes('does not exist')) return
    // Never throw — log loudly enough that a real regression is noticed.
    console.warn('[rejection-log] insert failed (non-fatal):', msg)
  }
}

/**
 * Resolve the best source URL for a rejected opportunity (for the log row).
 */
export function deriveEvidenceUrl(opportunity) {
  return (
    opportunity?.source_url ??
    opportunity?.url ??
    opportunity?.application_url ??
    opportunity?.evidence_url ??
    null
  )
}

function clampSnippet(text, max = 2000) {
  if (text === null || text === undefined) return null
  const s = String(text).trim()
  if (!s) return null
  return s.length > max ? s.slice(0, max) : s
}

/**
 * Build the evidence rows that justify an opportunity: the title, the matched
 * description text, and any eligibility text. The live adapters already carry
 * title/description/snippet/url, so we capture them verbatim at ingest time.
 *
 * @param {object} opportunity
 * @returns {Array<{ source_url: string|null, snippet: string, evidence_type: string }>}
 */
export function buildEvidenceRows(opportunity) {
  const sourceUrl = deriveEvidenceUrl(opportunity)
  const rows = []

  const title = clampSnippet(opportunity?.title)
  if (title) rows.push({ source_url: sourceUrl, snippet: title, evidence_type: 'title' })

  const description = clampSnippet(opportunity?.description ?? opportunity?.snippet)
  if (description) {
    rows.push({ source_url: sourceUrl, snippet: description, evidence_type: 'description' })
  }

  // eligibility_bullets may be an array or a JSON string at this point.
  let bullets = opportunity?.eligibility_bullets
  if (typeof bullets === 'string') {
    try {
      const parsed = JSON.parse(bullets)
      if (Array.isArray(parsed)) bullets = parsed
    } catch {
      bullets = bullets ? [bullets] : []
    }
  }
  if (Array.isArray(bullets) && bullets.length > 0) {
    const elig = clampSnippet(bullets.filter(Boolean).join(' • '))
    if (elig) rows.push({ source_url: sourceUrl, snippet: elig, evidence_type: 'eligibility' })
  }

  return rows
}

/**
 * Persist per-opportunity evidence snippets. Idempotent-ish: clears any prior
 * rows for the opportunity before inserting the fresh set, so re-ingesting the
 * same opportunity doesn't accumulate duplicate evidence. Best-effort.
 *
 * @param {object} db
 * @param {string} opportunityId
 * @param {object} opportunity  The (normalized) opportunity carrying evidence.
 */
export async function persistEvidence(db, opportunityId, opportunity) {
  if (!db || typeof db.prepare !== 'function' || !opportunityId) return
  const rows = buildEvidenceRows(opportunity)
  if (rows.length === 0) return
  try {
    // Replace prior evidence for this opportunity so updates stay clean.
    try {
      await db.prepare('DELETE FROM opportunity_evidence WHERE opportunity_id = ?').run(opportunityId)
    } catch (delErr) {
      const msg = String(delErr?.message || delErr)
      if (msg.includes('no such table') || msg.includes('does not exist')) return
      throw delErr
    }
    const stmt = db.prepare(`
      INSERT INTO opportunity_evidence (opportunity_id, source_url, snippet, evidence_type)
      VALUES (?, ?, ?, ?)
    `)
    for (const row of rows) {
      await stmt.run(opportunityId, row.source_url, row.snippet, row.evidence_type)
    }
  } catch (err) {
    const msg = String(err?.message || err)
    if (msg.includes('no such table') || msg.includes('does not exist')) return
    console.warn('[opportunity-evidence] insert failed (non-fatal):', msg)
  }
}

/**
 * Read recent evidence rows for an opportunity. Used by the API to surface the
 * evidence that justifies a stored opportunity.
 *
 * @param {object} db
 * @param {string} opportunityId
 * @returns {Promise<Array<object>>}
 */
export async function getEvidenceForOpportunity(db, opportunityId) {
  if (!db || typeof db.prepare !== 'function' || !opportunityId) return []
  try {
    const rows = await db
      .prepare(
        `SELECT id, opportunity_id, source_url, snippet, evidence_type, crawl_timestamp
         FROM opportunity_evidence
         WHERE opportunity_id = ?
         ORDER BY id ASC`,
      )
      .all(opportunityId)
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

export default {
  evaluateProvenance,
  recordRejection,
  deriveEvidenceUrl,
  buildEvidenceRows,
  persistEvidence,
  getEvidenceForOpportunity,
}

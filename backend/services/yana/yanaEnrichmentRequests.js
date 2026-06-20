/**
 * Yana — enrichment requests (John → Yana back-channel).
 *
 * John drafts outreach from the lead packets Yana produces. When a packet is
 * too thin to personalize — no mission, focus/program areas, or website
 * excerpt to write about — John can no longer just ship a bland email. Instead
 * he files a structured *enrichment request* here, and Yana services it on her
 * next cycle: she re-fetches the org's site, pulls a real excerpt/contact, and
 * refreshes the candidate so the next draft is specific.
 *
 * This is the database-mediated equivalent of John tapping Yana on the shoulder
 * and saying "I need more on this one before I can write it well."
 *
 * Storage is its own table so the request lifecycle (open → resolved /
 * unfulfilled, with an attempt counter) is auditable and never mutates the
 * lead row's own qualification bookkeeping.
 */

import crypto from 'node:crypto'

import { createLogger } from '../../utils/logger.js'

const log = createLogger('yana-enrichment-requests')

let ensured = new WeakMap()

export function _resetEnrichmentRequestSchemaCache() {
  ensured = new WeakMap()
}

export async function ensureEnrichmentRequestSchema(db) {
  if (!db?.exec) return
  if (ensured.get(db)) return
  const isPg = db?.dialect === 'postgres'
  const idDefault = isPg ? '(gen_random_uuid()::text)' : '(lower(hex(randomblob(16))))'
  const tsType = isPg ? 'TIMESTAMPTZ' : 'DATETIME'
  const nowFn = isPg ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.exec(`
    CREATE TABLE IF NOT EXISTS yana_enrichment_requests (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      candidate_id TEXT,
      organization_name TEXT,
      requested_by TEXT NOT NULL DEFAULT 'john',
      missing_json TEXT NOT NULL DEFAULT '[]',
      note TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      attempts INTEGER NOT NULL DEFAULT 0,
      outcome_json TEXT,
      created_at ${tsType} DEFAULT ${nowFn},
      updated_at ${tsType} DEFAULT ${nowFn},
      resolved_at ${tsType}
    );
    CREATE INDEX IF NOT EXISTS idx_yana_enrich_req_status ON yana_enrichment_requests(status);
    CREATE INDEX IF NOT EXISTS idx_yana_enrich_req_candidate ON yana_enrichment_requests(candidate_id);
  `)
  // One open request per candidate — re-asks bump the attempt counter instead
  // of piling up duplicate rows.
  try {
    await db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_yana_enrich_req_open
         ON yana_enrichment_requests(candidate_id) WHERE status = 'open'`,
    )
  } catch { /* legacy dup data / dialect quirk — non-fatal */ }
  ensured.set(db, true)
}

function parseJson(v, fallback) {
  if (v === null || v === undefined) return fallback
  if (typeof v === 'object') return v
  try { return JSON.parse(v) } catch { return fallback }
}

function nowFnFor(db) { return db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP' }

/** The currently-open request for a candidate, if any. */
export async function getOpenRequestForCandidate(db, candidateId) {
  if (!db?.prepare || !candidateId) return null
  await ensureEnrichmentRequestSchema(db)
  const row = await db
    .prepare(`SELECT * FROM yana_enrichment_requests WHERE candidate_id = ? AND status = 'open' LIMIT 1`)
    .get(String(candidateId))
  if (!row) return null
  return { ...row, missing: parseJson(row.missing_json, []), attempts: Number(row.attempts) || 0 }
}

/**
 * Record (or re-assert) an enrichment request from John.
 *
 * Idempotent per candidate: if an open request already exists, the missing
 * fields are merged and `attempts` is incremented — so a lead John keeps
 * finding thin is counted, not duplicated. Returns { ok, id, attempts, created }.
 */
export async function recordEnrichmentRequest(
  db,
  { candidateId, organizationName = null, missing = [], note = null, requestedBy = 'john' } = {},
) {
  if (!db?.prepare) return { ok: false, reason: 'no_db' }
  if (!candidateId) return { ok: false, reason: 'no_candidate_id' }
  await ensureEnrichmentRequestSchema(db)
  const nowFn = nowFnFor(db)
  const missList = Array.isArray(missing) ? missing.filter(Boolean).map(String) : []

  const existing = await getOpenRequestForCandidate(db, candidateId)
  if (existing) {
    const merged = Array.from(new Set([...(existing.missing || []), ...missList]))
    const attempts = (Number(existing.attempts) || 0) + 1
    await db
      .prepare(
        `UPDATE yana_enrichment_requests
           SET missing_json = ?, note = COALESCE(?, note), attempts = ?, updated_at = ${nowFn}
         WHERE id = ?`,
      )
      .run(JSON.stringify(merged), note, attempts, String(existing.id))
    log.info(`re-asked enrichment for "${organizationName || candidateId}" (attempt ${attempts})`)
    return { ok: true, id: existing.id, attempts, created: false }
  }

  const id = crypto.randomUUID()
  await db
    .prepare(
      `INSERT INTO yana_enrichment_requests
         (id, candidate_id, organization_name, requested_by, missing_json, note, status, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', 1, ${nowFn}, ${nowFn})`,
    )
    .run(id, String(candidateId), organizationName, requestedBy, JSON.stringify(missList), note)
  log.info(`John requested enrichment for "${organizationName || candidateId}": ${note || missList.join(', ')}`)
  return { ok: true, id, attempts: 1, created: true }
}

export async function listOpenEnrichmentRequests(db, { limit = 100 } = {}) {
  if (!db?.prepare) return []
  await ensureEnrichmentRequestSchema(db)
  const rows = await db
    .prepare(`SELECT * FROM yana_enrichment_requests WHERE status = 'open' ORDER BY created_at ASC LIMIT ?`)
    .all(Number(limit) || 100)
  return (rows || []).map((r) => ({ ...r, missing: parseJson(r.missing_json, []), attempts: Number(r.attempts) || 0 }))
}

export async function resolveEnrichmentRequest(db, id, { status = 'resolved', outcome = null } = {}) {
  if (!db?.prepare || !id) return { ok: false }
  await ensureEnrichmentRequestSchema(db)
  const nowFn = nowFnFor(db)
  await db
    .prepare(
      `UPDATE yana_enrichment_requests
         SET status = ?, outcome_json = ?, updated_at = ${nowFn}, resolved_at = ${nowFn}
       WHERE id = ?`,
    )
    .run(status, outcome ? JSON.stringify(outcome) : null, String(id))
  return { ok: true }
}

/**
 * Apply an enrichment result to a lead candidate: add the freshly-found website
 * excerpt as public evidence, register the homepage as a source URL, fill in a
 * contact email if we were missing one, and re-qualify. This is what actually
 * makes John's *next* draft specific instead of generic.
 */
async function applyEnrichmentToCandidate(db, row, enriched) {
  const nowFn = nowFnFor(db)
  let evidence = parseJson(row.public_evidence_json, [])
  if (!Array.isArray(evidence)) evidence = []
  const sources = parseJson(row.source_urls_json, [])
  const sourceSet = new Set(Array.isArray(sources) ? sources : [])

  const excerpt = String(enriched.excerpt || '').trim()
  let gainedEvidence = false
  if (excerpt) {
    const idx = evidence.findIndex((e) => e && e.type === 'website_excerpt')
    const item = { type: 'website_excerpt', text: excerpt.slice(0, 1500) }
    if (idx >= 0) evidence[idx] = item
    else { evidence.push(item); gainedEvidence = true }
  }
  if (enriched.website_url) sourceSet.add(enriched.website_url)

  let contactEmail = row.contact_email
  if (!contactEmail && enriched.email) contactEmail = enriched.email

  const hasEmail = Boolean(contactEmail)
  const hasEvidence = evidence.length > 0
  const hasSource = sourceSet.size > 0
  const qualified = hasEmail && hasEvidence && hasSource && (Number(row.lead_score) || 0) > 0
  const status = qualified ? 'qualified' : (hasEmail ? row.qualification_status : 'needs_enrichment')

  await db
    .prepare(
      `UPDATE yana_lead_candidates
         SET public_evidence_json = ?, source_urls_json = ?, contact_email = ?,
             website_url = COALESCE(website_url, ?), qualification_status = ?, updated_at = ${nowFn}
       WHERE id = ?`,
    )
    .run(
      JSON.stringify(evidence),
      JSON.stringify(Array.from(sourceSet)),
      contactEmail,
      enriched.website_url || null,
      status,
      String(row.id),
    )

  return { gainedEvidence, gainedExcerpt: !!excerpt, gainedEmail: !!(enriched.email && !row.contact_email), status }
}

/**
 * Service John's outstanding enrichment requests. For each, re-run the contact
 * enricher against the organization, fold any new facts back into the lead
 * candidate, and resolve the request. Requests that the enricher cannot fulfil
 * (live web disabled, no homepage found) accrue attempts and, past
 * `maxAttempts`, are closed as 'unfulfilled' so they don't loop forever — John's
 * own deferral cap then lets him draft the best available version.
 *
 * Returns a summary so the Yana run can report what it did for John.
 */
export async function processEnrichmentRequests(
  db,
  { enricher, limit = 25, maxAttempts = 3, logger = log } = {},
) {
  if (!db?.prepare) return { processed: 0, resolved: 0, unfulfilled: 0, enabled: false }
  await ensureEnrichmentRequestSchema(db)
  const enabled = Boolean(enricher && enricher.enabled)
  const requests = await listOpenEnrichmentRequests(db, { limit })
  const summary = { processed: 0, resolved: 0, unfulfilled: 0, still_open: 0, enabled }

  for (const req of requests) {
    summary.processed += 1
    const candidate = await db
      .prepare(`SELECT * FROM yana_lead_candidates WHERE id = ? LIMIT 1`)
      .get(String(req.candidate_id))
    if (!candidate) {
      await resolveEnrichmentRequest(db, req.id, { status: 'unfulfilled', outcome: { reason: 'candidate_gone' } })
      summary.unfulfilled += 1
      continue
    }

    let enriched = null
    if (enabled) {
      try {
        const [city, state] = String(candidate.location || '').split(',').map((s) => s.trim())
        enriched = await enricher.enrich({
          organization_name: candidate.organization_name,
          website_url: candidate.website_url,
          city: city || null,
          state: state || null,
        })
      } catch (err) {
        logger?.warn?.(`enrichment failed for "${candidate.organization_name}": ${err?.message || err}`)
      }
    }

    const attempts = (Number(req.attempts) || 0) + 1
    if (enriched?.ok && (enriched.excerpt || enriched.website_url || enriched.email)) {
      const applied = await applyEnrichmentToCandidate(db, candidate, enriched)
      await resolveEnrichmentRequest(db, req.id, { status: 'resolved', outcome: { ...applied, website_url: enriched.website_url } })
      summary.resolved += 1
      logger?.info?.(`enriched "${candidate.organization_name}" for John (${JSON.stringify(applied)})`)
    } else if (attempts >= maxAttempts || !enabled) {
      const reason = enabled ? 'no_new_facts_found' : 'enricher_disabled'
      await resolveEnrichmentRequest(db, req.id, { status: 'unfulfilled', outcome: { reason, attempts } })
      summary.unfulfilled += 1
    } else {
      const nowFn = nowFnFor(db)
      await db
        .prepare(`UPDATE yana_enrichment_requests SET attempts = ?, updated_at = ${nowFn} WHERE id = ?`)
        .run(attempts, String(req.id))
      summary.still_open += 1
    }
  }

  return summary
}

export default {
  ensureEnrichmentRequestSchema,
  recordEnrichmentRequest,
  getOpenRequestForCandidate,
  listOpenEnrichmentRequests,
  resolveEnrichmentRequest,
  processEnrichmentRequests,
}

/**
 * Laptop Connector — admin-only ingest + review API.
 *
 *   POST /api/laptop-connector/runs                 start a scan run
 *   POST /api/laptop-connector/runs/:id/ingest      submit one file's text → candidates
 *   POST /api/laptop-connector/runs/:id/complete    close out a run
 *   GET  /api/laptop-connector/runs                  recent runs
 *   GET  /api/laptop-connector/review                pending check-off inbox
 *   POST /api/laptop-connector/review/:id/accept     commit one item to its pipeline
 *   POST /api/laptop-connector/review/:id/dismiss    reject one item
 *
 * The connector (tools/laptop-connector) authenticates with ADMIN_TOKEN via a
 * Bearer header, which the auth middleware maps to the admin identity.
 *
 * Accept never duplicates pipeline logic:
 *   lead          → INSERT yana_lead_candidates (Yana qualifies + hands to John)
 *   funding       → INSERT robert_source_candidates (Robert's source pool)
 *   profile_field → forward to the guarded PUT /api/profiles/:id/sections/:key
 */

import express from 'express'
import { randomUUID } from 'node:crypto'
import { requireAuthenticatedUser, isAdminUserWithDb } from '../utils/accessControl.js'
import { safeParseJSON } from '../utils/safeJson.js'
import { createLogger } from '../utils/logger.js'
import { isValidEmail } from '../utils/validation.js'
import {
  createRun,
  getRun,
  bumpRunCounters,
  completeRun,
  listRuns,
  findDocumentByHash,
  insertSourceDocument,
  setDocumentCandidateCount,
  insertReviewItem,
  getReviewItem,
  mapReviewItem,
  listPendingReviewItems,
  markReviewItem,
} from '../services/laptopConnector/laptopConnectorStore.js'
import { analyzeText, buildProfilesDigest, redactSecrets } from '../services/laptopConnector/laptopAnalyzer.js'

const log = createLogger('route:laptop-connector')
const router = express.Router()

// --- admin gate (every route) ------------------------------------------------

router.use(async (req, res, next) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const isAdmin = req.ctx?.isAdmin === true || (await isAdminUserWithDb(req.db, user))
  if (!isAdmin) return res.status(403).json({ error: 'Admin access required' })
  next()
})

function nowFn(db) {
  return db?.dialect === 'postgres' ? 'NOW()' : 'CURRENT_TIMESTAMP'
}

// --- runs --------------------------------------------------------------------

router.post('/runs', async (req, res) => {
  try {
    const runId = await createRun(req.db, {
      host: req.body?.host,
      connectorVersion: req.body?.connector_version,
      rootPaths: Array.isArray(req.body?.root_paths) ? req.body.root_paths : [],
    })
    return res.status(201).json({ ok: true, run_id: runId })
  } catch (err) {
    log.error('[laptop-connector] create run failed', { err: err?.message })
    return res.status(500).json({ error: 'create_run_failed', message: err?.message })
  }
})

router.post('/runs/:id/complete', async (req, res) => {
  try {
    const status = ['completed', 'failed', 'cancelled'].includes(req.body?.status)
      ? req.body.status
      : 'completed'
    await completeRun(req.db, req.params.id, {
      status,
      summary: req.body?.summary && typeof req.body.summary === 'object' ? req.body.summary : {},
      errorText: req.body?.error_text || null,
    })
    return res.json({ ok: true, run_id: req.params.id, status })
  } catch (err) {
    return res.status(500).json({ error: 'complete_run_failed', message: err?.message })
  }
})

router.get('/runs', async (req, res) => {
  try {
    const runs = await listRuns(req.db, { limit: req.query?.limit })
    return res.json({ runs })
  } catch (err) {
    return res.json({ runs: [] })
  }
})

// --- ingest ------------------------------------------------------------------

router.post('/runs/:id/ingest', async (req, res) => {
  const runId = req.params.id
  const run = await getRun(req.db, runId).catch(() => null)
  if (!run) return res.status(404).json({ error: 'run_not_found' })

  const { file_path, file_name, file_type, file_hash, byte_size, modified_at, text } = req.body || {}
  if (!file_path || typeof text !== 'string') {
    return res.status(400).json({ error: 'file_path and text are required' })
  }

  // Dedupe: same content (by hash) was already analyzed in a prior run.
  if (file_hash) {
    const existing = await findDocumentByHash(req.db, file_hash).catch(() => null)
    if (existing) {
      await bumpRunCounters(req.db, runId, { scanned: 1, skipped: 1 })
      return res.json({ ok: true, skipped: true, reason: 'duplicate_hash', document_id: existing.id })
    }
  }

  let documentId
  try {
    documentId = await insertSourceDocument(req.db, {
      runId,
      filePath: file_path,
      fileName: file_name,
      fileType: file_type,
      fileHash: file_hash,
      byteSize: byte_size,
      modifiedAt: modified_at,
      charCount: text.length,
    })
  } catch (err) {
    log.warn('[laptop-connector] insert source document failed', { err: err?.message })
    return res.status(500).json({ error: 'insert_document_failed', message: err?.message })
  }

  // Analyze against current profile gaps.
  const profilesDigest = await buildProfilesDigest(req.db, {}).catch(() => ({ profiles: [] }))
  const analysis = await analyzeText({ text, fileName: file_name, profilesDigest })

  let created = 0
  const provenanceBase = { file_path, file_name: file_name || null }

  for (const lead of analysis.leads || []) {
    await insertReviewItem(req.db, {
      runId,
      documentId,
      candidateType: 'lead',
      title: lead.organization_name,
      summary: lead.grantflow_fit_summary || lead.funding_need_summary || 'Potential GrantFlow client',
      payload: lead,
      provenance: { ...provenanceBase, snippet: lead.evidence_snippet || null },
      confidence: lead.confidence,
    }).then(() => (created += 1)).catch((e) => log.warn('lead insert failed', { e: e?.message }))
  }
  for (const fund of analysis.funding || []) {
    await insertReviewItem(req.db, {
      runId,
      documentId,
      candidateType: 'funding',
      title: fund.source_name,
      summary: `Funding source${fund.source_scope ? ` (${fund.source_scope})` : ''}`,
      payload: fund,
      provenance: { ...provenanceBase, snippet: fund.evidence_snippet || null },
      confidence: fund.confidence,
    }).then(() => (created += 1)).catch((e) => log.warn('funding insert failed', { e: e?.message }))
  }
  for (const fill of analysis.profile_fields || []) {
    await insertReviewItem(req.db, {
      runId,
      documentId,
      candidateType: 'profile_field',
      targetProfileId: fill.profile_id,
      title: `${fill.section_key}.${fill.field}`,
      summary: `Fill ${fill.field} = ${JSON.stringify(fill.value)}`.slice(0, 200),
      payload: fill,
      provenance: { ...provenanceBase, snippet: fill.evidence_snippet || null },
      confidence: fill.confidence,
    }).then(() => (created += 1)).catch((e) => log.warn('field insert failed', { e: e?.message }))
  }

  await setDocumentCandidateCount(req.db, documentId, created).catch(() => {})
  await bumpRunCounters(req.db, runId, { scanned: 1, ingested: 1, candidates: created })

  return res.json({
    ok: true,
    document_id: documentId,
    candidates_created: created,
    counts: {
      leads: (analysis.leads || []).length,
      funding: (analysis.funding || []).length,
      profile_fields: (analysis.profile_fields || []).length,
    },
    warnings: analysis.warnings || [],
  })
})

// --- review inbox ------------------------------------------------------------

router.get('/review', async (req, res) => {
  try {
    const type = ['lead', 'funding', 'profile_field'].includes(req.query?.type) ? req.query.type : null
    const items = await listPendingReviewItems(req.db, { candidateType: type, limit: req.query?.limit })
    const grouped = { lead: [], funding: [], profile_field: [] }
    for (const it of items) grouped[it.candidate_type]?.push(it)
    return res.json({
      items,
      grouped,
      counts: {
        lead: grouped.lead.length,
        funding: grouped.funding.length,
        profile_field: grouped.profile_field.length,
        total: items.length,
      },
    })
  } catch (err) {
    log.warn('[laptop-connector] review list failed', { err: err?.message })
    return res.json({ items: [], grouped: { lead: [], funding: [], profile_field: [] }, counts: {} })
  }
})

router.post('/review/:id/dismiss', async (req, res) => {
  const row = await getReviewItem(req.db, req.params.id).catch(() => null)
  if (!row) return res.status(404).json({ error: 'item_not_found' })
  if (row.status !== 'pending') {
    return res.status(409).json({ error: 'already_acted', status: row.status })
  }
  const reason =
    typeof req.body?.reason === 'string' && req.body.reason.trim()
      ? req.body.reason.trim().slice(0, 200)
      : 'user_dismissed'
  await markReviewItem(req.db, row.id, 'dismissed', reason)
  return res.json({ ok: true, id: row.id, status: 'dismissed', reason })
})

router.post('/review/:id/accept', async (req, res) => {
  const row = await getReviewItem(req.db, req.params.id).catch(() => null)
  if (!row) return res.status(404).json({ error: 'item_not_found' })
  if (row.status !== 'pending') {
    return res.status(409).json({ error: 'already_acted', status: row.status, action_result: row.action_result })
  }

  const item = mapReviewItem(row)
  try {
    let result
    if (item.candidate_type === 'lead') result = await acceptLead(req, item)
    else if (item.candidate_type === 'funding') result = await acceptFunding(req, item)
    else if (item.candidate_type === 'profile_field') result = await acceptProfileField(req, item)
    else return res.status(400).json({ error: 'unknown_candidate_type' })

    if (!result.ok) {
      await markReviewItem(req.db, item.id, 'error', result.message || 'accept_failed').catch(() => {})
      return res.status(result.status || 422).json({ error: 'accept_failed', detail: result })
    }

    await markReviewItem(req.db, item.id, 'accepted', result.target_id || null)
    return res.json({ ok: true, id: item.id, status: 'accepted', ...result })
  } catch (err) {
    log.error('[laptop-connector] accept failed', { id: item.id, err: err?.message })
    await markReviewItem(req.db, item.id, 'error', err?.message).catch(() => {})
    return res.status(500).json({ error: 'accept_failed', message: err?.message })
  }
})

// --- accept routing ----------------------------------------------------------

async function acceptLead(req, item) {
  const p = item.payload || {}
  const id = randomUUID()
  const leadScore = Math.round((Number(p.confidence) || item.confidence || 0) * 100)
  const evidence = []
  if (item.provenance?.snippet) evidence.push({ type: 'laptop_file', text: item.provenance.snippet })
  const sourceUrls = p.website_url ? [p.website_url] : []

  // Qualification gate — mirror Yana's rule that 'qualified' MUST mean reachable
  // by email (qualifyScore in yanaLeadDiscovery.js). Force-qualifying an
  // approved lead with no email used to push it to John, who then silently
  // dropped it as no_usable_email_contact (the lead vanished). Instead:
  //   - usable email            → 'qualified' (ready for John to draft)
  //   - no email but a website  → 'needs_enrichment' (Yana can find a contact)
  //   - neither                 → 'candidate'  (parked for the operator; not
  //                                surfaced to John, so it never silently drops)
  const contactEmail = String(p.contact_email || '').trim() || null
  const hasEmail = contactEmail && isValidEmail(contactEmail)
  const status = hasEmail
    ? 'qualified'
    : (p.website_url ? 'needs_enrichment' : 'candidate')
  const reasons = ['approved_from_laptop_connector', `status:${status}`]
  if (!hasEmail) reasons.push('no_usable_email')

  try {
    await req.db
      .prepare(
        `INSERT INTO yana_lead_candidates
           (id, organization_name, organization_type, entity_type, website_url, location,
            contact_email, funding_need_summary, grantflow_fit_summary,
            public_evidence_json, source_urls_json, fit_score, lead_score,
            qualification_status, qualification_reasons_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        p.organization_name,
        p.entity_type || p.organization_type || null,
        p.entity_type || null,
        p.website_url || null,
        p.location || null,
        contactEmail,
        p.funding_need_summary || null,
        p.grantflow_fit_summary || null,
        JSON.stringify(evidence),
        JSON.stringify(sourceUrls),
        leadScore,
        leadScore,
        status,
        JSON.stringify(reasons),
      )
  } catch (err) {
    return { ok: false, status: 500, message: `yana insert failed: ${err?.message}` }
  }
  return { ok: true, routed_to: 'yana', target_id: id, qualification_status: status }
}

async function acceptFunding(req, item) {
  const p = item.payload || {}
  const id = randomUUID()
  const hasUrl = typeof p.source_url === 'string' && /^https?:\/\//i.test(p.source_url)
  // No URL → stage as 'pending' (Robert won't auto-crawl) with a navigable
  // search fallback so the admin can find + approve it later. Robert's source
  // pool keys on URL, so we must supply one.
  const sourceUrl = hasUrl
    ? p.source_url
    : `https://www.google.com/search?q=${encodeURIComponent(`${p.source_name} grant program`)}`
  const status = hasUrl ? 'approved' : 'pending'
  const trust = hasUrl ? 70 : 30
  let domain = null
  try {
    domain = new URL(sourceUrl).hostname
  } catch {
    domain = null
  }
  try {
    await req.db
      .prepare(
        `INSERT INTO robert_source_candidates
           (id, source_name, source_url, source_domain, source_type, source_scope,
            applicant_types_json, need_categories_json, trust_score, discovered_by, status, evidence_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'laptop', ?, ?)
         ON CONFLICT(source_url) DO NOTHING`,
      )
      .run(
        id,
        p.source_name,
        sourceUrl,
        domain,
        p.source_type || null,
        p.source_scope || null,
        JSON.stringify(Array.isArray(p.applicant_types) ? p.applicant_types : []),
        JSON.stringify(Array.isArray(p.need_categories) ? p.need_categories : []),
        trust,
        status,
        JSON.stringify({ origin: 'laptop_connector', snippet: item.provenance?.snippet || null }),
      )
  } catch (err) {
    return { ok: false, status: 500, message: `robert insert failed: ${err?.message}` }
  }
  return { ok: true, routed_to: 'robert', target_id: id, source_status: status, needs_url: !hasUrl }
}

/**
 * Forward the merged section to the guarded PUT /api/profiles/:id/sections/:key
 * so all validation, name-derivation, and field-sync logic applies unchanged.
 */
async function acceptProfileField(req, item) {
  const p = item.payload || {}
  const { profile_id: profileId, section_key: sectionKey, field, value } = p
  if (!profileId || !sectionKey || !field) {
    return { ok: false, status: 400, message: 'incomplete profile_field payload' }
  }

  // Load current section data, merge the single field, then forward the whole section.
  let existing = {}
  try {
    const row = await req.db
      .prepare('SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ? LIMIT 1')
      .get(profileId, sectionKey)
    existing = row ? safeParseJSON(row.data, {}) : {}
  } catch {
    existing = {}
  }
  const merged = { ...existing, [field]: value }

  const host = req.get('host')
  if (!host) return { ok: false, status: 500, message: 'cannot resolve internal host' }
  const base = (process.env.ANYA_SELF_BASE_URL || `${req.protocol || 'http'}://${host}`).replace(/\/+$/, '')
  const headers = {
    'content-type': 'application/json',
    ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
    ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
    'x-laptop-connector': 'profile-field-accept',
  }
  try {
    const r = await fetch(`${base}/api/profiles/${encodeURIComponent(profileId)}/sections/${encodeURIComponent(sectionKey)}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ data: merged, updated_by: 'laptop-connector' }),
    })
    if (!r.ok) {
      let body = null
      try {
        body = await r.json()
      } catch {
        body = null
      }
      return { ok: false, status: r.status, message: body?.error || body?.message || 'profile update rejected', detail: body }
    }
    return { ok: true, routed_to: 'profile', target_id: profileId, section_key: sectionKey, field }
  } catch (err) {
    return { ok: false, status: 502, message: `profile forward failed: ${err?.message}` }
  }
}

export default router

/**
 * robertRunStore.js
 *
 * Persistence for `robert_runs`, `robert_source_candidates`,
 * `robert_opportunity_candidates`, `robert_profile_coverage`, and
 * `robert_profile_recommendations`.
 *
 * Every async function takes `db` as the first argument so the unit
 * tests can inject an in-memory SQLite shim. All JSON columns are
 * stored as TEXT for SQLite / JSONB for Postgres but the API hands
 * back already-parsed objects.
 */

import { maskSecrets } from './robertSafety.js'
import {
  RUN_STATUS,
  SOURCE_STATUS,
  VERIFICATION_STATUS,
  RECOMMENDATION_STATUS,
  DELIVERY_STATUS,
} from './robertTypes.js'

function safeStringify(value) {
  try { return JSON.stringify(value ?? null) } catch { return 'null' }
}
function safeParse(value, fallback) {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(String(value)) } catch { return fallback }
}
function nowISO() { return new Date().toISOString() }
function genId(prefix = 'rob') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------
export async function startRun(db, { mode, trigger = 'manual', created_by_user_id = null } = {}) {
  if (!db?.prepare) throw new Error('startRun: db is required')
  if (!mode) throw new Error('startRun: mode is required')
  const id = genId('robert-run')
  await db.prepare(
    `INSERT INTO robert_runs (id, mode, trigger, status, started_at, summary_json, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, '{}', ?)`,
  ).run(id, mode, trigger, RUN_STATUS.RUNNING, nowISO(), created_by_user_id ?? null)
  return id
}

export async function completeRun(db, runId, {
  status = RUN_STATUS.COMPLETED,
  counters = {},
  summary = {},
  error = null,
} = {}) {
  if (!db?.prepare || !runId) return
  const c = {
    profiles_considered: 0,
    sources_considered: 0,
    urls_fetched: 0,
    candidates_found: 0,
    candidates_verified: 0,
    opportunities_ingested: 0,
    opportunities_matched: 0,
    recommendations_created: 0,
    recommendations_delivered: 0,
    recommendations_accepted: 0,
    recommendations_declined: 0,
    zero_result_profiles_helped: 0,
    ...counters,
  }
  await db.prepare(
    `UPDATE robert_runs
        SET status = ?, completed_at = ?,
            profiles_considered = ?, sources_considered = ?, urls_fetched = ?,
            candidates_found = ?, candidates_verified = ?, opportunities_ingested = ?,
            opportunities_matched = ?, recommendations_created = ?,
            recommendations_delivered = ?, recommendations_accepted = ?,
            recommendations_declined = ?, zero_result_profiles_helped = ?,
            summary_json = ?, error = ?
      WHERE id = ?`,
  ).run(
    status, nowISO(),
    c.profiles_considered, c.sources_considered, c.urls_fetched,
    c.candidates_found, c.candidates_verified, c.opportunities_ingested,
    c.opportunities_matched, c.recommendations_created,
    c.recommendations_delivered, c.recommendations_accepted,
    c.recommendations_declined, c.zero_result_profiles_helped,
    safeStringify(maskSecrets(summary)),
    error ? String(maskSecrets(error)).slice(0, 4_000) : null,
    runId,
  )
}

export async function getRun(db, runId) {
  if (!db?.prepare || !runId) return null
  const row = await db.prepare('SELECT * FROM robert_runs WHERE id = ? LIMIT 1').get(runId)
  return shapeRun(row)
}

export async function listRuns(db, { limit = 25 } = {}) {
  if (!db?.prepare) return []
  const cap = Math.max(1, Math.min(100, Number(limit) || 25))
  const rows = await db.prepare('SELECT * FROM robert_runs ORDER BY started_at DESC LIMIT ?').all(cap)
  return rows.map(shapeRun)
}

export async function latestRun(db) {
  if (!db?.prepare) return null
  const row = await db.prepare('SELECT * FROM robert_runs ORDER BY started_at DESC LIMIT 1').get()
  return shapeRun(row)
}

function shapeRun(row) {
  if (!row) return null
  return {
    id: row.id,
    mode: row.mode,
    trigger: row.trigger,
    status: row.status,
    started_at: row.started_at,
    completed_at: row.completed_at,
    profiles_considered: row.profiles_considered ?? 0,
    sources_considered: row.sources_considered ?? 0,
    urls_fetched: row.urls_fetched ?? 0,
    candidates_found: row.candidates_found ?? 0,
    candidates_verified: row.candidates_verified ?? 0,
    opportunities_ingested: row.opportunities_ingested ?? 0,
    opportunities_matched: row.opportunities_matched ?? 0,
    recommendations_created: row.recommendations_created ?? 0,
    recommendations_delivered: row.recommendations_delivered ?? 0,
    recommendations_accepted: row.recommendations_accepted ?? 0,
    recommendations_declined: row.recommendations_declined ?? 0,
    zero_result_profiles_helped: row.zero_result_profiles_helped ?? 0,
    summary: safeParse(row.summary_json, {}),
    error: row.error || null,
    created_by_user_id: row.created_by_user_id || null,
  }
}

// ---------------------------------------------------------------------------
// Source candidates
// ---------------------------------------------------------------------------
export async function upsertSourceCandidate(db, candidate) {
  if (!db?.prepare) throw new Error('upsertSourceCandidate: db required')
  if (!candidate?.source_url) throw new Error('upsertSourceCandidate: source_url required')
  const existing = await db.prepare(
    'SELECT * FROM robert_source_candidates WHERE source_url = ? LIMIT 1',
  ).get(candidate.source_url)
  if (existing) {
    await db.prepare(
      `UPDATE robert_source_candidates
          SET source_name = COALESCE(NULLIF(?, ''), source_name),
              source_type = COALESCE(?, source_type),
              source_scope = COALESCE(?, source_scope),
              trust_score = ?,
              last_checked_at = ?,
              evidence_json = ?
        WHERE id = ?`,
    ).run(
      candidate.source_name || '',
      candidate.source_type ?? null,
      candidate.source_scope ?? null,
      Number(candidate.trust_score ?? existing.trust_score ?? 0),
      nowISO(),
      safeStringify(candidate.evidence ?? safeParse(existing.evidence_json, {})),
      existing.id,
    )
    return { id: existing.id, inserted: false, updated: true }
  }
  const id = genId('robert-src')
  await db.prepare(
    `INSERT INTO robert_source_candidates (
       id, source_name, source_url, source_domain, source_type, source_scope,
       geography_state, geography_county, geography_city,
       applicant_types_json, need_categories_json, trust_score, discovered_by,
       discovered_at, status, evidence_json, robots_allowed, rate_limit_bucket
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, candidate.source_name, candidate.source_url, candidate.source_domain ?? null,
    candidate.source_type ?? null, candidate.source_scope ?? null,
    candidate.geography_state ?? null, candidate.geography_county ?? null, candidate.geography_city ?? null,
    safeStringify(candidate.applicant_types || []),
    safeStringify(candidate.need_categories || []),
    Number(candidate.trust_score || 0),
    candidate.discovered_by || 'robert',
    nowISO(),
    candidate.status || SOURCE_STATUS.PENDING,
    safeStringify(candidate.evidence || {}),
    candidate.robots_allowed === false ? 0 : 1,
    candidate.rate_limit_bucket || candidate.source_domain || null,
  )
  return { id, inserted: true, updated: false }
}

export async function setSourceCandidateStatus(db, id, status, { rejection_reason = null } = {}) {
  if (!db?.prepare || !id) return
  await db.prepare(
    `UPDATE robert_source_candidates
        SET status = ?, rejection_reason = ?, last_checked_at = ?
      WHERE id = ?`,
  ).run(status, rejection_reason, nowISO(), id)
}

export async function listSourceCandidates(db, { status = null, limit = 100 } = {}) {
  if (!db?.prepare) return []
  if (status) {
    return (await db.prepare(
      'SELECT * FROM robert_source_candidates WHERE status = ? ORDER BY discovered_at DESC LIMIT ?',
    ).all(status, Number(limit) || 100)).map(shapeSource)
  }
  return (await db.prepare(
    'SELECT * FROM robert_source_candidates ORDER BY discovered_at DESC LIMIT ?',
  ).all(Number(limit) || 100)).map(shapeSource)
}

function shapeSource(row) {
  if (!row) return null
  return {
    ...row,
    applicant_types: safeParse(row.applicant_types_json, []),
    need_categories: safeParse(row.need_categories_json, []),
    evidence: safeParse(row.evidence_json, {}),
    robots_allowed: row.robots_allowed === 1 || row.robots_allowed === true,
  }
}

// ---------------------------------------------------------------------------
// Opportunity candidates
// ---------------------------------------------------------------------------
export async function insertOpportunityCandidate(db, candidate) {
  if (!db?.prepare) throw new Error('insertOpportunityCandidate: db required')
  const id = genId('robert-opp')
  await db.prepare(
    `INSERT INTO robert_opportunity_candidates (
        id, run_id, source_candidate_id, title, sponsor, description,
        application_url, source_url, deadline, deadline_type,
        amount_min, amount_max, amount_description,
        geography_json, eligibility_json, categories_json, keywords_json,
        applicant_types_json, need_categories_json, raw_payload_json,
        extraction_method, confidence,
        verification_status, verification_reasons_json,
        created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, candidate.run_id ?? null, candidate.source_candidate_id ?? null,
    candidate.title ?? null, candidate.sponsor ?? null, candidate.description ?? null,
    candidate.application_url ?? null, candidate.source_url ?? null,
    candidate.deadline ?? null, candidate.deadline_type ?? null,
    candidate.amount_min ?? null, candidate.amount_max ?? null, candidate.amount_description ?? null,
    safeStringify(candidate.geography || {}),
    safeStringify(candidate.eligibility || []),
    safeStringify(candidate.categories || []),
    safeStringify(candidate.keywords || []),
    safeStringify(candidate.applicant_types || []),
    safeStringify(candidate.need_categories || []),
    safeStringify(candidate.raw_payload || {}),
    candidate.extraction_method ?? null,
    Number(candidate.confidence || 0),
    VERIFICATION_STATUS.PENDING,
    '[]',
    nowISO(), nowISO(),
  )
  return { id }
}

export async function updateOpportunityCandidate(db, id, patch) {
  if (!db?.prepare || !id) return
  const fields = []
  const params = []
  const allowed = [
    'verification_status', 'policy_status', 'policy_rejection_reason',
    'reality_status', 'reviewer_status', 'normalized_opportunity_json',
    'existing_opportunity_id', 'ingested_opportunity_id',
  ]
  for (const k of allowed) {
    if (k in patch) {
      fields.push(`${k} = ?`)
      const v = patch[k]
      params.push(typeof v === 'object' && v !== null ? safeStringify(v) : v)
    }
  }
  if ('verification_reasons' in patch) {
    fields.push('verification_reasons_json = ?')
    params.push(safeStringify(patch.verification_reasons || []))
  }
  if (fields.length === 0) return
  fields.push('updated_at = ?')
  params.push(nowISO(), id)
  await db.prepare(`UPDATE robert_opportunity_candidates SET ${fields.join(', ')} WHERE id = ?`).run(...params)
}

export async function listOpportunityCandidates(db, { run_id = null, verification_status = null, limit = 100 } = {}) {
  if (!db?.prepare) return []
  const where = []
  const params = []
  if (run_id) { where.push('run_id = ?'); params.push(run_id) }
  if (verification_status) { where.push('verification_status = ?'); params.push(verification_status) }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  params.push(Number(limit) || 100)
  const rows = await db.prepare(
    `SELECT * FROM robert_opportunity_candidates ${whereSql} ORDER BY created_at DESC LIMIT ?`,
  ).all(...params)
  return rows.map(shapeCandidate)
}

function shapeCandidate(row) {
  if (!row) return null
  return {
    ...row,
    geography: safeParse(row.geography_json, {}),
    eligibility: safeParse(row.eligibility_json, []),
    categories: safeParse(row.categories_json, []),
    keywords: safeParse(row.keywords_json, []),
    applicant_types: safeParse(row.applicant_types_json, []),
    need_categories: safeParse(row.need_categories_json, []),
    raw_payload: safeParse(row.raw_payload_json, {}),
    verification_reasons: safeParse(row.verification_reasons_json, []),
    normalized_opportunity: safeParse(row.normalized_opportunity_json, null),
  }
}

// ---------------------------------------------------------------------------
// Profile coverage
// ---------------------------------------------------------------------------
export async function upsertCoverage(db, coverage) {
  if (!db?.prepare) return
  if (!coverage?.profile_id) throw new Error('upsertCoverage: profile_id required')
  const existing = await db.prepare(
    'SELECT id FROM robert_profile_coverage WHERE profile_id = ? LIMIT 1',
  ).get(coverage.profile_id)
  if (existing) {
    await db.prepare(
      `UPDATE robert_profile_coverage
          SET coverage_score = ?, known_matches_count = ?, accepted_matches_count = ?,
              review_matches_count = ?, zero_result_risk = ?,
              missing_need_categories_json = ?, missing_geographies_json = ?,
              recommended_search_queries_json = ?, recommended_source_types_json = ?,
              last_analyzed_at = ?
        WHERE id = ?`,
    ).run(
      Number(coverage.coverage_score || 0),
      Number(coverage.known_matches_count || 0),
      Number(coverage.accepted_matches_count || 0),
      Number(coverage.review_matches_count || 0),
      Number(coverage.zero_result_risk || 0),
      safeStringify(coverage.missing_need_categories || []),
      safeStringify(coverage.missing_geographies || []),
      safeStringify(coverage.recommended_search_queries || []),
      safeStringify(coverage.recommended_source_types || []),
      nowISO(),
      existing.id,
    )
    return { id: existing.id, updated: true, inserted: false }
  }
  const id = genId('robert-cov')
  await db.prepare(
    `INSERT INTO robert_profile_coverage (
        id, profile_id, coverage_score, known_matches_count, accepted_matches_count,
        review_matches_count, zero_result_risk,
        missing_need_categories_json, missing_geographies_json,
        recommended_search_queries_json, recommended_source_types_json,
        last_analyzed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, coverage.profile_id,
    Number(coverage.coverage_score || 0),
    Number(coverage.known_matches_count || 0),
    Number(coverage.accepted_matches_count || 0),
    Number(coverage.review_matches_count || 0),
    Number(coverage.zero_result_risk || 0),
    safeStringify(coverage.missing_need_categories || []),
    safeStringify(coverage.missing_geographies || []),
    safeStringify(coverage.recommended_search_queries || []),
    safeStringify(coverage.recommended_source_types || []),
    nowISO(),
  )
  return { id, inserted: true, updated: false }
}

export async function getCoverage(db, profileId) {
  if (!db?.prepare || !profileId) return null
  const row = await db.prepare('SELECT * FROM robert_profile_coverage WHERE profile_id = ? LIMIT 1').get(profileId)
  if (!row) return null
  return {
    ...row,
    missing_need_categories: safeParse(row.missing_need_categories_json, []),
    missing_geographies: safeParse(row.missing_geographies_json, []),
    recommended_search_queries: safeParse(row.recommended_search_queries_json, []),
    recommended_source_types: safeParse(row.recommended_source_types_json, []),
  }
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------
export async function findActiveRecommendation(db, profileId, opportunityId) {
  if (!db?.prepare || !profileId || !opportunityId) return null
  const row = await db.prepare(
    `SELECT * FROM robert_profile_recommendations
       WHERE profile_id = ? AND opportunity_id = ?
         AND recommendation_status IN ('pending','delivered','viewed')
       LIMIT 1`,
  ).get(profileId, opportunityId)
  return shapeRecommendation(row)
}

export async function findRecommendationByPair(db, profileId, opportunityId, { includeDeclined = true } = {}) {
  if (!db?.prepare || !profileId || !opportunityId) return null
  const sql = includeDeclined
    ? `SELECT * FROM robert_profile_recommendations
         WHERE profile_id = ? AND opportunity_id = ? ORDER BY created_at DESC LIMIT 1`
    : `SELECT * FROM robert_profile_recommendations
         WHERE profile_id = ? AND opportunity_id = ?
           AND recommendation_status NOT IN ('declined','expired')
         ORDER BY created_at DESC LIMIT 1`
  const row = await db.prepare(sql).get(profileId, opportunityId)
  return shapeRecommendation(row)
}

export async function insertRecommendation(db, rec) {
  if (!db?.prepare) throw new Error('insertRecommendation: db required')
  if (!rec.profile_id) throw new Error('insertRecommendation: profile_id required')
  // Idempotency: refuse a duplicate ACTIVE recommendation. Declined / expired
  // / superseded recs are NOT blockers here — the recommendation service is
  // responsible for whether to supersede those before inserting.
  if (rec.opportunity_id) {
    const existing = await findActiveRecommendation(db, rec.profile_id, rec.opportunity_id)
    if (existing) return { id: existing.id, inserted: false, duplicate: true, existing }
  }
  const id = genId('robert-rec')
  await db.prepare(
    `INSERT INTO robert_profile_recommendations (
        id, profile_id, opportunity_id, robert_run_id,
        recommendation_status, delivery_status,
        match_score, match_decision, match_reasons_json, missing_profile_fields_json,
        why_found, search_query_used, source_candidate_id, opportunity_candidate_id,
        toast_title, toast_body, toast_priority,
        created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, rec.profile_id, rec.opportunity_id ?? null, rec.robert_run_id ?? null,
    rec.recommendation_status || RECOMMENDATION_STATUS.PENDING,
    rec.delivery_status || DELIVERY_STATUS.QUEUED,
    rec.match_score ?? null, rec.match_decision ?? null,
    safeStringify(rec.match_reasons || []),
    safeStringify(rec.missing_profile_fields || []),
    rec.why_found || '', rec.search_query_used || '',
    rec.source_candidate_id ?? null, rec.opportunity_candidate_id ?? null,
    rec.toast_title ?? null, rec.toast_body ?? null,
    rec.toast_priority || 'normal',
    nowISO(), nowISO(),
  )
  return { id, inserted: true, duplicate: false }
}

export async function listRecommendationsForProfile(db, profileId, { statuses = ['pending', 'delivered', 'viewed'], limit = 50 } = {}) {
  if (!db?.prepare || !profileId) return []
  const placeholders = statuses.map(() => '?').join(',')
  const params = [profileId, ...statuses, Number(limit) || 50]
  const rows = await db.prepare(
    `SELECT * FROM robert_profile_recommendations
       WHERE profile_id = ? AND recommendation_status IN (${placeholders})
       ORDER BY created_at DESC LIMIT ?`,
  ).all(...params)
  return rows.map(shapeRecommendation)
}

export async function getRecommendation(db, id) {
  if (!db?.prepare || !id) return null
  const row = await db.prepare('SELECT * FROM robert_profile_recommendations WHERE id = ? LIMIT 1').get(id)
  return shapeRecommendation(row)
}

export async function updateRecommendationStatus(db, id, {
  recommendation_status,
  delivery_status,
  toast_shown_at,
  viewed_at,
  accepted_at,
  declined_at,
  last_delivered_at,
  delivery_attempts,
} = {}) {
  if (!db?.prepare || !id) return
  const fields = []
  const params = []
  if (recommendation_status) { fields.push('recommendation_status = ?'); params.push(recommendation_status) }
  if (delivery_status) { fields.push('delivery_status = ?'); params.push(delivery_status) }
  if (toast_shown_at !== undefined) { fields.push('toast_shown_at = ?'); params.push(toast_shown_at) }
  if (viewed_at !== undefined) { fields.push('viewed_at = ?'); params.push(viewed_at) }
  if (accepted_at !== undefined) { fields.push('accepted_at = ?'); params.push(accepted_at) }
  if (declined_at !== undefined) { fields.push('declined_at = ?'); params.push(declined_at) }
  if (last_delivered_at !== undefined) { fields.push('last_delivered_at = ?'); params.push(last_delivered_at) }
  if (delivery_attempts !== undefined) { fields.push('delivery_attempts = ?'); params.push(delivery_attempts) }
  if (fields.length === 0) return
  fields.push('updated_at = ?')
  params.push(nowISO(), id)
  await db.prepare(`UPDATE robert_profile_recommendations SET ${fields.join(', ')} WHERE id = ?`).run(...params)
}

export async function countRecommendationsToday(db, profileId, { now = new Date() } = {}) {
  if (!db?.prepare || !profileId) return 0
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const row = await db.prepare(
    `SELECT COUNT(*) AS c FROM robert_profile_recommendations
       WHERE profile_id = ? AND created_at >= ?`,
  ).get(profileId, since)
  return Number(row?.c || 0)
}

function shapeRecommendation(row) {
  if (!row) return null
  return {
    id: row.id,
    profile_id: row.profile_id,
    opportunity_id: row.opportunity_id,
    robert_run_id: row.robert_run_id,
    recommendation_status: row.recommendation_status,
    delivery_status: row.delivery_status,
    match_score: row.match_score === null || row.match_score === undefined ? null : Number(row.match_score),
    match_decision: row.match_decision,
    match_reasons: safeParse(row.match_reasons_json, []),
    missing_profile_fields: safeParse(row.missing_profile_fields_json, []),
    why_found: row.why_found || '',
    search_query_used: row.search_query_used || '',
    source_candidate_id: row.source_candidate_id,
    opportunity_candidate_id: row.opportunity_candidate_id,
    toast_title: row.toast_title,
    toast_body: row.toast_body,
    toast_priority: row.toast_priority,
    toast_shown_at: row.toast_shown_at,
    viewed_at: row.viewed_at,
    accepted_at: row.accepted_at,
    declined_at: row.declined_at,
    last_delivered_at: row.last_delivered_at,
    delivery_attempts: row.delivery_attempts ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

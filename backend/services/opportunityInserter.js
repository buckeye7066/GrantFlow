import crypto from 'crypto'
import { isValidRealUrl, isLoanLike, isMatchingFunds, enforceOpportunityPolicy } from './crawlers/opportunityPolicy.js'
import { ALLOWED_RECORD_ORIGINS } from '../utils/recordOrigins.js'

// Backward-compat alias
const isValidHttpUrl = isValidRealUrl
const isLoanOrMatchingFund = (opp) => isLoanLike(opp) || isMatchingFunds(opp)

function ensureArray(value) {
  if (!value) return []
  if (Array.isArray(value)) return value
  return [value]
}

function normalizeNonEmptyString(value) {
  if (value == null) return null
  const text = String(value).trim()
  return text.length > 0 ? text : null
}

function normalizeUrl(value) {
  const text = normalizeNonEmptyString(value)
  return text
}

function stableSourceIdFromOpportunity(source, opportunity) {
  const url = opportunity?.source_url ?? opportunity?.url ?? opportunity?.application_url ?? null
  const title = opportunity?.title ?? ''
  const sponsor = opportunity?.sponsor ?? ''
  // Exclude deadline so deadline-only updates (e.g. extensions) don't create new records.
  const raw = `${source}|${String(url || '').trim().toLowerCase()}|${String(title).trim().toLowerCase()}|${String(sponsor).trim().toLowerCase()}`
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32)
}

function deriveIsNational(opportunity) {
  return (
    opportunity?.is_national === true ||
    opportunity?.is_national === 1 ||
    opportunity?.state === 'nationwide'
  )
}

function toDbBoolean(db, value) {
  const bool = Boolean(value)
  return db?.dialect === 'postgres' ? bool : bool ? 1 : 0
}

// ALLOWED_RECORD_ORIGINS imported from ../utils/recordOrigins.js

function deriveRecordOrigin(opportunity) {
    const origin = opportunity?.record_origin
    if (typeof origin === 'string' && origin.length > 0) {
          // Validate against allowed values; fall back to 'live_crawl' if unknown
          return ALLOWED_RECORD_ORIGINS.has(origin) ? origin : 'live_crawl'
    }
    return 'live_crawl'
}

function normalizeDateLikeOrNull(value) {
  if (value == null) return null
  if (typeof value === 'string' && value.trim() === '') return null
  return value
}

export async function upsertFundingOpportunity(db, opportunity) {
  const source = opportunity.source ?? 'crawler'
  const title = normalizeNonEmptyString(opportunity?.title)
  if (!title) {
    return {
      id: null,
      inserted: false,
      skipped: true,
      reason: 'missing title',
    }
  }

  const recordOrigin = deriveRecordOrigin(opportunity)
  const sourceUrl = normalizeUrl(opportunity.source_url ?? opportunity.url ?? opportunity.application_url)
  const applicationUrl = normalizeUrl(opportunity.application_url)
  const evidenceUrl = normalizeUrl(opportunity.evidence_url ?? sourceUrl ?? applicationUrl)

  // All opportunities must have at least one concrete valid http/https URL (no placeholders).
  const candidateUrl = sourceUrl ?? applicationUrl ?? evidenceUrl ?? null
  if (!candidateUrl || !isValidHttpUrl(candidateUrl)) {
    return {
      id: null,
      inserted: false,
      skipped: true,
      reason: !candidateUrl ? 'missing evidence/source/application URL' : 'invalid or placeholder URL',
    }
  }

  // Exclude loans, microloans, financing, and matching-fund/cost-share opportunities.
  if (isLoanOrMatchingFund(opportunity)) {
    return {
      id: null,
      inserted: false,
      skipped: true,
      reason: 'excluded: loan or matching-fund opportunity',
    }
  }

  const sourceId =
    opportunity.source_id ??
    // Many crawler datasets ship a stable `id` field; treat that as the source_id when present.
    opportunity.id ??
    stableSourceIdFromOpportunity(source, opportunity)

  // Check if record exists and if it's verified
  const existing = await db
    .prepare(
      `SELECT id, last_verified_at FROM funding_opportunities WHERE source = ? AND source_id = ? LIMIT 1`,
    )
    .get(source, sourceId)

  // Treat live crawl records as verified even if caller omits last_verified_at.
  const incomingIsBaseline = recordOrigin !== 'live_crawl' && opportunity.last_verified_at == null
  const existingIsVerified = existing?.last_verified_at != null

  // Only block baseline/unverified incoming data from downgrading verified existing records
  if (existing?.id && existingIsVerified && incomingIsBaseline) {
    return {
      id: existing.id,
      inserted: false,
      skipped: true,
      reason: 'baseline cannot downgrade verified record'
    }
  }

  // Otherwise allow updates (including verified→verified ingestion refresh)
  if (existing?.id) {
    const isNational = deriveIsNational(opportunity)

    const record = {
      title,
      sponsor: normalizeNonEmptyString(opportunity.sponsor),
      description: opportunity.description ?? null,
      source_url: sourceUrl,
      evidence_url: evidenceUrl,
      contact_info: opportunity.contact_info ?? null,
      eligibility_bullets: JSON.stringify(ensureArray(opportunity.eligibility_bullets)),
      match_reasons: JSON.stringify(ensureArray(opportunity.match_reasons)),
      amount_min: typeof opportunity.amount_min === 'number' ? opportunity.amount_min : null,
      amount_max: typeof opportunity.amount_max === 'number' ? opportunity.amount_max : null,
      amount_description: opportunity.amount_description ?? null,
      // Postgres DATE cannot accept empty string; normalize to null.
      deadline: normalizeDateLikeOrNull(opportunity.deadline),
      deadline_type: opportunity.deadline_type ?? null,
      application_url: applicationUrl,
      is_national: toDbBoolean(db, isNational),
      state: opportunity.state ?? (isNational ? 'nationwide' : null),
      categories: JSON.stringify(ensureArray(opportunity.categories)),
      keywords: JSON.stringify(ensureArray(opportunity.keywords)),
      opportunity_type: opportunity.opportunity_type ?? 'grant',
      funding_type: opportunity.funding_type ?? null,
      type: opportunity.type ?? 'OPPORTUNITY',
      last_verified_at:
        opportunity.last_verified_at ?? (recordOrigin === 'live_crawl' ? new Date().toISOString() : null),
      profile_id: opportunity.profile_id ?? null,
      requires_501c3: toDbBoolean(db, opportunity.requires_501c3),
      requires_match: toDbBoolean(db, opportunity.requires_match),
      match_percentage: typeof opportunity.match_percentage === 'number' ? opportunity.match_percentage : null,
      notes: opportunity.notes ?? null,
      record_origin: recordOrigin,
    }

    // For live_crawl: allow clearing nullable fields when source no longer has them (avoids stale data).
    const fromLiveCrawl = recordOrigin === 'live_crawl'
    const update = db.prepare(
      fromLiveCrawl
        ? `
      UPDATE funding_opportunities
      SET
        title = COALESCE(?, title),
        sponsor = COALESCE(?, sponsor),
        description = ?,
        source_url = COALESCE(?, source_url),
        evidence_url = COALESCE(?, evidence_url),
        contact_info = COALESCE(?, contact_info),
        record_origin = COALESCE(?, record_origin),
        eligibility_bullets = COALESCE(?, eligibility_bullets),
        amount_min = ?,
        amount_max = ?,
        amount_description = ?,
        deadline = ?,
        deadline_type = ?,
        application_url = COALESCE(?, application_url),
        is_national = COALESCE(?, is_national),
        state = COALESCE(?, state),
        categories = COALESCE(?, categories),
        keywords = COALESCE(?, keywords),
        opportunity_type = COALESCE(?, opportunity_type),
        type = COALESCE(?, type),
        last_verified_at = COALESCE(?, last_verified_at),
        profile_id = COALESCE(?, profile_id),
        requires_501c3 = COALESCE(?, requires_501c3),
        requires_match = COALESCE(?, requires_match),
        match_percentage = COALESCE(?, match_percentage),
        match_reasons = COALESCE(?, match_reasons),
        notes = COALESCE(?, notes),
        updated_at = CURRENT_TIMESTAMP,
        last_crawled = CURRENT_TIMESTAMP
      WHERE id = ?
    `
        : `
      UPDATE funding_opportunities
      SET
        title = COALESCE(?, title),
        sponsor = COALESCE(?, sponsor),
        description = COALESCE(?, description),
        source_url = COALESCE(?, source_url),
        evidence_url = COALESCE(?, evidence_url),
        contact_info = COALESCE(?, contact_info),
        record_origin = COALESCE(?, record_origin),
        eligibility_bullets = COALESCE(?, eligibility_bullets),
        amount_min = COALESCE(?, amount_min),
        amount_max = COALESCE(?, amount_max),
        amount_description = COALESCE(?, amount_description),
        deadline = COALESCE(?, deadline),
        deadline_type = COALESCE(?, deadline_type),
        application_url = COALESCE(?, application_url),
        is_national = COALESCE(?, is_national),
        state = COALESCE(?, state),
        categories = COALESCE(?, categories),
        keywords = COALESCE(?, keywords),
        opportunity_type = COALESCE(?, opportunity_type),
        type = COALESCE(?, type),
        last_verified_at = COALESCE(?, last_verified_at),
        profile_id = COALESCE(?, profile_id),
        requires_501c3 = COALESCE(?, requires_501c3),
        requires_match = COALESCE(?, requires_match),
        match_percentage = COALESCE(?, match_percentage),
        match_reasons = COALESCE(?, match_reasons),
        notes = COALESCE(?, notes),
        updated_at = CURRENT_TIMESTAMP,
        last_crawled = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    )

    await update.run(
      record.title,
      record.sponsor,
      record.description,
      record.source_url,
      record.evidence_url,
      record.contact_info,
      record.record_origin,
      record.eligibility_bullets,
      record.amount_min,
      record.amount_max,
      record.amount_description,
      record.deadline,
      record.deadline_type,
      record.application_url,
      record.is_national,
      record.state,
      record.categories,
      record.keywords,
      record.opportunity_type,
      record.type,
      record.last_verified_at,
      record.profile_id,
      record.requires_501c3,
      record.requires_match,
      record.match_percentage,
      record.match_reasons,
      record.notes,
      existing.id,
    )

    return { id: existing.id, inserted: false, updated: true, skipped: false }
  }

  // IMPORTANT:
  // `funding_opportunities.id` is the DB primary key. Never reuse dataset IDs here because
  // different sources can collide (e.g. "nat-snap") which triggers UNIQUE constraint failures.
  // Stability/deduplication is achieved via (source, source_id), not the primary key.
  const id = crypto.randomUUID()
  const isNational = deriveIsNational(opportunity)
  const record = {
    title,
    sponsor: normalizeNonEmptyString(opportunity.sponsor),
    description: opportunity.description ?? null,
    source_url: sourceUrl,
    evidence_url: evidenceUrl,
    contact_info: opportunity.contact_info ?? null,
    eligibility_bullets: JSON.stringify(
      ensureArray(opportunity.eligibility_bullets),
    ),
    match_reasons: JSON.stringify(ensureArray(opportunity.match_reasons)),
    amount_min:
      typeof opportunity.amount_min === 'number'
        ? opportunity.amount_min
        : null,
    amount_max:
      typeof opportunity.amount_max === 'number'
        ? opportunity.amount_max
        : null,
    amount_description: opportunity.amount_description ?? null,
    // Postgres rejects empty-string dates (e.g. ""), so normalize to null.
    deadline: normalizeDateLikeOrNull(opportunity.deadline),
    deadline_type: opportunity.deadline_type ?? null,
    application_url: applicationUrl,
    is_national: toDbBoolean(db, isNational),
    state: opportunity.state ?? (isNational ? 'nationwide' : null),
    categories: JSON.stringify(ensureArray(opportunity.categories)),
    keywords: JSON.stringify(ensureArray(opportunity.keywords)),
    opportunity_type: opportunity.opportunity_type ?? 'grant',
    funding_type: opportunity.funding_type ?? null,
    type: opportunity.type ?? 'OPPORTUNITY',
    last_verified_at:
      opportunity.last_verified_at ?? (recordOrigin === 'live_crawl' ? new Date().toISOString() : null),
    profile_id: opportunity.profile_id ?? null,
    requires_501c3: toDbBoolean(db, opportunity.requires_501c3),
    requires_match: toDbBoolean(db, opportunity.requires_match),
    match_percentage:
      typeof opportunity.match_percentage === 'number'
        ? opportunity.match_percentage
        : null,
    notes: opportunity.notes ?? null,
    record_origin: recordOrigin,
    funding_domain: opportunity.funding_domain ?? null,
    funding_subdomain: opportunity.funding_subdomain ?? null,
    source_category: opportunity.source_category ?? null,
    compliance_required: JSON.stringify(ensureArray(opportunity.compliance_required)),
    certifications_required: JSON.stringify(ensureArray(opportunity.certifications_required)),
    geo_eligibility: opportunity.geo_eligibility != null ? JSON.stringify(opportunity.geo_eligibility) : null,
    signal_tags: JSON.stringify(ensureArray(opportunity.signal_tags)),
    crawler_version: opportunity.crawler_version ?? null,
  }

  const insert = db.prepare(`
    INSERT INTO funding_opportunities (
      id,
      title,
      sponsor,
      source,
      source_id,
      source_url,
      evidence_url,
      contact_info,
      record_origin,
      description,
      eligibility_bullets,
      amount_min,
      amount_max,
      amount_description,
      deadline,
      deadline_type,
      application_url,
      is_national,
      state,
      categories,
      keywords,
      opportunity_type,
      funding_type,
      type,
      last_verified_at,
      profile_id,
      requires_501c3,
      requires_match,
      match_percentage,
      match_reasons,
      notes,
      is_active,
      last_crawled,
      funding_domain,
      funding_subdomain,
      source_category,
      compliance_required,
      certifications_required,
      geo_eligibility,
      signal_tags,
      crawler_version
    ) VALUES (
      @id,
      @title,
      @sponsor,
      @source,
      @source_id,
      @source_url,
      @evidence_url,
      @contact_info,
      @record_origin,
      @description,
      @eligibility_bullets,
      @amount_min,
      @amount_max,
      @amount_description,
      @deadline,
      @deadline_type,
      @application_url,
      @is_national,
      @state,
      @categories,
      @keywords,
      @opportunity_type,
      @funding_type,
      @type,
      @last_verified_at,
      @profile_id,
      @requires_501c3,
      @requires_match,
      @match_percentage,
      @match_reasons,
      @notes,
      @is_active,
      CURRENT_TIMESTAMP,
      @funding_domain,
      @funding_subdomain,
      @source_category,
      @compliance_required,
      @certifications_required,
      @geo_eligibility,
      @signal_tags,
      @crawler_version
    )
    ON CONFLICT(source, source_id) DO UPDATE SET
      title = COALESCE(excluded.title, funding_opportunities.title),
      sponsor = COALESCE(excluded.sponsor, funding_opportunities.sponsor),
      description = COALESCE(excluded.description, funding_opportunities.description),
      source_url = COALESCE(excluded.source_url, funding_opportunities.source_url),
      evidence_url = COALESCE(excluded.evidence_url, funding_opportunities.evidence_url),
      application_url = COALESCE(excluded.application_url, funding_opportunities.application_url),
      eligibility_bullets = COALESCE(excluded.eligibility_bullets, funding_opportunities.eligibility_bullets),
      categories = COALESCE(excluded.categories, funding_opportunities.categories),
      keywords = COALESCE(excluded.keywords, funding_opportunities.keywords),
      amount_min = COALESCE(excluded.amount_min, funding_opportunities.amount_min),
      amount_max = COALESCE(excluded.amount_max, funding_opportunities.amount_max),
      amount_description = COALESCE(excluded.amount_description, funding_opportunities.amount_description),
      deadline = COALESCE(excluded.deadline, funding_opportunities.deadline),
      record_origin = COALESCE(excluded.record_origin, funding_opportunities.record_origin),
      last_verified_at = COALESCE(excluded.last_verified_at, funding_opportunities.last_verified_at),
      match_reasons = COALESCE(excluded.match_reasons, funding_opportunities.match_reasons),
      updated_at = CURRENT_TIMESTAMP,
      last_crawled = CURRENT_TIMESTAMP
  `)

  await insert.run({
    id,
    title: record.title,
    sponsor: record.sponsor,
    source,
    source_id: sourceId,
    source_url: record.source_url,
    evidence_url: record.evidence_url,
    contact_info: record.contact_info,
    record_origin: record.record_origin,
    description: record.description,
    eligibility_bullets: record.eligibility_bullets,
    amount_min: record.amount_min,
    amount_max: record.amount_max,
    amount_description: record.amount_description,
    deadline: record.deadline,
    deadline_type: record.deadline_type,
    application_url: record.application_url,
    is_national: record.is_national,
    state: record.state,
    categories: record.categories,
    keywords: record.keywords,
    opportunity_type: record.opportunity_type,
    funding_type: record.funding_type,
    type: record.type,
    last_verified_at: record.last_verified_at,
    profile_id: record.profile_id,
    requires_501c3: record.requires_501c3,
    requires_match: record.requires_match,
    match_percentage: record.match_percentage,
    match_reasons: record.match_reasons,
    notes: record.notes,
    is_active: toDbBoolean(db, true),
    funding_domain: record.funding_domain,
    funding_subdomain: record.funding_subdomain,
    source_category: record.source_category,
    compliance_required: record.compliance_required,
    certifications_required: record.certifications_required,
    geo_eligibility: record.geo_eligibility,
    signal_tags: record.signal_tags,
    crawler_version: record.crawler_version,
  })

  return { id, inserted: true, skipped: false }
}

/**
 * Persist only policy-compliant opportunities. Non-negotiable: loans, matching funds,
 * placeholders, and invalid/missing URLs are never written to the database.
 * Batched in transactions of 50 for performance.
 */
export async function bulkUpsertFundingOpportunities(db, opportunities = []) {
  const BATCH_SIZE = 50
  const inserted = []
  for (let i = 0; i < opportunities.length; i += BATCH_SIZE) {
    const batch = opportunities.slice(i, i + BATCH_SIZE)
    try {
      await db.withTransaction(async (tx) => {
        for (const opportunity of batch) {
          const policy = enforceOpportunityPolicy(opportunity)
          if (!policy.ok) continue
          const result = await upsertFundingOpportunity(tx, opportunity)
          if (result?.inserted) inserted.push(result.id)
        }
      })
    } catch (err) {
      console.error(`[bulkUpsert] Batch ${i}-${i + batch.length} failed, falling back to individual:`, err.message)
      for (const opportunity of batch) {
        try {
          const policy = enforceOpportunityPolicy(opportunity)
          if (!policy.ok) continue
          const result = await upsertFundingOpportunity(db, opportunity)
          if (result?.inserted) inserted.push(result.id)
        } catch (err) { console.error('[bulkUpsert] Individual insert failed:', err.message, opportunity?.title) }
      }
    }
  }
  return inserted
}

import crypto from 'crypto'
import { isValidRealUrl, isLoanLike, isMatchingFunds, enforceOpportunityPolicy } from './crawlers/opportunityPolicy.js'
import { ALLOWED_RECORD_ORIGINS } from '../utils/recordOrigins.js'
import { validateOpportunity, deduplicateByUrl } from './opportunityValidator.js'
import { normalizeUrlForDedupe } from '../routes/opportunityHelpers.js'

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

/**
 * Derive funding_source_type from record_origin and source when not explicitly set.
 */
/**
 * Classify a funding opportunity's category for housing usability.
 * Categories: tuition_only, refund_eligible, stipend, housing_direct, faith_based, talent_based, coa_adjustment
 */
function classifyFundingCategory(opportunity) {
  const text = `${opportunity.title || ''} ${opportunity.description || ''} ${(opportunity.eligibility_bullets || []).join(' ')}`.toLowerCase()

  // Housing direct: RA programs, housing grants, room and board coverage
  if (/\b(resident\s*a(dvisor|ssistant)|ra\s+position|housing\s+(grant|assistance|scholarship|stipend)|room\s+and\s+board|dormitor|on-campus\s+housing)\b/.test(text)) {
    return 'housing_direct'
  }
  // Stipend: monthly stipend, living allowance, fellowship stipend
  if (/\b(stipend|living\s+(allowance|expense)|monthly\s+(payment|allowance)|fellowship.*stipend|research\s+assistantship)\b/.test(text)) {
    return 'stipend'
  }
  // COA adjustment: cost of attendance appeals, professional judgment
  if (/\b(cost\s+of\s+attendance|coa\s+(adjustment|appeal)|professional\s+judgment|financial\s+aid\s+appeal|special\s+circumstances?\s+appeal)\b/.test(text)) {
    return 'coa_adjustment'
  }
  // Faith-based
  if (/\b(faith[- ]based|church\s+scholarship|christian\s+(scholarship|grant)|ministry\s+(grant|scholarship)|religious\s+(scholarship|grant)|denominational|baptist|methodist|presbyterian|catholic\s+scholarship|lutheran)\b/.test(text)) {
    return 'faith_based'
  }
  // Talent-based
  if (/\b(music\s+scholarship|talent[- ]based|athletic\s+scholarship|art\s+scholarship|perform(ance|ing)\s+(arts?\s+)?(scholarship|grant)|band\s+scholarship|choir\s+scholarship|instrument|audition[- ]based)\b/.test(text)) {
    return 'talent_based'
  }
  // Refund eligible: scholarships that pay to student or exceed tuition
  if (opportunity.opportunity_type === 'scholarship' || /\bscholarship\b/.test(text)) {
    if (/\b(refund|excess|remaining\s+balance|disbursed?\s+to\s+student|direct\s+to\s+student|overage|credit\s+balance)\b/.test(text)) {
      return 'refund_eligible'
    }
    // Large scholarships likely produce refunds
    if (opportunity.amount_max && opportunity.amount_max > 10000) {
      return 'refund_eligible'
    }
  }
  // Tuition only
  if (/\b(tuition[- ]only|applied\s+directly\s+to\s+tuition|pays\s+tuition|tuition\s+waiver|tuition\s+remission)\b/.test(text)) {
    return 'tuition_only'
  }
  return null
}

/**
 * Determine if a funding opportunity can be used for housing/living expenses.
 */
function deriveUsableForHousing(opportunity, fundingCategory) {
  if (['refund_eligible', 'stipend', 'housing_direct', 'coa_adjustment'].includes(fundingCategory)) {
    return true
  }
  const text = `${opportunity.title || ''} ${opportunity.description || ''}`.toLowerCase()
  if (/\b(living\s+expenses?|off[- ]campus|rent|utilit(y|ies)|food|room\s+and\s+board|housing)\b/.test(text)) {
    return true
  }
  return false
}

/**
 * Determine refund potential for a funding opportunity.
 */
function deriveRefundPotential(opportunity, fundingCategory) {
  if (fundingCategory === 'refund_eligible') return true
  if (fundingCategory === 'stipend') return true
  const text = `${opportunity.title || ''} ${opportunity.description || ''}`.toLowerCase()
  if (/\b(refund|excess\s+funds?|credit\s+balance|disbursed?\s+to\s+student|remaining\s+balance)\b/.test(text)) {
    return true
  }
  return false
}

/**
 * Extract structured eligibility signals from opportunity data.
 */
function extractEligibilitySignals(opportunity) {
  const text = `${opportunity.title || ''} ${opportunity.description || ''} ${(opportunity.eligibility_bullets || []).join(' ')}`.toLowerCase()
  const signals = {}

  // GPA requirement
  const gpaMatch = text.match(/\b(\d\.\d{1,2})\s*(?:gpa|grade\s+point|cumulative)\b/) ||
    text.match(/\bgpa\s*(?:of\s+)?(\d\.\d{1,2})\b/)
  if (gpaMatch) signals.gpa_min = parseFloat(gpaMatch[1])

  // Faith affiliation
  if (/\b(faith|christian|church|ministry|religious|baptist|methodist|presbyterian|catholic|lutheran|evangelical|protestant|jewish|muslim|interfaith)\b/.test(text)) {
    signals.faith_affiliation = true
  }

  // Talent type
  const talentPatterns = [
    { pattern: /\b(music|instrument|band|choir|orchestra|flute|piano|violin|vocal)\b/, type: 'music' },
    { pattern: /\b(athlet|sport|basketball|football|soccer|track|swimming|tennis|golf|baseball)\b/, type: 'athletics' },
    { pattern: /\b(art|visual\s+art|painting|sculpture|drawing|design|photography)\b/, type: 'visual_arts' },
    { pattern: /\b(theater|theatre|drama|acting|perform(ance|ing)\s+arts?|dance)\b/, type: 'performing_arts' },
    { pattern: /\b(leadership|community\s+service|volunteer|civic)\b/, type: 'leadership' },
    { pattern: /\b(debate|speech|forensic|public\s+speaking|model\s+un)\b/, type: 'speech_debate' },
    { pattern: /\b(stem|science|math|engineer|computer|coding|robotics)\b/, type: 'stem' },
    { pattern: /\b(writ(e|ing)|essay|journal|poet|literary|creative\s+writing)\b/, type: 'writing' },
  ]
  const talents = []
  for (const { pattern, type } of talentPatterns) {
    if (pattern.test(text)) talents.push(type)
  }
  if (talents.length > 0) signals.talent_type = talents

  // State
  if (opportunity.state && opportunity.state !== 'nationwide') {
    signals.state = opportunity.state
  }

  // Field of study
  const fieldPatterns = [
    { pattern: /\b(forensic\s+science|criminalistics|crime\s+lab)\b/, field: 'forensic_science' },
    { pattern: /\b(nursing|pre[- ]?nursing|bsn|rn\b)\b/, field: 'nursing' },
    { pattern: /\b(engineering|mechanical|electrical|civil|chemical)\b/, field: 'engineering' },
    { pattern: /\b(computer\s+science|software|information\s+technology|cybersecurity)\b/, field: 'computer_science' },
    { pattern: /\b(business|accounting|finance|marketing|mba)\b/, field: 'business' },
    { pattern: /\b(education|teaching|pedagogy)\b/, field: 'education' },
    { pattern: /\b(medicine|pre[- ]?med|medical\s+school)\b/, field: 'medicine' },
    { pattern: /\b(biology|biochemistry|biomedical)\b/, field: 'biology' },
  ]
  for (const { pattern, field } of fieldPatterns) {
    if (pattern.test(text)) {
      signals.field_of_study = field
      break
    }
  }

  return Object.keys(signals).length > 0 ? signals : null
}

function deriveFundingSourceType(recordOrigin, source) {
  if (recordOrigin === 'grants_gov' || ['grants.gov', 'grants_gov', 'usa_spending', 'usaspending'].includes(source)) return 'federal'
  if (['state_portal', 'state_grants_portal', 'state_waiver'].includes(source)) return 'state'
  if (['local_foundation', 'community_foundation', 'cof_foundation_locator', 'candid_directory', 'propublica.990'].includes(source)) return 'foundation'
  if (source === 'corporate_giving') return 'corporate'
  if (['scholarship_crawler', 'scholarship_database', 'school_portal'].includes(source)) return 'university'
  if (['health_resources_crawler', 'charity_care'].includes(source)) return 'medical'
  if (source?.startsWith('local_directory_') || source === 'osm_overpass') return 'community'
  if (['curated_benefits', 'curated_verified', 'verified_real', 'curated_program'].includes(recordOrigin)) return 'federal'
  return 'other'
}

function normalizeUrl(value) {
  const text = normalizeNonEmptyString(value)
  if (!text) return null
  return isValidRealUrl(text) ? text : null
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

export async function upsertFundingOpportunity(db, opportunity, opts = {}) {
  // Full policy enforcement on every path (not just bulk).
  const policyResult = enforceOpportunityPolicy(opportunity)
  if (!policyResult.ok) {
    return {
      id: null,
      inserted: false,
      skipped: true,
      reason: `policy:${policyResult.reason}`,
    }
  }

  // Comprehensive validation (required fields, categorization, directory/expiration detection).
  const validation = validateOpportunity(opportunity, {
    allowLoans: opts.allowLoans ?? false,
    allowDirectories: opts.allowDirectories ?? true,
  })
  if (!validation.valid) {
    return {
      id: null,
      inserted: false,
      skipped: true,
      reason: `validation:${validation.errors.join(',')}`,
    }
  }

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

  const candidateUrl = sourceUrl ?? applicationUrl ?? evidenceUrl ?? null
  if (!candidateUrl || !isValidHttpUrl(candidateUrl)) {
    return {
      id: null,
      inserted: false,
      skipped: true,
      reason: !candidateUrl ? 'missing evidence/source/application URL' : 'invalid or placeholder URL',
    }
  }

  if (isLoanOrMatchingFund(opportunity)) {
    return {
      id: null,
      inserted: false,
      skipped: true,
      reason: 'excluded: loan or matching-fund opportunity',
    }
  }

  // Apply inferred opportunity_type from validator if not already set.
  if (validation.opportunityType && !opportunity.opportunity_type) {
    opportunity.opportunity_type = validation.opportunityType
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
        application_url = ?,
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
        application_url = ?,
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

  // URL-based cross-source deduplication: if another active opportunity has the same
  // normalized URL from a different source, treat it as a duplicate (skip insert).
  const normalizedCandidateUrl = normalizeUrlForDedupe(candidateUrl)
  if (normalizedCandidateUrl && !opts.skipUrlDedup) {
    try {
      const urlDupe = await db
        .prepare(
          `SELECT id, source, source_id FROM funding_opportunities
           WHERE source_url = ? OR application_url = ?
           LIMIT 1`,
        )
        .get(candidateUrl, candidateUrl)
      if (urlDupe && urlDupe.source !== source) {
        return {
          id: urlDupe.id,
          inserted: false,
          skipped: true,
          reason: `url_duplicate:${urlDupe.source}/${urlDupe.source_id}`,
        }
      }
    } catch (err) {
      console.warn('[opportunityInserter] URL dedup query failed (allowing insert):', err?.message)
    }
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
      crawler_version,
      funding_source_type,
      funding_category,
      usable_for_housing,
      refund_potential,
      eligibility_signals,
      verification_status
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
      @crawler_version,
      @funding_source_type,
      @funding_category,
      @usable_for_housing,
      @refund_potential,
      @eligibility_signals,
      @verification_status
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
      deadline_type = COALESCE(excluded.deadline_type, funding_opportunities.deadline_type),
      opportunity_type = COALESCE(excluded.opportunity_type, funding_opportunities.opportunity_type),
      funding_type = COALESCE(excluded.funding_type, funding_opportunities.funding_type),
      type = COALESCE(excluded.type, funding_opportunities.type),
      is_national = COALESCE(excluded.is_national, funding_opportunities.is_national),
      state = COALESCE(excluded.state, funding_opportunities.state),
      contact_info = COALESCE(excluded.contact_info, funding_opportunities.contact_info),
      requires_501c3 = COALESCE(excluded.requires_501c3, funding_opportunities.requires_501c3),
      requires_match = COALESCE(excluded.requires_match, funding_opportunities.requires_match),
      match_percentage = COALESCE(excluded.match_percentage, funding_opportunities.match_percentage),
      signal_tags = COALESCE(excluded.signal_tags, funding_opportunities.signal_tags),
      funding_domain = COALESCE(excluded.funding_domain, funding_opportunities.funding_domain),
      funding_subdomain = COALESCE(excluded.funding_subdomain, funding_opportunities.funding_subdomain),
      source_category = COALESCE(excluded.source_category, funding_opportunities.source_category),
      compliance_required = COALESCE(excluded.compliance_required, funding_opportunities.compliance_required),
      certifications_required = COALESCE(excluded.certifications_required, funding_opportunities.certifications_required),
      geo_eligibility = COALESCE(excluded.geo_eligibility, funding_opportunities.geo_eligibility),
      crawler_version = COALESCE(excluded.crawler_version, funding_opportunities.crawler_version),
      funding_source_type = COALESCE(excluded.funding_source_type, funding_opportunities.funding_source_type),
      funding_category = COALESCE(excluded.funding_category, funding_opportunities.funding_category),
      usable_for_housing = COALESCE(excluded.usable_for_housing, funding_opportunities.usable_for_housing),
      refund_potential = COALESCE(excluded.refund_potential, funding_opportunities.refund_potential),
      eligibility_signals = COALESCE(excluded.eligibility_signals, funding_opportunities.eligibility_signals),
      verification_status = COALESCE(excluded.verification_status, funding_opportunities.verification_status),
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
    funding_source_type: record.funding_source_type ?? deriveFundingSourceType(record.record_origin, source),
    funding_category: record.funding_category,
    usable_for_housing: record.usable_for_housing,
    refund_potential: record.refund_potential,
    eligibility_signals: record.eligibility_signals,
    verification_status: record.verification_status,
  })

  return { id, inserted: true, skipped: false }
}

/**
 * Persist only policy-compliant opportunities. Non-negotiable: loans, matching funds,
 * placeholders, and invalid/missing URLs are never written to the database.
 * Batched in transactions of 50 for performance.
 * Pre-deduplicates by normalized URL before batch processing.
 */
export async function bulkUpsertFundingOpportunities(db, opportunities = [], opts = {}) {
  // Pre-deduplicate by normalized URL within the batch itself.
  const { unique: deduped, duplicateCount } = deduplicateByUrl(opportunities)
  if (duplicateCount > 0) {
    console.log(`[bulkUpsert] Removed ${duplicateCount} intra-batch URL duplicates`)
  }

  const BATCH_SIZE = 50
  const inserted = []
  for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
    const batch = deduped.slice(i, i + BATCH_SIZE)
    try {
      await db.withTransaction(async (tx) => {
        for (const opportunity of batch) {
          const result = await upsertFundingOpportunity(tx, opportunity, opts)
          if (result?.skipped && result?.reason) {
            console.warn('[bulkUpsert] Rejected:', result.reason, '|', opportunity?.title ?? 'untitled')
          }
          if (result?.inserted) inserted.push(result.id)
        }
      })
    } catch (err) {
      console.error(`[bulkUpsert] Batch ${i}-${i + batch.length} failed, falling back to individual:`, err.message)
      for (const opportunity of batch) {
        try {
          const result = await upsertFundingOpportunity(db, opportunity, opts)
          if (result?.skipped && result?.reason) {
            console.warn('[bulkUpsert] Rejected:', result.reason, '|', opportunity?.title ?? 'untitled')
          }
          if (result?.inserted) inserted.push(result.id)
        } catch (indivErr) { console.error('[bulkUpsert] Individual insert failed:', indivErr.message, opportunity?.title) }
      }
    }
  }
  return inserted
}

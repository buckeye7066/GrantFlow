/**
 * robertMatchBridge.js
 *
 * Robert's catalog miner must use the same proof-producing Crawler OS authority
 * as live discovery. A plain canonical score is not enough to recommend direct
 * funding: the returned match explanation must carry positive proof that the
 * source is real, relatable, meets a declared profile need, and that the profile
 * qualifies.
 *
 * Tests may inject a matcher. That compatibility path intentionally keeps the
 * legacy (profile, opportunity, options) signature used by focused unit tests.
 */

let _cachedCrawlerOsAuthority = null

async function getCrawlerOsAuthority() {
  if (_cachedCrawlerOsAuthority) return _cachedCrawlerOsAuthority
  const [{ computeMatchDecision }, { buildThesis }] = await Promise.all([
    import('../../crawler-os/matchEngine.js'),
    import('../../crawler-os/profileIntelligence.js'),
  ])
  _cachedCrawlerOsAuthority = { computeMatchDecision, buildThesis }
  return _cachedCrawlerOsAuthority
}

function parseValue(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(String(value)) } catch { return fallback }
}

function stringList(...values) {
  const out = []
  for (const value of values.flatMap((entry) => {
    const parsed = parseValue(entry, entry)
    return Array.isArray(parsed) ? parsed : [parsed]
  })) {
    const text = String(value ?? '').trim()
    if (text && !out.includes(text)) out.push(text)
  }
  return out
}

function boolValue(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1
  return ['1', 'true', 'yes', 'y'].includes(String(value ?? '').trim().toLowerCase())
}

function normalizeRealityStatus(value) {
  const status = String(value ?? '').trim().toUpperCase()
  if (status === 'ALLOWED') return 'VERIFIED'
  if (status === 'DOWNGRADED') return 'LINK_UNVERIFIED'
  return status || null
}

/**
 * Convert a catalog DB row to the one Crawler OS opportunity contract. This is
 * a shape adapter only; it does not invent evidence, eligibility, or proof.
 */
export function catalogRowToCrawlerOsOpportunity(opportunity = {}) {
  const geography = parseValue(opportunity.geography_json ?? opportunity.geography, {}) || {}
  const state = opportunity.state ?? opportunity.geo_state ?? null
  const evidenceUrl = opportunity.evidence_url ?? opportunity.source_url ??
    opportunity.info_url ?? opportunity.url ?? opportunity.application_url ?? opportunity.apply_url ?? null

  return {
    id: opportunity.id ?? opportunity.opportunity_id ?? null,
    source_id: opportunity.source_id ?? opportunity.source ?? opportunity.record_origin ?? 'funding_catalog',
    kind: String(
      opportunity.opportunity_kind ?? opportunity.kind ?? opportunity.opportunity_type ?? 'DIRECT_GRANT',
    ).toUpperCase(),
    title: opportunity.title ?? null,
    sponsor: opportunity.sponsor ?? opportunity.funder ?? opportunity.organization_name ?? null,
    summary: opportunity.summary ?? opportunity.description ?? null,
    applicant_types: stringList(
      opportunity.applicant_types,
      opportunity.applicant_types_json,
      opportunity.entity_types_allowed,
      opportunity.eligible_applicant_types,
    ),
    need_categories: stringList(
      opportunity.need_categories,
      opportunity.need_categories_json,
      opportunity.need_types_supported,
      opportunity.categories,
      opportunity.keywords,
    ),
    geography: {
      ...geography,
      national: boolValue(geography.national ?? opportunity.is_national),
      states: stringList(geography.states, state),
      counties: stringList(geography.counties, opportunity.geo_county ?? opportunity.county),
      zips: stringList(geography.zips, opportunity.geo_zip ?? opportunity.zip),
    },
    funding: {
      ...(parseValue(opportunity.funding_json ?? opportunity.funding, {}) || {}),
      amount_min: opportunity.amount_min ?? parseValue(opportunity.funding_json ?? opportunity.funding, {})?.amount_min ?? null,
      amount_max: opportunity.amount_max ?? parseValue(opportunity.funding_json ?? opportunity.funding, {})?.amount_max ?? null,
      is_loan: boolValue(opportunity.is_loan),
      requires_cost_share: boolValue(opportunity.requires_match ?? opportunity.requires_cost_share),
    },
    deadline: opportunity.deadline ?? null,
    is_rolling: String(opportunity.deadline_type ?? '').toLowerCase() === 'rolling',
    apply_url: opportunity.application_url ?? opportunity.apply_url ?? null,
    info_url: opportunity.info_url ?? opportunity.source_url ?? opportunity.url ?? evidenceUrl,
    trust_tier: opportunity.source_trust_tier ?? opportunity.trust_tier ?? null,
    reality_status: normalizeRealityStatus(opportunity.reality_status),
    evidence: {
      url: evidenceUrl,
      content_hash: opportunity.content_hash ?? opportunity.evidence_content_hash ?? null,
      fetched_at: opportunity.fetched_at ?? opportunity.evidence_fetched_at ??
        opportunity.verified_at ?? null,
    },
    eligibility_text: opportunity.eligibility_text ?? opportunity.eligibility ?? null,
    eligibility_bullets: stringList(
      opportunity.eligibility_bullets,
      opportunity.eligibility_bullets_json,
      opportunity.page_fact_eligibility_bullets,
    ),
    page_fact_schema_version: opportunity.page_fact_schema_version ?? null,
    field_provenance: parseValue(opportunity.field_provenance_json ?? opportunity.field_provenance, null),
  }
}

function wholeProfile(profileContext) {
  const sections = profileContext?.sections ?? {}
  const sectionRows = Array.isArray(sections)
    ? sections
    : Object.entries(sections).map(([section_key, data]) => ({ section_key, data }))
  return {
    ...(profileContext?.profile ?? {}),
    ...(profileContext?.organization ?? {}),
    ...(profileContext?.linked_organization ?? {}),
    sections: sectionRows,
    profile_sections: sections,
    signals: profileContext?.signals ?? null,
  }
}

function normalizeBridgeResult(result) {
  const explain = result?.match_explain ?? null
  return {
    score: Number(result?.score ?? result?.match_score) || 0,
    decision: result?.decision ?? result?.match_decision ?? 'REVIEW',
    reasons: Array.isArray(result?.reasons)
      ? result.reasons
      : Array.isArray(explain?.warnings) ? explain.warnings : [],
    eligible: result?.eligible ?? explain?.eligibility_fit,
    missingProfileFields: Array.isArray(result?.missingEligibilityFields)
      ? result.missingEligibilityFields
      : Array.isArray(explain?.missing_eligibility_fields) ? explain.missing_eligibility_fields : [],
    explanation: result?.explanation ?? explain?.why ?? '',
    matchExplain: explain,
    matcherVersion: result?.matcherVersion ?? explain?.matcher_version ?? null,
  }
}

/**
 * Score a profile/opportunity pair using the proof-producing authority.
 *
 * @param {object} args
 * @param {object} args.profileContext output of loadProfileContext
 * @param {object} args.opportunity normalized opportunity or DB row
 * @param {Function} [args.computeMatchDecision] deterministic test injection
 */
export async function scoreOpportunityForProfile({ profileContext, opportunity, computeMatchDecision = null } = {}) {
  if (!profileContext?.profile) {
    return {
      score: 0,
      decision: 'NEEDS_PROFILE_DATA',
      reasons: ['Profile context missing'],
      eligible: 'maybe',
      missingProfileFields: [],
      explanation: 'Profile context not loaded.',
      matchExplain: null,
      matcherVersion: null,
    }
  }
  if (!opportunity) {
    return {
      score: 0,
      decision: 'REJECT',
      reasons: ['Opportunity missing'],
      eligible: false,
      missingProfileFields: [],
      explanation: 'Opportunity not provided.',
      matchExplain: null,
      matcherVersion: null,
    }
  }

  if (typeof computeMatchDecision === 'function') {
    const result = await computeMatchDecision(profileContext.profile, opportunity, {
      profileSections: profileContext.sections,
      signals: profileContext.signals,
    })
    return normalizeBridgeResult(result)
  }

  const authority = await getCrawlerOsAuthority()
  const completeProfile = wholeProfile(profileContext)
  const thesis = authority.buildThesis(completeProfile)
  const osOpportunity = catalogRowToCrawlerOsOpportunity(opportunity)
  const realityStatus = String(osOpportunity.reality_status ?? '').toUpperCase()
  const result = await authority.computeMatchDecision(osOpportunity, thesis, {
    profileRow: completeProfile,
    profileSections: profileContext.sections,
    signals: profileContext.signals,
    realityPassed: realityStatus === 'VERIFIED' || realityStatus === 'ROLLING',
    enforceFourTruths: true,
  })
  return normalizeBridgeResult(result)
}

/**
 * Score a single opportunity against many profiles. Profiles are loaded one at
 * a time so a full Robert sweep does not retain every profile context in memory.
 */
export async function scoreOpportunityAcrossProfiles({
  db,
  opportunity,
  profileIds = [],
  loadProfileContext,
  computeMatchDecision = null,
}) {
  if (!db || !opportunity) return []
  if (typeof loadProfileContext !== 'function') {
    throw new Error('scoreOpportunityAcrossProfiles: loadProfileContext required')
  }
  const out = []
  for (const profileId of profileIds) {
    let ctx
    try { ctx = await loadProfileContext(db, profileId) } catch { ctx = null }
    if (!ctx?.profile) continue
    const decision = await scoreOpportunityForProfile({
      profileContext: ctx,
      opportunity,
      computeMatchDecision,
    })
    out.push({ profile_id: profileId, ...decision })
  }
  return out
}

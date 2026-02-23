function normalizeString(value) {
  if (typeof value !== 'string') return ''
  return value.trim()
}

function normalizeLower(value) {
  return normalizeString(value).toLowerCase()
}

function isPlainObject(value) {
  return Boolean(value) && Object.prototype.toString.call(value) === '[object Object]'
}

function uniqueStrings(values = []) {
  const out = []
  const seen = new Set()
  for (const value of values) {
    const normalized = normalizeString(String(value || ''))
    if (!normalized) continue
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(normalized)
  }
  return out
}

function ensureArray(value) {
  if (Array.isArray(value)) return value
  if (value === null || value === undefined) return []
  return [value]
}

function isValidHttpUrl(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function inferEligibilityBullets(raw) {
  if (Array.isArray(raw?.eligibility_bullets)) return raw.eligibility_bullets
  if (typeof raw?.eligibility === 'string' && raw.eligibility.trim().length > 0) {
    return raw.eligibility
      .split(/[\n;]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, 8)
  }
  return []
}

export function resolveCrawlerContext(profileOrContext, options = {}) {
  const context =
    profileOrContext &&
    typeof profileOrContext === 'object' &&
    profileOrContext.profile &&
    typeof profileOrContext.profile === 'object'
      ? profileOrContext
      : {
          profile: profileOrContext ?? {},
          sections: profileOrContext?.sections ?? {},
          signals: profileOrContext?.signals ?? null,
          facets: profileOrContext?.facets ?? {},
          trace: profileOrContext?.trace ?? {},
          queryPlan: options?.query_plan ?? null,
        }

  return {
    context,
    profile: context.profile ?? {},
    sections: context.sections ?? {},
    signals: context.signals ?? context.profile?.signals ?? null,
    facets: context.facets ?? {},
    trace: context.trace ?? {},
    queryPlan: context.queryPlan ?? options?.query_plan ?? null,
  }
}

export function mergePlanKeywords(baseKeywords = [], queryPlan = null) {
  const fromPlan = [
    ...(Array.isArray(queryPlan?.mustTerms) ? queryPlan.mustTerms : []),
    ...(Array.isArray(queryPlan?.shouldTerms) ? queryPlan.shouldTerms : []),
  ]
  return uniqueStrings([...baseKeywords, ...fromPlan])
}

export function violatesMustNot(rawOpportunity, queryPlan = null) {
  const mustNot = Array.isArray(queryPlan?.mustNotTerms) ? queryPlan.mustNotTerms : []
  if (mustNot.length === 0) return false
  const text = normalizeLower(
    `${rawOpportunity?.title || ''} ${rawOpportunity?.description || ''} ${
      Array.isArray(rawOpportunity?.keywords) ? rawOpportunity.keywords.join(' ') : ''
    } ${Array.isArray(rawOpportunity?.categories) ? rawOpportunity.categories.join(' ') : ''}`,
  )
  return mustNot.some((term) => {
    const needle = normalizeLower(term)
    return needle && text.includes(needle)
  })
}

export function enforceCrawlerOpportunityContract(
  rawOpportunity,
  {
    crawlerType,
    facets = {},
    queryPlan = null,
    recordOrigin = null,
    sourceFallback = null,
    includeFacetReasons = true,
  } = {},
) {
  if (!isPlainObject(rawOpportunity)) return null
  if (violatesMustNot(rawOpportunity, queryPlan)) return null

  const title = normalizeString(rawOpportunity.title || rawOpportunity.name || '')
  if (!title) return null

  const url = rawOpportunity.url || rawOpportunity.application_url || rawOpportunity.source_url || null
  if (!isValidHttpUrl(url)) return null

  const description = normalizeString(rawOpportunity.description || rawOpportunity.summary || title)
  const keywords = uniqueStrings(ensureArray(rawOpportunity.keywords))
  const categories = uniqueStrings(ensureArray(rawOpportunity.categories))
  const eligibilityBullets = uniqueStrings(inferEligibilityBullets(rawOpportunity))

  const facetReasons = includeFacetReasons
    ? uniqueStrings([
        facets?.profile?.primary_profile_type
          ? `Profile type: ${String(facets.profile.primary_profile_type).replace(/_/g, ' ')}`
          : '',
        facets?.geo?.state ? `State context: ${String(facets.geo.state).toUpperCase()}` : '',
        facets?.intent?.primary_need_category && facets.intent.primary_need_category !== 'unknown'
          ? `Intent category: ${String(facets.intent.primary_need_category).replace(/_/g, ' ')}`
          : '',
      ])
    : []

  const matchReasons = uniqueStrings([
    ...(Array.isArray(rawOpportunity.match_reasons) ? rawOpportunity.match_reasons : []),
    ...facetReasons,
  ])

  const normalized = {
    ...rawOpportunity,
    title,
    sponsor: rawOpportunity.sponsor ?? rawOpportunity.funder ?? sourceFallback ?? null,
    description: description || null,
    source: rawOpportunity.source ?? sourceFallback ?? crawlerType,
    source_url: rawOpportunity.source_url ?? url,
    application_url: rawOpportunity.application_url ?? url,
    url,
    categories,
    keywords,
    eligibility_bullets: eligibilityBullets,
    opportunity_type: rawOpportunity.opportunity_type ?? rawOpportunity.type ?? 'program',
    record_origin:
      rawOpportunity.record_origin ??
      recordOrigin ??
      (String(rawOpportunity.opportunity_type || '').toLowerCase() === 'program' ? 'directory_resource' : 'live_crawl'),
    crawler_type: crawlerType,
    match_reasons: matchReasons,
  }

  return normalized
}

export default {
  resolveCrawlerContext,
  mergePlanKeywords,
  violatesMustNot,
  enforceCrawlerOpportunityContract,
}

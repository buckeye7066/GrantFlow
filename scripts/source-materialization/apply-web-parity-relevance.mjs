#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const file = path.resolve('backend/services/webParityBenchmark.js')
let source = fs.readFileSync(file, 'utf8')

const RELEVANCE_SIGNATURE = 'export function isBenchmarkRelevantHit'
const SOURCE_QUALITY_SIGNATURE = 'export function isGenericFundingPortalHit'
const QUEUE_REFRESH_SIGNATURE = 'function isTerminalGapStatus'
const TOP_EVIDENCE_SIGNATURE = 'const WEB_ONLY_TOP_CAP = 20'

function replaceOnce(before, after, label) {
  const first = source.indexOf(before)
  if (first < 0 || first !== source.lastIndexOf(before)) {
    throw new Error(`[web-parity-relevance] ${label} missing or ambiguous`)
  }
  source = source.replace(before, after)
}

function replaceRange(startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker)
  const end = start < 0 ? -1 : source.indexOf(endMarker, start + startMarker.length)
  if (start < 0 || end < 0) {
    throw new Error(`[web-parity-relevance] ${label} markers missing`)
  }
  if (
    source.indexOf(startMarker, start + startMarker.length) >= 0 ||
    source.indexOf(endMarker, end + endMarker.length) >= 0
  ) {
    throw new Error(`[web-parity-relevance] ${label} markers ambiguous`)
  }
  source = source.slice(0, start) + replacement + source.slice(end)
}

if (!source.includes(RELEVANCE_SIGNATURE)) {
  const fundingMarker = `/** Text signal that a page is about money an applicant can get. */
const FUNDING_SIGNAL_RE =
  /\\b(grants?|scholarships?|funding|funds?|assistance|awards?|stipends?|fellowships?|benefits?|relief|financial aid)\\b/i
`

  const relevanceHelpers = `${fundingMarker}
/**
 * Search results that mention money are not automatically funding opportunities
 * for THIS profile. The live 2026-07-29 benchmark counted a Czech government
 * board, a generic Grants.gov search page, an NPS grants index, and a foundation's
 * past-grantee list as recall misses for two Tennessee individuals. Those are
 * search-session noise, not evidence that GrantFlow omitted an actionable match.
 */
const HISTORICAL_OR_INDEX_PAGE_RE =
  /\\b(our grantees|past grantees|grant recipients|awards made|funded projects|search grants|browse grants|grant search|grants database|grant database|grants overview|funding opportunities search)\\b/i
const GENERIC_GRANTS_TITLE_RE = /^(?:search |browse |find )?(?:available )?grants?(?:\\s*\\([^)]*\\))?$/i
const ACTIONABLE_PROGRAM_RE =
  /\\b(apply|application|applications open|accepting applications|eligib(?:le|ility)|deadline|financial assistance|scholarship|stipend|voucher|benefit|relief program|assistance program)\\b/i
const INDIVIDUAL_SIGNAL_RE =
  /\\b(individuals?|famil(?:y|ies)|households?|patients?|students?|veterans?|caregivers?|people|persons?|children|adults?|seniors?|residents?|homeowners?|renters?|workers?|employees?|wheelchair|mobility|medical bills?|utility assistance|rent assistance|home repair|tuition)\\b/i
const ORGANIZATION_SIGNAL_RE =
  /\\b(nonprofits?|not[- ]for[- ]profits?|organizations?|businesses?|companies|schools?|districts?|municipalities|local governments?|public agencies|institutions?|tribal governments?|fire departments?|churches?|ministries)\\b/i
const INDIVIDUAL_APPLICANT_TYPES = new Set([
  'individual', 'family', 'student', 'high_school_student', 'college_student',
  'graduate_student', 'medical_need', 'medical_assistance', 'individual_need',
  'senior', 'veteran', 'disabled_adult', 'homeschool_family',
])

const NEED_SEMANTIC_RULES = Object.freeze([
  { need: /\\b(disabil|mobility|wheelchair|accessib|assistive|adaptive)\\w*/i, hit: /\\b(disabil|mobility|wheelchair|accessib|assistive|adaptive)\\w*/i },
  { need: /\\b(medical|health|cancer|disease|illness|patient|treatment|medication|hospital)\\w*/i, hit: /\\b(medical|health|cancer|disease|illness|patient|treatment|medication|hospital|clinical)\\w*/i },
  { need: /\\b(transport|vehicle|van|car)\\w*/i, hit: /\\b(transport|vehicle|van|car|mobility)\\w*/i },
  { need: /\\b(education|school|college|student|tuition|training|scholarship)\\w*/i, hit: /\\b(education|school|college|student|tuition|training|scholarship|academic)\\w*/i },
  { need: /\\b(housing|home|rent|mortgage|shelter|utility|repair)\\w*/i, hit: /\\b(housing|home|rent|mortgage|shelter|utility|repair|weatherization)\\w*/i },
  { need: /\\b(caregiver|respite|caregiving)\\w*/i, hit: /\\b(caregiver|respite|caregiving|family care)\\w*/i },
  { need: /\\b(food|nutrition|meal|pantry)\\w*/i, hit: /\\b(food|nutrition|meal|pantry|grocer)\\w*/i },
  { need: /\\b(veteran|military|service member)\\w*/i, hit: /\\b(veteran|military|service member|armed forces)\\w*/i },
  { need: /\\b(emergency|hardship|low income|financial|debt|relief|benefit)\\w*/i, hit: /\\b(emergency|hardship|low income|financial assistance|debt relief|benefit|cash assistance)\\w*/i },
  { need: /\\b(business|startup|entrepreneur|workforce|employment)\\w*/i, hit: /\\b(business|startup|entrepreneur|workforce|employment|job training)\\w*/i },
  { need: /\\b(nonprofit|community|ministry|church|program)\\w*/i, hit: /\\b(nonprofit|community|ministry|church|program)\\w*/i },
])

const NEED_TOKEN_STOPWORDS = new Set([
  'assistance', 'funding', 'grant', 'grants', 'help', 'need', 'needs', 'program',
  'programs', 'service', 'services', 'support', 'individual', 'general',
])

function normalizedHitText(hit) {
  return [hit?.title ?? '', hit?.snippet ?? '', hit?.url ?? '']
    .join(' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\\s+/g, ' ')
    .trim()
}

/** Foreign public-sector pages are outside a US-profile benchmark. */
export function isForeignGovernmentHit(url) {
  const domain = extractHostname(url)
  if (!domain || domain.endsWith('.gov') || domain.endsWith('.mil')) return false
  return /(?:^|\\.)(?:gov|gob|gouv|go)\\.[a-z]{2,3}$/i.test(domain)
}

function needMatchesHit(hit, needs = []) {
  const text = normalizedHitText(hit)
  const normalizedNeeds = (Array.isArray(needs) ? needs : [])
    .map((need) => String(need || '').replace(/[_-]+/g, ' ').trim())
    .filter(Boolean)
  if (normalizedNeeds.length === 0) return true

  for (const need of normalizedNeeds) {
    if (need.length >= 3 && text.toLowerCase().includes(need.toLowerCase())) return true
    if (NEED_SEMANTIC_RULES.some((rule) => rule.need.test(need) && rule.hit.test(text))) return true
    const tokens = need
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4 && !NEED_TOKEN_STOPWORDS.has(token))
    if (tokens.some((token) => new RegExp('\\\\b' + token + '\\\\b', 'i').test(text))) return true
  }
  return false
}

function applicantMatchesHit(hit, applicantTypes = []) {
  const types = (Array.isArray(applicantTypes) ? applicantTypes : [])
    .map((type) => String(type || '').trim().toLowerCase())
    .filter(Boolean)
  if (types.length === 0) return true

  const text = normalizedHitText(hit)
  const hasIndividual = types.some((type) => INDIVIDUAL_APPLICANT_TYPES.has(type))
  const hasOrganization = types.some((type) => !INDIVIDUAL_APPLICANT_TYPES.has(type))
  if (hasIndividual && hasOrganization) return true

  if (hasIndividual) {
    if (INDIVIDUAL_SIGNAL_RE.test(text)) return true
    if (ORGANIZATION_SIGNAL_RE.test(text)) return false
    return ACTIONABLE_PROGRAM_RE.test(text)
  }

  if (ORGANIZATION_SIGNAL_RE.test(text)) return true
  const typeText = types.join(' ').replace(/_/g, ' ')
  return typeText.split(/\\s+/).some((token) => token.length >= 4 && text.toLowerCase().includes(token))
}

/**
 * True only when a non-overlapping web hit is a plausible actionable funding
 * source for the benchmarked profile. Identity-confirmed overlaps are allowed by
 * classifyWebResults before this gate, so sparse snippets never erase proof that
 * GrantFlow already covers a page.
 */
export function isBenchmarkRelevantHit(hit, { needs = [], applicantTypes = [] } = {}) {
  if (!isRealFundingHit(hit)) return false
  if (isForeignGovernmentHit(hit?.url)) return false

  const title = String(hit?.title || '').trim()
  const text = normalizedHitText(hit)
  if (HISTORICAL_OR_INDEX_PAGE_RE.test(text)) return false
  if (GENERIC_GRANTS_TITLE_RE.test(title) && !ACTIONABLE_PROGRAM_RE.test(text)) return false
  if (!needMatchesHit(hit, needs)) return false
  return applicantMatchesHit(hit, applicantTypes)
}
`

  replaceOnce(fundingMarker, relevanceHelpers, 'funding marker')

  replaceOnce(
    `export function classifyWebResults(webHits, storedMatches, { needs = [], state = null } = {}) {`,
    `export function classifyWebResults(webHits, storedMatches, { needs = [], state = null, applicantTypes = [] } = {}) {`,
    'classify signature',
  )

  replaceOnce(
    `    const covers =
      storedUrlKeys.has(urlKey) ||
      (titleKey && storedTitleKeys.has(titleKey)) ||
      (domain && storedDomains.has(domain))

    if (covers) {`,
    `    const covers =
      storedUrlKeys.has(urlKey) ||
      (titleKey && storedTitleKeys.has(titleKey)) ||
      (domain && storedDomains.has(domain))

    // A confirmed overlap is evidence GrantFlow already covers the web page,
    // even when the search snippet is sparse. Only a purported NEW miss must
    // prove that it is relevant and actionable for this profile.
    if (!covers && !isBenchmarkRelevantHit(hit, { needs, applicantTypes })) continue
    webReal += 1

    if (covers) {`,
    'relevance gate',
  )

  replaceOnce(
    `    seen.add(urlKey)
    webReal += 1

    const titleKey = titleIdentityKey(hit.title) || ''`,
    `    seen.add(urlKey)

    const titleKey = titleIdentityKey(hit.title) || ''`,
    'web-real counter move',
  )

  replaceOnce(
    `    const needs = Array.isArray(thesis.needs) ? thesis.needs : []
    const profileState = thesis?.location?.state ?? null
    const { overlap, web_only, grantflow_only, web_real } = classifyWebResults(hits, stored, { needs, state: profileState })`,
    `    const needs = Array.isArray(thesis.needs) ? thesis.needs : []
    const applicantTypes = Array.isArray(thesis.applicant_types)
      ? thesis.applicant_types
      : (Array.isArray(thesis.applicantTypes) ? thesis.applicantTypes : [])
    const profileState = thesis?.location?.state ?? null
    const { overlap, web_only, grantflow_only, web_real } = classifyWebResults(hits, stored, {
      needs,
      state: profileState,
      applicantTypes,
    })`,
    'profile context handoff',
  )

  replaceOnce(
    `  normalizeUrlKey,
  isRealFundingHit,
  parityScore,`,
    `  normalizeUrlKey,
  isRealFundingHit,
  isForeignGovernmentHit,
  isBenchmarkRelevantHit,
  parityScore,`,
    'default exports',
  )
}

if (!source.includes(SOURCE_QUALITY_SIGNATURE)) {
  replaceOnce(
    `  'disabilityguidance.org',
]))`,
    `  'disabilityguidance.org',
  // Search/listing/referral sites observed in the final 2026-07-29 benchmark.
  // They point applicants elsewhere and are not direct award opportunities.
  'thegrantportal.com',
  'disability-grants.org',
  'themobilityresource.com',
]))`,
    'source-quality noise domains',
  )

  replaceOnce(
    `  if (!domain || AGGREGATOR_NOISE_DOMAINS.has(domain)) return false`,
    `  if (
    !domain ||
    [...AGGREGATOR_NOISE_DOMAINS].some(
      (noiseDomain) => domain === noiseDomain || domain.endsWith('.' + noiseDomain),
    )
  ) return false`,
    'subdomain-aware noise filter',
  )

  replaceOnce(
    `const WEB_ONLY_TOP_CAP = 5`,
    `const WEB_ONLY_TOP_CAP = 20`,
    'expanded web-only evidence',
  )

  replaceOnce(
    `  return applicantMatchesHit(hit, applicantTypes)
}

/**
 * True only when a non-overlapping web hit is a plausible actionable funding`,
    `  return applicantMatchesHit(hit, applicantTypes)
}

const GENERIC_PORTAL_TITLE_RE =
  /^(?:home|search grants|browse grants|find grants|grant search|funding opportunities)(?:\\s*[|–—-]\\s*grants?\\.gov)?$/i
const GENERIC_GRANTS_GOV_PATH_RE =
  /^\\/(?:$|search-grants\\/?$|learn-grants(?:\\/.*)?$|applicants(?:\\/.*)?$|grantors(?:\\/.*)?$|support(?:\\/.*)?$)/i

/**
 * A federal or state portal can contain real opportunities without being one.
 * Only a specific opportunity/detail page belongs in the direct-recall metric.
 */
export function isGenericFundingPortalHit(hit) {
  const url = String(hit?.url || '').trim()
  const domain = extractHostname(url)
  const title = String(hit?.title || '').trim()
  if (GENERIC_PORTAL_TITLE_RE.test(title)) return true
  if (domain !== 'grants.gov') return false
  try {
    return GENERIC_GRANTS_GOV_PATH_RE.test(new URL(url).pathname || '/')
  } catch {
    return true
  }
}

/** Final direct-source gate for a purported web-only recall miss. */
export function isBenchmarkDirectFundingHit(hit, context = {}) {
  return isBenchmarkRelevantHit(hit, context) && !isGenericFundingPortalHit(hit)
}

/**
 * True only when a non-overlapping web hit is a plausible actionable funding`,
    'direct-funding quality helpers',
  )

  replaceOnce(
    `if (!covers && !isBenchmarkRelevantHit(hit, { needs, applicantTypes })) continue`,
    `if (!covers && !isBenchmarkDirectFundingHit(hit, { needs, applicantTypes })) continue`,
    'direct-funding classification gate',
  )

  replaceOnce(
    `  isForeignGovernmentHit,
  isBenchmarkRelevantHit,
  parityScore,`,
    `  isForeignGovernmentHit,
  isBenchmarkRelevantHit,
  isGenericFundingPortalHit,
  isBenchmarkDirectFundingHit,
  parityScore,`,
    'direct-funding default exports',
  )
}

if (!source.includes(QUEUE_REFRESH_SIGNATURE)) {
  const refreshedQueueFunction = `function isTerminalGapStatus(value) {
  return new Set(['adopted', 'gated_out', 'dismissed']).has(
    String(value || '').trim().toLowerCase(),
  )
}

function gapCandidateKey(candidate) {
  const profileId = String(candidate?.profile_id || '').trim()
  const urlKey = normalizeUrlKey(candidate?.url)
  return profileId && urlKey ? profileId + '|' + urlKey : ''
}

/**
 * Refresh the benchmark-owned pending queue to the latest scoped run.
 *
 * Terminal decisions and candidates owned by other producers are retained.
 * Pending web-parity candidates that disappeared from the latest run are pruned,
 * preventing generic portals and previously filtered noise from being re-seeded
 * forever. Scoped profile ids make partial/manual runs non-destructive.
 */
export async function appendGapCandidates(
  db,
  entries = [],
  { now = new Date(), profileIds = null } = {},
) {
  if (!db?.prepare) return { appended: 0, refreshed: 0, pruned: 0, total: 0 }

  const incoming = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && entry.url && entry.profile_id)
  const explicitScope = Array.isArray(profileIds)
    ? profileIds.map(String).filter(Boolean)
    : []
  const inferredScope = [...new Set(incoming.map((entry) => String(entry.profile_id)))]
  const scope = new Set(explicitScope.length ? explicitScope : inferredScope)
  const existing = await readWebParityGapQueue(db)
  const currentKeys = new Set(incoming.map(gapCandidateKey).filter(Boolean))
  const previousPending = new Map()
  const byKey = new Map()

  let pruned = 0
  let refreshed = 0
  let appended = 0

  for (const candidate of existing) {
    const key = gapCandidateKey(candidate)
    if (!key) continue
    const sourceName = String(candidate?.source || 'web_parity_benchmark')
    const terminal = isTerminalGapStatus(candidate?.status)
    const inScope = scope.has(String(candidate?.profile_id || ''))

    if (sourceName === 'web_parity_benchmark' && !terminal && inScope) {
      previousPending.set(key, candidate)
      if (currentKeys.has(key)) refreshed += 1
      else pruned += 1
      continue
    }
    byKey.set(key, candidate)
  }

  const at = (now instanceof Date ? now : new Date(now)).toISOString()
  for (const entry of incoming) {
    const key = gapCandidateKey(entry)
    if (!key || byKey.has(key)) continue
    if (!previousPending.has(key)) appended += 1
    byKey.set(key, {
      url: String(entry.url).trim(),
      title: String(entry.title || '').trim().slice(0, 200),
      profile_id: entry.profile_id,
      need: entry.need ?? null,
      domain: entry.domain ?? extractHostname(entry.url) ?? null,
      source: entry.source ?? 'web_parity_benchmark',
      status: 'candidate',
      found_at: at,
    })
  }

  const candidates = [...byKey.values()].slice(-GAP_QUEUE_CAP)
  await kvSet(db, GAP_QUEUE_KV_KEY, { updated_at: at, candidates }, at)
  return {
    appended,
    refreshed,
    pruned,
    total: candidates.length,
    scoped_profiles: scope.size,
  }
}

`

  replaceRange(
    `export async function appendGapCandidates(`,
    `/**
 * Seed pages for ONE profile's next discovery run`,
    refreshedQueueFunction,
    'benchmark gap-queue refresh',
  )

  replaceOnce(
    `result.gap_queue = await appendGapCandidates(db, gapEntries, { now })`,
    `result.gap_queue = await appendGapCandidates(db, gapEntries, {
        now,
        profileIds: golden.map((profile) => profile.profile_id),
      })`,
    'gap-queue scope handoff',
  )
}

const required = [
  RELEVANCE_SIGNATURE,
  SOURCE_QUALITY_SIGNATURE,
  QUEUE_REFRESH_SIGNATURE,
  TOP_EVIDENCE_SIGNATURE,
]
const missing = required.filter((signature) => !source.includes(signature))
if (missing.length > 0) {
  throw new Error('[web-parity-relevance] final signatures missing: ' + missing.join(', '))
}

fs.writeFileSync(file, source)
console.log('[source-materialization] web-parity relevance, direct-source quality, and queue convergence applied')

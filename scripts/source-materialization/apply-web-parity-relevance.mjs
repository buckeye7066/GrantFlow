#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const file = path.resolve('backend/services/webParityBenchmark.js')
let source = fs.readFileSync(file, 'utf8')

if (source.includes('export function isBenchmarkRelevantHit')) {
  console.log('[source-materialization] web-parity relevance correction already present')
  process.exit(0)
}

function replaceOnce(before, after, label) {
  const first = source.indexOf(before)
  if (first < 0 || first !== source.lastIndexOf(before)) {
    throw new Error(`[web-parity-relevance] ${label} missing or ambiguous`)
  }
  source = source.replace(before, after)
}

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

fs.writeFileSync(file, source)
console.log('[source-materialization] web-parity profile relevance correction applied')

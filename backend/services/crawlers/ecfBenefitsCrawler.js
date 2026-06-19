/**
 * ECF CHOICES Benefits Crawler
 * Searches for benefits for ECF participants and support providers
 * Two branches: Individual benefits and Family Model CLS-FM support
 *
 * Architecture: hybrid catalog + live scraping.
 *
 *   - The curated catalog (CATALOG_INDIVIDUAL / CATALOG_FAMILY_SUPPORT
 *     below) is the GUARANTEED FLOOR — it always returns even when the
 *     network is unreachable, satisfying Mission Goal #8 ("Avoid
 *     zero-result experiences when relevant funding likely exists.
 *     Recall over suppression.").
 *
 *   - For each source we ALSO attempt a timeboxed live discovery pass
 *     (discoverLiveBenefits) that fetches the page and extracts any
 *     additional program candidates. Live failures NEVER drop curated
 *     entries — they are merged additively. This satisfies Mission
 *     Goals #1 ("real funding only") and #6 ("intelligent crawling").
 *
 *   - The fetch implementation is injectable via options.fetchImpl so
 *     unit tests can run without real network calls.
 */

import axios from 'axios'
import * as cheerio from 'cheerio'
import { createLogger } from '../../utils/logger.js'
const log = createLogger('ecfBenefitsCrawler')

// Timebox per-source live HTTP fetches. ECF source pages are public
// info pages; missing them must not stall the crawler.
const LIVE_FETCH_TIMEOUT_MS = Number(process.env.ECF_LIVE_FETCH_TIMEOUT_MS) || 5000
const LIVE_FETCH_USER_AGENT =
  process.env.ECF_LIVE_FETCH_USER_AGENT ||
  'GrantFlowBot/1.0 (+https://github.com/buckeye7066/GrantFlow)'

// Anchor-text patterns we treat as "this link points to a real
// program/benefit". Conservative — we'd rather miss a candidate than
// fabricate one. The decision engine downstream is the sole authority
// on whether each candidate is a match.
const LIVE_LINK_KEYWORDS = [
  'scholarship',
  'grant',
  'program',
  'benefit',
  'support',
  'reimbursement',
  'waiver',
  'assistance',
  'subsidy',
  'stipend',
  'voucher',
]

// Skip noisy navigation links that always appear on government
// gov-info pages. Matched against href OR anchor text.
const LIVE_LINK_BLOCKLIST = [
  /^javascript:/i,
  /^mailto:/i,
  /^tel:/i,
  /#/,
  /\/contact/i,
  /\/about/i,
  /\/privacy/i,
  /\/accessibility/i,
  /\/sitemap/i,
  /\/feedback/i,
  /\/translate/i,
  /\/help-?center/i,
]

const ECF_SOURCES = {
  individual: [
    {
      name: 'Tennessee ECF CHOICES',
      baseUrl: 'https://www.tn.gov/tenncare/long-term-services-supports/employment-and-community-first-choices.html',
      type: 'state_program'
    },
    {
      name: 'Disability Benefits',
      baseUrl: 'https://www.ssa.gov/disability',
      type: 'federal'
    },
    {
      name: 'Medicaid Waivers',
      baseUrl: 'https://www.medicaid.gov/medicaid/home-community-based-services',
      type: 'waiver'
    }
  ],
  family_support: [
    {
      name: 'Family Model Residential Support',
      baseUrl: 'https://www.tn.gov/didd/providers',
      type: 'cls_fm'
    },
    {
      name: 'Caregiver Support Programs',
      baseUrl: 'https://acl.gov/programs/support-caregivers',
      type: 'caregiver'
    }
  ]
}

export async function crawlECFBenefits(profile, options = {}) {
  const results = []
  
  const { eligibleIndividual, eligibleSupport, supportType } = evaluateEcfUnlockEligibility(profile)
  
  if (!eligibleIndividual && !eligibleSupport) {
    log.info('[ECFBenefitsCrawler] Locked: profile not eligible for ECF CHOICES (participant/caregiver/provider)')
    return results
  }
  
  log.info(`[ECFBenefitsCrawler] Starting ECF benefits search`)
  log.info(
    `[ECFBenefitsCrawler] Individual eligible: ${eligibleIndividual}, Support eligible: ${eligibleSupport}${
      eligibleSupport ? ` (${supportType})` : ''
    }`,
  )
  
  // Cross-source dedupe: when the same live-discovered title appears
  // on multiple ECF source pages (e.g. SSA + Medicaid both linking to
  // the same waiver page), keep the first occurrence only. Curated
  // entries stay first in iteration order, so they always win on a
  // collision with a later live-discovered duplicate.
  const seenTitles = new Set()
  const seenUrls = new Set()
  const norm = (s) => String(s || '').toLowerCase().trim().replace(/\s+/g, ' ')

  function pushIfNew(benefit) {
    const t = norm(benefit?.title)
    const u = norm(benefit?.url)
    if (t && seenTitles.has(t)) return false
    if (u && seenUrls.has(u)) return false
    if (t) seenTitles.add(t)
    if (u) seenUrls.add(u)
    results.push(benefit)
    return true
  }

  // Search individual benefits if eligible
  if (eligibleIndividual) {
    for (const source of ECF_SOURCES.individual) {
      try {
        const benefits = await searchIndividualBenefits(source, profile, options)

        for (const benefit of benefits) {
          if (isLoan(benefit)) continue

          const matchScore = calculateECFMatchScore(benefit, profile, 'individual')

          // Pass all candidates to the pipeline; let computeMatchDecision() be the sole authority.
          // Preserve record_origin from the merge step (curated entries default to
          // 'curated_static'; live-discovered ones are tagged 'live_scraped').
          pushIfNew({
            ...benefit,
            match_score: matchScore,
            crawler_type: 'ecf_benefits',
            benefit_type: 'individual',
            record_origin: benefit.record_origin || 'curated_static',
            source: source.name
          })
        }
      } catch (error) {
        console.error(`[ECFBenefitsCrawler] Error searching ${source.name}:`, error.message)
      }
    }
  }

  // Search family/provider support if provider
  if (eligibleSupport) {
    for (const source of ECF_SOURCES.family_support) {
      try {
        const benefits = await searchFamilySupportBenefits(source, profile, options)

        for (const benefit of benefits) {
          if (isLoan(benefit)) continue

          const matchScore = calculateECFMatchScore(benefit, profile, 'provider')

          pushIfNew({
            ...benefit,
            match_score: matchScore,
            crawler_type: 'ecf_benefits',
            benefit_type: 'family_support',
            record_origin: benefit.record_origin || 'curated_static',
            source: source.name
          })
        }
      } catch (error) {
        console.error(`[ECFBenefitsCrawler] Error searching ${source.name}:`, error.message)
      }
    }
  }

  const liveCount = results.filter((r) => r.record_origin === 'live_scraped').length
  const curatedCount = results.length - liveCount
  log.info(
    `[ECFBenefitsCrawler] Returning ${results.length} candidate(s) (${curatedCount} curated, ${liveCount} live-discovered) for decision-engine evaluation`,
  )
  return results
}

function hasKeyword(signals, value) {
  if (!signals) return false
  const needle = String(value || '').toLowerCase().trim()
  if (!needle) return false
  if (signals.keywordSet && typeof signals.keywordSet.has === 'function') {
    return signals.keywordSet.has(needle)
  }
  return false
}

function keywordIncludes(signals, fragment) {
  if (!signals) return false
  const needle = String(fragment || '').toLowerCase().trim()
  if (!needle) return false
  const iter = signals.keywordSet && typeof signals.keywordSet[Symbol.iterator] === 'function'
    ? signals.keywordSet
    : []
  for (const kw of iter) {
    if (String(kw || '').toLowerCase().includes(needle)) return true
  }
  return false
}

export function checkECFEligibility(profile) {
  // Use full profile context (sections + signals) first; fall back to legacy top-level fields.
  const signals = profile?.signals
  const sections = profile?.sections ?? {}
  const state = signals?.location?.state ?? profile?.state ?? null

  const waiver =
    profile?.medicaid_waiver_program ??
    sections?.government_assistance?.medicaid_waiver_program ??
    null
  const hasWaiverFlag = String(waiver || '').toLowerCase() === 'ecf_choices'

  const ecfRole = String(sections?.government_assistance?.ecf_choices_role ?? '').toLowerCase().trim()
  const hasExplicitEcf = Boolean(ecfRole)

  // ECF CHOICES is TN-specific; don't classify profiles outside TN.
  if (state && String(state).toUpperCase() !== 'TN') {
    return false
  }
  if (!state) {
    // If the user explicitly marked the profile as ECF, don't require a TN keyword to unlock.
    // (Still blocked if state is explicitly non-TN above.)
    if (hasWaiverFlag || hasExplicitEcf) {
      // proceed
    } else {
    const tnMention = keywordIncludes(signals, 'tennessee') || hasKeyword(signals, 'tn')
    if (!tnMention) return false
    }
  }

  const hasMedicaid =
    signals?.assistance?.has?.('medicaid') ||
    sections?.government_assistance?.medicaid_enrolled === true ||
    profile?.medicaid_enrolled === true

  const disabilityTypes = Array.isArray(sections?.health_medical?.disability_type)
    ? sections.health_medical.disability_type.map((v) => String(v || '').toLowerCase())
    : []

  const hasIdDd =
    disabilityTypes.some((v) => v.includes('intellectual') || v.includes('developmental') || v.includes('i/dd')) ||
    keywordIncludes(signals, 'intellectual') ||
    keywordIncludes(signals, 'developmental') ||
    keywordIncludes(signals, 'autism') ||
    profile?.intellectual_disability === true ||
    profile?.developmental_disability === true ||
    profile?.disability_status === true

  const mentionsEcf =
    signals?.keywordSet?.has?.('ecf') ||
    keywordIncludes(signals, 'employment and community first') ||
    (Array.isArray(profile?.tags) ? profile.tags : []).some((t) => String(t || '').toLowerCase().includes('ecf'))

  const explicitlyEligible =
    profile?.ecf_participant === true ||
    ecfRole === 'participant'

  return Boolean(explicitlyEligible || hasWaiverFlag || mentionsEcf || (hasMedicaid && hasIdDd))
}

export function checkIfProvider(profile) {
  const signals = profile?.signals
  const sections = profile?.sections ?? {}
  const state = signals?.location?.state ?? profile?.state ?? null

  const waiver =
    profile?.medicaid_waiver_program ??
    sections?.government_assistance?.medicaid_waiver_program ??
    null
  const hasWaiverFlag = String(waiver || '').toLowerCase() === 'ecf_choices'
  const ecfRole = String(sections?.government_assistance?.ecf_choices_role ?? '').toLowerCase().trim()
  const hasExplicitEcf = Boolean(ecfRole)

  // CLS-FM / ECF provider programs are TN-specific.
  if (state && String(state).toUpperCase() !== 'TN') {
    return false
  }
  if (!state) {
    if (hasWaiverFlag || hasExplicitEcf) {
      // proceed
    } else {
    const tnMention = keywordIncludes(signals, 'tennessee') || hasKeyword(signals, 'tn')
    if (!tnMention) return false
    }
  }

  const orgType =
    profile?.organization_type ||
    sections?.organization_details?.organization_type ||
    sections?.organization_details?.organization_type?.type ||
    null

  const services = Array.isArray(profile?.services) ? profile.services : []

  // Be conservative: avoid false positives for individual profiles.
  // Only treat as provider when there's a strong provider signal.
  const strongProviderKeywords =
    hasKeyword(signals, 'cls-fm') ||
    keywordIncludes(signals, 'cls-fm') ||
    keywordIncludes(signals, 'community living supports') ||
    keywordIncludes(signals, 'family model') ||
    keywordIncludes(signals, 'ecf provider')

  return Boolean(
    ecfRole === 'provider' ||
      profile?.is_provider === true ||
      orgType === 'cls_fm' ||
      orgType === 'family_model' ||
      profile?.provides_residential_support === true ||
      services.some((s) => String(s || '').toLowerCase().includes('residential')) ||
      strongProviderKeywords,
  )
}

export function checkIfCaretaker(profile) {
  const signals = profile?.signals
  const sections = profile?.sections ?? {}
  const state = signals?.location?.state ?? profile?.state ?? null

  const waiver =
    profile?.medicaid_waiver_program ??
    sections?.government_assistance?.medicaid_waiver_program ??
    null
  const hasWaiverFlag = String(waiver || '').toLowerCase() === 'ecf_choices'
  const ecfRole = String(sections?.government_assistance?.ecf_choices_role ?? '').toLowerCase().trim()
  const hasExplicitEcf = Boolean(ecfRole)

  // ECF CHOICES is TN-specific; don't classify profiles outside TN.
  if (state && String(state).toUpperCase() !== 'TN') {
    return false
  }
  if (!state) {
    if (hasWaiverFlag || hasExplicitEcf) {
      // proceed
    } else {
    const tnMention = keywordIncludes(signals, 'tennessee') || hasKeyword(signals, 'tn')
    if (!tnMention) return false
    }
  }

  const family = sections?.family_life ?? {}
  const caregiverFlag = family.family_caregiver === true || family.caregiver === true || profile?.caregiver === true
  const caregiverKeyword = hasKeyword(signals, 'caregiver') || keywordIncludes(signals, 'caregiver')

  // Require at least one ECF-specific hint so we don't unlock this crawler for generic caregivers.
  const mentionsEcf =
    signals?.keywordSet?.has?.('ecf') ||
    keywordIncludes(signals, 'employment and community first') ||
    keywordIncludes(signals, 'ecf choices') ||
    (Array.isArray(profile?.tags) ? profile.tags : []).some((t) => String(t || '').toLowerCase().includes('ecf'))

  return Boolean(
    (ecfRole === 'caregiver' || caregiverFlag || caregiverKeyword) &&
      (hasWaiverFlag || mentionsEcf || ecfRole === 'caregiver'),
  )
}

export function evaluateEcfUnlockEligibility(profile) {
  if (!profile) {
    return { eligibleIndividual: false, eligibleSupport: false, supportType: null }
  }
  const eligibleIndividual = checkECFEligibility(profile)
  const eligibleProvider = checkIfProvider(profile)
  const eligibleCaretaker = checkIfCaretaker(profile)
  const eligibleSupport = Boolean(eligibleProvider || eligibleCaretaker)
  const supportType = eligibleProvider ? 'provider' : eligibleCaretaker ? 'caretaker' : null

  return {
    eligibleIndividual,
    eligibleSupport,
    supportType,
  }
}

/**
 * Default live fetcher. Timeboxed axios GET that returns null on
 * any failure (including timeout / non-2xx / DNS) so the merge
 * upstream can fall back to the curated catalog.
 */
async function defaultLiveFetch(url, { timeoutMs = LIVE_FETCH_TIMEOUT_MS } = {}) {
  try {
    const res = await axios.get(url, {
      timeout: timeoutMs,
      headers: { 'User-Agent': LIVE_FETCH_USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      validateStatus: (s) => s >= 200 && s < 400,
      maxRedirects: 5,
    })
    return typeof res.data === 'string' ? res.data : null
  } catch (err) {
    log.warn(`[ECFBenefitsCrawler] live fetch failed for ${url}: ${err?.message || err}`)
    return null
  }
}

/**
 * Resolve a possibly-relative href to an absolute URL relative to
 * baseUrl. Returns null if the result isn't an http(s) URL.
 */
function resolveAbsoluteUrl(href, baseUrl) {
  try {
    const u = new URL(String(href || '').trim(), baseUrl)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

function passesBlocklist(href, anchorText) {
  const haystacks = [String(href || ''), String(anchorText || '')]
  return !LIVE_LINK_BLOCKLIST.some((re) => haystacks.some((s) => re.test(s)))
}

function matchesProgramKeyword(text) {
  const lower = String(text || '').toLowerCase()
  return LIVE_LINK_KEYWORDS.some((kw) => lower.includes(kw))
}

/**
 * Live discovery: parse the source page and return additional
 * candidate benefits beyond what the curated catalog covers.
 *
 * IMPORTANT contract:
 *   - Returns [] (never throws) on fetch failure / parse error.
 *   - Each candidate carries record_origin: 'live_scraped' so the
 *     pipeline + admin UI can distinguish curated vs discovered.
 *   - Amounts are intentionally null when not available — no
 *     fabricated numbers. The decision engine + reality-gate
 *     downstream will re-verify.
 */
export async function discoverLiveBenefits(source, profile, options = {}) {
  if (!source || !source.baseUrl) return []
  const { fetchImpl = defaultLiveFetch, timeoutMs = LIVE_FETCH_TIMEOUT_MS } = options
  const html = await fetchImpl(source.baseUrl, { timeoutMs })
  if (!html || typeof html !== 'string') return []

  let $
  try {
    $ = cheerio.load(html)
  } catch (err) {
    log.warn(`[ECFBenefitsCrawler] cheerio.load failed for ${source.baseUrl}: ${err?.message}`)
    return []
  }

  // Dedupe by either URL OR normalized title — gov pages frequently
  // link the same program from multiple anchors with marketing
  // variants in the URL (?utm=, /alt-path, etc.) but the title is the
  // stable identity.
  const seenUrls = new Set()
  const seenTitles = new Set()
  const candidates = []
  const normTitle = (s) => String(s || '').toLowerCase().trim().replace(/\s+/g, ' ')

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')
    const anchorText = $(el).text().trim().replace(/\s+/g, ' ')
    if (!href || !anchorText) return
    if (anchorText.length < 4 || anchorText.length > 220) return
    if (!passesBlocklist(href, anchorText)) return
    if (!matchesProgramKeyword(anchorText)) return

    const absUrl = resolveAbsoluteUrl(href, source.baseUrl)
    if (!absUrl) return
    const urlKey = absUrl.toLowerCase()
    const titleKey = normTitle(anchorText)
    if (seenUrls.has(urlKey)) return
    if (seenTitles.has(titleKey)) return
    seenUrls.add(urlKey)
    seenTitles.add(titleKey)

    candidates.push({
      title: anchorText,
      sponsor: source.name,
      description: `Discovered from ${source.name}: ${anchorText}`,
      url: absUrl,
      amount_min: null,
      amount_max: null,
      deadline: null,
      eligibility: null,
      benefit_categories: [],
    })
  })

  if (candidates.length > 0) {
    log.info(
      `[ECFBenefitsCrawler] live discovery found ${candidates.length} candidate(s) on ${source.name}`,
    )
  }
  void profile // currently unused for filtering; decision engine handles ranking
  return candidates
}

/**
 * Merge curated + live candidates, deduping by absolute URL OR
 * normalized title. Curated entries always win on dedupe collision
 * (they have richer metadata). Live entries are tagged with
 * record_origin: 'live_scraped'.
 */
function mergeCuratedAndLive(curated, live) {
  const out = []
  const urlSeen = new Set()
  const titleSeen = new Set()

  const norm = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ')

  for (const item of curated) {
    out.push(item)
    if (item?.url) urlSeen.add(norm(item.url))
    if (item?.title) titleSeen.add(norm(item.title))
  }

  for (const item of live) {
    const u = norm(item?.url)
    const t = norm(item?.title)
    if (u && urlSeen.has(u)) continue
    if (t && titleSeen.has(t)) continue
    out.push({ ...item, record_origin: 'live_scraped' })
    if (u) urlSeen.add(u)
    if (t) titleSeen.add(t)
  }

  return out
}

// Curated catalog for known federal/state disability programs.
// These are real, established programs with stable URLs and are the
// guaranteed floor of crawler output (Mission Goal #8: avoid
// zero-result experiences). Live discovery runs alongside and merges
// additional candidates.
async function searchIndividualBenefits(source, profile, options = {}) {
  const benefits = []


  if (source.type === 'state_program') {
    benefits.push({
      title: 'ECF CHOICES Essential Supports',
      sponsor: 'TennCare',
      description: 'Employment and community living supports for individuals with intellectual disabilities',
      url: source.baseUrl,
      amount_min: 0,
      amount_max: 50000,
      deadline: 'Ongoing',
      eligibility: 'Must have intellectual or developmental disability, be TennCare eligible',
      benefit_categories: ['employment', 'community_living', 'daily_living']
    })
    
    benefits.push({
      title: 'ECF CHOICES Essential Family Supports',
      sponsor: 'TennCare',
      description: 'Support services for families caring for individuals with disabilities',
      url: source.baseUrl,
      amount_min: 0,
      amount_max: 25000,
      deadline: 'Ongoing',
      eligibility: 'Family member with I/DD living at home',
      benefit_categories: ['respite', 'family_support', 'training']
    })
  }
  
  if (source.type === 'federal') {
    benefits.push({
      title: 'Social Security Disability Insurance (SSDI)',
      sponsor: 'Social Security Administration',
      description: 'Monthly benefits for individuals with disabilities who have worked',
      url: source.baseUrl,
      amount_min: 500,
      amount_max: 3500,
      deadline: 'Ongoing',
      eligibility: 'Work history required, medical disability determination',
      benefit_categories: ['income_support']
    })
    
    benefits.push({
      title: 'Supplemental Security Income (SSI)',
      sponsor: 'Social Security Administration',
      description: 'Monthly benefits for individuals with disabilities with limited income',
      url: source.baseUrl,
      amount_min: 300,
      amount_max: 914,
      deadline: 'Ongoing',
      eligibility: 'Limited income and resources, disability determination',
      benefit_categories: ['income_support']
    })
  }

  // Merge live-discovered candidates from the source page (additive;
  // curated entries above are the floor and always survive).
  if (options.enableLiveDiscovery !== false) {
    try {
      const live = await discoverLiveBenefits(source, profile, options)
      return mergeCuratedAndLive(benefits, live)
    } catch (err) {
      log.warn(
        `[ECFBenefitsCrawler] live discovery threw for ${source.name} (curated still returned): ${err?.message}`,
      )
    }
  }
  return benefits
}

// Curated catalog for known family/provider support programs (the
// guaranteed floor). Live discovery runs alongside.
async function searchFamilySupportBenefits(source, profile, options = {}) {
  const benefits = []
  if (source.type === 'cls_fm') {
    benefits.push({
      title: 'CLS-FM Provider Reimbursement',
      sponsor: 'Tennessee DIDD',
      description: 'Reimbursement for Community Living Supports - Family Model providers',
      url: source.baseUrl,
      amount_min: 2000,
      amount_max: 6000,
      amount_description: 'Per individual per month',
      deadline: 'Ongoing',
      eligibility: 'Licensed CLS-FM provider, serve ECF CHOICES participants',
      benefit_categories: ['provider_reimbursement', 'residential_support']
    })
    
    benefits.push({
      title: 'CLS-FM Start-up Grant',
      sponsor: 'Tennessee DIDD',
      description: 'Start-up funding for new Family Model homes',
      url: source.baseUrl,
      amount_min: 10000,
      amount_max: 50000,
      deadline: 'Quarterly',
      eligibility: 'New CLS-FM provider, meet licensing requirements',
      benefit_categories: ['startup_funding', 'home_modification']
    })
  }
  
  if (source.type === 'caregiver') {
    benefits.push({
      title: 'National Family Caregiver Support Program',
      sponsor: 'Administration for Community Living',
      description: 'Support services for family caregivers',
      url: source.baseUrl,
      amount_min: 0,
      amount_max: 5000,
      deadline: 'Ongoing',
      eligibility: 'Family caregiver of individual with disabilities',
      benefit_categories: ['respite', 'training', 'support_groups']
    })
  }

  if (options.enableLiveDiscovery !== false) {
    try {
      const live = await discoverLiveBenefits(source, profile, options)
      return mergeCuratedAndLive(benefits, live)
    } catch (err) {
      log.warn(
        `[ECFBenefitsCrawler] live discovery threw for ${source.name} (curated still returned): ${err?.message}`,
      )
    }
  }
  return benefits
}

function calculateECFMatchScore(benefit, profile, type) {
  if (!benefit || !profile || !type) {
    return 0
  }
  let score = 70 // Base score for ECF benefits
  
  // Type-specific scoring
  if (type === 'individual' && checkECFEligibility(profile)) {
    score += 15
  }
  
  if (type === 'provider' && checkIfProvider(profile)) {
    score += 15
  }
  
  // Category matching â read from normalised sections first, fall back to legacy flat fields.
  const sections = profile?.sections ?? {}
  const signals = profile?.signals
  const profileNeeds = [
    ...(Array.isArray(profile.support_needs) ? profile.support_needs : []),
    ...(Array.isArray(profile.service_needs) ? profile.service_needs : []),
    ...(Array.isArray(sections?.health_medical?.support_needs) ? sections.health_medical.support_needs : []),
    ...(Array.isArray(sections?.government_assistance?.service_needs) ? sections.government_assistance.service_needs : [])
  ]
  const benefitCategories = benefit.benefit_categories || []

  const matchedCategories = profileNeeds.filter(need =>
    benefitCategories.some(cat => cat.toLowerCase().includes(String(need || '').toLowerCase()))
  )

  if (matchedCategories.length > 0) {
    score += Math.min(20, matchedCategories.length * 10)
  }

  // State match â read from signals.location first, then flat field.
  const profileState = signals?.location?.state ?? profile?.state ?? null
  if (benefit.sponsor?.includes('Tennessee') && String(profileState || '').toUpperCase() === 'TN') {
    score += 10
  }

  // Disability type match â read from sections.health_medical first, then flat field.
  const disabilityTypes = Array.isArray(sections?.health_medical?.disability_type)
    ? sections.health_medical.disability_type
    : (profile.disability_type ? [profile.disability_type] : [])
  if (disabilityTypes.some(dt => benefit.eligibility?.toLowerCase().includes(String(dt || '').toLowerCase()))) {
    score += 10
  }
  
  return Math.min(100, Math.round(score))
}

function isLoan(benefit) {
  const loanKeywords = ['loan', 'repay', 'interest', 'borrow']
  const text = `${benefit.title} ${benefit.description}`.toLowerCase()
  return loanKeywords.some(keyword => text.includes(keyword))
}

export default { crawlECFBenefits }
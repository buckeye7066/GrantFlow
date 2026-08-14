import { createLogger } from '../../utils/logger.js'
const qualityLog = createLogger('services:crawlers:domainCrawlerEngine')
/**
 * Domain Template Crawler Engine
 * Registry-driven crawler runner that supports 50–100+ crawler types without duplicating logic.
 * - Every opportunity MUST have a URL (url or application_url or source_url).
 * - No fake results. If we can't provide a real URL, do not return the item.
 * - Directory resources always included; live fetchers best-effort, never throw.
 */

/**
 * Returns null if title missing or no URL exists.
 * Enforces: every opportunity must have a real URL.
 */
export function normalizeOpportunity(raw, crawlerType) {
  if (!raw || typeof raw !== 'object') return null

  const title = raw.title ?? raw.name ?? null
  const url = raw.url ?? raw.application_url ?? raw.source_url ?? null

  if (!title || typeof title !== 'string' || !title.trim()) return null
  if (!url || typeof url !== 'string' || !url.trim()) return null

  // Must look like a valid URL
  const urlStr = String(url).trim()
  if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) return null
  try {
    const parsed = new URL(urlStr)
    if (!parsed.hostname || parsed.hostname.trim() === '') return null
  } catch (_) {
    return null
  }

  return {
    title: String(title).trim(),
    description: raw.description ?? null,
    url: urlStr,
    application_url: raw.application_url ?? urlStr,
    source_url: raw.source_url ?? urlStr,
    sponsor: raw.sponsor ?? raw.funder ?? null,
    opportunity_type: raw.opportunity_type ?? 'grant',
    deadline_type: raw.deadline_type ?? 'rolling',
    categories: Array.isArray(raw.categories) ? raw.categories : [],
    keywords: Array.isArray(raw.keywords) ? raw.keywords : [],
    eligibility_bullets: Array.isArray(raw.eligibility_bullets) ? raw.eligibility_bullets : [],
    source: raw.source ?? crawlerType,
    crawler_type: crawlerType,
    record_origin: raw.record_origin ?? 'directory_resource',
  }
}

const LOAN_PATTERNS = [
  /\bloan\b/i,
  /\bmicroloan\b/i,
  /\bline\s+of\s+credit\b/i,
  /\bdebt\s+financing\b/i,
  /\binterest\s+rate\b/i,
  /\brepay\b/i,
  /\brepayment\b/i,
  /\blender\b/i,
  /\bborrow\b/i,
  /\bcredit\s+union\b/i,
  /\bSBA\s+loan\b/i,
  /\b7a\s+loan\b/i,
  /\b504\s+loan\b/i,
  /\bworking\s+capital\s+loan\b/i,
]

/**
 * Returns true if text suggests a loan (money to be repaid).
 */
export function looksLikeLoan(text) {
  if (!text || typeof text !== 'string') return false
  const t = String(text).toLowerCase()
  return LOAN_PATTERNS.some((p) => p.test(t))
}

const MATCHING_FUND_PATTERNS = [
  /\bmatching\s+funds?\b/i,
  /\bmatch\s+requirement\b/i,
  /\bmatch\s+ratio\b/i,
  /\brequired\s+match\b/i,
  /\bcost\s+share\b/i,
  /\bco[-\s]?funding\b/i,
  /\bleveraged\s+funds?\b/i,
  /\bmatching\s+grant\b/i,
  /\bdollar[-\s]?for[-\s]?dollar\b/i,
  /\bmatch\s+of\s+\d+%\s*\/\s*\d+%/i,
]

/**
 * Returns true if text suggests matching-funds / cost-share requirements.
 */
export function looksLikeMatchingFunds(text) {
  if (!text || typeof text !== 'string') return false
  const t = String(text).toLowerCase()
  return MATCHING_FUND_PATTERNS.some((p) => p.test(t))
}

function applyExclusions(opportunities, config) {
  return opportunities.filter((opp) => {
    const text = [opp.title, opp.description, ...(opp.eligibility_bullets || []), ...(opp.keywords || [])]
      .filter(Boolean)
      .join(' ')

    if (config.strict_no_loans && looksLikeLoan(text)) {
      console.warn(
        `[domainCrawlerEngine] crawler="${config.id}" pre-excluding loan record: title="${opp.title}" url="${opp.url}"`
      )
      return false
    }
    if (config.strict_no_matching && looksLikeMatchingFunds(text)) {
      console.warn(
        `[domainCrawlerEngine] crawler="${config.id}" pre-excluding matching-funds record: title="${opp.title}" url="${opp.url}"`
      )
      return false
    }
    return true
  })
}

/**
 * Light pre-score using keyword overlap. Route will rescore with calculateMatchScore.
 * Keep simple: keyword match = base score.
 */
function lightPreScore(opp, profile, config) {
  const signals = profile?.signals ?? null
  const keywordSet = signals?.keywordSet
  // Multi-address aware: collect every state the profile is tied to (primary-first),
  // falling back to the single primary/flat state so single-address profiles behave
  // exactly as before. Lowercased for substring checks against opportunity text.
  const profileStateList = (() => {
    const out = []
    const add = (v) => {
      const s = String(v ?? '').toLowerCase().trim()
      if (s && !out.includes(s)) out.push(s)
    }
    add(signals?.location?.state ?? profile?.state ?? '')
    if (Array.isArray(signals?.states)) for (const st of signals.states) add(st)
    return out.filter(Boolean)
  })()
  const profileState = profileStateList[0] ?? ''

  if (!keywordSet || typeof keywordSet.has !== 'function') {
    return 50 // neutral
  }

  const text = [opp.title, opp.description, ...(opp.categories || []), ...(opp.keywords || [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  let matches = 0
  const boostSignals = config.boostSignals ?? []
  for (const kw of keywordSet) {
    const k = String(kw).toLowerCase()
    if (text.includes(k)) matches++
  }
  for (const b of boostSignals) {
    const k = String(b).toLowerCase()
    if (text.includes(k)) matches += 2
  }

  // Location boost: if the opportunity text references ANY of the user's states, lift the pre-score
  if (profileStateList.some((st) => text.includes(st))) matches += 3

  if (matches > 0) return Math.min(85, 50 + matches * 8)
  return 50
}

/**
 * Run domain crawler for a given config.
 * - Validates profile + profile.signals exist.
 * - Builds directory resources first (always included).
 * - Optionally runs live fetchers (best-effort, never throw).
 * - Normalizes to standard format with mandatory URL.
 * - Applies strict exclusions.
 */
export async function runDomainCrawler({ profile, config, options = {} }) {
  try {
  const minDirectory = config.min_directory_items ?? 6

  // Validate profile
  if (!profile || typeof profile !== 'object') {
    return []
  }

  const signals = profile.signals ?? null
  const hasSignals = Boolean(signals)
  const keywordSet = signals?.keywordSet
  const keywordCount = keywordSet?.size ?? 0
  const zip = signals?.location?.zip ?? profile?.zip_code ?? profile?.state ?? null
  const state = signals?.location?.state ?? profile?.state ?? null
  const profileThin = !zip && !state && keywordCount < 5
  if (profileThin) {
    console.warn(
      `[domainCrawlerEngine] crawler="${config.id}" profile is thin (no zip, no state, <5 keywords). ` +
      `Results will be directory-only and pre-scores will be neutral. ` +
      `Prompt user to complete profile fields: zip_code, state, and need categories.`
    )
  }

  // Build directory resources (always included, even for thin profiles)
  const directoryResources = config.directoryResources ?? []
  const directoryRows = directoryResources
    .map((res) => ({
      title: res.title,
      description: res.description ?? '',
      url: res.url,
      application_url: res.url,
      source_url: res.url,
      categories: Array.isArray(res.categories) ? res.categories : [],
      keywords: Array.isArray(res.keywords) ? res.keywords : [],
      eligibility_bullets: [],
      record_origin: 'directory_resource',
    }))
    .filter((r) => r.url && r.title)

  const normalizedDir = directoryRows
    .map((row) => normalizeOpportunity(row, config.id))
    .filter(Boolean)

  const afterExclusions = applyExclusions(normalizedDir, config)

  // Ensure minimum directory items
  // Honor hard-exclusions even when below min_directory target.
  // Never reinstate loan/matching-fund items to meet a quota.
  // Log when we cannot meet the minimum so operators can expand directoryResources.
  const directory = afterExclusions
  if (directory.length < minDirectory) {
    console.warn(
      `[domainCrawlerEngine] crawler="${config.id}" directory items after exclusions: ${directory.length} ` +
      `(target ${minDirectory}). Some items were excluded as loans/matching-funds. ` +
      `Expand directoryResources or relax strict_no_loans/strict_no_matching in config to meet target.`
    )
  }

  // Live fetchers: best-effort, never throw (placeholder for future expansion)
  let liveRows = []
  if (config.liveFetchers && Array.isArray(config.liveFetchers)) {
    for (const fetcher of config.liveFetchers) {
      try {
        const results = await fetcher(profile, config)
        const rows = Array.isArray(results) ? results : []
        for (const r of rows) {
          const n = normalizeOpportunity({ ...r, record_origin: 'live_crawl' }, config.id)
          if (n) liveRows.push(n)
        }
      } catch (_) {
        // Best-effort: never throw
      }
    }
  }

  const all = [...directory, ...liveRows]

  // Dedupe by URL
  const seen = new Set()
  const deduped = all.filter((o) => {
    const key = (o.url || o.application_url || o.source_url || '').toLowerCase().trim()
    if (!key) {
      console.warn(`[domainCrawlerEngine] crawler="${config.id}" dropping URL-less record: title="${o.title}"`)
      return false
    }
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  // Light pre-score; route will rescore with calculateMatchScore
  const scored = deduped.map((opp) => ({
    ...opp,
    pre_score: lightPreScore(opp, profile, config),
    pre_score_note: 'crawler_prescore_only — will be overwritten by computeMatchDecision()',
    match_score: null,
    match_reasons: [],
    match_explanation: null,
  }))

    return scored
  } catch (error) {
    qualityLog.error('Domain crawler error:', error)
    return []
  }
}

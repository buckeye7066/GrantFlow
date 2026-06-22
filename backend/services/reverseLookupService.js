/**
 * Reverse-Lookup Matching Service
 *
 * Given a profile, finds grantmakers aligned with the profile's mission area
 * (NTEE codes + state) using ProPublica 990 search and the local foundation
 * catalog as fallback.
 */

import { searchOrganizations } from '../src/integrations/propublica990.js'
import { needsToNteeCodes, NTEE_DESCRIPTIONS } from '../constants/nteeMapping.js'
import { buildProfileContext } from './profileHelpers.js'
import { normalizeProfile } from './profileNormalizer.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('reverseLookupService')

const RATE_LIMIT_MS = 250
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** ProPublica requires a real text query — wildcard `*` returns nothing useful. */
const NTEE_SEARCH_TERMS = {
  A: 'arts culture humanities',
  B: 'education school',
  C: 'environment conservation',
  D: 'animal welfare',
  E: 'healthcare hospital',
  F: 'mental health crisis',
  G: 'disease medical',
  H: 'medical research',
  I: 'legal aid crime',
  J: 'employment workforce',
  K: 'food nutrition agriculture',
  L: 'housing shelter',
  M: 'disaster public safety',
  N: 'recreation sports',
  O: 'youth development',
  P: 'human services charity',
  Q: 'international foreign affairs',
  R: 'civil rights advocacy',
  S: 'community development',
  T: 'foundation philanthropy grantmaker',
  U: 'science technology',
  V: 'social science research',
  W: 'public benefit community',
  X: 'church faith ministry',
  Y: 'membership association',
  Z: 'nonprofit charity',
}

const GRANTMAKER_SEARCH_TERMS = [
  'community foundation',
  'private foundation',
  'charitable trust',
  'philanthropy',
]

const FOUNDATION_NAME_RX = /\b(foundation|fund|trust|endowment|philanthrop|charitab)\b/i

const NEED_SEARCH_KEYWORDS = {
  food: ['food', 'nutrition', 'hunger', 'snap'],
  health_medical: ['health', 'medical', 'healthcare', 'hospital'],
  mental_health: ['mental health', 'behavioral', 'crisis'],
  disability: ['disability', 'adaptive', 'accessibility'],
  housing: ['housing', 'shelter', 'homeless'],
  education: ['education', 'school', 'scholarship'],
  employment: ['workforce', 'employment', 'job training'],
  nonprofit_ministry: ['nonprofit', 'church', 'faith', 'ministry'],
  community_development: ['community', 'capacity building'],
  veteran: ['veteran', 'military'],
  children_youth: ['youth', 'children', 'child'],
  family_life: ['family', 'caregiver'],
  cash_assistance: ['assistance', 'emergency fund'],
}

function nteeSearchQuery(ntee) {
  return NTEE_SEARCH_TERMS[ntee] || NTEE_DESCRIPTIONS[ntee]?.split(',')[0]?.trim() || 'nonprofit charity'
}

function isLikelyGrantmaker(org) {
  const grantAmt = org.grant_amount ?? 0
  const assets = org.asset_amount ?? 0
  const ntee = String(org.ntee_code || org.matched_ntee || '').toUpperCase()
  const name = String(org.name || '')
  if (grantAmt > 0) return true
  if (ntee.startsWith('T')) return true
  if (assets >= 1_000_000 && FOUNDATION_NAME_RX.test(name)) return true
  if (FOUNDATION_NAME_RX.test(name) && assets >= 250_000) return true
  return false
}

function scoreOrg(org, state) {
  let score = 20
  if (state && org.state === state) score += 15
  const grantAmt = org.grant_amount ?? 0
  if (grantAmt > 0) score += 10
  if (grantAmt >= 100_000) score += 10
  if (grantAmt >= 1_000_000) score += 5
  if (org.asset_amount >= 500_000) score += 5
  if (org.asset_amount >= 5_000_000) score += 5
  if (isLikelyGrantmaker(org)) score += 8
  return score
}

function formatOrg(org, existingByEin) {
  return {
    ein: org.ein,
    name: org.name,
    city: org.city,
    state: org.state,
    ntee_code: org.ntee_code,
    ntee_label: org.ntee_label ?? NTEE_DESCRIPTIONS[org.matched_ntee] ?? org.matched_ntee,
    matched_ntee: org.matched_ntee,
    grant_amount: org.grant_amount,
    asset_amount: org.asset_amount,
    income_amount: org.income_amount,
    profile_url: org.profile_url,
    relevance_score: org.relevance_score,
    already_in_catalog: existingByEin.has(org.ein),
    source: org.source ?? 'propublica.990',
  }
}

async function searchPropublicaOrgs({ q, state, ntee, seen, matchedNtee }) {
  const added = []
  try {
    await sleep(RATE_LIMIT_MS)
    const result = await searchOrganizations({
      q,
      state: state ?? undefined,
      ntee,
      c_code: '3',
      page: 0,
    })
    for (const org of result.organizations ?? []) {
      if (!org.ein || seen.has(org.ein)) continue
      seen.add(org.ein)
      added.push({
        ...org,
        matched_ntee: ntee ?? org.ntee_code,
        ntee_label: NTEE_DESCRIPTIONS[ntee] ?? NTEE_DESCRIPTIONS[org.ntee_code?.[0]] ?? ntee,
        source: 'propublica.990',
      })
    }
  } catch (err) {
    log.warn(`[reverseLookup] ProPublica search failed q="${q}" ntee=${ntee}: ${err.message}`)
  }
  return added
}

function buildNeedKeywords(needCategories) {
  const kws = new Set(['foundation', 'grantmaker', 'philanthropy'])
  for (const need of needCategories) {
    const mapped = NEED_SEARCH_KEYWORDS[need]
    if (mapped) mapped.forEach((k) => kws.add(k))
    else if (need) kws.add(String(need).replace(/_/g, ' '))
  }
  return [...kws]
}

async function searchLocalFoundationCatalog(db, { state, needCategories, limit = 25 }) {
  const keywords = buildNeedKeywords(needCategories)
  const rows = await db.prepare(
    `SELECT id, title, sponsor, source_id, application_url, source_url, state, keywords, categories
     FROM funding_opportunities
     WHERE is_active = 1
       AND (
         LOWER(COALESCE(categories, '')) LIKE '%foundation%'
         OR LOWER(COALESCE(keywords, '')) LIKE '%foundation%'
         OR LOWER(COALESCE(keywords, '')) LIKE '%grantmaker%'
         OR LOWER(COALESCE(title, '')) LIKE '%foundation%'
         OR source = 'propublica.990'
         OR record_origin = 'cof_foundation_locator'
       )
       AND (
         CAST(? AS TEXT) IS NULL OR state = ? OR is_national = 1
         OR LOWER(COALESCE(state, '')) IN ('nationwide', 'national')
       )
     ORDER BY
       CASE WHEN CAST(? AS TEXT) IS NOT NULL AND state = ? THEN 0 ELSE 1 END,
       updated_at DESC
     LIMIT ?`,
  ).all(state, state, state, state, limit)

  return rows
    .map((row) => {
      const haystack = [
        row.title,
        row.sponsor,
        row.keywords,
        row.categories,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      let score = 10
      for (const kw of keywords) {
        if (haystack.includes(kw.toLowerCase())) score += 4
      }
      if (state && row.state === state) score += 10
      const url = row.application_url || row.source_url
      return {
        ein: row.source_id || row.id,
        name: row.sponsor || row.title,
        city: null,
        state: row.state,
        ntee_code: null,
        ntee_label: 'Foundation / grantmaker (catalog)',
        matched_ntee: null,
        grant_amount: null,
        asset_amount: null,
        income_amount: null,
        profile_url: url,
        relevance_score: score,
        already_in_catalog: true,
        source: 'local_catalog',
      }
    })
    .sort((a, b) => b.relevance_score - a.relevance_score)
}

/**
 * Find grantmakers aligned with a profile's mission area and location.
 *
 * @param {Object} db
 * @param {string} profileId
 * @param {Object} [options]
 * @param {number} [options.maxResults=20]
 */
export async function findSimilarOrgsFunders(db, profileId, options = {}) {
  const { maxResults = 20 } = options

  const profileContext = await buildProfileContext(db, profileId)
  if (!profileContext?.profile) {
    throw new Error(`Profile ${profileId} not found`)
  }

  const profileNorm = normalizeProfile(
    profileContext.profile,
    profileContext.sections,
    profileContext.signals,
  )

  const state = profileNorm?.state ?? profileContext.signals?.location?.state ?? null
  const needCategories = profileNorm?.needCategories ?? []
  const entityType = profileNorm?.entityType ?? 'individual'
  const nteeCodes = needsToNteeCodes(needCategories)

  log.info(
    `[reverseLookup] Profile ${profileId}: state=${state}, entity=${entityType}, needs=${needCategories.join(',')}, ntee=${nteeCodes.join(',')}`,
  )

  const seen = new Set()
  const allOrgs = []

  // 1) Grantmakers (NTEE T + foundation keywords) — primary funder source
  for (const term of GRANTMAKER_SEARCH_TERMS) {
    const batch = await searchPropublicaOrgs({ q: term, state, ntee: 'T', seen, matchedNtee: 'T' })
    allOrgs.push(...batch)
  }

  // 2) Mission-aligned nonprofits / funders by NTEE (skip T — already searched)
  for (const ntee of nteeCodes.filter((c) => c !== 'T').slice(0, 6)) {
    const batch = await searchPropublicaOrgs({
      q: nteeSearchQuery(ntee),
      state,
      ntee,
      seen,
      matchedNtee: ntee,
    })
    allOrgs.push(...batch)
  }

  // 3) Local catalog fallback (always runs — works when ProPublica is down)
  const localFunders = await searchLocalFoundationCatalog(db, {
    state,
    needCategories,
    limit: maxResults,
  })

  const scored = allOrgs.map((org) => ({
    ...org,
    relevance_score: scoreOrg(org, state),
  }))
  scored.sort((a, b) => b.relevance_score - a.relevance_score)

  const existingByEin = new Map()
  const catalogEins = [...scored, ...localFunders].map((o) => o.ein).filter(Boolean)
  if (catalogEins.length > 0) {
    const placeholders = catalogEins.map(() => '?').join(',')
    const existing = await db.prepare(
      `SELECT source_id, title FROM funding_opportunities
       WHERE source = 'propublica.990' AND source_id IN (${placeholders})
       AND is_active = 1`,
    ).all(...catalogEins)
    for (const row of existing) existingByEin.set(row.source_id, row)
  }

  const similarOrgs = scored.slice(0, maxResults).map((org) => formatOrg(org, existingByEin))

  const funderCandidates = [
    ...scored.filter(isLikelyGrantmaker).map((org) => formatOrg(org, existingByEin)),
    ...localFunders,
  ]

  const funderSeen = new Set()
  const suggestedFunders = []
  for (const funder of funderCandidates.sort(
    (a, b) => (b.grant_amount ?? b.relevance_score ?? 0) - (a.grant_amount ?? a.relevance_score ?? 0),
  )) {
    const key = funder.ein || funder.name
    if (!key || funderSeen.has(key)) continue
    funderSeen.add(key)
    suggestedFunders.push(funder)
    if (suggestedFunders.length >= maxResults) break
  }

  return {
    similar_orgs: similarOrgs,
    suggested_funders: suggestedFunders,
    ntee_codes_used: nteeCodes.map((c) => ({ code: c, label: NTEE_DESCRIPTIONS[c] ?? c })),
    profile_summary: {
      state,
      entity_type: entityType,
      need_categories: needCategories,
    },
    sources: {
      propublica_orgs: scored.length,
      local_catalog: localFunders.length,
    },
  }
}

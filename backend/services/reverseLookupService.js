/**
 * Reverse-Lookup Matching Service
 *
 * Given a profile, finds organizations with similar characteristics in
 * ProPublica 990 data, then surfaces their funders as potential matches.
 *
 * This is the GrantWatch $249/yr premium feature — "find orgs like me,
 * show their funders."
 */

import { searchOrganizations, getOrganization } from '../src/integrations/propublica990.js'
import { needsToNteeCodes, NTEE_DESCRIPTIONS } from '../constants/nteeMapping.js'
import { buildProfileContext } from './profileHelpers.js'
import { normalizeProfile } from './profileNormalizer.js'
import { createLogger } from '../utils/logger.js'
const log = createLogger('reverseLookupService')

const RATE_LIMIT_MS = 250
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

/**
 * Find similar organizations and their funders for a given profile.
 *
 * @param {Object} db - Database connection
 * @param {string} profileId - Profile ID to match against
 * @param {Object} [options]
 * @param {number} [options.maxResults=20] - Max similar orgs to return
 * @returns {Promise<Object>} { similar_orgs, suggested_funders, ntee_codes_used }
 */
export async function findSimilarOrgsFunders(db, profileId, options = {}) {
  const { maxResults = 20 } = options

  // Load profile context
  const profileContext = await buildProfileContext(db, profileId)
  if (!profileContext?.profile) {
    throw new Error(`Profile ${profileId} not found`)
  }

  const profileNorm = normalizeProfile(
    profileContext.profile,
    profileContext.sections,
    profileContext.signals
  )

  const state = profileNorm?.state ?? null
  const needCategories = profileNorm?.needCategories ?? []
  const entityType = profileNorm?.entityType ?? 'individual'

  // Map profile needs to NTEE codes
  const nteeCodes = needsToNteeCodes(needCategories)

  log.info(`[reverseLookup] Profile ${profileId}: state=${state}, entity=${entityType}, needs=${needCategories.join(',')}, ntee=${nteeCodes.join(',')}`)

  // Search for similar organizations
  const allOrgs = []
  const seen = new Set()

  for (const ntee of nteeCodes.slice(0, 5)) {
    try {
      await sleep(RATE_LIMIT_MS)

      const result = await searchOrganizations({
        q: '*',
        state: state ?? undefined,
        ntee,
        c_code: '3',
        page: 0,
      })

      for (const org of result.organizations ?? []) {
        if (org.ein && !seen.has(org.ein)) {
          seen.add(org.ein)
          allOrgs.push({
            ...org,
            matched_ntee: ntee,
            ntee_label: NTEE_DESCRIPTIONS[ntee] ?? ntee,
          })
        }
      }
    } catch (err) {
      console.warn(`[reverseLookup] Search error for NTEE ${ntee}: ${err.message}`)
    }
  }

  // Score and rank similar orgs
  const scored = allOrgs.map(org => {
    let score = 0

    // NTEE code match (the fact they appeared means they match)
    score += 20

    // Same state
    if (state && org.state === state) score += 15

    // Has grant data (indicates active grantmaker)
    const grantAmt = org.grant_amount ?? 0
    if (grantAmt > 0) score += 10
    if (grantAmt >= 100_000) score += 10
    if (grantAmt >= 1_000_000) score += 5

    // Has meaningful assets
    if (org.asset_amount >= 500_000) score += 5
    if (org.asset_amount >= 5_000_000) score += 5

    return { ...org, relevance_score: score }
  })

  scored.sort((a, b) => b.relevance_score - a.relevance_score)

  const topOrgs = scored.slice(0, maxResults)

  // Also check local DB for any existing funding_opportunities from these foundations
  const existingByEin = new Map()
  if (topOrgs.length > 0) {
    const eins = topOrgs.map(o => o.ein).filter(Boolean)
    if (eins.length > 0) {
      const placeholders = eins.map(() => '?').join(',')
      const existing = await db.prepare(
        `SELECT source_id, title, match_score FROM funding_opportunities
         WHERE source = 'propublica.990' AND source_id IN (${placeholders})
         AND is_active = 1`
      ).all(...eins)
      for (const row of existing) {
        existingByEin.set(row.source_id, row)
      }
    }
  }

  // Format results
  const similarOrgs = topOrgs.map(org => ({
    ein: org.ein,
    name: org.name,
    city: org.city,
    state: org.state,
    ntee_code: org.ntee_code,
    ntee_label: org.ntee_label,
    matched_ntee: org.matched_ntee,
    grant_amount: org.grant_amount,
    asset_amount: org.asset_amount,
    income_amount: org.income_amount,
    profile_url: org.profile_url,
    relevance_score: org.relevance_score,
    already_in_catalog: existingByEin.has(org.ein),
  }))

  // Separate grantmakers (orgs with grant_amount > 0) as "suggested funders"
  const suggestedFunders = similarOrgs
    .filter(org => (org.grant_amount ?? 0) > 0)
    .sort((a, b) => (b.grant_amount ?? 0) - (a.grant_amount ?? 0))

  return {
    similar_orgs: similarOrgs,
    suggested_funders: suggestedFunders,
    ntee_codes_used: nteeCodes.map(c => ({ code: c, label: NTEE_DESCRIPTIONS[c] ?? c })),
    profile_summary: {
      state,
      entity_type: entityType,
      need_categories: needCategories,
    },
  }
}

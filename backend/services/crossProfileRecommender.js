/**
 * crossProfileRecommender.js
 *
 * Cross-Profile Recommender
 *
 * Leverages collective intelligence across all profiles in the same organization.
 * Computes Jaccard similarity between profiles using keyword sets, shared state,
 * shared needs, and shared demographics. Recommends successful grants from similar
 * profiles to profiles that haven't seen them.
 *
 * Privacy: only recommends grants (not profile data) and only within the same organization.
 *
 * @module crossProfileRecommender
 */

import { safeParseArrayField, resolveApplicantType, buildProfileSignals } from './profileHelpers.js'
import { createLogger } from '../utils/logger.js'
const log = createLogger('crossProfileRecommender')

// ── Signal helpers ────────────────────────────────────────────────────────────

/**
 * Extract a flat keyword set from a profile's signals for similarity computation.
 * Includes keywords, demographics, assistance, military, family, occupation sets.
 *
 * @param {Object} signals - signals object from buildProfileSignals
 * @param {Object} profile - raw profile row
 * @returns {Set<string>}
 */
function buildKeywordSet(signals, profile) {
  const set = new Set()

  function addAll(iterable) {
    if (!iterable) return
    if (typeof iterable[Symbol.iterator] === 'function') {
      for (const item of iterable) {
        if (item && typeof item === 'string') set.add(item.toLowerCase().trim())
      }
    }
  }

  addAll(signals?.keywords)
  addAll(signals?.demographics)
  addAll(signals?.assistance)
  addAll(signals?.military)
  addAll(signals?.family)
  addAll(signals?.occupation)
  addAll(signals?.health)

  // Add location signals
  const state = signals?.location?.state || profile?.state || ''
  if (state) set.add(`state:${state.toLowerCase()}`)

  // Add profile type
  const type = resolveApplicantType(profile) || ''
  if (type) set.add(`type:${type.toLowerCase()}`)

  return set
}

/**
 * Jaccard similarity between two Sets.
 * |A ∩ B| / |A ∪ B|
 */
function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0

  let intersection = 0
  for (const item of setA) {
    if (setB.has(item)) intersection++
  }

  const union = setA.size + setB.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * Return the intersection of two Sets.
 */
function setIntersection(setA, setB) {
  const result = []
  for (const item of setA) {
    if (setB.has(item)) result.push(item)
  }
  return result
}

// ── Profile signals cache (per call) ─────────────────────────────────────────

/**
 * Load signals for all profiles in the same organization as `profileId`.
 * Returns a map of profileId → { profile, signals, keywordSet }.
 */
async function loadOrgProfileSignals(db, profileId) {
  // Find the target profile's organization
  let targetProfile
  try {
    targetProfile = await db
      .prepare('SELECT id, organization_id, display_name, primary_type, state, tags FROM profiles WHERE id = ? LIMIT 1')
      .get(profileId)
  } catch {
    return new Map()
  }

  if (!targetProfile) return new Map()

  // Load all profiles in the same organization (privacy: org-scoped only)
  let orgProfiles
  try {
    orgProfiles = targetProfile.organization_id
      ? await db
          .prepare(
            'SELECT id, organization_id, display_name, primary_type, state, tags FROM profiles WHERE organization_id = ?',
          )
          .all(targetProfile.organization_id)
      : [targetProfile]
  } catch {
    return new Map()
  }

  const signalsMap = new Map()

  for (const profile of orgProfiles) {
    // Load sections for this profile
    let sections = {}
    try {
      const rows = await db
        .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
        .all(profile.id)
      for (const row of rows) {
        try {
          sections[row.section_key] = typeof row.data === 'string' ? JSON.parse(row.data) : row.data
        } catch {
          sections[row.section_key] = {}
        }
      }
    } catch {
      sections = {}
    }

    const tags = safeParseArrayField(profile.tags, [])
    const mergedProfile = { ...profile, tags }

    let signals
    try {
      signals = buildProfileSignals({ profile: mergedProfile, sections })
    } catch {
      signals = {}
    }

    const keywordSet = buildKeywordSet(signals, mergedProfile)

    signalsMap.set(profile.id, {
      profile: mergedProfile,
      signals,
      keywordSet,
      sections,
    })
  }

  return signalsMap
}

// ── Main exports ──────────────────────────────────────────────────────────────

/**
 * @typedef {Object} SimilarProfile
 * @property {string} profileId
 * @property {string} displayName
 * @property {number} similarity  - Jaccard similarity (0–1)
 * @property {string[]} sharedSignals
 */

/**
 * Find profiles similar to the given profile using Jaccard similarity.
 *
 * @param {Object} db - DB instance
 * @param {string} profileId - Target profile ID
 * @param {number} [minSimilarity=0.3] - Minimum Jaccard similarity threshold
 * @returns {{ similar: SimilarProfile[] }}
 */
export async function findSimilarProfiles(db, profileId, minSimilarity = 0.3) {
  if (!db || !profileId) return { similar: [] }

  const signalsMap = await loadOrgProfileSignals(db, profileId)

  const targetEntry = signalsMap.get(profileId)
  if (!targetEntry) return { similar: [] }

  const similar = []

  for (const [pid, entry] of signalsMap) {
    if (pid === profileId) continue

    const similarity = jaccardSimilarity(targetEntry.keywordSet, entry.keywordSet)
    if (similarity < minSimilarity) continue

    const sharedSignals = setIntersection(targetEntry.keywordSet, entry.keywordSet)
      .filter((s) => !s.startsWith('type:')) // De-noise: type tokens are not informative in shared-signal explanations
      .slice(0, 10) // Cap at 10 for readability

    similar.push({
      profileId: pid,
      displayName: entry.profile.display_name || pid,
      similarity: Math.round(similarity * 100) / 100,
      sharedSignals,
    })
  }

  // Sort by similarity descending
  similar.sort((a, b) => b.similarity - a.similarity)

  return { similar }
}

/**
 * @typedef {Object} Recommendation
 * @property {string} grantTitle
 * @property {string} grantId
 * @property {string} sourceProfileId
 * @property {string} sourceProfileName
 * @property {string} matchReason
 * @property {number} estimatedRelevance  - 0–1
 */

/**
 * Get grant recommendations from similar profiles.
 * Only surfaces grants that were successfully applied for or awarded by similar profiles.
 *
 * @param {Object} db - DB instance
 * @param {string} profileId - Target profile ID
 * @returns {{ recommendations: Recommendation[] }}
 */
export async function getRecommendationsFromSimilarProfiles(db, profileId) {
  if (!db || !profileId) return { recommendations: [] }

  // Find similar profiles
  const { similar } = await findSimilarProfiles(db, profileId, 0.25)
  if (similar.length === 0) return { recommendations: [] }

  // Get grants from target profile to avoid recommending what they already have
  let existingGrantIds = new Set()
  let existingGrantTitles = new Set()
  try {
    const existing = await db
      .prepare('SELECT id, title FROM grants WHERE profile_id = ?')
      .all(profileId)
    existingGrantIds = new Set(existing.map((g) => g.id).filter(Boolean))
    existingGrantTitles = new Set(existing.map((g) => g.title.toLowerCase()))
  } catch (existingErr) {
    console.warn('[crossProfileRecommender] Could not load existing grants for profile', profileId, existingErr?.message)
  }

  const recommendations = []
  const seenGrantTitles = new Set()

  // Look for successful grants (applied, awarded, submitted, etc.) from similar profiles
  const POSITIVE_STATUSES = ['awarded', 'submitted', 'pending_review', 'portal', 'auto_applied', 'follow_up']
  const placeholders = POSITIVE_STATUSES.map(() => '?').join(',')

  for (const similarProfile of similar.slice(0, 10)) {
    let grants
    try {
      grants = await db
        .prepare(
          `SELECT id, title, funder, application_url, status, match_score
           FROM grants
           WHERE profile_id = ?
             AND status IN (${placeholders})
           ORDER BY match_score DESC
           LIMIT 20`,
        )
        .all(similarProfile.profileId, ...POSITIVE_STATUSES)
    } catch (err) {
      console.warn('[crossProfileRecommender] Failed to load grants for similar profile', similarProfile.profileId, err?.message)
      continue
    }

    for (const grant of grants) {
      const titleLower = grant.title.toLowerCase()

      // Skip if target profile already has this grant
      if (existingGrantTitles.has(titleLower)) continue

      // Avoid duplicate recommendations across similar profiles
      if (seenGrantTitles.has(titleLower)) continue
      seenGrantTitles.add(titleLower)

      const matchReason =
        `${similarProfile.displayName} (${Math.round(similarProfile.similarity * 100)}% similar) ` +
        `has ${grant.status === 'awarded' ? '✅ won' : '📤 applied to'} this grant. ` +
        `Shared signals: ${similarProfile.sharedSignals.slice(0, 5).join(', ')}.`

      // Estimate relevance: weight by similarity × (1 if awarded, 0.7 if applied)
      const statusWeight = grant.status === 'awarded' ? 1.0 : 0.7
      const estimatedRelevance = Math.round(similarProfile.similarity * statusWeight * 100) / 100

      // Validate application_url (Goal 1: real funding only)
      const appUrl = grant.application_url || null
      if (!appUrl) continue

      recommendations.push({
        grantTitle: grant.title,
        grantId: grant.id,
        sourceProfileId: similarProfile.profileId,
        sourceProfileName: similarProfile.displayName,
        matchReason,
        estimatedRelevance,
        applicationUrl: appUrl,
        sourceStatus: grant.status,
        requiresValidation: true, // Callers MUST call relevanceFilter + computeMatchDecision before any pipeline insertion
        _validatedByRecommender: false, // Explicit flag: decision engine has NOT been run
      })
    }
  }

  // Sort by estimated relevance descending
  recommendations.sort((a, b) => b.estimatedRelevance - a.estimatedRelevance)

  return { recommendations: recommendations.slice(0, 50) } // Cap at 50
}

// ── Standalone CLI entrypoint ─────────────────────────────────────────────────
// Run: node backend/services/crossProfileRecommender.js <profileId>

if (
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].includes('crossProfileRecommender')
) {
  const profileId = process.argv[2]
  if (!profileId) {
    log.error('Usage: node crossProfileRecommender.js <profileId>')
    process.exit(1)
  }

  let db
  try {
    const dbModule = await import('../db/database.js')
    db = dbModule.default || dbModule.db
  } catch {
    log.error('Could not load database. Exiting.')
    process.exit(1)
  }

  log.info(`=== Cross-Profile Recommender (profile: ${profileId}) ===`)

  const { similar } = await findSimilarProfiles(db, profileId)
  log.info(`\nSimilar profiles (${similar.length}):`)
  similar.forEach((s) =>
    log.info(`  [${(s.similarity * 100).toFixed(0)}%] ${s.displayName} — ${s.sharedSignals.join(', ')}`),
  )

  const { recommendations } = await getRecommendationsFromSimilarProfiles(db, profileId)
  log.info(`\nRecommendations from similar profiles (${recommendations.length}):`)
  recommendations.slice(0, 10).forEach((r) =>
    log.info(`  [${(r.estimatedRelevance * 100).toFixed(0)}%] ${r.grantTitle} — ${r.matchReason}`),
  )
}

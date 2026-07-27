import { apiFetch } from '@/api/client'
import { AUTO_ADD_SCORE } from '@/lib/matchDisplayThresholds'

// Owner-facing curated funding-sources list (Crawler OS per-profile matches).
export async function listProfileFundingSources(profileId, { minScore = AUTO_ADD_SCORE } = {}) {
  if (!profileId) throw new Error('profileId is required')
  const params = new URLSearchParams({ min_score: String(minScore) })
  return apiFetch(`/api/profiles/${encodeURIComponent(profileId)}/funding-sources?${params}`)
}

/**
 * Sticky-remove a matched source from a profile's Funding Sources list.
 * Records a dismissal tombstone server-side, so discovery/re-crawl can never
 * bring it back for this profile (deliberate re-add clears the tombstone).
 */
export async function dismissProfileFundingSource(profileId, opportunityId) {
  if (!profileId) throw new Error('profileId is required')
  if (!opportunityId) throw new Error('opportunityId is required')
  return apiFetch(
    `/api/profiles/${encodeURIComponent(profileId)}/funding-sources/${encodeURIComponent(opportunityId)}`,
    { method: 'DELETE' },
  )
}

export async function matchProfileToGrants(profileId) {
  if (!profileId) throw new Error('profileId is required')
  return apiFetch(`/api/matching/profile/${profileId}/grants`)
}

export async function matchProfileToOpportunities(profileId, { minScore = AUTO_ADD_SCORE, limit = 200 } = {}) {
  if (!profileId) throw new Error('profileId is required')
  const params = new URLSearchParams({ min_score: minScore, limit })
  return apiFetch(`/api/matching/profile/${profileId}/opportunities?${params}`)
}

/**
 * Turn free-text funding needs into search terms for the matcher catalog.
 * @param {string} text
 */
export async function interpretMatcherIntent(text) {
  return apiFetch('/api/matching/interpret-intent', {
    method: 'POST',
    body: JSON.stringify({ text: String(text || '').trim() }),
  })
}

/**
 * Fetch matching-specific profile gaps (items that affect match scoring)
 * plus real-world success steps based on the profile's goals.
 */
export async function getMatchingGaps(profileId) {
  if (!profileId) throw new Error('profileId is required')
  return apiFetch(`/api/matching/profile/${profileId}/matching-gaps`)
}

import { apiFetch } from '@/api/client'

export async function matchProfileToGrants(profileId) {
  if (!profileId) throw new Error('profileId is required')
  return apiFetch(`/api/matching/profile/${profileId}/grants`)
}

export async function matchProfileToOpportunities(profileId, { minScore = 50, limit = 200 } = {}) {
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

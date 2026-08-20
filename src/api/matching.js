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

// Single-flight + short cooldown so remounts / double-clicks cannot stampede
// POST /interpret-intent (production 429 class: SmartMatcher mutation spam).
let _interpretInflight = null
let _interpretInflightKey = null
let _interpretLastStartedAt = 0
const INTERPRET_MIN_GAP_MS = 1200

/**
 * Turn free-text funding needs into search terms for the matcher catalog.
 * @param {string} text
 */
export async function interpretMatcherIntent(text) {
  const trimmed = String(text || '').trim()
  if (_interpretInflight && _interpretInflightKey === trimmed) {
    return _interpretInflight
  }
  const now = Date.now()
  const sinceLast = now - _interpretLastStartedAt
  if (_interpretLastStartedAt > 0 && sinceLast < INTERPRET_MIN_GAP_MS) {
    const waitMs = INTERPRET_MIN_GAP_MS - sinceLast
    _interpretInflightKey = trimmed
    _interpretInflight = new Promise((resolve) => {
      setTimeout(resolve, waitMs)
    }).then(() => interpretMatcherIntent(trimmed))
    return _interpretInflight
  }
  _interpretLastStartedAt = now
  _interpretInflightKey = trimmed
  _interpretInflight = apiFetch('/api/matching/interpret-intent', {
    method: 'POST',
    body: JSON.stringify({ text: trimmed }),
  }).finally(() => {
    if (_interpretInflightKey === trimmed) {
      _interpretInflight = null
      _interpretInflightKey = null
    }
  })
  return _interpretInflight
}

/** Test/harness only — clears client-side interpret coalescing state. */
export function resetInterpretMatcherIntentStateForTests() {
  _interpretInflight = null
  _interpretInflightKey = null
  _interpretLastStartedAt = 0
}

/**
 * Fetch matching-specific profile gaps (items that affect match scoring)
 * plus real-world success steps based on the profile's goals.
 */
export async function getMatchingGaps(profileId) {
  if (!profileId) throw new Error('profileId is required')
  return apiFetch(`/api/matching/profile/${profileId}/matching-gaps`)
}

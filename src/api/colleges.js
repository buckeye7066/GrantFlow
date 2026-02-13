/**
 * Colleges API - local funding by ZIP
 */

import { apiFetch } from './client.js'

/**
 * Fetch local funding resources within radius of a ZIP.
 * @param {object} params - { zip: string, radiusMiles?: number }
 * @returns {Promise<{ success: boolean, zip: string, radiusMiles: number, radiusFilteringApplied: boolean, results: Array<{ title, url, source, distanceMiles? }> }>}
 */
export async function fetchLocalFundingByZip({ zip, radiusMiles = 25 }) {
  const z = String(zip ?? '').trim()
  if (!z) {
    throw new Error('ZIP code is required')
  }
  const params = new URLSearchParams({ zip: z })
  if (typeof radiusMiles === 'number' && radiusMiles > 0) {
    params.set('radiusMiles', String(radiusMiles))
  }
  const res = await apiFetch(`/api/colleges/local-funding?${params.toString()}`)
  if (!res?.success && res?.error) {
    throw new Error(res.message || res.error || 'Failed to fetch local funding')
  }
  return res
}

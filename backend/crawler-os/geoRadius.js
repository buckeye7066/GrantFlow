// crawler-os/geoRadius.js
//
// ZIP-radius geography for profile discovery. The product rule is that "local"
// discovery covers a ~25-mile radius around the profile's ZIP — but query
// construction only ever knew the profile's own city/county name tokens, so a
// funder one town over (or across a county line) was unreachable. This module
// turns the profile ZIP into the distinct nearby towns inside that radius so
// the web-query builder can search them by name.
//
// Deterministic: the `zipcodes` dataset is static; no I/O, no clock.

import zipcodes from 'zipcodes'

export const DEFAULT_RADIUS_MILES = 25

/**
 * nearbyCities — distinct towns within `miles` of a US ZIP, nearest first.
 *
 * The profile's own city (and an optional explicit exclude) is omitted — the
 * query builder already covers it via the city/county phrases. Distances are
 * ZIP-centroid haversine (the same basis as matchEngine's geo scorer).
 *
 * @param {string|number} zip 5-digit US ZIP (ZIP+4 tolerated)
 * @param {{ miles?: number, max?: number, excludeCity?: string|null }} [opts]
 * @returns {Array<{city: string, state: string, miles: number|null}>}
 */
export function nearbyCities(zip, { miles = DEFAULT_RADIUS_MILES, max = 4, excludeCity = null } = {}) {
  const z = String(zip ?? '').trim().slice(0, 5)
  if (!/^\d{5}$/.test(z)) return []
  const home = zipcodes.lookup(z)
  if (!home) return []

  let ring
  try {
    ring = zipcodes.radius(z, miles)
  } catch {
    return []
  }
  if (!Array.isArray(ring) || ring.length === 0) return []

  const excluded = new Set(
    [home.city, excludeCity]
      .map((c) => String(c ?? '').trim().toLowerCase())
      .filter(Boolean),
  )
  const seen = new Set()
  const out = []
  for (const nz of ring) {
    const info = zipcodes.lookup(nz)
    if (!info?.city || !info?.state) continue
    const cityKey = `${info.city}|${info.state}`.toLowerCase()
    if (seen.has(cityKey) || excluded.has(info.city.toLowerCase())) continue
    seen.add(cityKey)
    const dist = zipcodes.distance(z, String(nz))
    out.push({
      city: info.city,
      state: info.state,
      miles: Number.isFinite(dist) ? dist : null,
    })
  }
  out.sort((a, b) => (a.miles ?? Number.MAX_SAFE_INTEGER) - (b.miles ?? Number.MAX_SAFE_INTEGER))
  return out.slice(0, Math.max(0, max))
}

export default { nearbyCities, DEFAULT_RADIUS_MILES }

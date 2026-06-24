/**
 * censusGeo.js
 *
 * FREE, KEYLESS deterministic geo resolution via the US Census Geocoder.
 * Resolves an address (or ZIP, via the bundled `zipcodes` dataset) to its
 * county, state, and 5-digit county FIPS code.
 *
 *   Docs:  https://geocoding.geo.census.gov/geocoder/
 *   Endpoint (structured):
 *     https://geocoding.geo.census.gov/geocoder/geographies/address?
 *       street=..&city=..&state=..&zip=..&benchmark=Public_AR_Current
 *       &vintage=Current_Current&format=json
 *   Endpoint (oneline):
 *     https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?
 *       address=..&benchmark=..&vintage=..&format=json
 *
 * CONTRACT:
 *   - Deterministic ENRICHMENT only. We resolve county/FIPS to improve geo
 *     matching and reduce out-of-state false positives. We NEVER introduce a
 *     new hard reject on API failure — a miss/timeout returns apiAnswered:false
 *     and the matcher falls back to its existing state logic unchanged.
 *   - NEVER throws — all network errors are caught and degraded to neutral.
 *   - Cached by ZIP / normalized address.
 *
 * NOTE: The Census geographies endpoint requires a street address; it cannot
 * geocode a bare ZIP. For ZIP-only profiles we derive city/state from the
 * bundled `zipcodes` package (already a dependency) so we still return a
 * deterministic county/FIPS where the dataset has it, WITHOUT a network call.
 */

import zipcodes from 'zipcodes'
import { createLogger } from '../../utils/logger.js'
import { createTtlCache, timedFetch } from './verificationCache.js'
import {
  isCensusGeoEnabled,
  censusTimeoutMs,
  verificationCacheTtlMs,
} from './verificationConfig.js'

const log = createLogger('censusGeo')

export const CENSUS_SOURCE = 'us_census_geocoder'
const API_BASE = 'https://geocoding.geo.census.gov/geocoder/geographies'
const BENCHMARK = 'Public_AR_Current'
const VINTAGE = 'Current_Current'

const cache = createTtlCache()

/** Neutral result — apiAnswered:false means the matcher must fall back. */
function neutral(reason) {
  return { source: CENSUS_SOURCE, apiAnswered: false, resolved: false, reason }
}

/** Pull county/state/FIPS out of a Census geographies match object. */
export function mapGeographies(geographies) {
  const counties = Array.isArray(geographies?.Counties) ? geographies.Counties : []
  const states = Array.isArray(geographies?.States) ? geographies.States : []
  const county = counties[0] ?? null
  const state = states[0] ?? null
  if (!county) return neutral('no_county_in_match')
  // County GEOID is the canonical 5-digit FIPS (2 state + 3 county).
  const fips = county.GEOID ?? (((county.STATE ?? '') + (county.COUNTY ?? '')) || null)
  return {
    source: CENSUS_SOURCE,
    apiAnswered: true,
    resolved: true,
    county: county.NAME ?? county.BASENAME ?? null,
    state: state?.STUSAB ?? null,
    stateFips: county.STATE ?? state?.STATE ?? null,
    countyFips: county.COUNTY ?? null,
    fips: fips || null,
  }
}

/** Build the structured geocoder URL. */
function buildUrl({ street, city, state, zip, oneline }) {
  const params = new URLSearchParams({
    benchmark: BENCHMARK,
    vintage: VINTAGE,
    format: 'json',
  })
  if (oneline) {
    params.set('address', oneline)
    return `${API_BASE}/onelineaddress?${params.toString()}`
  }
  if (street) params.set('street', street)
  if (city) params.set('city', city)
  if (state) params.set('state', state)
  if (zip) params.set('zip', zip)
  return `${API_BASE}/address?${params.toString()}`
}

async function fetchGeographies(urlArgs, cacheKey) {
  const ttl = verificationCacheTtlMs()
  const cached = cache.get(cacheKey, ttl)
  if (cached !== undefined) return cached

  let result
  try {
    const res = await timedFetch(buildUrl(urlArgs), { timeoutMs: censusTimeoutMs() })
    if (!res.ok) {
      result = neutral(`http_${res.status}`)
    } else {
      const payload = await res.json()
      const match = payload?.result?.addressMatches?.[0]
      if (!match) {
        // API answered but found no match — deterministic "no match", not an error.
        result = { source: CENSUS_SOURCE, apiAnswered: true, resolved: false, reason: 'no_match' }
      } else {
        result = mapGeographies(match.geographies)
      }
    }
  } catch (err) {
    log.warn('census.fetch_failed', { error: err?.message })
    result = neutral('api_error')
  }

  // Cache only definitive answers so transient failures stay retryable.
  if (result.apiAnswered) cache.set(cacheKey, result)
  return result
}

/**
 * Resolve a full street address to county/state/FIPS via the Census geocoder.
 * @param {object} addr { street, city, state, zip }
 * @returns {Promise<object>}
 */
export async function resolveAddress(addr = {}) {
  if (!isCensusGeoEnabled()) return neutral('disabled')
  const street = String(addr.street || '').trim()
  const city = String(addr.city || '').trim()
  const state = String(addr.state || '').trim()
  const zip = String(addr.zip || '').trim()
  if (!street && !addr.oneline) return neutral('no_street')
  const key = addr.oneline
    ? `addr:${String(addr.oneline).toLowerCase().trim()}`
    : `addr:${street}|${city}|${state}|${zip}`.toLowerCase()
  return fetchGeographies({ street, city, state, zip, oneline: addr.oneline }, key)
}

/**
 * Resolve a bare ZIP to county/state/FIPS.
 *
 * The Census geographies endpoint cannot geocode a ZIP alone, so we first try
 * the offline `zipcodes` dataset to obtain a representative city/state (and,
 * when available, its county) — a deterministic, zero-network resolution. We
 * then geocode the ZIP centroid via the Census endpoint to obtain an
 * authoritative FIPS where possible, but if that misses we still return the
 * offline county/state (apiAnswered reflects whichever path produced data).
 *
 * @param {string} zip
 * @returns {Promise<object>}
 */
export async function resolveZip(zip) {
  if (!isCensusGeoEnabled()) return neutral('disabled')
  const z = String(zip || '').trim().slice(0, 5)
  if (!/^\d{5}$/.test(z)) return neutral('invalid_zip')

  const key = `zip:${z}`
  const ttl = verificationCacheTtlMs()
  const cached = cache.get(key, ttl)
  if (cached !== undefined) return cached

  // Offline lookup first (always available, no network).
  const info = zipcodes.lookup(z) || null
  const offline = info
    ? {
        source: CENSUS_SOURCE,
        apiAnswered: false, // offline dataset, not the live API
        resolved: true,
        county: info.county ?? null,
        state: info.state ?? null,
        stateFips: null,
        countyFips: null,
        fips: null,
        offline: true,
      }
    : null

  // Try the live geocoder on the ZIP centroid for an authoritative FIPS.
  let live = neutral('no_match')
  if (info?.latitude && info?.longitude) {
    live = await resolveCoordinates(info.latitude, info.longitude)
  }

  let result
  if (live.resolved) {
    // Prefer the authoritative live FIPS; backfill county/state from offline.
    result = {
      ...live,
      county: live.county ?? offline?.county ?? null,
      state: live.state ?? offline?.state ?? null,
    }
  } else if (offline) {
    result = offline
  } else {
    result = neutral('unresolved_zip')
  }

  // Cache when we produced any deterministic resolution (offline or live).
  if (result.resolved) cache.set(key, result)
  return result
}

/**
 * Resolve lat/lon to county/state/FIPS via the Census coordinate geocoder.
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<object>}
 */
export async function resolveCoordinates(lat, lon) {
  if (!isCensusGeoEnabled()) return neutral('disabled')
  const y = Number(lat)
  const x = Number(lon)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return neutral('invalid_coords')

  const key = `coord:${y.toFixed(4)},${x.toFixed(4)}`
  const ttl = verificationCacheTtlMs()
  const cached = cache.get(key, ttl)
  if (cached !== undefined) return cached

  const params = new URLSearchParams({
    x: String(x),
    y: String(y),
    benchmark: BENCHMARK,
    vintage: VINTAGE,
    format: 'json',
  })
  let result
  try {
    const res = await timedFetch(`${API_BASE}/coordinates?${params.toString()}`, {
      timeoutMs: censusTimeoutMs(),
    })
    if (!res.ok) {
      result = neutral(`http_${res.status}`)
    } else {
      const payload = await res.json()
      const geos = payload?.result?.geographies
      result = geos ? mapGeographies(geos) : { source: CENSUS_SOURCE, apiAnswered: true, resolved: false, reason: 'no_match' }
    }
  } catch (err) {
    log.warn('census.coords_failed', { error: err?.message })
    result = neutral('api_error')
  }

  if (result.apiAnswered) cache.set(key, result)
  return result
}

/** Test/maintenance helper. */
export function _clearCache() {
  cache.clear()
}

export default {
  CENSUS_SOURCE,
  resolveAddress,
  resolveZip,
  resolveCoordinates,
  mapGeographies,
}

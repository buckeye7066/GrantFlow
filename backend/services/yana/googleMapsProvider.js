/**
 * yana/googleMapsProvider.js
 *
 * A Google Maps (Places) source for Yana's outbound prospect discovery. Yana
 * finds LOCAL organizations/businesses that aren't GrantFlow clients yet, gets
 * their websites in ONE call, and feeds them into her existing lead pipeline
 * (score → qualify → enrich → push to John).
 *
 * Uses the NEW Google Places API v1 Text Search:
 *   POST https://places.googleapis.com/v1/places:searchText
 * with an `X-Goog-Api-Key` header and a `X-Goog-FieldMask` so the website comes
 * back in the SAME response — no separate Place Details round-trip. The field
 * mask requests displayName, formattedAddress, websiteUri, nationalPhoneNumber,
 * types, and location.
 *
 * Activation: keyed by GOOGLE_MAPS_API_KEY (falls back to GOOGLE_PLACES_API_KEY).
 * No key → searchPlaces returns [] after a single clear one-line log note; it
 * NEVER throws. Non-200 / quota (429 / 402) / network errors → [] (failure-
 * tolerant), so Yana behaves exactly as today when the source is unavailable.
 *
 * The Places API is metered but has a recurring monthly free credit; an
 * unattended discovery loop stays within it at the default per-cycle limits.
 */

import { createLogger } from '../../utils/logger.js'

const log = createLogger('yanaGoogleMaps')

const PLACES_TEXT_SEARCH_ENDPOINT = 'https://places.googleapis.com/v1/places:searchText'

// One-call field mask: identity + website + contact + classification + geo.
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.types',
  'places.location',
].join(',')

const SOURCE_NAME = 'google_maps'

/** Resolve the Maps/Places API key from env, with the documented fallback. */
export function getGoogleMapsApiKey(env = process.env) {
  return (env?.GOOGLE_MAPS_API_KEY || env?.GOOGLE_PLACES_API_KEY || '').trim() || null
}

/** Map one raw Places v1 `place` object into Yana's normalized place shape. */
function normalizePlace(place) {
  if (!place || typeof place !== 'object') return null
  const name = place.displayName?.text || place.displayName || null
  if (!name) return null
  return {
    name: String(name),
    website: place.websiteUri || null,
    address: place.formattedAddress || null,
    phone: place.nationalPhoneNumber || null,
    place_id: place.id || null,
    types: Array.isArray(place.types) ? place.types : [],
    lat: Number.isFinite(place.location?.latitude) ? place.location.latitude : null,
    lng: Number.isFinite(place.location?.longitude) ? place.location.longitude : null,
    source: SOURCE_NAME,
  }
}

/**
 * Text-search Google Maps for places matching `query` (optionally biased toward
 * a `location` string and filtered by an `includedType`). Returns a normalized
 * array; never throws. Time-bounded via AbortController.
 *
 * @param {object}   args
 * @param {string}   args.query       free-text query, e.g. "nonprofit organizations in Nashville TN"
 * @param {string}   [args.location]  human location appended to the query for biasing
 * @param {string}   [args.type]      Places `includedType` (e.g. "non_profit_organization")
 * @param {number}   [args.limit=20]  max results (Places caps at 20/page)
 * @param {object}   [deps]
 * @param {string}   [deps.apiKey]    overrides env (tests inject)
 * @param {Function} [deps.fetchImpl] overrides global fetch (tests inject)
 * @param {object}   [deps.env]       overrides process.env
 * @param {number}   [deps.timeoutMs] request timeout (default 9000)
 * @returns {Promise<Array<{name,website,address,phone,place_id,types,lat,lng,source}>>}
 */
export async function searchPlaces({ query, location, type, limit = 20 } = {}, deps = {}) {
  const env = deps.env || process.env
  const apiKey = deps.apiKey || getGoogleMapsApiKey(env)
  if (!apiKey) {
    log.info('Google Maps source inactive — set GOOGLE_MAPS_API_KEY to enable Google Maps source')
    return []
  }

  const textQuery = [String(query || '').trim(), String(location || '').trim()]
    .filter(Boolean)
    .join(' ')
    .trim()
  if (!textQuery) return []

  const fetchImpl = typeof deps.fetchImpl === 'function'
    ? deps.fetchImpl
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null)
  if (!fetchImpl) {
    log.warn('Google Maps source: no fetch implementation available')
    return []
  }

  const pageSize = Math.max(1, Math.min(20, Number(limit) || 20))
  const body = { textQuery, pageSize }
  if (type) body.includedType = String(type)

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), Number(deps.timeoutMs) || 9000)
  let res
  try {
    res = await fetchImpl(PLACES_TEXT_SEARCH_ENDPOINT, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    if (err?.name !== 'AbortError') {
      log.warn(`Google Maps request failed for "${textQuery}": ${err?.message || err}`)
    } else {
      log.warn(`Google Maps request timed out for "${textQuery}"`)
    }
    return []
  } finally {
    clearTimeout(timer)
  }

  if (res.status === 429 || res.status === 402) {
    log.warn(`Google Maps quota/billing limit (${res.status}) for "${textQuery}" — backing off`)
    return []
  }
  if (!res.ok) {
    log.warn(`Google Maps returned ${res.status} for "${textQuery}"`)
    return []
  }

  let json
  try {
    json = await res.json()
  } catch {
    return []
  }
  const places = Array.isArray(json?.places) ? json.places : []
  return places.map(normalizePlace).filter(Boolean).slice(0, pageSize)
}

export const __googleMaps__ = { normalizePlace, PLACES_TEXT_SEARCH_ENDPOINT, FIELD_MASK, SOURCE_NAME }

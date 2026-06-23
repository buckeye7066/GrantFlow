/**
 * yana/osmProvider.js
 *
 * A FREE, keyless OpenStreetMap source for Yana's outbound prospect discovery —
 * the no-cost replacement for the Google Maps Places source (which needs a
 * billed API key). It finds LOCAL mission/community organizations near the
 * discovery geography (nonprofits, charities, foundations, churches, community
 * centers, libraries, schools) and feeds them into Yana's lead pipeline
 * (score -> qualify -> enrich -> push to John). It deliberately targets only
 * mission/community tags, never commercial chains (fast food / fuel / retail).
 *
 * Two public, no-key OSM endpoints:
 *   1. Nominatim search   -> geocode the location string to a bounding box.
 *   2. Overpass API        -> mission-org POIs within that bbox + their tags.
 * OSM etiquette: a descriptive User-Agent is required; calls are bounded and
 * failure-tolerant — any error / non-JSON / timeout returns [] (Yana then
 * behaves exactly as when the source is unavailable). Websites are often absent
 * in OSM; that's fine — Yana's contact enrichment finds the site/email later.
 */

import { createLogger } from '../../utils/logger.js'

const log = createLogger('yanaOSM')

const NOMINATIM = 'https://nominatim.openstreetmap.org/search'
const OVERPASS = 'https://overpass-api.de/api/interpreter'
const SOURCE_NAME = 'openstreetmap'
const UA = 'GrantFlow/1.0 (nonprofit grant discovery; buckeye7066@gmail.com)'

function getFetch(deps = {}) {
  if (typeof deps.fetchImpl === 'function') return deps.fetchImpl
  return typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null
}

async function withTimeout(fetchImpl, url, init, timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Geocode a "City, State" string to an OSM bounding box [s, w, n, e] or null. */
async function geocodeBbox(location, deps = {}) {
  const fetchImpl = getFetch(deps)
  if (!fetchImpl || !location) return null
  const url = `${NOMINATIM}?q=${encodeURIComponent(location)}&format=json&limit=1`
  try {
    const res = await withTimeout(fetchImpl, url, { headers: { 'user-agent': UA, accept: 'application/json' } }, Number(deps.timeoutMs) || 9000)
    if (!res.ok) return null
    const arr = await res.json().catch(() => [])
    const bb = arr?.[0]?.boundingbox // [south, north, west, east]
    if (!Array.isArray(bb) || bb.length < 4) return null
    const [s, n, w, e] = bb.map(Number)
    if ([s, n, w, e].some((x) => !Number.isFinite(x))) return null
    return { s, n, w, e }
  } catch (err) {
    log.warn(`OSM geocode failed for "${location}": ${err?.message || err}`)
    return null
  }
}

/** Compose a single-line street address from OSM addr:* tags (or null). */
function composeAddress(tags) {
  const parts = [
    [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' '),
    tags['addr:city'],
    [tags['addr:state'], tags['addr:postcode']].filter(Boolean).join(' '),
  ].filter(Boolean)
  return parts.length ? parts.join(', ') : null
}

/** Map one Overpass element to Yana's normalized place shape (mirrors googleMapsProvider). */
function normalizeElement(el) {
  const tags = el?.tags
  if (!tags || !tags.name) return null
  const kind = tags.office || tags.amenity || tags.club || null
  return {
    name: String(tags.name),
    website: tags.website || tags['contact:website'] || null,
    address: composeAddress(tags),
    phone: tags.phone || tags['contact:phone'] || null,
    place_id: el.type && el.id ? `osm:${el.type}/${el.id}` : null,
    types: kind ? [kind] : [],
    lat: Number.isFinite(el.lat) ? el.lat : (Number.isFinite(el.center?.lat) ? el.center.lat : null),
    lng: Number.isFinite(el.lon) ? el.lon : (Number.isFinite(el.center?.lon) ? el.center.lon : null),
    source: SOURCE_NAME,
  }
}

/**
 * Find local mission/community organizations near `location`. Returns a
 * normalized array (same shape as googleMapsProvider.searchPlaces); never throws.
 *
 * @param {object} args
 * @param {string} args.location  human "City, State" string (required — the bbox anchor)
 * @param {number} [args.limit=40]
 * @param {object} [deps] { fetchImpl, timeoutMs } injectable for tests
 */
export async function searchPlaces({ location, limit = 40 } = {}, deps = {}) {
  const fetchImpl = getFetch(deps)
  if (!fetchImpl) { log.warn('OSM source: no fetch implementation'); return [] }
  const loc = String(location || '').trim()
  if (!loc) return [] // OSM source is geo-anchored; without a location it no-ops
  const box = await geocodeBbox(loc, deps)
  if (!box) return []
  const bbox = `${box.s},${box.w},${box.n},${box.e}`
  // Mission/community/nonprofit/faith/education ONLY — never commercial chains.
  const ql = `[out:json][timeout:25];(`
    + `nwr[office~"ngo|charity|association|foundation|educational|religion"](${bbox});`
    + `nwr[amenity~"community_centre|social_facility|social_centre|place_of_worship|library"](${bbox});`
    + `nwr[amenity~"school|college|university"][website](${bbox});`
    + `);out tags center ${Math.max(1, Math.min(200, Number(limit) * 3 || 120))};`
  let res
  try {
    res = await withTimeout(fetchImpl, OVERPASS, {
      method: 'POST',
      headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: 'data=' + encodeURIComponent(ql),
    }, Number(deps.timeoutMs) || 25000)
  } catch (err) {
    log.warn(`OSM Overpass request failed for "${loc}": ${err?.message || err}`)
    return []
  }
  const ct = res.headers?.get?.('content-type') || ''
  if (!res.ok || !ct.includes('json')) {
    log.warn(`OSM Overpass non-JSON/${res.status} for "${loc}"`)
    return []
  }
  let json
  try { json = await res.json() } catch { return [] }
  const els = Array.isArray(json?.elements) ? json.elements : []
  const seen = new Set()
  const out = []
  for (const el of els) {
    const p = normalizeElement(el)
    if (!p) continue
    const key = p.name.toLowerCase().trim()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
    if (out.length >= Math.max(1, Number(limit) || 40)) break
  }
  return out
}

export const __osm__ = { normalizeElement, composeAddress, geocodeBbox, SOURCE_NAME }

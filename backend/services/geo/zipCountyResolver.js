import fetch from 'node-fetch'
import { ensureZipGeoCache } from './geoSchema.js'

async function fetchCountyFromFcc(lat, lng) {
  if (lat == null || lng == null) return null
  const url = `https://geo.fcc.gov/api/census/block/find?latitude=${encodeURIComponent(
    lat,
  )}&longitude=${encodeURIComponent(lng)}&format=json`
  const response = await fetch(url, {
    headers: { 'User-Agent': 'GrantFlow/1.0 (admin geo crawl)' },
  })
  if (!response.ok) {
    throw new Error(`FCC geo API error: ${response.status} ${response.statusText}`)
  }
  const json = await response.json()
  const countyName = json?.County?.name ?? null
  return typeof countyName === 'string' && countyName.trim() ? countyName.trim() : null
}

export async function resolveZipCounty(db, zipEntry) {
  ensureZipGeoCache(db)
  const zip = zipEntry?.zip_code
  if (!zip) return null

  const existing = db
    .prepare(`SELECT zip_code, city, state, county, lat, lng FROM zip_geo_cache WHERE zip_code = ?`)
    .get(zip)

  if (existing?.county) {
    return existing
  }

  const city = zipEntry.city ?? existing?.city ?? null
  const state = zipEntry.state ?? existing?.state ?? null
  const lat = zipEntry.lat ?? existing?.lat ?? null
  const lng = zipEntry.lng ?? existing?.lng ?? null

  let county = null
  try {
    county = await fetchCountyFromFcc(lat, lng)
  } catch (error) {
    // Keep running; county is optional (but improves targeting).
    console.warn('[zipCountyResolver] County lookup failed for', zip, error.message)
  }

  db.prepare(
    `
      INSERT INTO zip_geo_cache (zip_code, city, state, county, lat, lng, last_resolved_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(zip_code) DO UPDATE SET
        city = COALESCE(excluded.city, zip_geo_cache.city),
        state = COALESCE(excluded.state, zip_geo_cache.state),
        county = COALESCE(excluded.county, zip_geo_cache.county),
        lat = COALESCE(excluded.lat, zip_geo_cache.lat),
        lng = COALESCE(excluded.lng, zip_geo_cache.lng),
        last_resolved_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    `,
  ).run(zip, city, state, county, lat, lng)

  return db
    .prepare(`SELECT zip_code, city, state, county, lat, lng FROM zip_geo_cache WHERE zip_code = ?`)
    .get(zip)
}

export default { resolveZipCounty }


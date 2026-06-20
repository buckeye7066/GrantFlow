import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'

let cached = null
let loadedFrom = null
let cachedFromZipcodesDataset = false
const require = createRequire(import.meta.url)

function loadMappingOnce() {
  if (cached) return cached

  const repoRoot = path.resolve(process.cwd())
  const candidates = [
    process.env.ZIP_COUNTY_MAP_PATH ? path.resolve(process.env.ZIP_COUNTY_MAP_PATH) : null,
    path.join(repoRoot, 'backend', 'resources', 'zip_county_map.json'),
  ].filter(Boolean)

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue
      const raw = fs.readFileSync(p, 'utf8')
      const json = JSON.parse(raw)
      if (json && typeof json === 'object') {
        cached = json
        loadedFrom = p
        cachedFromZipcodesDataset = false
        return cached
      }
    } catch {
      // try next
    }
  }

  // Fallback: use an offline ZIP→county dataset shipped as an npm dependency.
  // This satisfies “real county names” without relying on any network lookup.
  //
  // NOTE: `zipcodes-nrviens` is CJS; ESM import yields a default export.
  try {
    const mod = require('zipcodes-nrviens')
    if (mod && typeof mod.lookup === 'function') {
      cached = { __zipcodes_dataset__: mod }
      loadedFrom = 'npm:zipcodes-nrviens'
      cachedFromZipcodesDataset = true
      return cached
    }
  } catch {
    // ignore
  }

  cached = {}
  loadedFrom = null
  cachedFromZipcodesDataset = false
  return cached
}

export function getZipCountyMappingSource() {
  loadMappingOnce()
  return loadedFrom
}

/**
 * Resolve a full city / state / county for a US ZIP code.
 *
 * Used by the public onboarding flow to auto-fill the location step the
 * moment a visitor types a valid ZIP — no network call, no leaking the
 * user's ZIP to a third-party geocoder. Returns null when the ZIP is
 * malformed or unknown.
 *
 * Returns: { zip, city, state, county } | null
 */
export function resolveZipLocation(zip) {
  const z = String(zip || '').trim()
  if (!/^\d{5}$/.test(z)) return null
  const mapping = loadMappingOnce()

  if (cachedFromZipcodesDataset && mapping?.__zipcodes_dataset__) {
    try {
      const row = mapping.__zipcodes_dataset__.lookup(z)
      if (!row) return null
      const state = row.state ? String(row.state).trim().toUpperCase() : null
      const city = row.city ? String(row.city).trim() : null
      const county = row.county ? String(row.county).trim() : null
      if (!state && !city) return null
      return { zip: z, city, state, county }
    } catch {
      return null
    }
  }

  const entry = mapping?.[z] ?? null
  if (!entry || typeof entry !== 'object') return null
  const state = entry.state ? String(entry.state).trim().toUpperCase() : null
  const city = entry.city ? String(entry.city).trim() : null
  const county = entry.county ? String(entry.county).trim() : null
  if (!state && !city) return null
  return { zip: z, city, state, county }
}

/**
 * Resolve county name for a US ZIP code.
 *
 * Mapping file format (zip_county_map.json):
 * {
 *   "37323": { "state": "TN", "county": "McMinn County" },
 *   "10001": { "state": "NY", "county": "New York County" }
 * }
 */
export function resolveCountyForZip(zip, stateHint = null) {
  const z = String(zip || '').trim()
  if (!/^\d{5}$/.test(z)) return null
  const mapping = loadMappingOnce()

  if (cachedFromZipcodesDataset && mapping?.__zipcodes_dataset__) {
    try {
      const mod = mapping.__zipcodes_dataset__
      const row = mod.lookup(z)
      const county = row?.county ? String(row.county).trim() : null
      if (!county) return null

      const state = row?.state ? String(row.state).trim().toUpperCase() : null
      const hint = stateHint ? String(stateHint).trim().toUpperCase() : null
      if (hint && state && hint !== state) return null

      return county
    } catch {
      return null
    }
  }

  const entry = mapping?.[z] ?? null
  if (!entry || typeof entry !== 'object') return null

  const county = entry.county ? String(entry.county).trim() : null
  if (!county) return null

  const state = entry.state ? String(entry.state).trim().toUpperCase() : null
  const hint = stateHint ? String(stateHint).trim().toUpperCase() : null
  if (hint && state && hint !== state) {
    // Mismatch: safer to return null than show a wrong county.
    return null
  }

  return county
}


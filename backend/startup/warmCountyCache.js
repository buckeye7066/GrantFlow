/**
 * warmCountyCache — regenerate the counties-by-state cache at boot.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 * ─────────────────────────────────────────────────────────────────────────
 * Broad county enumeration (the admin geo endpoints in routes/admin.js —
 * `/geo/state/:state/counties` and `/index-counties`) reads a counties-by-state
 * dataset. That dataset lives under `backend/data/`, which is gitignored
 * (generated/runtime data) AND ephemeral on Railway — so a fresh boot has no
 * cache and every county-dropdown request recomputes counties by iterating an
 * entire state's ZIPs through `resolveCountyForZip`. Correct, but slow and
 * repeated per process.
 *
 * This task regenerates the cache ONCE per boot from the app's OWN resolver
 * (real county names via the offline `zipcodes-nrviens` dataset — no network),
 * so enumeration is instant and file-backed. `admin.js#loadCountiesByState`
 * re-resolves the dataset path while its cache is empty, so a file written here
 * shortly after boot is picked up without a restart.
 *
 * It does NOT change crawl behavior: the national crawler resolves county
 * per-ZIP directly; this only warms the admin enumeration cache. Best-effort and
 * non-blocking — a failure never affects boot or requests, which keep the
 * on-demand fallback.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { resolveCountyForZip } from '../services/geo/zipCountyResolver.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(__dirname, '..', '..')
const require = createRequire(import.meta.url)

// 50 states + DC. Mirrors the admin geo UI's coverage.
const STATES = Object.freeze([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID',
  'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO',
  'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA',
  'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
])

// A cache is "fresh enough" to skip regeneration when it already covers most
// states — this is the same shape admin.js reads: { STATE: [countyName, ...] }.
const MIN_FRESH_STATES = 45

/** The dataset path admin.js reads (matches routes/admin.js resolveCountiesDatasetPath default). */
export function countyCachePath() {
  if (process.env.GEO_COUNTIES_BY_STATE_PATH) {
    return path.resolve(process.env.GEO_COUNTIES_BY_STATE_PATH)
  }
  return path.join(repoRoot, 'backend', 'data', 'crawlers', 'counties_by_state.json')
}

function existingCacheStateCount(cachePath) {
  try {
    if (!fs.existsSync(cachePath)) return 0
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return 0
    return Object.keys(parsed).filter((k) => Array.isArray(parsed[k]) && parsed[k].length).length
  } catch {
    return 0
  }
}

async function countiesForState(zipcodes, state) {
  const rows = zipcodes.lookupByState(state) || []
  const seen = new Map() // normalized -> original (matches admin.js computeCountiesForState)
  for (const row of rows) {
    const zip = String(row?.zip || '').padStart(5, '0')
    if (!/^\d{5}$/.test(zip)) continue
    const county = await resolveCountyForZip(zip, state)
    if (!county) continue
    const norm = String(county).trim().toLowerCase().replace(/\s+county\s*$/, '')
    if (norm && !seen.has(norm)) seen.set(norm, String(county).trim())
  }
  return Array.from(seen.values()).sort((a, b) => a.localeCompare(b))
}

/**
 * Regenerate the counties-by-state cache.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force] regenerate even when a fresh cache exists
 * @param {string[]} [opts.states] limit to specific states (used by tests)
 * @returns {Promise<{ ok: boolean, written?: boolean, skipped?: string, states?: number, counties?: number, path?: string, error?: string }>}
 */
export async function warmCountyCache({ force = false, states = STATES } = {}) {
  const cachePath = countyCachePath()
  try {
    if (/^(0|false|no|off)$/i.test(String(process.env.WARM_COUNTY_CACHE || ''))) {
      return { ok: true, skipped: 'disabled' }
    }
    if (!force && existingCacheStateCount(cachePath) >= MIN_FRESH_STATES) {
      return { ok: true, skipped: 'cache_fresh', path: cachePath }
    }

    let zipcodes
    try {
      zipcodes = require('zipcodes')
    } catch {
      return { ok: false, skipped: 'zipcodes_unavailable' }
    }
    if (typeof zipcodes?.lookupByState !== 'function') {
      return { ok: false, skipped: 'zipcodes_unavailable' }
    }

    const out = {}
    let counties = 0
    for (const state of states) {
      out[state] = await countiesForState(zipcodes, state)
      counties += out[state].length
    }

    // Guard against writing a degenerate cache (e.g. resolver dataset missing).
    const covered = Object.values(out).filter((v) => Array.isArray(v) && v.length).length
    if (states === STATES && covered < MIN_FRESH_STATES) {
      return { ok: false, skipped: 'insufficient_data', states: covered, counties }
    }

    fs.mkdirSync(path.dirname(cachePath), { recursive: true })
    fs.writeFileSync(cachePath, `${JSON.stringify(out)}\n`, 'utf8')
    return { ok: true, written: true, states: Object.keys(out).length, counties, path: cachePath }
  } catch (err) {
    // Best-effort: never let a warm failure surface to boot.
    return { ok: false, error: err?.message || String(err) }
  }
}

export default warmCountyCache

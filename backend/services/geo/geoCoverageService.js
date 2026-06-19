/**
 * Geographic Coverage Service
 *
 * Resolves geographic coverage for a profile using progressive expansion:
 *   1. Local (25 mi radius) — nearby ZIPs via haversine
 *   2. Expanded (50 mi radius) — wider radius for rural/sparse areas
 *   3. State — all opportunities in the profile's state(s)
 *   4. National — is_national / nationwide fallback
 *
 * Ensures rural areas still return results and no profile returns zero
 * when data exists anywhere in the system.
 */

import zipcodes from 'zipcodes'
import { haversineDistanceMiles } from '../sharedGeo.js'
import { createLogger } from '../../utils/logger.js'
const log = createLogger('geoCoverageService')

// ── Thresholds ──────────────────────────────────────────────────────────────
const LOCAL_RADIUS_MI = 25
const EXPANDED_RADIUS_MI = 50
const MIN_LOCAL_RESULTS = 5
const MIN_EXPANDED_RESULTS = 10
const MIN_STATE_RESULTS = 3

// ── In-memory cache: centerZip → { radius → [{ zip, distance, state }] } ──
const _nearbyCache = new Map()

/**
 * Find all US ZIP codes within `radiusMiles` of `centerZip`.
 * Uses the in-memory `zipcodes` dataset + haversine. Cached per (zip, radius).
 *
 * @param {string} centerZip  5-digit ZIP
 * @param {number} radiusMiles  search radius (default 25)
 * @returns {{ zip: string, distance: number, state: string }[]}
 */
export function findNearbyZips(centerZip, radiusMiles = LOCAL_RADIUS_MI) {
  const cacheKey = `${centerZip}:${radiusMiles}`
  if (_nearbyCache.has(cacheKey)) return _nearbyCache.get(cacheKey)

  const center = zipcodes.lookup(centerZip)
  if (!center) return []
  const cLat = parseFloat(center.latitude)
  const cLng = parseFloat(center.longitude)
  if (!Number.isFinite(cLat) || !Number.isFinite(cLng)) return []

  const results = []
  const allCodes = zipcodes.codes || {}

  for (const zip of Object.keys(allCodes)) {
    if (zip === centerZip) continue
    const info = allCodes[zip]
    const zLat = parseFloat(info.latitude)
    const zLng = parseFloat(info.longitude)
    if (!Number.isFinite(zLat) || !Number.isFinite(zLng)) continue

    const dist = haversineDistanceMiles(cLat, cLng, zLat, zLng)
    if (dist <= radiusMiles) {
      results.push({
        zip,
        distance: Math.round(dist * 10) / 10,
        state: info.state ? String(info.state).toUpperCase() : null,
      })
    }
  }

  results.sort((a, b) => a.distance - b.distance)
  _nearbyCache.set(cacheKey, results)
  return results
}

/**
 * Count active opportunities reachable from a set of ZIPs via the geo index.
 * Falls back gracefully if the table is missing.
 */
async function countGeoIndexHits(db, zips) {
  if (!db || !zips?.length) return 0
  try {
    const ph = zips.map(() => '?').join(',')
    const isPostgres = db?.dialect === 'postgres'
    const activeVal = isPostgres ? 'TRUE' : '1'
    const sql = `
      SELECT COUNT(DISTINCT gi.opportunity_id) AS cnt
      FROM funding_opportunity_geo_index gi
      JOIN funding_opportunities fo ON fo.id = gi.opportunity_id
      WHERE gi.zip IN (${ph})
        AND fo.is_active = ${activeVal}
    `
    const row = await db.prepare(sql).get(...zips)
    return Number(row?.cnt ?? 0)
  } catch {
    return 0
  }
}

/**
 * Fetch distinct opportunity IDs from the geo index for a ZIP set.
 */
async function fetchGeoIndexIds(db, zips, limit = 3000) {
  if (!db || !zips?.length) return []
  try {
    const ph = zips.map(() => '?').join(',')
    const isPostgres = db?.dialect === 'postgres'
    const activeVal = isPostgres ? 'TRUE' : '1'
    // Coerce LIMIT to a bounded integer before interpolation — never trust the
    // caller-supplied value verbatim in SQL (LIMIT can't be parameterized
    // portably across both drivers through this wrapper).
    const safeLimit = Math.max(1, Math.min(100000, Math.floor(Number(limit)) || 3000))
    const sql = `
      SELECT DISTINCT gi.opportunity_id
      FROM funding_opportunity_geo_index gi
      JOIN funding_opportunities fo ON fo.id = gi.opportunity_id
      WHERE gi.zip IN (${ph})
        AND fo.is_active = ${activeVal}
      LIMIT ${safeLimit}
    `
    const rows = await db.prepare(sql).all(...zips)
    return (rows || []).map((r) => r.opportunity_id).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Count active opportunities by state(s).
 */
async function countStateHits(db, states) {
  if (!db || !states?.length) return 0
  try {
    const ph = states.map(() => '?').join(',')
    const isPostgres = db?.dialect === 'postgres'
    const activeVal = isPostgres ? 'TRUE' : '1'
    const sql = `
      SELECT COUNT(*) AS cnt FROM funding_opportunities
      WHERE state IN (${ph}) AND is_active = ${activeVal}
    `
    const row = await db.prepare(sql).get(...states)
    return Number(row?.cnt ?? 0)
  } catch {
    return 0
  }
}

/**
 * Resolve geographic coverage for a profile.
 *
 * Returns the set of ZIPs to search, nearby states for cross-border coverage,
 * the tier that was sufficient, and stats for logging.
 *
 * @param {object} db
 * @param {{ zip?: string, state?: string, county?: string }} location
 * @returns {Promise<GeoCoverageResult>}
 *
 * @typedef {object} GeoCoverageResult
 * @property {string[]} localZips       ZIPs within 25mi (including center)
 * @property {string[]} expandedZips    ZIPs within 50mi (superset of localZips)
 * @property {Set<string>} nearbyStates All states represented by nearby ZIPs
 * @property {string} tier              'local' | 'expanded' | 'state' | 'national'
 * @property {object} stats             Counts at each expansion tier
 */
export async function resolveGeoCoverage(db, { zip, state, county } = {}) {
  const result = {
    localZips: [],
    expandedZips: [],
    nearbyStates: new Set(),
    tier: 'national',
    stats: { local: 0, expanded: 0, state: 0 },
  }

  if (state) result.nearbyStates.add(String(state).toUpperCase())

  if (!zip) {
    // No ZIP — skip radius tiers, go straight to state/national
    if (state) {
      const stateCount = await countStateHits(db, [String(state).toUpperCase()])
      result.stats.state = stateCount
      if (stateCount >= MIN_STATE_RESULTS) {
        result.tier = 'state'
      }
    }
    log.info(`[GeoCoverage] No ZIP; tier=${result.tier} states=[${[...result.nearbyStates]}]`)
    return result
  }

  // ── Tier 1: Local (25 mi) ──
  const nearby25 = findNearbyZips(zip, LOCAL_RADIUS_MI)
  result.localZips = [zip, ...nearby25.map((z) => z.zip)]
  for (const z of nearby25) {
    if (z.state) result.nearbyStates.add(z.state)
  }

  const localCount = await countGeoIndexHits(db, result.localZips)
  result.stats.local = localCount

  if (localCount >= MIN_LOCAL_RESULTS) {
    result.tier = 'local'
    log.info(
      `[GeoCoverage] zip=${zip} tier=local zips=${result.localZips.length} hits=${localCount} states=[${[...result.nearbyStates]}]`,
    )
    return result
  }

  // ── Tier 2: Expanded (50 mi) ──
  const nearby50 = findNearbyZips(zip, EXPANDED_RADIUS_MI)
  result.expandedZips = [zip, ...nearby50.map((z) => z.zip)]
  for (const z of nearby50) {
    if (z.state) result.nearbyStates.add(z.state)
  }

  const expandedCount = await countGeoIndexHits(db, result.expandedZips)
  result.stats.expanded = expandedCount

  if (expandedCount >= MIN_EXPANDED_RESULTS) {
    result.tier = 'expanded'
    log.info(
      `[GeoCoverage] zip=${zip} tier=expanded zips=${result.expandedZips.length} hits=${expandedCount} states=[${[...result.nearbyStates]}]`,
    )
    return result
  }

  // ── Tier 3: State ──
  if (result.nearbyStates.size > 0) {
    const stateCount = await countStateHits(db, [...result.nearbyStates])
    result.stats.state = stateCount
    if (stateCount >= MIN_STATE_RESULTS) {
      result.tier = 'state'
      log.info(
        `[GeoCoverage] zip=${zip} tier=state states=[${[...result.nearbyStates]}] hits=${stateCount}`,
      )
      return result
    }
  }

  // ── Tier 4: National (always included) ──
  log.info(
    `[GeoCoverage] zip=${zip} tier=national (local=${localCount} expanded=${expandedCount} state=${result.stats.state})`,
  )
  return result
}

/**
 * Build the SQL WHERE clause for geographic coverage.
 * Returns { clause: string, params: any[] } to append to a query.
 *
 * The clause includes geo-index ZIP hits (local/expanded), state matches,
 * and always includes national opportunities as a safety net.
 */
export function buildGeoCoverageClause(db, geoCoverage) {
  const isPostgres = db?.dialect === 'postgres'
  const parts = []
  const params = []

  const tier = geoCoverage?.tier || 'national'
  const nearbyStates = geoCoverage?.nearbyStates instanceof Set
    ? [...geoCoverage.nearbyStates]
    : Array.isArray(geoCoverage?.nearbyStates) ? geoCoverage.nearbyStates : []

  // ZIP-level matches (from geo_index populated ZIPs or direct geo_zip column)
  const zipsToUse =
    tier === 'local' ? geoCoverage.localZips
      : tier === 'expanded' ? geoCoverage.expandedZips
        : []

  if (zipsToUse.length > 0) {
    const ph = zipsToUse.map(() => '?').join(',')
    // Match opportunities whose geo_zip is in our radius
    parts.push(`geo_zip IN (${ph})`)
    params.push(...zipsToUse)
  }

  // State-level matches (includes cross-border states from nearby ZIPs)
  if (nearbyStates.length > 0) {
    const ph = nearbyStates.map(() => '?').join(',')
    parts.push(`state IN (${ph})`)
    params.push(...nearbyStates)
  }

  // Always include national opportunities and state=NULL (unscoped)
  const natClause = isPostgres
    ? "(is_national = TRUE OR state = 'nationwide')"
    : "(is_national = 1 OR state = 'nationwide')"
  parts.push(natClause)
  parts.push('state IS NULL')

  // Also include opportunities that match by geo_index (subquery)
  if (zipsToUse.length > 0) {
    const ph = zipsToUse.map(() => '?').join(',')
    parts.push(
      `id IN (SELECT opportunity_id FROM funding_opportunity_geo_index WHERE zip IN (${ph}))`,
    )
    params.push(...zipsToUse)
  }

  const clause = parts.length > 0 ? `(${parts.join(' OR ')})` : '1=1'
  return { clause, params }
}

/**
 * Populate the geo index for all states where profiles exist.
 * Returns a list of states that need geo crawling.
 */
export async function findStatesNeedingCoverage(db) {
  if (!db) return []

  try {
    const profileStatesRaw = await db
      .prepare(
        `SELECT DISTINCT
           UPPER(COALESCE(p.state, o.state)) AS st
         FROM profiles p
         LEFT JOIN organizations o ON o.id = p.organization_id
         WHERE COALESCE(p.state, o.state) IS NOT NULL`,
      )
      .all()

    const allStates = (profileStatesRaw || [])
      .map((r) => r?.st || r?.ST)
      .filter((s) => s && /^[A-Z]{2}$/.test(String(s).trim()))
      .map((s) => String(s).trim().toUpperCase())

    const unique = [...new Set(allStates)]

    // Check which states have geo coverage already
    const covered = []
    const uncovered = []

    for (const st of unique) {
      try {
        const row = await db
          .prepare(
            `SELECT COUNT(*) AS cnt FROM geo_state_runs WHERE state = ? AND status = 'completed'`,
          )
          .get(st)
        if (Number(row?.cnt ?? 0) > 0) {
          covered.push(st)
        } else {
          uncovered.push(st)
        }
      } catch {
        uncovered.push(st)
      }
    }

    log.info(
      `[GeoCoverage] Profile states: ${unique.length} total, ${covered.length} covered, ${uncovered.length} need crawling`,
    )
    return { all: unique, covered, uncovered }
  } catch (e) {
    console.error('[GeoCoverage] findStatesNeedingCoverage error:', e?.message || e)
    return { all: [], covered: [], uncovered: [] }
  }
}

/**
 * Ensure the geo_zip_coverage table + indexes exist.
 * Called during schema migration or before population.
 */
export async function ensureGeoCoverageTables(db) {
  if (!db) return
  const isPostgres = db?.dialect === 'postgres'

  try {
    await db
      .prepare(
        isPostgres
          ? `
              CREATE TABLE IF NOT EXISTS geo_zip_coverage (
                center_zip TEXT NOT NULL,
                nearby_zip TEXT NOT NULL,
                distance_miles REAL NOT NULL,
                tier TEXT NOT NULL CHECK(tier IN ('local','expanded')),
                state TEXT,
                PRIMARY KEY (center_zip, nearby_zip)
              )
            `
          : `
              CREATE TABLE IF NOT EXISTS geo_zip_coverage (
                center_zip TEXT NOT NULL,
                nearby_zip TEXT NOT NULL,
                distance_miles REAL NOT NULL,
                tier TEXT NOT NULL CHECK(tier IN ('local','expanded')),
                state TEXT,
                PRIMARY KEY (center_zip, nearby_zip)
              )
            `,
      )
      .run()

    await db
      .prepare('CREATE INDEX IF NOT EXISTS idx_gzc_center ON geo_zip_coverage(center_zip)')
      .run()
    await db
      .prepare('CREATE INDEX IF NOT EXISTS idx_gzc_nearby ON geo_zip_coverage(nearby_zip)')
      .run()
    await db
      .prepare('CREATE INDEX IF NOT EXISTS idx_gzc_tier ON geo_zip_coverage(center_zip, tier)')
      .run()

    // Ensure geo_index has a zip index for fast lookups
    await db
      .prepare(
        'CREATE INDEX IF NOT EXISTS idx_fo_geo_index_zip ON funding_opportunity_geo_index(zip)',
      )
      .run()
  } catch (e) {
    console.warn('[GeoCoverage] ensureGeoCoverageTables:', e?.message || e)
  }
}

/**
 * Populate the geo_zip_coverage table for a given center ZIP.
 * Stores all nearby ZIPs within 50mi (both local + expanded tiers).
 */
export async function populateZipCoverage(db, centerZip) {
  if (!db || !centerZip) return 0

  const nearby50 = findNearbyZips(centerZip, EXPANDED_RADIUS_MI)
  if (nearby50.length === 0) return 0

  const isPostgres = db?.dialect === 'postgres'
  let inserted = 0

  for (const entry of nearby50) {
    const tier = entry.distance <= LOCAL_RADIUS_MI ? 'local' : 'expanded'
    try {
      const sql = isPostgres
        ? `
            INSERT INTO geo_zip_coverage (center_zip, nearby_zip, distance_miles, tier, state)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (center_zip, nearby_zip) DO NOTHING
          `
        : `
            INSERT OR IGNORE INTO geo_zip_coverage (center_zip, nearby_zip, distance_miles, tier, state)
            VALUES (?, ?, ?, ?, ?)
          `
      await db.prepare(sql).run(centerZip, entry.zip, entry.distance, tier, entry.state)
      inserted++
    } catch {
      // best-effort
    }
  }

  return inserted
}

/**
 * Bulk-populate geo_zip_coverage for all ZIPs associated with profiles.
 * Returns summary stats.
 */
export async function populateProfileZipCoverage(db) {
  if (!db) return { zips: 0, entries: 0 }

  await ensureGeoCoverageTables(db)

  // Find all distinct ZIPs from profiles + organizations
  let profileZips = []
  try {
    const rows = await db
      .prepare(
        `SELECT DISTINCT COALESCE(p.postal_code, p.zip_code, o.zip) AS z
         FROM profiles p
         LEFT JOIN organizations o ON o.id = p.organization_id
         WHERE COALESCE(p.postal_code, p.zip_code, o.zip) IS NOT NULL`,
      )
      .all()
    profileZips = (rows || [])
      .map((r) => String(r?.z || '').trim())
      .filter((z) => /^\d{5}$/.test(z))
  } catch (e) {
    console.error('[GeoCoverage] Failed to fetch profile ZIPs:', e?.message || e)
    return { zips: 0, entries: 0 }
  }

  const uniqueZips = [...new Set(profileZips)]
  log.info(`[GeoCoverage] Populating coverage for ${uniqueZips.length} profile ZIPs...`)

  let totalEntries = 0
  for (let i = 0; i < uniqueZips.length; i++) {
    const count = await populateZipCoverage(db, uniqueZips[i])
    totalEntries += count
    if ((i + 1) % 50 === 0 || i === uniqueZips.length - 1) {
      log.info(`[GeoCoverage] Progress: ${i + 1}/${uniqueZips.length} ZIPs, ${totalEntries} entries`)
    }
  }

  log.info(`[GeoCoverage] Population complete: ${uniqueZips.length} ZIPs, ${totalEntries} coverage entries`)
  return { zips: uniqueZips.length, entries: totalEntries }
}

export default {
  findNearbyZips,
  resolveGeoCoverage,
  buildGeoCoverageClause,
  findStatesNeedingCoverage,
  ensureGeoCoverageTables,
  populateZipCoverage,
  populateProfileZipCoverage,
}

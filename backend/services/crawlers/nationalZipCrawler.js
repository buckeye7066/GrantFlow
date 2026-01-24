/**
 * Geo Crawl (ZIP discovery)
 *
 * Discovers real funding sources for ZIP-scoped crawl runs.
 * This is the canonical crawl path used by the Admin "Geo Crawl" tools.
 *
 * Features:
 * - Batch processing (configurable, default 25-100 ZIPs per batch)
 * - Checkpointing to national_zip_progress table every batch (legacy table name)
 * - Rate limiting and caching to avoid hammering upstream sources
 * - Resumable after interruption
 * - Memory-safe (no accumulating massive arrays)
 * 
 * Data sources:
 * - Grants.gov API (filter by geography where possible)
 * - State grant portal APIs
 * - Legitimate foundation locator services
 */

import axios from 'axios'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import zipcodes from 'zipcodes'

// All US ZIP codes (43,859 total)
// In production, this would be loaded from a file or database
// For now, we load from the local `zipcodes` dataset to avoid network lookups.
const US_ZIP_CODES_SAMPLE = generateUSZipCodes()

// Default configuration
const DEFAULT_CONFIG = {
  batch_size: 50,
  min_sources_per_zip: 3,
  rate_limit_ms: 1000, // 1 second between ZIP requests
  checkpoint_every: 50, // Checkpoint after every 50 ZIPs
  timeout_ms: 10000,
  // Geo Crawl discovery defaults (enabled via options.discover_local_resources)
  overpass_radius_km: 12,
  overpass_max_results: 60,
}

function normalizeUrl(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return null
  if (/^https?:\/\//i.test(value)) return value
  if (/^www\./i.test(value)) return `https://${value}`
  if (/^facebook\.com\//i.test(value) || /^instagram\.com\//i.test(value)) return `https://${value}`
  return null
}

function pickFirstUrl(...candidates) {
  for (const candidate of candidates) {
    const normalized = normalizeUrl(candidate)
    if (normalized) return normalized
  }
  return null
}

function isLoanOrMatchingFund(opp) {
  const title = String(opp?.title || '').toLowerCase()
  const desc = String(opp?.description || '').toLowerCase()
  const text = `${title} ${desc}`

  if (opp?.requires_match === true) return true
  if (/\bloan\b|\bmicroloan\b|\bfinancing\b|\bapr\b/.test(text)) return true
  if (/\bmatching\b|\bcost share\b|\bmatch required\b|\b1:1\b|\bdollar for dollar\b/.test(text)) return true
  return false
}

function normalizeZip(value) {
  const zip = String(value ?? '').trim()
  return /^\d{5}$/.test(zip) ? zip : null
}

function normalizeState(value) {
  const s = String(value ?? '').trim().toUpperCase()
  return /^[A-Z]{2}$/.test(s) ? s : null
}

function resolveZipList({ zip_list, state, max_zips } = {}) {
  let list = []

  if (Array.isArray(zip_list) && zip_list.length > 0) {
    list = zip_list.map(normalizeZip).filter(Boolean)
  } else {
    const st = normalizeState(state)
    if (st) {
      const byState = zipcodes.lookupByState(st) || []
      list = byState.map((row) => normalizeZip(row?.zip)).filter(Boolean)
    } else {
      list = US_ZIP_CODES_SAMPLE.slice()
    }
  }

  list = Array.from(new Set(list)).sort()

  const lim = Number(max_zips)
  if (Number.isFinite(lim) && lim > 0) {
    list = list.slice(0, Math.min(lim, list.length))
  }

  return list
}

function resolveFixturesDir(options = {}) {
  const candidate =
    options.fixtures_dir ||
    options.fixturesDir ||
    process.env.GEO_CRAWL_FIXTURES_DIR ||
    null
  if (!candidate) return null
  const p = path.resolve(String(candidate))
  try {
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p
  } catch {
    // ignore
  }
  return null
}

function readZipFixture(fixturesDir, zip) {
  if (!fixturesDir) return null
  const candidates = [
    path.join(fixturesDir, `zip_${zip}.json`),
    path.join(fixturesDir, `zip-${zip}.json`),
    path.join(fixturesDir, `${zip}.json`),
  ]
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue
      const raw = fs.readFileSync(p, 'utf8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed
      if (parsed && Array.isArray(parsed.opportunities)) return parsed.opportunities
    } catch {
      // ignore invalid fixture
    }
  }
  return null
}

function deriveZipMeta(zip) {
  try {
    const row = zipcodes.lookup(zip)
    if (!row) return null
    return {
      zip: normalizeZip(row?.zip) || zip,
      city: row?.city ?? null,
      state: normalizeState(row?.state) ?? null,
      lat: typeof row?.latitude === 'number' ? row.latitude : null,
      lng: typeof row?.longitude === 'number' ? row.longitude : null,
    }
  } catch {
    return null
  }
}

/**
 * Generate representative US ZIP codes
 * In production, load from zipcodes library or database
 */
function generateUSZipCodes() {
  // `zipcodes.codes` is an object keyed by ZIP string.
  // This dramatically reduces "skipped" runs caused by invalid generated ZIPs
  // and removes dependency on external geocoding APIs for basic ZIP metadata.
  const codes = zipcodes?.codes && typeof zipcodes.codes === 'object' ? zipcodes.codes : {}
  return Object.keys(codes).sort()
}

/**
 * Search Grants.gov API for a specific ZIP code
 */
async function searchGrantsGovByZip(zip, coords) {
  const opportunities = []
  
  try {
    // Grants.gov "search2" public API (2026).
    // Docs: https://api.grants.gov/v1/api/search2
    const body = {
      rows: 10,
      startRecordNum: 0,
      keyword: '',
      oppStatuses: 'posted',
      sortBy: 'openDate|desc',
    }

    const response = await axios.post('https://api.grants.gov/v1/api/search2', body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: DEFAULT_CONFIG.timeout_ms,
    })

    const hits = response?.data?.data?.oppHits
    if (Array.isArray(hits)) {
      for (const [idx, hit] of hits.entries()) {
        const sourceIdRaw = hit?.id || hit?.number || hit?.oppNumber || null
        opportunities.push({
          title: hit?.title || hit?.number || 'Grant opportunity',
          sponsor: hit?.agency || hit?.agencyCode || 'Grants.gov',
          description: '',
          url: hit?.id ? `https://www.grants.gov/search-results-detail/${hit.id}` : 'https://www.grants.gov',
          opportunity_number: hit?.number || null,
          deadline: hit?.closeDate || null,
          source: 'grants.gov',
          source_id: sourceIdRaw ? String(sourceIdRaw) : `grantsgov:${zip}:${idx}`,
          zip: zip,
          state: coords?.state,
        })
      }
    }
  } catch (error) {
    console.error(`[GeoCrawl] Grants.gov error for ZIP ${zip}:`, error.message)
  }
  
  return opportunities
}

function buildOverpassQuery({ lat, lng, radiusMeters, maxResults }) {
  const r = Math.max(1000, Math.min(50000, Number(radiusMeters) || 12000))
  const limit = Math.max(10, Math.min(500, Number(maxResults) || 60))

  return `
[out:json][timeout:25];
(
  nwr(around:${r},${lat},${lng})["amenity"="food_bank"];
  nwr(around:${r},${lat},${lng})["amenity"="shelter"];
  nwr(around:${r},${lat},${lng})["amenity"="community_centre"];
  nwr(around:${r},${lat},${lng})["amenity"="townhall"];
  nwr(around:${r},${lat},${lng})["social_facility"];
  nwr(around:${r},${lat},${lng})["office"="government"];
  nwr(around:${r},${lat},${lng})["office"="ngo"];
  nwr(around:${r},${lat},${lng})["shop"="charity"];
  nwr(around:${r},${lat},${lng})["shop"="second_hand"];
);
out tags center ${limit};
`
    .trim()
}

function mapOsmElementToOpportunity({ element, zip, coords }) {
  const tags = element?.tags ?? {}
  const name = String(tags.name || tags.operator || tags.brand || '').trim()
  if (!name) return null

  const url = pickFirstUrl(
    tags.website,
    tags['contact:website'],
    tags.url,
    tags['contact:url'],
    tags['contact:facebook'],
    tags.facebook,
    tags['contact:instagram'],
    tags.instagram,
  )
  if (!url) return null

  const kind = String(tags.amenity || tags.social_facility || tags.shop || '').trim()
  const normalizedKind = kind.toLowerCase()

  const categories = []
  if (normalizedKind.includes('food')) categories.push('food_assistance')
  if (normalizedKind.includes('shelter')) categories.push('housing_assistance')
  if (normalizedKind.includes('community')) categories.push('community_support')
  if (normalizedKind.includes('charity') || normalizedKind.includes('second_hand')) {
    categories.push('material_assistance')
  }
  if (tags.social_facility) categories.push('social_services')

  const city = coords?.city ? String(coords.city) : ''
  const state = coords?.state ? String(coords.state) : null
  const keywords = [zip, city, state, normalizedKind].filter(Boolean).map((v) => String(v).toLowerCase())

  const suffix = normalizedKind ? ` (${normalizedKind.replace(/_/g, ' ')})` : ''

  return {
    title: `${name}${suffix}`,
    sponsor: name,
    description:
      tags.description
        ? String(tags.description).trim().slice(0, 600)
        : `Local resource discovered near ${zip}${city ? ` (${city})` : ''}.`,
    url,
    application_url: url,
    source_url: url,
    evidence_url: url,
    opportunity_type: 'benefit',
    type: 'PROGRAM',
    requires_match: false,
    match_percentage: 0,
    is_national: false,
    state,
    categories,
    keywords,
    source: 'osm_overpass',
    source_id: `${element.type}:${element.id}`,
    last_verified_at: new Date().toISOString(),
  }
}

async function searchOverpassLocalResources(zip, coords, config) {
  const opportunities = []
  if (!coords || !Number.isFinite(coords.lat) || !Number.isFinite(coords.lng)) return opportunities

  const query = buildOverpassQuery({
    lat: coords.lat,
    lng: coords.lng,
    radiusMeters: Number(config.overpass_radius_km ?? 12) * 1000,
    maxResults: config.overpass_max_results ?? 60,
  })

  try {
    const resp = await axios.post(
      'https://overpass-api.de/api/interpreter',
      new URLSearchParams({ data: query }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: Math.max(8000, Number(config.timeout_ms) || 10000),
      },
    )

    const elements = resp?.data?.elements
    if (!Array.isArray(elements)) return opportunities

    for (const el of elements) {
      const mapped = mapOsmElementToOpportunity({ element: el, zip, coords })
      if (mapped) opportunities.push(mapped)
    }
  } catch (error) {
    console.warn(`[GeoCrawl] Overpass error for ZIP ${zip}:`, error?.message || error)
  }

  return opportunities
}

/**
 * Search state grant portals by ZIP
 */
async function searchStateGrantsByZip(zip, coords) {
  const opportunities = []
  
  if (!coords || !coords.state) {
    return opportunities
  }
  
  const state = normalizeState(coords.state)
  if (!state) return opportunities

  // State grant portal URLs (best-effort directory links; no scraping here)
  const statePortals = {
    NY: 'https://grantsgateway.ny.gov/IntelliGrants_NYSGG/module/nysgg/goportal.aspx',
    CA: 'https://www.grants.ca.gov/',
    TX: 'https://gov.texas.gov/organization/financial-services/grants',
    FL: 'https://www.flgov.com/grant-opportunities/',
    PA: 'https://www.grants.pa.gov/',
    IL: 'https://www2.illinois.gov/sites/GATA/Grants/Pages/default.aspx',
    OH: 'https://grants.ohio.gov/',
    GA: 'https://gema.georgia.gov/grants',
    NC: 'https://www.osbm.nc.gov/grants',
    MI: 'https://www.michigan.gov/leo/bureaus-agencies/michiganworks/grants',
    TN: 'https://www.tn.gov/finance/grants.html',
    CO: 'https://www.colorado.gov/grants',
  }
  
  try {
    // Always return a real, user-actionable directory source (even if we don't have a
    // state-specific portal link yet).
    const portalUrl = statePortals[state] || 'https://www.grants.gov/search-grants'
    const stateName = zipcodes?.states?.[state] || state

    opportunities.push({
      title: `${stateName} Grant Opportunities Portal`,
      sponsor: `${stateName} State Government`,
      description:
        portalUrl === 'https://www.grants.gov/search-grants'
          ? `Directory link for grant opportunities relevant to ${stateName}. This is a fallback link when a state-specific portal is not configured.`
          : `Official grant portal for ${stateName}. Use this portal to find current state funding opportunities, deadlines, and application requirements.`,
      url: portalUrl,
      application_url: portalUrl,
      source_url: portalUrl,
      evidence_url: portalUrl,
      opportunity_type: 'grant_directory',
      type: 'DIRECTORY',
      requires_match: false,
      match_percentage: 0,
      is_national: false,
      state,
      categories: ['government', 'directory', 'state_grants'],
      keywords: [zip, state.toLowerCase(), stateName.toLowerCase(), 'state grants', 'grant portal', 'government']
        .filter(Boolean)
        .map((v) => String(v).toLowerCase()),
      source: 'state_grants_portal',
      source_id: `${state}-portal`,
      last_verified_at: new Date().toISOString(),
    })
  } catch (error) {
    console.error(`[GeoCrawl] State portal error for ZIP ${zip}:`, error?.message || error)
  }
  
  return opportunities
}

/**
 * Search foundation locator services
 */
async function searchFoundationLocator(zip, coords) {
  const opportunities = []
  
  if (!coords || !coords.lat || !coords.lng) {
    return opportunities
  }
  
  try {
    // Legitimate directory links (no scraping required).
    const cofUrl = `https://www.cof.org/foundation-locator?lat=${coords.lat}&lng=${coords.lng}&radius=25`
    const candidUrl = 'https://candid.org/find-us'

    opportunities.push(
      {
        title: 'Council on Foundations — Foundation Locator',
        sponsor: 'Council on Foundations',
        description:
          `Foundation Locator directory search centered near ${zip}. Use this to find nearby community foundations and philanthropic funders.`,
        url: cofUrl,
        application_url: cofUrl,
        source_url: cofUrl,
        evidence_url: cofUrl,
        opportunity_type: 'directory',
        type: 'DIRECTORY',
        requires_match: false,
        match_percentage: 0,
        is_national: true,
        state: coords?.state || null,
        categories: ['foundation', 'directory', 'philanthropy'],
        keywords: [zip, coords?.city, coords?.state, 'foundation', 'community foundation', 'philanthropy']
          .filter(Boolean)
          .map((v) => String(v).toLowerCase()),
        source: 'cof_foundation_locator',
        source_id: `cof:${zip}`,
        last_verified_at: new Date().toISOString(),
      },
      {
        title: 'Candid — Find Us / Nonprofit resources',
        sponsor: 'Candid',
        description:
          'Directory and guidance resources for nonprofits (including funder discovery resources).',
        url: candidUrl,
        application_url: candidUrl,
        source_url: candidUrl,
        evidence_url: candidUrl,
        opportunity_type: 'directory',
        type: 'DIRECTORY',
        requires_match: false,
        match_percentage: 0,
        is_national: true,
        state: coords?.state || null,
        categories: ['nonprofit', 'directory', 'philanthropy'],
        keywords: [zip, coords?.city, coords?.state, 'nonprofit', 'funder', 'foundation directory']
          .filter(Boolean)
          .map((v) => String(v).toLowerCase()),
        source: 'candid_directory',
        source_id: `candid:${zip}`,
        last_verified_at: new Date().toISOString(),
      },
    )
  } catch (error) {
    console.error(`[GeoCrawl] Foundation locator error for ZIP ${zip}:`, error?.message || error)
  }
  
  return opportunities
}

/**
 * Get coordinates for ZIP code
 */
async function getZipCoordinates(zip) {
  try {
    // Prefer local dataset to avoid network flakiness and mass skipping.
    const local = zipcodes.lookup(zip)
    if (local) {
      return {
        lat: parseFloat(local.latitude),
        lng: parseFloat(local.longitude),
        city: local.city,
        state: local.state
      }
    }

    const response = await axios.get(`https://api.zippopotam.us/us/${zip}`, {
      timeout: DEFAULT_CONFIG.timeout_ms
    })
    
    if (response.data && response.data.places && response.data.places[0]) {
      return {
        lat: parseFloat(response.data.places[0].latitude),
        lng: parseFloat(response.data.places[0].longitude),
        city: response.data.places[0]['place name'],
        state: response.data.places[0]['state abbreviation']
      }
    }
  } catch (error) {
    // ZIP not found or service unavailable
    return null
  }
  
  return null
}

/**
 * Process a single ZIP code
 */
async function processZip(zip, db, config) {
  console.log(`[GeoCrawl] Processing ZIP ${zip}...`)
  
  const startTime = Date.now()
  let sources = []
  let inserted = 0
  let error = null
  let status = 'completed'
  
  try {
    const fixturesDir = resolveFixturesDir(config)
    if (fixturesDir) {
      const fixture = readZipFixture(fixturesDir, zip) || []
      const meta = deriveZipMeta(zip)
      const inferredState = meta?.state ?? null
      sources = Array.isArray(fixture) ? fixture : []

      for (const opp of sources) {
        if (!opp) continue
        if (opp.state == null && inferredState) opp.state = inferredState
        if (opp.is_national == null && inferredState) opp.is_national = false
        if (opp.keywords == null && inferredState) {
          opp.keywords = [zip, inferredState].filter(Boolean)
        }
        if (isLoanOrMatchingFund(opp)) continue
        const changes = await saveOpportunity(db, opp)
        if (Number(changes) > 0) inserted += Number(changes)
      }

      console.log(`  [fixtures] Inserted ${inserted} sources for ZIP ${zip}`)
      return { zip, status: 'completed', sources_found: inserted, duration: Date.now() - startTime }
    }

    // Get coordinates
    const coords = await getZipCoordinates(zip)
    
    if (!coords) {
      console.log(`  Warning: Could not geocode ZIP ${zip}, skipping`)
      status = 'skipped'
      return { zip, status, sources_found: 0, duration: Date.now() - startTime }
    }
    
    // Search all data sources
    const discoverLocal = Boolean(config?.discover_local_resources)
    const [grantsGovResults, stateResults, foundationResults, overpassResults] = await Promise.all([
      searchGrantsGovByZip(zip, coords),
      searchStateGrantsByZip(zip, coords),
      searchFoundationLocator(zip, coords),
      discoverLocal ? searchOverpassLocalResources(zip, coords, config) : Promise.resolve([]),
    ])
    
    sources = [...grantsGovResults, ...stateResults, ...foundationResults, ...(overpassResults || [])]
    
    console.log(`  Found ${sources.length} sources for ZIP ${zip}`)
    
    // Save opportunities to database
    for (const opp of sources) {
      if (isLoanOrMatchingFund(opp)) continue
      const changes = await saveOpportunity(db, opp)
      if (Number(changes) > 0) inserted += Number(changes)
    }
    
    // Check if we met minimum sources requirement
    const min = Number(config?.min_sources_per_zip ?? DEFAULT_CONFIG.min_sources_per_zip)
    if (inserted < min) {
      console.log(`  Warning: Only inserted ${inserted} sources (minimum: ${min})`)
    }
    
  } catch (err) {
    error = err.message
    status = 'failed'
    console.error(`  Error processing ZIP ${zip}:`, err.message)
  }
  
  return {
    zip,
    status,
    sources_found: inserted,
    error,
    duration: Date.now() - startTime
  }
}

async function createStateRunRow(db, { state, jobId }) {
  const st = normalizeState(state)
  if (!st) return null
  const id = crypto.randomUUID()
  const sql =
    db?.dialect === 'postgres'
      ? `
          INSERT INTO geo_state_runs (id, state, job_id, status, started_at, created_at, updated_at)
          VALUES (?, ?, ?, 'running', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `
      : `
          INSERT INTO geo_state_runs (id, state, job_id, status, started_at, created_at, updated_at)
          VALUES (?, ?, ?, 'running', datetime('now'), datetime('now'), datetime('now'))
        `
  await db.prepare(sql).run(id, st, jobId ?? null)
  return { id, state: st }
}

async function completeStateRunRow(db, runRow, { status, processed, sources, failed, skipped, error }) {
  if (!runRow?.id) return
  const st = normalizeState(runRow.state)
  if (!st) return
  const sql =
    db?.dialect === 'postgres'
      ? `
          UPDATE geo_state_runs
          SET status = ?,
              completed_at = CURRENT_TIMESTAMP,
              processed_zips = ?,
              sources_inserted = ?,
              failed_zips = ?,
              skipped_zips = ?,
              error = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `
      : `
          UPDATE geo_state_runs
          SET status = ?,
              completed_at = datetime('now'),
              processed_zips = ?,
              sources_inserted = ?,
              failed_zips = ?,
              skipped_zips = ?,
              error = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `
  await db
    .prepare(sql)
    .run(
      status,
      Number(processed ?? 0),
      Number(sources ?? 0),
      Number(failed ?? 0),
      Number(skipped ?? 0),
      error ?? null,
      runRow.id,
    )
}

/**
 * Save opportunity to database
 */
async function saveOpportunity(db, opp) {
  if (!opp?.title) return 0
  if (!opp?.source || !opp?.source_id) return 0

  const insertSql =
    db?.dialect === 'postgres'
      ? `
          INSERT INTO funding_opportunities (
            id,
            title, sponsor, description,
            source, source_id, source_url,
            application_url, evidence_url,
            is_national, state,
            categories, keywords,
            opportunity_type, type,
            requires_match, match_percentage,
            last_verified_at,
            created_at, updated_at
          )
          SELECT
            gen_random_uuid()::text,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?,
            ?, ?,
            ?, ?,
            ?, ?,
            ?, ?,
            ?,
            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          WHERE NOT EXISTS (
            SELECT 1
            FROM funding_opportunities
            WHERE source = ?
              AND source_id = ?
          )
        `
      : `
          INSERT OR IGNORE INTO funding_opportunities (
            title, sponsor, description,
            source, source_id, source_url,
            application_url, evidence_url,
            is_national, state,
            categories, keywords,
            opportunity_type, type,
            requires_match, match_percentage,
            last_verified_at,
            created_at, updated_at
          ) VALUES (
            ?, ?, ?,
            ?, ?, ?,
            ?, ?,
            ?, ?,
            ?, ?,
            ?, ?,
            ?, ?,
            ?,
            datetime('now'), datetime('now')
          )
        `

  const stmt = db.prepare(insertSql)

  const categoriesJson = JSON.stringify(Array.isArray(opp.categories) ? opp.categories : [])
  const keywordsJson = JSON.stringify(Array.isArray(opp.keywords) ? opp.keywords : [])
  const isNational = Boolean(opp.is_national)
  const requiresMatch = Boolean(opp.requires_match)
  const matchPct = typeof opp.match_percentage === 'number' ? opp.match_percentage : 0
  const lastVerifiedAt = opp.last_verified_at ? String(opp.last_verified_at) : new Date().toISOString()
  
  if (db?.dialect === 'postgres') {
    const result = await stmt.run(
      opp.title,
      opp.sponsor || null,
      opp.description || null,
      String(opp.source),
      String(opp.source_id),
      opp.source_url || opp.url || null,
      opp.application_url || opp.url || null,
      opp.evidence_url || opp.url || null,
      isNational,
      opp.state || null,
      categoriesJson,
      keywordsJson,
      opp.opportunity_type || null,
      opp.type || 'OPPORTUNITY',
      requiresMatch,
      matchPct,
      lastVerifiedAt,
      // De-dupe keys (no unique index required)
      String(opp.source),
      String(opp.source_id),
    )
    return result?.changes ?? 0
  } else {
    const result = stmt.run(
      opp.title,
      opp.sponsor || null,
      opp.description || null,
      String(opp.source),
      String(opp.source_id),
      opp.source_url || opp.url || null,
      opp.application_url || opp.url || null,
      opp.evidence_url || opp.url || null,
      isNational ? 1 : 0,
      opp.state || null,
      categoriesJson,
      keywordsJson,
      opp.opportunity_type || null,
      opp.type || 'OPPORTUNITY',
      requiresMatch ? 1 : 0,
      matchPct,
      lastVerifiedAt,
    )
    return result?.changes ?? 0
  }
}

/**
 * Update ZIP progress in database
 */
async function updateZipProgress(db, zip, status, sources_found, error = null) {
  const sql =
    db?.dialect === 'postgres'
      ? `
          INSERT INTO national_zip_progress (zip, last_run_at, sources_found, status, error, updated_at)
          VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT (zip) DO UPDATE SET
            last_run_at = excluded.last_run_at,
            sources_found = excluded.sources_found,
            status = excluded.status,
            error = excluded.error,
            updated_at = CURRENT_TIMESTAMP
        `
      : `
          INSERT OR REPLACE INTO national_zip_progress
          (zip, last_run_at, sources_found, status, error, updated_at)
          VALUES (?, datetime('now'), ?, ?, ?, datetime('now'))
        `

  const stmt = db.prepare(sql)
  await stmt.run(zip, sources_found, status, error)
}

/**
 * Get last processed ZIP for resumability
 */
async function getLastProcessedZip(db) {
  const row = await db.prepare(`
    SELECT zip FROM national_zip_progress 
    WHERE status = 'completed'
    ORDER BY updated_at DESC 
    LIMIT 1
  `).get()
  
  return row?.zip || null
}

async function getLastProcessedZipForList(db, zipList) {
  if (!Array.isArray(zipList) || zipList.length === 0) return null
  if (zipList.length > 2000) return null

  const placeholders = zipList.map(() => '?').join(', ')
  const row = await db
    .prepare(
      `
        SELECT zip
        FROM national_zip_progress
        WHERE status = 'completed'
          AND zip IN (${placeholders})
        ORDER BY updated_at DESC
        LIMIT 1
      `,
    )
    .get(...zipList)

  return row?.zip || null
}

/**
 * Geo Crawl ZIP discovery function
 */
export async function runNationalZipCrawl(dbPath, options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options }

  // Prefer the shared DB wrapper when invoked from the app (Postgres-safe),
  // keep sqlite file-path mode for local/script usage.
  const ownsDb = typeof dbPath === 'string'
  const db = ownsDb ? new Database(dbPath) : dbPath

  const zipList = resolveZipList({
    zip_list: options.zip_list,
    state: options.state,
    max_zips: options.max_zips,
  })

  if (zipList.length === 0) {
    // Nothing to do. Important: do NOT close shared DB connections.
    return { processed: 0, sources: 0, duration: 0 }
  }

  console.log('='.repeat(80))
  console.log('Geo Crawl Starting')
  console.log('='.repeat(80))
  console.log(`Batch size: ${config.batch_size}`)
  console.log(`Min sources per ZIP: ${config.min_sources_per_zip}`)
  console.log(`Rate limit: ${config.rate_limit_ms}ms`)
  console.log()
  
  // Resumability:
  // - Full crawl is resumable by default (resume=true)
  // - State-scoped and explicit-list crawls default to resume=false to avoid surprising skips.
  const inferredResumeDefault = !options.state && !options.zip_list
  const allowResume = options.resume != null ? Boolean(options.resume) : inferredResumeDefault
  const lastProcessedZip = allowResume
    ? (await getLastProcessedZipForList(db, zipList)) ?? (await getLastProcessedZip(db))
    : null

  const startIndex = lastProcessedZip ? zipList.indexOf(lastProcessedZip) + 1 : 0
  
  if (lastProcessedZip) {
    console.log(`Resuming from ZIP ${lastProcessedZip} (index ${startIndex})`)
  } else {
    console.log('Starting from beginning')
  }
  
  const totalZips = zipList.length
  const remainingZips = Math.max(0, totalZips - startIndex)
  
  console.log(`Total ZIPs: ${totalZips}`)
  console.log(`Remaining: ${remainingZips}`)
  console.log()
  
  let processedCount = 0
  let totalSources = 0
  let failedCount = 0
  let skippedCount = 0
  const startTime = Date.now()

  // Per-state run tracking (Phase 6). Only persists when a valid state is provided.
  const stateRun =
    options.state && normalizeState(options.state) ? await createStateRunRow(db, { state: options.state, jobId: options.job_id ?? null }) : null
  
  // Process in batches
  try {
    for (let i = startIndex; i < totalZips; i += config.batch_size) {
      const batchEnd = Math.min(i + config.batch_size, totalZips)
      const batch = zipList.slice(i, batchEnd)
      
      console.log(`Processing batch ${Math.floor(i / config.batch_size) + 1}: ZIPs ${i} - ${batchEnd}`)
      
      for (const zip of batch) {
        const result = await processZip(zip, db, config)
        
        // Update progress in database
        await updateZipProgress(db, result.zip, result.status, result.sources_found, result.error)
        
        processedCount++
        totalSources += result.sources_found
        if (result.status === 'failed') failedCount += 1
        if (result.status === 'skipped') skippedCount += 1
        
        // Rate limiting
        if (Number(config.rate_limit_ms) > 0) {
          await new Promise(resolve => setTimeout(resolve, config.rate_limit_ms))
        }
        
        // Memory management
        if (processedCount % 100 === 0) {
          const elapsed = Date.now() - startTime
          const rate = (processedCount / elapsed) * 1000 * 60 // per minute
          console.log(`  Progress: ${processedCount}/${remainingZips} ZIPs (${rate.toFixed(1)}/min), ${totalSources} sources found`)
          
          // Force garbage collection if available
          if (global.gc) {
            global.gc()
          }
        }
      }
      
      console.log(`  Batch complete, checkpointing...`)
      console.log()
    }
  } finally {
    if (stateRun) {
      await completeStateRunRow(db, stateRun, {
        status: 'completed',
        processed: processedCount,
        sources: totalSources,
        failed: failedCount,
        skipped: skippedCount,
        error: null,
      })
    }
  }
  
  const totalDuration = Date.now() - startTime
  
  console.log('='.repeat(80))
  console.log('Geo Crawl Complete')
  console.log('='.repeat(80))
  console.log(`Total ZIPs processed: ${processedCount}`)
  console.log(`Total sources found: ${totalSources}`)
  console.log(`Average sources per ZIP: ${processedCount > 0 ? (totalSources / processedCount).toFixed(2) : '0.00'}`)
  console.log(`Duration: ${(totalDuration / 1000 / 60).toFixed(2)} minutes`)
  console.log()
  
  if (ownsDb && typeof db?.close === 'function') {
    db.close()
  }
  
  return {
    processed: processedCount,
    sources: totalSources,
    failed: failedCount,
    skipped: skippedCount,
    total_zips: totalZips,
    duration: totalDuration
  }
}

export default { runNationalZipCrawl }

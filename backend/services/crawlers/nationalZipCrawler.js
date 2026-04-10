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
import zipcodes from 'zipcodes'
import { searchGrants } from './grantsGovClient.js'

// Lazy-import better-sqlite3 only when actually needed (local script mode).
// In production (Railway/Postgres), the app passes the shared db wrapper,
// so better-sqlite3 is never required — and may not even be installable.
let _Database = null
async function getSQLiteDatabase() {
  if (!_Database) {
    try {
      const mod = await import('better-sqlite3')
      _Database = mod.default ?? mod
    } catch {
      throw new Error(
        'better-sqlite3 is not available. Pass a db wrapper instead of a file path.',
      )
    }
  }
  return _Database
}
import {
  appendGeoCrawlEvent,
  completeGeoCrawlRun,
  incrementGeoCrawlRunCounts,
  markGeoCrawlRunRunning,
  updateGeoCrawlRunCurrent,
  getGeoCrawlRun,
} from '../geoCrawlRunStore.js'
import { resolveCountyForZip } from '../geo/zipCountyResolver.js'

// All US ZIP codes (~43k total).
// We load from the local `zipcodes` dataset to avoid network lookups.
// NOTE: This list is used when Geo Crawl is run without a state scope.
const US_ZIP_CODES_ALL = generateUSZipCodes()

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

async function ensureGeoCrawlTables(db) {
  if (!db || typeof db.prepare !== 'function') return

  // Some deployments may lag migrations. Geo Crawl should still run (and record progress)
  // rather than immediately failing with "relation does not exist".
  const isPostgres = db?.dialect === 'postgres'

  const createNationalZipProgress = isPostgres
    ? `
        CREATE TABLE IF NOT EXISTS national_zip_progress (
          zip TEXT PRIMARY KEY,
          last_run_at TIMESTAMPTZ DEFAULT now(),
          sources_found INTEGER DEFAULT 0,
          cursor_meta TEXT DEFAULT '{}',
          status TEXT DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed','failed','skipped')),
          error TEXT,
          created_at TIMESTAMPTZ DEFAULT now(),
          updated_at TIMESTAMPTZ DEFAULT now()
        );
      `
    : `
        CREATE TABLE IF NOT EXISTS national_zip_progress (
          zip TEXT PRIMARY KEY,
          last_run_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          sources_found INTEGER DEFAULT 0,
          cursor_meta TEXT DEFAULT '{}',
          status TEXT DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed','failed','skipped')),
          error TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `

  const createGeoStateRuns = isPostgres
    ? `
        CREATE TABLE IF NOT EXISTS geo_state_runs (
          id TEXT PRIMARY KEY,
          state TEXT NOT NULL,
          job_id TEXT REFERENCES crawler_jobs(id) ON DELETE SET NULL,
          started_at TIMESTAMPTZ DEFAULT now(),
          completed_at TIMESTAMPTZ,
          status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed')),
          processed_zips INTEGER DEFAULT 0,
          sources_inserted INTEGER DEFAULT 0,
          failed_zips INTEGER DEFAULT 0,
          skipped_zips INTEGER DEFAULT 0,
          error TEXT,
          created_at TIMESTAMPTZ DEFAULT now(),
          updated_at TIMESTAMPTZ DEFAULT now()
        );
      `
    : `
        CREATE TABLE IF NOT EXISTS geo_state_runs (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          state TEXT NOT NULL,
          job_id TEXT REFERENCES crawler_jobs(id) ON DELETE SET NULL,
          started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          completed_at DATETIME,
          status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed')),
          processed_zips INTEGER DEFAULT 0,
          sources_inserted INTEGER DEFAULT 0,
          failed_zips INTEGER DEFAULT 0,
          skipped_zips INTEGER DEFAULT 0,
          error TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `

  try {
    await db.prepare(createNationalZipProgress).run()
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_national_zip_status ON national_zip_progress(status);`).run()
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_national_zip_last_run ON national_zip_progress(last_run_at);`).run()
  } catch {
    // best-effort: if the table is truly unavailable, Geo Crawl will fail later with a clearer error
  }

  try {
    await db.prepare(createGeoStateRuns).run()
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_geo_state_runs_state ON geo_state_runs(state);`).run()
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_geo_state_runs_created_at ON geo_state_runs(created_at);`).run()
  } catch {
    // best-effort
  }

  // Association index so globally-deduped opportunities can be linked to many ZIPs/runs.
  // (Avoids overwriting geo_* fields on the opportunity row.)
  const createGeoIndex = isPostgres
    ? `
        CREATE TABLE IF NOT EXISTS funding_opportunity_geo_index (
          id TEXT PRIMARY KEY,
          opportunity_id TEXT NOT NULL REFERENCES funding_opportunities(id) ON DELETE CASCADE,
          geo_run_id TEXT,
          state TEXT,
          zip TEXT,
          county TEXT,
          source TEXT,
          created_at TIMESTAMPTZ DEFAULT now()
        );
      `
    : `
        CREATE TABLE IF NOT EXISTS funding_opportunity_geo_index (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          opportunity_id TEXT NOT NULL REFERENCES funding_opportunities(id) ON DELETE CASCADE,
          geo_run_id TEXT,
          state TEXT,
          zip TEXT,
          county TEXT,
          source TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `

  try {
    await db.prepare(createGeoIndex).run()
    await db
      .prepare(
        `
          CREATE UNIQUE INDEX IF NOT EXISTS uniq_fo_geo_index
          ON funding_opportunity_geo_index(opportunity_id, geo_run_id, state, zip, source);
        `,
      )
      .run()
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_fo_geo_index_run_id ON funding_opportunity_geo_index(geo_run_id);`).run()
  } catch {
    // best-effort
  }
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

async function resolveZipList({ zip_list, state, max_zips, counties }) {
  // Resolve ZIP list for a geo crawl run.
  // Priority:
  // 1) Explicit ZIP list (city selection / manual ZIP selection)
  // 2) State ZIP index
  // 3) All US ZIPs (when no state is provided)
  // Then optionally filter by counties (within the resolved base list).
  const fromExplicit = Array.isArray(zip_list) ? zip_list : [];
  const wasZipListProvided = Array.isArray(zip_list) && zip_list.length > 0;
  let zips = fromExplicit
    .map((z) => String(z || '').trim())
    .filter((z) => /^\d{5}$/.test(z));

  // Only fall back to state/national ZIPs if NO explicit zip_list was provided.
  // If user provides ['BADZIP'], respect that intent (return empty after filtering).
  if (!zips.length && !wasZipListProvided) {
    if (state && typeof state === 'string') {
      const rows = zipcodes.lookupByState(state) || [];
      zips = rows
        .map((row) => String(row?.zip || '').padStart(5, '0'))
        .filter((z) => /^\d{5}$/.test(z));
    } else {
      // National scope: run across all ZIPs (caller can still cap via max_zips).
      zips = Array.isArray(US_ZIP_CODES_ALL) ? US_ZIP_CODES_ALL.slice() : []
    }
  }

  // County scoping (optional): filter ZIPs to those whose resolved county is in the selected set.
  if (Array.isArray(counties) && counties.length) {
    const normalize = (v) =>
      String(v || '')
        .trim()
        .toLowerCase()
        .replace(/\s+county\s*$/, '');

    const wanted = new Set(counties.map(normalize).filter(Boolean));
    if (wanted.size) {
      const filtered = [];
      for (const zip of zips) {
        // NOTE: resolveCountyForZip is cached; this loop is usually fast.
        // We pass state as a hint to avoid ambiguous fallbacks.
        // If county can't be resolved, we treat it as non-matching.
        // (Explicit ZIP lists should still work even if a county is missing.)
        const county = await resolveCountyForZip(zip, state);
        if (!county) continue;
        if (wanted.has(normalize(county))) filtered.push(zip);
      }
      zips = filtered;
    }
  }

  // Apply ZIP cap last (after filtering).
  const limit = Number.isFinite(Number(max_zips)) ? Number(max_zips) : null;
  if (limit && limit > 0) zips = zips.slice(0, limit);

  // Deduplicate while preserving order.
  const seen = new Set();
  const out = [];
  for (const z of zips) {
    if (seen.has(z)) continue;
    seen.add(z);
    out.push(z);
  }
  return out;
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
      lat: Number.isFinite(Number.parseFloat(row?.latitude)) ? Number.parseFloat(row.latitude) : null,
      lng: Number.isFinite(Number.parseFloat(row?.longitude)) ? Number.parseFloat(row.longitude) : null,
    }
  } catch {
    return null
  }
}

function buildBaselineDirectorySources({ zip, meta }) {
  const city = meta?.city ? String(meta.city) : null
  const state = meta?.state ? String(meta.state) : null
  const keywords = [zip, city, state].filter(Boolean).map((v) => String(v).toLowerCase())

  // These are durable, user-actionable “entry point” resources that do not depend on scraping.
  // They ensure every ZIP produces at least 3 local-ish resources even if upstream APIs are down.
  return [
    {
      title: city && state ? `United Way near ${city}, ${state}` : 'United Way Locator (find local chapter)',
      sponsor: 'United Way',
      description:
        'Find your local United Way chapter for community support, emergency assistance programs, and local partner referrals.',
      url: `https://www.unitedway.org/find-your-united-way?zip=${zip}`,
      application_url: `https://www.unitedway.org/find-your-united-way?zip=${zip}`,
      source_url: `https://www.unitedway.org/find-your-united-way?zip=${zip}`,
      evidence_url: `https://www.unitedway.org/find-your-united-way?zip=${zip}`,
      opportunity_type: 'program',
      type: 'DIRECTORY',
      requires_match: false,
      match_percentage: 0,
      is_national: false,
      state,
      categories: ['community', 'local', 'emergency_assistance'],
      keywords: ['united way', 'emergency assistance', 'community', ...keywords].filter(Boolean),
      source: 'local_directory_united_way',
      source_id: `united_way:${zip}`,
      last_verified_at: new Date().toISOString(),
    },
    {
      title: city && state ? `Food Bank resources near ${city}, ${state}` : 'Food Bank Locator (Feeding America)',
      sponsor: 'Feeding America',
      description: 'Find local food bank partners and emergency food assistance resources near the profile ZIP.',
      url: `https://www.feedingamerica.org/find-your-local-foodbank?postal-code=${zip}`,
      application_url: `https://www.feedingamerica.org/find-your-local-foodbank?postal-code=${zip}`,
      source_url: `https://www.feedingamerica.org/find-your-local-foodbank?postal-code=${zip}`,
      evidence_url: `https://www.feedingamerica.org/find-your-local-foodbank?postal-code=${zip}`,
      opportunity_type: 'program',
      type: 'DIRECTORY',
      requires_match: false,
      match_percentage: 0,
      is_national: false,
      state,
      categories: ['food', 'local', 'emergency_assistance'],
      keywords: ['food bank', 'food assistance', 'snap', ...keywords].filter(Boolean),
      source: 'local_directory_feeding_america',
      source_id: `feeding_america:${zip}`,
      last_verified_at: new Date().toISOString(),
    },
    {
      title:
        city && state ? `Community Action Agency near ${city}, ${state}` : 'Community Action Agency Locator (CAP)',
      sponsor: 'Community Action Partnership',
      description:
        'Locate a Community Action Agency (CAA/CAP) that can help with housing, utilities, food, and employment support.',
      url: `https://communityactionpartnership.com/find-a-cap/?zip=${zip}`,
      application_url: `https://communityactionpartnership.com/find-a-cap/?zip=${zip}`,
      source_url: `https://communityactionpartnership.com/find-a-cap/?zip=${zip}`,
      evidence_url: `https://communityactionpartnership.com/find-a-cap/?zip=${zip}`,
      opportunity_type: 'program',
      type: 'DIRECTORY',
      requires_match: false,
      match_percentage: 0,
      is_national: false,
      state,
      categories: ['utilities', 'housing', 'local', 'community'],
      keywords: ['community action', 'utilities assistance', 'rent assistance', ...keywords].filter(Boolean),
      source: 'local_directory_cap',
      source_id: `cap:${zip}`,
      last_verified_at: new Date().toISOString(),
    },
  ]
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
 * Search Grants.gov API for a specific ZIP code.
 * Uses the resilient grantsGovClient (API key, User-Agent, retries) rather than
 * raw axios — see grantsGovClient.js header comment.
 */
async function searchGrantsGovByZip(zip, coords) {
  try {
    const { ok, opportunities: hits } = await searchGrants('', { rows: 10 })
    if (!ok || !Array.isArray(hits) || hits.length === 0) return []

    return hits.map((hit, idx) => {
      const sourceIdRaw = hit.source_id || hit.id || hit.number || null
      return {
        title: hit.title || hit.number || 'Grant opportunity',
        sponsor: hit.sponsor || hit.agency || 'Grants.gov',
        description: hit.description || '',
        url: hit.url || (hit.id ? `https://www.grants.gov/search-results-detail/${hit.id}` : 'https://www.grants.gov'),
        opportunity_number: hit.number || hit.opportunity_number || null,
        deadline: hit.deadline || hit.closeDate || null,
        source: 'grants.gov',
        source_id: sourceIdRaw ? String(sourceIdRaw) : `grantsgov:${zip}:${idx}`,
        zip,
        // Grants.gov is national. Do not stamp it with the ZIP's state (it causes bad grouping).
        // The ZIP/state association is tracked separately via funding_opportunity_geo_index.
        state: null,
        is_national: true,
        type: 'OPPORTUNITY',
      }
    })
  } catch (error) {
    console.error(`[GeoCrawl] Grants.gov error for ZIP ${zip}:`, error.message)
    return []
  }
}

async function upsertGeoAssociation(db, { opportunityId, geoRunId, state, zip, county, source } = {}) {
  if (!opportunityId || !geoRunId) return 0
  const id = crypto.randomUUID()
  const st = state ? String(state).toUpperCase() : null
  const z = normalizeZip(zip) || null
  const c = county ? String(county) : null
  const src = source ? String(source) : null

  if (db?.dialect === 'postgres') {
    const res = await db
      .prepare(
        `
          INSERT INTO funding_opportunity_geo_index (id, opportunity_id, geo_run_id, state, zip, county, source, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT (opportunity_id, geo_run_id, state, zip, source) DO NOTHING
        `,
      )
      .run(id, String(opportunityId), String(geoRunId), st, z, c, src)
    return Number(res?.changes ?? res?.rowCount ?? 0)
  }

  const res = db
    .prepare(
      `
        INSERT OR IGNORE INTO funding_opportunity_geo_index (id, opportunity_id, geo_run_id, state, zip, county, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `,
    )
    .run(id, String(opportunityId), String(geoRunId), st, z, c, src)

  return Number(res?.changes ?? 0)
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

  // Overpass public API is frequently overloaded (504). Retry once with backoff.
  const maxAttempts = 2
  const timeoutMs = Math.max(30000, Number(config.timeout_ms) || 30000)

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await axios.post(
        'https://overpass-api.de/api/interpreter',
        new URLSearchParams({ data: query }).toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: timeoutMs,
        },
      )

      const elements = resp?.data?.elements
      if (!Array.isArray(elements)) return opportunities

      for (const el of elements) {
        const mapped = mapOsmElementToOpportunity({ element: el, zip, coords })
        if (mapped) opportunities.push(mapped)
      }
      return opportunities
    } catch (error) {
      const status = error?.response?.status
      if (attempt < maxAttempts && (status === 504 || status === 429 || status === 503)) {
        const delay = 2000 * attempt
        console.warn(`[GeoCrawl] Overpass ${status} for ZIP ${zip}, retrying in ${delay}ms...`)
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      console.warn(`[GeoCrawl] Overpass error for ZIP ${zip}:`, error?.message || error)
    }
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
    FL: 'https://www.myfloridacfo.com/division/aa/grants',
    PA: 'https://www.grants.pa.gov/',
    IL: 'https://www.illinois.gov/content/state/en/agencies/gata.html',
    OH: 'https://grants.ohio.gov/',
    GA: 'https://www.georgia.gov/grants',
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
    // NOTE: foundation-locator (lat/lng) had invalid TLS; community-foundation-locator works.
    const cofBase = 'https://www.cof.org/community-foundation-locator'
    const cofUrl = coords?.state
      ? `${cofBase}?state=${encodeURIComponent(coords.state)}`
      : cofBase
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
      const lat = Number.parseFloat(local.latitude)
      const lng = Number.parseFloat(local.longitude)
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
      return { lat, lng, city: local.city, state: local.state }
    }

    const response = await axios.get(`https://api.zippopotam.us/us/${zip}`, {
      timeout: DEFAULT_CONFIG.timeout_ms
    })
    
    if (response.data && response.data.places && response.data.places[0]) {
      const lat = Number.parseFloat(response.data.places[0].latitude)
      const lng = Number.parseFloat(response.data.places[0].longitude)
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
      return { lat, lng, city: response.data.places[0]['place name'], state: response.data.places[0]['state abbreviation'] }
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
  let insertedNew = 0
  let associationsNew = 0
  let eligibleFound = 0
  let associationWriteAvailable = true
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
        const saved = await saveOpportunity(db, opp)
        if (saved?.inserted) insertedNew += 1
      }

      const eligibleFixtureCount = sources.filter((opp) => opp && !isLoanOrMatchingFund(opp)).length
      console.log(`  [fixtures] Found ${eligibleFixtureCount} sources; inserted ${insertedNew} new for ZIP ${zip}`)
      return {
        zip,
        status: 'completed',
        sources_found: eligibleFixtureCount,
        inserted_new: insertedNew,
        associations_new: 0,
        duration: Date.now() - startTime,
      }
    }

    // Get coordinates
    const coords = await getZipCoordinates(zip)
    const meta = deriveZipMeta(zip) || null
    
    // Always include durable local directory sources so every ZIP yields at least 3.
    // (These are “entry points” users can click even when upstream APIs are blocked.)
    const baselineDirectories = buildBaselineDirectorySources({ zip, meta: meta ?? coords ?? null })

    // Deterministic/no-network mode for tests and local debugging.
    // Keeps GeoCrawl stable even when upstream providers throttle.
    const offlineOnly = Boolean(config?.offline_only ?? config?.offlineOnly ?? false)
    
    // Search all data sources (sequential so GeoCrawl Monitor can show current_source live).
    const discoverLocal = Boolean(config?.discover_local_resources)
    const runId = config?.geo_run_id ?? null
    const stateForZip = (coords?.state ?? meta?.state ?? null)
      ? String(coords?.state ?? meta?.state).toUpperCase()
      : null
    const countyForZip = stateForZip ? (await resolveCountyForZip(zip, stateForZip)) : null

    const reportSource = async (source, message) => {
      if (!runId) return
      await updateGeoCrawlRunCurrent(db, runId, {
        state: stateForZip,
        zip,
        county: countyForZip,
        source,
      })
      await appendGeoCrawlEvent(db, runId, {
        level: 'info',
        state: stateForZip,
        zip,
        county: countyForZip,
        source,
        message,
      })
    }

    await reportSource(null, `Starting ZIP ${zip}`)

    let grantsGovResults = []
    let stateResults = []
    let foundationResults = []
    let overpassResults = []

    // Directory-style resources must survive "offline" mode.
    // offline_only is intended to skip upstream network calls, not to eliminate deterministic directory links.
    await reportSource('state_portal', 'Querying source: state portals')
    stateResults = await searchStateGrantsByZip(zip, coords ?? meta ?? null)

    await reportSource('foundation_locator', 'Querying source: foundation locators')
    foundationResults = await searchFoundationLocator(zip, coords ?? meta ?? null)

    if (!offlineOnly) {
      await reportSource('grants.gov', 'Querying source: grants.gov')
      grantsGovResults = coords ? await searchGrantsGovByZip(zip, coords) : []

      if (discoverLocal) {
        await reportSource('overpass', 'Querying source: overpass directories')
        overpassResults = await searchOverpassLocalResources(zip, coords ?? meta ?? null, config).catch(() => [])
      }
    }
    
    sources = [
      ...baselineDirectories,
      ...grantsGovResults,
      ...stateResults,
      ...foundationResults,
      ...(overpassResults || []),
    ]
    
    console.log(`  Found ${sources.length} sources for ZIP ${zip}`)

    // De-dupe by (source, source_id) so retries don’t collapse to “0 found”.
    const seen = new Set()
    const deduped = sources.filter((opp) => {
      const key = `${String(opp?.source || '')}::${String(opp?.source_id || '')}`
      if (!opp?.source || !opp?.source_id) return false
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    
    const eligible = deduped.filter((opp) => opp && !isLoanOrMatchingFund(opp))
    eligibleFound = eligible.length
    
    // Save opportunities to database (global de-dupe) + per-run association index.
    for (const opp of eligible) {
      if (runId) {
        opp.geo_run_id = runId
        opp.geo_zip = zip
        opp.geo_county = countyForZip
        opp.geo_source = opp.source ?? null
        opp.geo_scope = 'zip'
      }
      let saved = null
      try {
        saved = await saveOpportunity(db, opp)
        if (saved?.inserted) insertedNew += 1
      } catch (e) {
        // Do not fail the ZIP if one item can't be persisted; continue so we still meet minimums.
        console.warn(`[GeoCrawl] saveOpportunity failed (zip=${zip} source=${opp?.source}):`, e?.message || e)
        continue
      }

      if (runId && saved?.id && associationWriteAvailable) {
        try {
          associationsNew += await upsertGeoAssociation(db, {
            opportunityId: saved.id,
            geoRunId: runId,
            state: stateForZip,
            zip,
            county: countyForZip,
            source: opp.source ?? null,
          })
        } catch (e) {
          // If the association table is missing or permissions are limited, we should still save
          // globally (funding_opportunities). Mark association writes unavailable for this ZIP.
          associationWriteAvailable = false
          console.warn(
            `[GeoCrawl] geo association insert failed (zip=${zip} run=${runId}) continuing without associations:`,
            e?.message || e,
          )
        }
      }
    }
    
    // Enforce minimum only; there is no cap on max sources per zip (all eligible are saved).
    const min = Number(config?.min_sources_per_zip ?? DEFAULT_CONFIG.min_sources_per_zip)
    if (eligibleFound < min) {
      console.log(`  Warning: Only found ${eligibleFound} eligible sources (minimum: ${min})`)
    }
    
  } catch (err) {
    error = err.message
    status = 'failed'
    console.error(`  Error processing ZIP ${zip}:`, err.message)
  }
  
  return {
    zip,
    status,
    // IMPORTANT: This is “sources found for the ZIP”, not “new rows inserted”.
    // UI and progress should be non-zero when opportunities exist, even on reruns.
    sources_found: eligibleFound,
    inserted_new: insertedNew,
    associations_new: associationsNew,
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
  if (!opp?.title) return { inserted: false, id: null }
  if (!opp?.source || !opp?.source_id) return { inserted: false, id: null }
  // Only persist real, usable resources: require at least one valid URL
  const hasUrl = normalizeUrl(opp?.url) || normalizeUrl(opp?.source_url) || normalizeUrl(opp?.application_url)
  if (!hasUrl) return { inserted: false, id: null }

  const id = crypto.randomUUID()
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
            ?,
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
            ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?,
            ?, ?,
            ?, ?,
            ?, ?,
            ?, ?,
            ?,
            datetime('now'), datetime('now')
          WHERE NOT EXISTS (
            SELECT 1
            FROM funding_opportunities
            WHERE source = ?
              AND source_id = ?
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
      id,
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

    const inserted = Number(result?.changes ?? result?.rowCount ?? 0) > 0
    let finalId = id
    if (!inserted) {
      try {
        const existing = await db
          .prepare('SELECT id FROM funding_opportunities WHERE source = ? AND source_id = ? LIMIT 1')
          .get(String(opp.source), String(opp.source_id))
        if (existing?.id) finalId = existing.id
      } catch {
        // ignore
      }
    }

    // Tag geo columns ONLY on insert to avoid overwriting geo fields for globally deduped opportunities.
    if (
      inserted &&
      (opp.geo_run_id || opp.geo_zip || opp.geo_county || opp.geo_source || opp.geo_scope)
    ) {
      try {
        await db
          .prepare(
            `
              UPDATE funding_opportunities
              SET geo_run_id = ?,
                  geo_zip = ?,
                  geo_county = ?,
                  geo_source = ?,
                  geo_scope = ?,
                  updated_at = CURRENT_TIMESTAMP
              WHERE source = ?
                AND source_id = ?
            `,
          )
          .run(
            opp.geo_run_id ?? null,
            opp.geo_zip ?? null,
            opp.geo_county ?? null,
            opp.geo_source ?? null,
            opp.geo_scope ?? null,
            String(opp.source),
            String(opp.source_id),
          )
      } catch {
        // ignore (schema drift / migrations not applied yet)
      }
    }

    // Data hygiene: Grants.gov opportunities are national. Older rows may have been incorrectly
    // stamped with a state from the first ZIP that discovered them.
    if (String(opp.source) === 'grants.gov' && isNational === true) {
      try {
        await db
          .prepare(
            `
              UPDATE funding_opportunities
              SET is_national = TRUE,
                  state = NULL,
                  updated_at = CURRENT_TIMESTAMP
              WHERE source = ?
                AND source_id = ?
            `,
          )
          .run(String(opp.source), String(opp.source_id))
      } catch {
        // ignore
      }
    }
    return { inserted, id: finalId }
  } else {
    const result = stmt.run(
      id,
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
      // De-dupe keys (no unique index required)
      String(opp.source),
      String(opp.source_id),
    )

    const inserted = Number(result?.changes ?? 0) > 0
    let finalId = id
    if (!inserted) {
      try {
        const existing = db
          .prepare('SELECT id FROM funding_opportunities WHERE source = ? AND source_id = ? LIMIT 1')
          .get(String(opp.source), String(opp.source_id))
        if (existing?.id) finalId = existing.id
      } catch {
        // ignore
      }
    }

    if (
      inserted &&
      (opp.geo_run_id || opp.geo_zip || opp.geo_county || opp.geo_source || opp.geo_scope)
    ) {
      try {
        db.prepare(
          `
            UPDATE funding_opportunities
            SET geo_run_id = ?,
                geo_zip = ?,
                geo_county = ?,
                geo_source = ?,
                geo_scope = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE source = ?
              AND source_id = ?
          `,
        ).run(
          opp.geo_run_id ?? null,
          opp.geo_zip ?? null,
          opp.geo_county ?? null,
          opp.geo_source ?? null,
          opp.geo_scope ?? null,
          String(opp.source),
          String(opp.source_id),
        )
      } catch {
        // ignore (schema drift / migrations not applied yet)
      }
    }

    if (String(opp.source) === 'grants.gov' && isNational === true) {
      try {
        db.prepare(
          `
            UPDATE funding_opportunities
            SET is_national = 1,
                state = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE source = ?
              AND source_id = ?
          `,
        ).run(String(opp.source), String(opp.source_id))
      } catch {
        // ignore
      }
    }
    return { inserted, id: finalId }
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
  // Only resume from ZIPs completed within the last 2 hours to avoid stale checkpoints.
  const since2h = db?.dialect === 'postgres'
    ? "updated_at > (NOW() - INTERVAL '2 hours')"
    : "updated_at > datetime('now', '-2 hours')"
  const row = await db.prepare(`
    SELECT zip FROM national_zip_progress
    WHERE status = 'completed'
      AND ${since2h}
    ORDER BY updated_at DESC
    LIMIT 1
  `).get()

  return row?.zip || null
}

async function getLastProcessedZipForList(db, zipList) {
  if (!Array.isArray(zipList) || zipList.length === 0) return null
  if (zipList.length > 2000) return null

  // Only resume from ZIPs completed within the last 2 hours.
  // Stale checkpoints from previous runs should not cause the crawl to skip everything.
  const placeholders = zipList.map(() => '?').join(', ')
  const since2h = db?.dialect === 'postgres'
    ? "updated_at > (NOW() - INTERVAL '2 hours')"
    : "updated_at > datetime('now', '-2 hours')"
  const row = await db
    .prepare(
      `
        SELECT zip
        FROM national_zip_progress
        WHERE status = 'completed'
          AND zip IN (${placeholders})
          AND ${since2h}
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
  const db = ownsDb ? new (await getSQLiteDatabase())(dbPath) : dbPath

  const zipList = await resolveZipList({
    zip_list: options.zip_list,
    state: options.state,
    max_zips: options.max_zips,
    counties: options.counties,
  })

  if (zipList.length === 0) {
    // Nothing to do.
    // IMPORTANT: do NOT touch DB or close shared DB connections.
    // If we opened the DB (sqlite file-path mode), close it on the way out.
    if (ownsDb) {
      try {
        db.close()
      } catch {
        // ignore
      }
    }
    return { processed: 0, sources: 0, duration: 0 }
  }

  // Ensure Phase-6 geo tables exist (prod safety).
  await ensureGeoCrawlTables(db)

  const geoRunId = config.geo_run_id ?? options.geo_run_id ?? null
  if (geoRunId) {
    // Mark run as running; do not hard-fail if run tables are missing.
    try {
      await markGeoCrawlRunRunning(db, geoRunId)
      await appendGeoCrawlEvent(db, geoRunId, {
        level: 'info',
        state: options.state ? String(options.state).toUpperCase() : null,
        zip: null,
        county: null,
        source: null,
        message: 'Geo crawl started',
      })
    } catch {
      // ignore (schema drift / migrations not applied yet)
    }
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
  let lastProcessedZip = allowResume
    ? (await getLastProcessedZipForList(db, zipList)) ?? (await getLastProcessedZip(db))
    : null

  // Prefer geo_crawl_runs.current_zip when provided (durable per-run resume).
  // We re-run the current ZIP on resume for safety (dedupe prevents duplication).
  let startIndex = lastProcessedZip ? zipList.indexOf(lastProcessedZip) + 1 : 0
  if (geoRunId && allowResume) {
    try {
      const runRow = await getGeoCrawlRun(db, geoRunId)
      const currentZip = runRow?.current_zip ? String(runRow.current_zip) : null
      if (currentZip && zipList.includes(currentZip)) {
        lastProcessedZip = currentZip
        startIndex = zipList.indexOf(currentZip)
      }
    } catch {
      // ignore
    }
  }
  
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
  let fatalError = null
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

        if (geoRunId) {
          try {
            await incrementGeoCrawlRunCounts(db, geoRunId, {
              processedZipDelta: 1,
              // Count “new run associations” so progress is non-zero even when the global
              // opportunity already existed (global de-dupe is preserved).
              foundOppDelta: Number(result?.associations_new ?? result?.inserted_new ?? 0),
            })
            const eventState =
              options.state ? String(options.state).toUpperCase() : (zipcodes.lookup(result.zip)?.state ?? null)
            const delta = Number(result?.associations_new ?? result?.inserted_new ?? 0)
            if (delta > 0) {
              await appendGeoCrawlEvent(db, geoRunId, {
                level: 'info',
                state: eventState,
                zip: result.zip,
                county: resolveCountyForZip(result.zip, eventState) ?? null,
                source: null,
                message: `Saved ${delta} run result link(s)`,
                foundCountDelta: delta,
              })
            }
            if (result.status === 'failed' && result.error) {
              await appendGeoCrawlEvent(db, geoRunId, {
                level: 'error',
                state: eventState,
                zip: result.zip,
                county: resolveCountyForZip(result.zip, eventState) ?? null,
                source: null,
                message: `ZIP failed: ${result.error}`,
              })
            }
          } catch {
            // ignore
          }
        }
        
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
  } catch (error) {
    fatalError = error
    if (geoRunId) {
      try {
        await appendGeoCrawlEvent(db, geoRunId, {
          level: 'error',
          state: options.state ? String(options.state).toUpperCase() : null,
          zip: null,
          county: null,
          source: null,
          message: `Geo crawl failed: ${error?.message || String(error)}`,
        })
        await completeGeoCrawlRun(db, geoRunId, { status: 'failed', error: error?.message || String(error) })
      } catch {
        // ignore
      }
    }
    throw error
  } finally {
    if (geoRunId && !fatalError) {
      try {
        await completeGeoCrawlRun(db, geoRunId, { status: 'complete', error: null })
        await appendGeoCrawlEvent(db, geoRunId, {
          level: 'info',
          state: options.state ? String(options.state).toUpperCase() : null,
          zip: null,
          county: null,
          source: null,
          message: 'Geo crawl complete',
        })
      } catch {
        // ignore
      }
    }
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

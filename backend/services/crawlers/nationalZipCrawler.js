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
// zipcodes-nrviens is a superset of `zipcodes`: identical US data (42,555 ZIPs)
// PLUS Canadian postal data keyed by FSA (the first 3 chars, e.g. "K1A" — 1,620
// of them). Its API surface (lookup/lookupByState/lookupByCoords/codes/states)
// matches `zipcodes`, so this is a drop-in swap that unlocks Canada coverage.
import zipcodes from 'zipcodes-nrviens'
import { searchGrants } from '../shared/grantsGovClient.js'
import { upsertFundingOpportunity } from '../opportunityInserter.js'
// Profile-driven Grants.gov query terms. When a profile context is supplied to
// the geo crawl, we build the search keywords from the profile (type + needs +
// interests, PII-scrubbed) instead of a generic fallback — see canonical_rules
// "use the full profile" + Phase 4 "never blank/generic ZIP search".
import { buildGrantsGovQueryTerms } from '../sourceRegistry.js'

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
  touchGeoCrawlRunHeartbeat,
  updateGeoCrawlRunCurrent,
  getGeoCrawlRun,
} from '../geoCrawlRunStore.js'
import { resolveCountyForZip } from '../geo/zipCountyResolver.js'
import { createLogger } from '../../utils/logger.js'
const log = createLogger('nationalZipCrawler')

// All North American crawl codes: ~42.5k US ZIPs + ~1.6k Canadian FSAs (~44k total).
// Loaded from the local `zipcodes-nrviens` dataset to avoid network lookups.
// NOTE: This list is used when Geo Crawl is run without a state scope. Callers
// can scope it to a subset via the `countries` option (default US + CA).
const US_ZIP_CODES_ALL = generateAllPostalCodes()

// Default configuration
const DEFAULT_CONFIG = {
  batch_size: 50,
  min_sources_per_zip: 3,
  rate_limit_ms: 1000, // 1 second between ZIP requests
  checkpoint_every: 50, // Checkpoint after every 50 ZIPs
  timeout_ms: 10000,
  per_zip_timeout_ms: 45_000, // Hard wall-clock limit per ZIP (prevents hung API calls from blocking job)
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

// --- Postal-code helpers (US ZIP + Canadian FSA) -------------------------
//
// A "postal code" in Geo Crawl is the crawl unit. For the US that's a 5-digit
// ZIP; for Canada it's a 3-character Forward Sortation Area (FSA), e.g. "K1A".
// The Canadian dataset is keyed by FSA and lookup() truncates a full postal
// code ("K1A 0B1") to its FSA, so FSA is the natural Canadian crawl unit.
const US_ZIP_RE = /^\d{5}$/
const CA_FSA_RE = /^[A-Za-z]\d[A-Za-z]$/

// zipcodes-nrviens stores the full province NAME in `state` for Canadian rows
// (e.g. "Ontario"), unlike US rows which already carry a 2-letter abbr ("OH").
// Normalize provinces to their official 2-letter abbreviations for clean,
// consistent geo storage and grouping.
const CA_PROVINCE_ABBR = {
  alberta: 'AB',
  'british columbia': 'BC',
  manitoba: 'MB',
  'new brunswick': 'NB',
  'newfoundland and labrador': 'NL',
  newfoundland: 'NL',
  'northwest territories': 'NT',
  'nova scotia': 'NS',
  nunavut: 'NU',
  ontario: 'ON',
  'prince edward island': 'PE',
  quebec: 'QC',
  'québec': 'QC',
  saskatchewan: 'SK',
  yukon: 'YT',
  // Dataset quirk: a few BC sub-regions are labelled by area name.
  'sunshine coast': 'BC',
}

function isCanadianCode(value) {
  return CA_FSA_RE.test(String(value ?? '').trim().slice(0, 3))
}

function countryForCode(value) {
  return isCanadianCode(value) ? 'CA' : 'US'
}

// Canonical crawl key: a US 5-digit ZIP, or a Canadian 3-char FSA (uppercased).
// Accepts full Canadian postal codes ("K1A 0B1") and reduces them to the FSA.
function normalizePostalCode(value) {
  const raw = String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
  if (US_ZIP_RE.test(raw)) return raw
  const fsa = raw.slice(0, 3)
  if (CA_FSA_RE.test(fsa)) return fsa
  return null
}

// Resolve a 2-letter region (US state or CA province) from a meta/coords row.
function regionForMeta(meta) {
  const st = meta?.state ? String(meta.state).trim() : null
  if (!st) return null
  if (/^[A-Za-z]{2}$/.test(st)) return st.toUpperCase()
  return CA_PROVINCE_ABBR[st.toLowerCase()] || st.toUpperCase()
}

// Backwards-compatible: now accepts US ZIPs *and* Canadian FSAs (used by
// deriveZipMeta and the geo-index association, both of which just store the key).
function normalizeZip(value) {
  return normalizePostalCode(value)
}

function normalizeState(value) {
  const s = String(value ?? '').trim().toUpperCase()
  return /^[A-Z]{2}$/.test(s) ? s : null
}

async function resolveZipList({ zip_list, state, max_zips, counties, countries }) {
  // Resolve the postal-code list for a geo crawl run.
  // Priority:
  // 1) Explicit list (city selection / manual selection) — US ZIPs or CA FSAs
  // 2) State/province index
  // 3) All US ZIPs + Canadian FSAs (when no state is provided)
  // Then optionally filter by counties (within the resolved base list).
  //
  // `countries` (default ['US','CA']) scopes the national branch. US keys are
  // numeric ZIPs; Canadian keys are alphabetic FSAs — so we can partition the
  // merged dataset by the first character without extra lookups.
  const wantCountries = Array.isArray(countries) && countries.length
    ? new Set(countries.map((c) => String(c).trim().toUpperCase()))
    : new Set(['US', 'CA'])

  const fromExplicit = Array.isArray(zip_list) ? zip_list : [];
  const wasZipListProvided = Array.isArray(zip_list) && zip_list.length > 0;
  let zips = fromExplicit
    .map((z) => normalizePostalCode(z))
    .filter((z) => z && wantCountries.has(countryForCode(z)));

  // Only fall back to state/national codes if NO explicit list was provided.
  // If user provides ['BADZIP'], respect that intent (return empty after filtering).
  if (!zips.length && !wasZipListProvided) {
    if (state && typeof state === 'string') {
      const rows = zipcodes.lookupByState(state) || [];
      zips = rows
        .map((row) => normalizePostalCode(row?.zip))
        .filter((z) => z && wantCountries.has(countryForCode(z)));
    } else {
      // National scope: run across all US ZIPs + Canadian FSAs (caller can still
      // cap via max_zips, or narrow via `countries`).
      const all = Array.isArray(US_ZIP_CODES_ALL) ? US_ZIP_CODES_ALL : []
      zips = all.filter((z) => wantCountries.has(countryForCode(z)))
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
      // regionForMeta handles both US abbrs ("OH") and CA province names ("Ontario" → "ON").
      state: regionForMeta(row) ?? null,
      lat: Number.isFinite(Number.parseFloat(row?.latitude)) ? Number.parseFloat(row.latitude) : null,
      lng: Number.isFinite(Number.parseFloat(row?.longitude)) ? Number.parseFloat(row.longitude) : null,
    }
  } catch {
    return null
  }
}

// REMOVED: per-ZIP placeholder directory stubs.
//
// This function used to synthesize one templated row per ZIP for United Way,
// Feeding America, and Community Action Partnership — e.g. "United Way near
// Bradley, SD" pointing at a generic locator URL with the ZIP appended. Those
// rows are NOT real, ZIP-specific funding opportunities: they are the same
// three national locator portals re-stamped with a city/state label and shoved
// into the catalog for every one of ~44k crawl codes. That manufactured
// thousands of near-duplicate junk rows ("X near <city>, <state>") and directly
// violates canonical_rules.md: "real sources, not junk" / "no placeholder
// funding" (Goal #1) and G7's "REAL means non-placeholder, deduped by domain".
//
// The fix is to emit NOTHING per ZIP rather than per-ZIP junk. Real ZIP-scoped
// coverage comes from the actual upstream sources (Grants.gov via
// searchGrantsGovByZip, state portals, foundation locators, Overpass/OSM). The
// genuine national locators (United Way, Feeding America, CAP) are already
// represented as canonical, NON-geo-templated entries in the domain corpus
// crawl (runDomainCorpusCrawl) + sourceRegistry — a single clean row each, not
// one per ZIP.
//
// Kept as a no-op (returning []) so existing callers (processZip's
// `baselineDirectories` spread) stay safe without restructuring.
function buildBaselineDirectorySources(_args = {}) {
  return []
}

// ── CANADIAN SOURCE SET ───────────────────────────────────────────────────
//
// Domain-judgment surface: these are the curated, durable, user-actionable
// Canadian "entry point" funding/assistance resources — the Canadian analogue
// of the US United Way / Feeding America / Community Action trio above. They
// guarantee every Canadian FSA clears `min_sources_per_zip` even when upstream
// APIs are down, and they map directly to GrantFlow goals #1 (real sources,
// not junk), #4 (support many user types), and #6 (directory sources).
//
// If you want to tune which Canadian orgs represent the baseline, this map and
// the two functions below (provincial portals + foundations) are the place.
// REMOVED: per-FSA placeholder directory stubs (Canadian analogue of the US
// trio removed above). This used to emit one title-templated row per Canadian
// FSA for 211 Canada / Food Banks Canada / United Way Centraide — e.g. "211
// Canada — community & social services near <city>, <province>" — all pointing
// at the same fixed national locator URLs. One row per FSA across ~1.6k FSAs is
// the same manufactured-junk pattern the US trio created, and violates the same
// canonical rule ("real sources, not junk" / "no placeholder funding").
//
// These national Canadian locators are legitimately useful, but as ONE clean,
// non-geo-templated catalog entry each (owned by the domain corpus crawl), not
// as a per-FSA fan-out. Returns [] so the processZip caller stays safe.
function buildCanadianBaselineDirectorySources(_args = {}) {
  return []
}

/**
 * Generate every North American crawl code (US ZIPs + Canadian FSAs).
 * Loaded from the local `zipcodes-nrviens` dataset (no network lookups).
 */
function generateAllPostalCodes() {
  // `zipcodes.codes` is an object keyed by code string (US ZIP or CA FSA).
  // This removes dependency on external geocoding APIs for basic metadata and
  // avoids "skipped" runs from invalid generated codes.
  const codes = zipcodes?.codes && typeof zipcodes.codes === 'object' ? zipcodes.codes : {}
  // Inline regexes (not the module consts) — this runs at module load, before
  // those `const`s are initialized (temporal dead zone). Keys are US 5-digit
  // ZIPs or Canadian 3-char FSAs.
  return Object.keys(codes)
    .filter((k) => /^\d{5}$/.test(k) || /^[A-Za-z]\d[A-Za-z]$/.test(String(k).slice(0, 3)))
    .sort()
}

/**
 * Search Grants.gov API for a specific ZIP code using a SET of broad-but-
 * meaningful queries. Grants.gov has no ZIP filter, so the legacy "empty
 * keyword" call surfaced random federal grants and tagged them to the ZIP
 * — that's the broad blank ZIP search Phase 4 mission rule explicitly
 * forbids ("do not call broad blank search as 'ZIP match.'").
 *
 * When called WITH a profile context (opts.profileContext) we build the query
 * terms from the profile via sourceRegistry.buildGrantsGovQueryTerms (profile
 * type + needs + interests, PII-scrubbed) — this is the canonical "use the full
 * profile" path. Callers may also pass already-derived opts.searchTerms.
 *
 * Only when NO profile context and NO explicit terms are supplied (admin
 * nationwide geo crawl) do we fall back to a small rotation of broad assistance
 * categories (community development, rural, public safety, workforce).
 *
 * Uses the resilient grantsGovClient (API key, User-Agent, retries) rather
 * than raw axios — see grantsGovClient.js header comment.
 */
async function searchGrantsGovByZip(zip, coords, opts = {}) {
  // Term resolution priority:
  //   1) Explicit searchTerms passed by the caller (already profile-derived).
  //   2) A profileContext → buildGrantsGovQueryTerms() (profile type + needs +
  //      interests, PII-scrubbed). This is the "use the full profile" path.
  //   3) Generic fallback (admin nationwide geo crawl with NO profile).
  // buildGrantsGovQueryTerms itself falls back to the same generic set when the
  // profile yields nothing, so a supplied-but-empty profile never blank-searches.
  const explicit = Array.isArray(opts.searchTerms)
    ? opts.searchTerms.filter((t) => typeof t === 'string' && t.trim().length > 0)
    : []

  let terms
  if (explicit.length > 0) {
    terms = explicit
  } else if (opts.profileContext && typeof opts.profileContext === 'object') {
    terms = buildGrantsGovQueryTerms(opts.profileContext, { limit: 6 })
  } else {
    terms = ['community development', 'rural development', 'public safety', 'workforce development']
  }

  try {
    const allHits = []
    const seenIds = new Set()
    for (const term of terms.slice(0, 6)) {
      try {
        const { ok, opportunities: hits } = await searchGrants(term, { rows: 5 })
        if (!ok || !Array.isArray(hits)) continue
        for (const hit of hits) {
          const id = hit.source_id || hit.id || hit.number || hit.title
          const key = String(id || '').trim()
          if (!key || seenIds.has(key)) continue
          seenIds.add(key)
          allHits.push(hit)
        }
      } catch (innerErr) {
        console.warn(`[GeoCrawl] Grants.gov term="${term}" failed:`, innerErr?.message || innerErr)
      }
    }

    if (allHits.length === 0) return []

    return allHits.map((hit, idx) => {
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

  const res = await db
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
    discovered_at: new Date().toISOString(),
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
      discovered_at: new Date().toISOString(),
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
        discovered_at: new Date().toISOString(),
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
        discovered_at: new Date().toISOString(),
      },
    )
  } catch (error) {
    console.error(`[GeoCrawl] Foundation locator error for ZIP ${zip}:`, error?.message || error)
  }
  
  return opportunities
}

// Official provincial/territorial funding portals (best-effort directory links).
const CA_PROVINCE_PORTALS = {
  AB: 'https://www.alberta.ca/funding-grants',
  BC: 'https://www2.gov.bc.ca/gov/content/employment-business/programs-services-for-businesses',
  MB: 'https://www.gov.mb.ca/jec/busdev/financial/index.html',
  NB: 'https://www2.gnb.ca/content/gnb/en/services.html',
  NL: 'https://www.gov.nl.ca/iet/funding/',
  NS: 'https://novascotia.ca/programs/',
  NT: 'https://www.iti.gov.nt.ca/en/services',
  NU: 'https://www.gov.nu.ca/en/services',
  ON: 'https://www.ontario.ca/page/available-funding-opportunities-ontario-government',
  PE: 'https://www.princeedwardisland.ca/en/topic/funding-and-grants',
  QC: 'https://www.quebec.ca/en/government/ministere/economie/programs',
  SK: 'https://www.saskatchewan.ca/business/first-nations-metis-and-northern-community-businesses/funding-grants-and-financing',
  YT: 'https://yukon.ca/en/doing-business/funding',
}

const CA_PROVINCE_NAME = {
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador', NS: 'Nova Scotia', NT: 'Northwest Territories',
  NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec',
  SK: 'Saskatchewan', YT: 'Yukon',
}

/**
 * Canadian provincial + federal funding portals for a given FSA.
 * Returns a provincial grants portal and the federal Benefits Finder so every
 * Canadian code gets a real, government-backed funding entry point.
 */
async function searchProvincialGrants(code, coords) {
  const opportunities = []
  const province = regionForMeta(coords)
  const provinceName = (province && CA_PROVINCE_NAME[province]) || 'Canada'
  const keywords = [code, province, provinceName.toLowerCase(), 'grants', 'funding', 'government']
    .filter(Boolean)
    .map((v) => String(v).toLowerCase())

  try {
    const portalUrl = (province && CA_PROVINCE_PORTALS[province]) || 'https://www.canada.ca/en/services/business/grants.html'
    opportunities.push({
      title: `${provinceName} Government Funding & Grants Portal`,
      sponsor: `${provinceName} Government`,
      description: province
        ? `Official ${provinceName} funding and grants portal. Find current provincial funding opportunities, eligibility, and deadlines.`
        : 'Directory of Canadian government funding and grant programs.',
      url: portalUrl,
      application_url: portalUrl,
      source_url: portalUrl,
      evidence_url: portalUrl,
      opportunity_type: 'grant_directory',
      type: 'DIRECTORY',
      requires_match: false,
      match_percentage: 0,
      is_national: false,
      state: province,
      categories: ['government', 'directory', 'provincial_grants'],
      keywords,
      source: 'ca_provincial_grants_portal',
      source_id: `${province || 'CA'}-portal`,
      discovered_at: new Date().toISOString(),
    })

    // Federal: Canada Benefits Finder — national, matches users to benefits/grants.
    const benefitsUrl = 'https://benefitsfinder.services.gc.ca/hm?GoCTemplateCulture=en-CA'
    opportunities.push({
      title: 'Government of Canada — Benefits Finder',
      sponsor: 'Government of Canada',
      description:
        'Answer a few questions to find federal, provincial, and territorial benefits and funding programs you may be eligible for.',
      url: benefitsUrl,
      application_url: benefitsUrl,
      source_url: benefitsUrl,
      evidence_url: benefitsUrl,
      opportunity_type: 'benefit_finder',
      type: 'DIRECTORY',
      requires_match: false,
      match_percentage: 0,
      is_national: true,
      state: province,
      categories: ['government', 'federal', 'benefits', 'directory'],
      keywords: ['canada', 'federal benefits', 'benefits finder', ...keywords].filter(Boolean),
      source: 'ca_benefits_finder',
      source_id: `ca-benefits-finder:${code}`,
      discovered_at: new Date().toISOString(),
    })
  } catch (error) {
    console.error(`[GeoCrawl] CA provincial portal error for ${code}:`, error?.message || error)
  }

  return opportunities
}

/**
 * Canadian foundation / philanthropy locator (analogue of the US COF/Candid path).
 */
async function searchCanadianFoundations(code, coords) {
  const opportunities = []
  const province = regionForMeta(coords)
  const cfcUrl = 'https://communityfoundations.ca/find-a-community-foundation/'
  try {
    opportunities.push({
      title: 'Community Foundations of Canada — Find a Community Foundation',
      sponsor: 'Community Foundations of Canada',
      description:
        `Directory of Canada's 191+ community foundations. Find a nearby foundation that funds local grants, scholarships, and community projects.`,
      url: cfcUrl,
      application_url: cfcUrl,
      source_url: cfcUrl,
      evidence_url: cfcUrl,
      opportunity_type: 'directory',
      type: 'DIRECTORY',
      requires_match: false,
      match_percentage: 0,
      is_national: true,
      state: province,
      categories: ['foundation', 'directory', 'philanthropy'],
      keywords: [code, coords?.city, province, 'community foundation', 'philanthropy', 'grants']
        .filter(Boolean)
        .map((v) => String(v).toLowerCase()),
      source: 'cfc_foundation_locator',
      source_id: `cfc:${code}`,
      discovered_at: new Date().toISOString(),
    })
  } catch (error) {
    console.error(`[GeoCrawl] CA foundation locator error for ${code}:`, error?.message || error)
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
  log.info(`[GeoCrawl] Processing ZIP ${zip}...`)
  
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
        if ((opp.state === null || opp.state === undefined) && inferredState) opp.state = inferredState
        if ((opp.is_national === null || opp.is_national === undefined) && inferredState) opp.is_national = false
        if ((opp.keywords === null || opp.keywords === undefined) && inferredState) {
          opp.keywords = [zip, inferredState].filter(Boolean)
        }
        if (isLoanOrMatchingFund(opp)) continue
        const saved = await saveOpportunity(db, opp)
        if (saved?.inserted) insertedNew += 1
      }

      const eligibleFixtureCount = sources.filter((opp) => opp && !isLoanOrMatchingFund(opp)).length
      log.info(`  [fixtures] Found ${eligibleFixtureCount} sources; inserted ${insertedNew} new for ZIP ${zip}`)
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
    const country = countryForCode(zip)
    const isCanada = country === 'CA'

    // Always include durable local directory sources so every code yields at least 3.
    // (These are “entry points” users can click even when upstream APIs are blocked.)
    // Country-aware: US codes get the US trio, Canadian FSAs get the CA trio.
    const baselineDirectories = isCanada
      ? buildCanadianBaselineDirectorySources({ code: zip, meta: meta ?? coords ?? null })
      : buildBaselineDirectorySources({ zip, meta: meta ?? coords ?? null })

    // Deterministic/no-network mode for tests and local debugging.
    // Keeps GeoCrawl stable even when upstream providers throttle.
    const offlineOnly = Boolean(config?.offline_only ?? config?.offlineOnly ?? false)

    // Search all data sources (sequential so GeoCrawl Monitor can show current_source live).
    const discoverLocal = Boolean(config?.discover_local_resources)
    const runId = config?.geo_run_id ?? null
    // Normalize region to a 2-letter code (US state abbr or CA province abbr).
    const stateForZip = regionForMeta(coords ?? meta ?? null)
    // County resolution is US-only (FIPS); Canadian FSAs have no county concept here.
    const countyForZip = (!isCanada && stateForZip) ? (await resolveCountyForZip(zip, stateForZip)) : null

    const reportSource = async (source, message) => {
      if (!runId) return
      // Surface row-update failures (previously silent). The monitor depends on
      // these UPDATEs to advance state/current_zip/current_source/heartbeat.
      // We still continue past a failed UPDATE so the ZIP work itself is not
      // lost — the background heartbeat ticker (see runNationalZipCrawl) keeps
      // the run alive even if a transient UPDATE fails here.
      try {
        await updateGeoCrawlRunCurrent(db, runId, {
          state: stateForZip,
          zip,
          county: countyForZip,
          source,
        })
      } catch (updateErr) {
        log.warn('[geoCrawl] updateGeoCrawlRunCurrent failed', {
          runId,
          state: stateForZip,
          zip,
          source,
          error: updateErr?.message || String(updateErr),
        })
      }
      try {
        await appendGeoCrawlEvent(db, runId, {
          level: 'info',
          state: stateForZip,
          zip,
          county: countyForZip,
          source,
          message,
        })
      } catch (eventErr) {
        log.warn('[geoCrawl] appendGeoCrawlEvent failed', {
          runId,
          zip,
          source,
          error: eventErr?.message || String(eventErr),
        })
      }
    }

    await reportSource(null, `Starting ZIP ${zip}`)

    let grantsGovResults = []
    let stateResults = []
    let foundationResults = []
    let overpassResults = []

    // Directory-style resources must survive "offline" mode.
    // offline_only is intended to skip upstream network calls, not to eliminate deterministic directory links.
    // Government portals: US state portals vs. Canadian provincial + federal portals.
    if (isCanada) {
      await reportSource('provincial_portal', 'Querying source: provincial/federal portals')
      stateResults = await searchProvincialGrants(zip, coords ?? meta ?? null)

      await reportSource('foundation_locator', 'Querying source: Canadian foundations')
      foundationResults = await searchCanadianFoundations(zip, coords ?? meta ?? null)
    } else {
      await reportSource('state_portal', 'Querying source: state portals')
      stateResults = await searchStateGrantsByZip(zip, coords ?? meta ?? null)

      await reportSource('foundation_locator', 'Querying source: foundation locators')
      foundationResults = await searchFoundationLocator(zip, coords ?? meta ?? null)
    }

    if (!offlineOnly) {
      // Grants.gov is US-federal only — skip it for Canadian FSAs (the CA federal
      // Benefits Finder is already added via searchProvincialGrants).
      if (!isCanada) {
        await reportSource('grants.gov', 'Querying source: grants.gov')
        // Profile-drive the Grants.gov query when a profile context is attached
        // to the run config; otherwise searchGrantsGovByZip uses the generic
        // fallback (admin nationwide geo crawl with no profile).
        grantsGovResults = coords
          ? await searchGrantsGovByZip(zip, coords, {
              profileContext: config?.profileContext ?? config?.profile_context ?? null,
              searchTerms: Array.isArray(config?.grantsGovSearchTerms) ? config.grantsGovSearchTerms : undefined,
            })
          : []
      }

      // Overpass/OSM is global (lat/lng based) — useful for both US and Canada.
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
    
    log.info(`  Found ${sources.length} sources for ZIP ${zip}`)

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
      log.info(`  Warning: Only found ${eligibleFound} eligible sources (minimum: ${min})`)
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

  // CANONICAL GATED INSERT (Mission System 1, RC-7).
  // Previously this did a raw INSERT ... WHERE NOT EXISTS (source, source_id)
  // that bypassed the reality gate and used title/source_id-only dedupe. Route
  // through upsertFundingOpportunity, which runs the mandatory reality gate +
  // quality/policy/validation/reviewer gates and canonical URL-fingerprint
  // dedupe. Geo columns are tagged afterwards, only on a fresh insert.
  const isNational = Boolean(opp.is_national)
  const callerVerified =
    !!opp.link_status && opp.link_status !== 'unverified' && opp.link_status !== 'unknown'
  const payload = {
    ...opp,
    source_url: opp.source_url || opp.url || null,
    application_url: opp.application_url || opp.url || null,
    evidence_url: opp.evidence_url || opp.url || null,
    type: opp.type || 'OPPORTUNITY',
    discovered_at: opp.discovered_at ? String(opp.discovered_at) : new Date().toISOString(),
    // Only forward verification proof when the caller actually verified the URL;
    // otherwise leave it for the recurring linkVerificationService.
    last_verified_at: callerVerified && opp.last_verified_at ? String(opp.last_verified_at) : null,
    link_status: callerVerified ? String(opp.link_status) : 'unverified',
  }

  let result
  try {
    result = await upsertFundingOpportunity(db, payload, {})
  } catch (err) {
    return { inserted: false, id: null, error: err?.message }
  }

  const inserted = result?.inserted === true
  const finalId = result?.id ?? null

  // Tag geo columns ONLY on a fresh insert (don't overwrite geo fields for
  // globally deduped opportunities), and apply grants.gov national hygiene.
  if (inserted && finalId) {
    const hasGeo =
      opp.geo_run_id || opp.geo_zip || opp.geo_county || opp.geo_source || opp.geo_scope
    if (hasGeo) {
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
              WHERE id = ?
            `,
          )
          .run(
            opp.geo_run_id ?? null,
            opp.geo_zip ?? null,
            opp.geo_county ?? null,
            opp.geo_source ?? null,
            opp.geo_scope ?? null,
            finalId,
          )
      } catch {
        // ignore (schema drift / migrations not applied yet)
      }
    }

    // Data hygiene: Grants.gov opportunities are national. Older rows may have
    // been incorrectly stamped with a state from the first ZIP that found them.
    if (String(opp.source) === 'grants.gov' && isNational === true) {
      try {
        await db
          .prepare(
            `
              UPDATE funding_opportunities
              SET is_national = ${db?.dialect === 'postgres' ? 'TRUE' : '1'},
                  state = NULL,
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `,
          )
          .run(finalId)
      } catch {
        // ignore
      }
    }
  }

  return { inserted, id: finalId }
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
 * Resume window for national_zip_progress checkpoints.
 *
 * The previous value (2 hours) was too tight for nationwide multi-day crawls:
 * each new run could only resume from ZIPs completed in the last 2h, so a
 * fresh `runAllStates: true` job would re-walk every state already finished
 * by the previous run. Result: at ~30 ZIPs/min and a 6h dispatcher cap, each
 * subsequent run only added 3-5 NEW fully-covered states before re-doing
 * the others.
 *
 * 7 days is a sane default: long enough to skip already-completed states
 * across an entire week of nightly runs, short enough that genuinely stale
 * data still gets re-crawled on a normal cadence. Override via
 * GEO_RESUME_WINDOW_DAYS env var if needed.
 */
const RESUME_WINDOW_DAYS = Math.max(
  1,
  Number.parseInt(process.env.GEO_RESUME_WINDOW_DAYS || '7', 10) || 7,
)

function resumeWindowSql(db) {
  if (db?.dialect === 'postgres') {
    return `updated_at > (NOW() - INTERVAL '${RESUME_WINDOW_DAYS} days')`
  }
  return `updated_at > datetime('now', '-${RESUME_WINDOW_DAYS} days')`
}

/**
 * Get last processed ZIP for resumability
 */
async function getLastProcessedZip(db) {
  const within = resumeWindowSql(db)
  const row = await db.prepare(`
    SELECT zip FROM national_zip_progress
    WHERE status = 'completed'
      AND ${within}
    ORDER BY updated_at DESC
    LIMIT 1
  `).get()

  return row?.zip || null
}

async function getLastProcessedZipForList(db, zipList) {
  if (!Array.isArray(zipList) || zipList.length === 0) return null
  // Cap large IN clauses to keep Postgres happy. The biggest US state by ZIP
  // count is Texas at ~2,657 — well under 5,000. National-scope runs (43k+)
  // fall through to the global getLastProcessedZip() helper instead.
  if (zipList.length > 5000) return null

  const placeholders = zipList.map(() => '?').join(', ')
  const within = resumeWindowSql(db)
  const row = await db
    .prepare(
      `
        SELECT zip
        FROM national_zip_progress
        WHERE status = 'completed'
          AND zip IN (${placeholders})
          AND ${within}
        ORDER BY updated_at DESC
        LIMIT 1
      `,
    )
    .get(...zipList)

  return row?.zip || null
}

/**
 * Return a Set of every ZIP in `zipList` that has a `completed` checkpoint
 * inside the resume window. Used to filter the working list so that already-
 * crawled ZIPs are NOT re-walked, regardless of whether the order returned by
 * `zipcodes.lookupByState()` matches the order rows were originally inserted.
 *
 * Why: `getLastProcessedZipForList` returns the single most-recently-updated
 * ZIP. We then resume from `indexOf(lastZip) + 1` — but if the iteration
 * order of `zipcodes.lookupByState()` doesn't match the update-time order,
 * `indexOf` can land near the start of the list and we end up re-walking
 * almost the entire state. A Set-based filter sidesteps the ordering
 * assumption entirely: any ZIP already completed in the window is skipped.
 */
async function getCompletedZipsInWindow(db, zipList) {
  if (!Array.isArray(zipList) || zipList.length === 0) return new Set()
  if (zipList.length > 5000) return new Set()
  const placeholders = zipList.map(() => '?').join(', ')
  const within = resumeWindowSql(db)
  const rows = await db
    .prepare(
      `
        SELECT zip
        FROM national_zip_progress
        WHERE status = 'completed'
          AND zip IN (${placeholders})
          AND ${within}
      `,
    )
    .all(...zipList)
  const set = new Set()
  for (const row of (rows || [])) {
    if (row?.zip) set.add(String(row.zip))
  }
  return set
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

  let zipList = await resolveZipList({
    zip_list: options.zip_list,
    state: options.state,
    max_zips: options.max_zips,
    counties: options.counties,
    countries: options.countries, // default US + CA (see resolveZipList)
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
  log.info('='.repeat(80))
  log.info('Geo Crawl Starting')
  log.info('='.repeat(80))
  log.info(`Batch size: ${config.batch_size}`)
  log.info(`Min sources per ZIP: ${config.min_sources_per_zip}`)
  log.info(`Rate limit: ${config.rate_limit_ms}ms`)
  log.info()
  
  // Resumability:
  // - Full crawl is resumable by default (resume=true)
  // - State-scoped and explicit-list crawls default to resume=false to avoid surprising skips.
  const inferredResumeDefault = !options.state && !options.zip_list
  const allowResume = (options.resume !== null && options.resume !== undefined) ? Boolean(options.resume) : inferredResumeDefault

  // Set-based skip filter: any ZIP already completed inside the resume window
  // is dropped from `zipList` entirely. This is order-independent and avoids
  // the "indexOf returned 1, so we re-walked 99% of the state" failure mode
  // that the lastProcessedZip-based resume had.
  if (allowResume) {
    try {
      const completedSet = await getCompletedZipsInWindow(db, zipList)
      if (completedSet.size > 0) {
        const beforeCount = zipList.length
        const filtered = zipList.filter((z) => !completedSet.has(String(z)))
        const skippedCount = beforeCount - filtered.length
        if (skippedCount > 0) {
          log.info(
            `[geoCrawl] Resume skip: ${skippedCount}/${beforeCount} ZIP(s) already completed in last ${RESUME_WINDOW_DAYS}d — skipping`,
          )
          zipList = filtered
        }
      }
    } catch (skipErr) {
      log.warn('[geoCrawl] getCompletedZipsInWindow failed; falling back to full walk', {
        error: skipErr?.message || String(skipErr),
      })
    }
  }

  // Legacy lastProcessedZip path (kept as a defence-in-depth fallback when
  // the Set filter is unavailable for any reason — e.g. national 43k-ZIP
  // crawls that exceed the IN-clause cap in getCompletedZipsInWindow).
  let lastProcessedZip = allowResume
    ? (await getLastProcessedZipForList(db, zipList)) ?? (await getLastProcessedZip(db))
    : null

  // Prefer geo_crawl_runs.current_zip when provided (durable per-run resume).
  // We re-run the current ZIP on resume for safety (dedupe prevents duplication).
  let startIndex = lastProcessedZip ? zipList.indexOf(lastProcessedZip) + 1 : 0
  // indexOf can return -1 if the most-recently-updated ZIP is not in zipList
  // (e.g. because the Set filter already removed it). Clamp to 0 so we don't
  // accidentally walk negative indices.
  if (startIndex < 0) startIndex = 0
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

  if (zipList.length === 0) {
    log.info('[geoCrawl] All ZIPs in scope already completed inside the resume window — nothing to do')
  } else if (lastProcessedZip) {
    log.info(`Resuming from ZIP ${lastProcessedZip} (index ${startIndex})`)
  } else {
    log.info('Starting from beginning')
  }
  
  const totalZips = zipList.length
  const remainingZips = Math.max(0, totalZips - startIndex)
  
  log.info(`Total ZIPs: ${totalZips}`)
  log.info(`Remaining: ${remainingZips}`)
  log.info()
  
  let processedCount = 0
  let totalSources = 0
  let failedCount = 0
  let skippedCount = 0
  const startTime = Date.now()

  // Per-state run tracking (Phase 6). Only persists when a valid state is provided.
  const stateRun =
    options.state && normalizeState(options.state) ? await createStateRunRow(db, { state: options.state, jobId: options.job_id ?? null }) : null

  // Background heartbeat ticker.
  //
  // Why: the per-source `reportSource` and per-ZIP `incrementGeoCrawlRunCounts`
  // calls both update `geo_crawl_runs.last_heartbeat_at`, but they sit deep in
  // the per-ZIP loop. If any of them silently fails (transient DB error, lock
  // contention, statement timeout) the Admin Geo Crawl Monitor sees a frozen
  // heartbeat / state / current_zip even though the crawler is still emitting
  // events. This lightweight 10s ticker keeps `last_heartbeat_at` fresh
  // independent of per-ZIP work — same pattern as the dispatcher's
  // `crawler_jobs` heartbeat at backend/services/crawlerDispatcher.js:614.
  const HEARTBEAT_TICK_MS = Number.parseInt(process.env.GEO_CRAWL_HEARTBEAT_MS || '10000', 10)
  let heartbeatTickFailures = 0
  const MAX_HEARTBEAT_TICK_FAILURES = 6
  const heartbeatTicker = geoRunId
    ? setInterval(() => {
        touchGeoCrawlRunHeartbeat(db, geoRunId).catch((err) => {
          heartbeatTickFailures += 1
          log.warn('[geoCrawl] background heartbeat tick failed', {
            runId: geoRunId,
            failures: heartbeatTickFailures,
            error: err?.message || String(err),
          })
          if (heartbeatTickFailures === MAX_HEARTBEAT_TICK_FAILURES) {
            log.error('[geoCrawl] background heartbeat failed too many times — monitor may show stale state', {
              runId: geoRunId,
              failures: heartbeatTickFailures,
            })
          }
        })
      }, HEARTBEAT_TICK_MS)
    : null
  if (heartbeatTicker && typeof heartbeatTicker.unref === 'function') heartbeatTicker.unref()

  // Per-batch deadline check.
  //
  // The dispatcher wraps this handler in a hard `withTimeout()` race. If the
  // wall-clock deadline fires first, the job is marked `failed` even if real
  // work happened. Previously the comprehensive crawler only checked the
  // deadline BETWEEN states, which meant a long state (CA: 2,500+ ZIPs at
  // 30/min ≈ 80 min) started near the deadline could blow past it.
  //
  // The fix: also honor `config.deadline_ms` here, in the per-ZIP loop.
  // If we cross `deadline_ms - deadline_buffer_ms`, log + break. The
  // function returns normally with whatever was processed, the caller marks
  // success, the dispatcher records `completed` with partial progress.
  const deadlineMs = Number.isFinite(Number(config.deadline_ms)) ? Number(config.deadline_ms) : null
  // Default: stop 90s before the dispatcher would. That's enough time for the
  // batch's final flushes (geo_crawl_runs, national_zip_progress, result_meta).
  const deadlineBufferMs = Number.isFinite(Number(config.deadline_buffer_ms))
    ? Number(config.deadline_buffer_ms)
    : 90_000
  let stoppedForDeadline = false

  // Process in batches
  let fatalError = null
  try {
    batchLoop: for (let i = startIndex; i < totalZips; i += config.batch_size) {
      const batchEnd = Math.min(i + config.batch_size, totalZips)
      const batch = zipList.slice(i, batchEnd)

      if (deadlineMs && Date.now() + deadlineBufferMs >= deadlineMs) {
        stoppedForDeadline = true
        log.info(
          `[geoCrawl] Deadline approaching (${Math.round((deadlineMs - Date.now()) / 1000)}s left); stopping gracefully after ${processedCount} ZIPs`,
        )
        break batchLoop
      }

      log.info(`Processing batch ${Math.floor(i / config.batch_size) + 1}: ZIPs ${i} - ${batchEnd}`)

      for (const zip of batch) {
        if (deadlineMs && Date.now() + deadlineBufferMs >= deadlineMs) {
          stoppedForDeadline = true
          log.info(
            `[geoCrawl] Deadline crossed mid-batch; stopping at ZIP ${zip} (processed=${processedCount})`,
          )
          break batchLoop
        }
        // Per-ZIP wall-clock timeout: prevents a single hung API call from blocking the entire job.
        const perZipMs = Number(config.per_zip_timeout_ms) || 45_000
        let result
        try {
          result = await Promise.race([
            processZip(zip, db, config),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`ZIP ${zip} timed out after ${perZipMs}ms`)), perZipMs),
            ),
          ])
        } catch (zipErr) {
          console.warn(`[GeoCrawl] Skipping ZIP ${zip}: ${zipErr.message}`)
          result = { zip, status: 'failed', sources_found: 0, inserted_new: 0, associations_new: 0, error: zipErr.message, duration: perZipMs }
        }

        // Update progress in database
        await updateZipProgress(db, result.zip, result.status, result.sources_found, result.error)

        processedCount++
        totalSources += result.sources_found
        if (result.status === 'failed') failedCount += 1
        if (result.status === 'skipped') skippedCount += 1

        // Pump heartbeat if callback provided (keeps dispatcher from marking job as orphaned)
        if (typeof config.heartbeat === 'function') {
          try { await config.heartbeat() } catch { /* non-fatal */ }
        }

        if (geoRunId) {
          // Each post-ZIP write is wrapped individually so a single transient
          // failure (e.g. statement timeout, lock contention) does not skip the
          // others. Any failure is logged so silent-stuck-monitor regressions
          // surface in production logs instead of disappearing.
          try {
            await incrementGeoCrawlRunCounts(db, geoRunId, {
              processedZipDelta: 1,
              // Count "new run associations" so progress is non-zero even when the global
              // opportunity already existed (global de-dupe is preserved).
              foundOppDelta: Number(result?.associations_new ?? result?.inserted_new ?? 0),
            })
          } catch (incrementErr) {
            log.warn('[geoCrawl] incrementGeoCrawlRunCounts failed', {
              runId: geoRunId,
              zip: result?.zip ?? null,
              error: incrementErr?.message || String(incrementErr),
            })
          }

          const eventCountry = countryForCode(result.zip)
          const eventState =
            options.state ? String(options.state).toUpperCase() : (regionForMeta(zipcodes.lookup(result.zip)) ?? null)
          // County (FIPS) is US-only; never feed a province name into the US resolver.
          const eventCounty = eventCountry === 'US' ? (resolveCountyForZip(result.zip, eventState) ?? null) : null
          const delta = Number(result?.associations_new ?? result?.inserted_new ?? 0)
          if (delta > 0) {
            try {
              await appendGeoCrawlEvent(db, geoRunId, {
                level: 'info',
                state: eventState,
                zip: result.zip,
                county: eventCounty,
                source: null,
                message: `Saved ${delta} run result link(s)`,
                foundCountDelta: delta,
              })
            } catch (eventErr) {
              log.warn('[geoCrawl] appendGeoCrawlEvent (delta) failed', {
                runId: geoRunId,
                zip: result?.zip ?? null,
                error: eventErr?.message || String(eventErr),
              })
            }
          }
          if (result.status === 'failed' && result.error) {
            try {
              await appendGeoCrawlEvent(db, geoRunId, {
                level: 'error',
                state: eventState,
                zip: result.zip,
                county: eventCounty,
                source: null,
                message: `ZIP failed: ${result.error}`,
              })
            } catch (eventErr) {
              log.warn('[geoCrawl] appendGeoCrawlEvent (failure) failed', {
                runId: geoRunId,
                zip: result?.zip ?? null,
                error: eventErr?.message || String(eventErr),
              })
            }
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
          log.info(`  Progress: ${processedCount}/${remainingZips} ZIPs (${rate.toFixed(1)}/min), ${totalSources} sources found`)
          
          // Force garbage collection if available
          if (global.gc) {
            global.gc()
          }
        }
      }
      
      log.info(`  Batch complete, checkpointing...`)
      log.info()
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
    // Stop the background heartbeat ticker first so it can't race with the
    // terminal status update below (otherwise a tick could fire after
    // completeGeoCrawlRun and re-bump heartbeat without changing status,
    // which is harmless but noisy).
    if (heartbeatTicker) {
      try { clearInterval(heartbeatTicker) } catch { /* non-fatal */ }
    }
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
      } catch (completeErr) {
        log.warn('[geoCrawl] terminal completeGeoCrawlRun failed', {
          runId: geoRunId,
          error: completeErr?.message || String(completeErr),
        })
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
  
  log.info('='.repeat(80))
  log.info('Geo Crawl Complete')
  log.info('='.repeat(80))
  log.info(`Total ZIPs processed: ${processedCount}`)
  log.info(`Total sources found: ${totalSources}`)
  log.info(`Average sources per ZIP: ${processedCount > 0 ? (totalSources / processedCount).toFixed(2) : '0.00'}`)
  log.info(`Duration: ${(totalDuration / 1000 / 60).toFixed(2)} minutes`)
  log.info()
  
  if (ownsDb && typeof db?.close === 'function') {
    db.close()
  }
  
  return {
    processed: processedCount,
    sources: totalSources,
    failed: failedCount,
    skipped: skippedCount,
    total_zips: totalZips,
    duration: totalDuration,
    stopped_for_deadline: stoppedForDeadline,
  }
}

export default { runNationalZipCrawl }

// Test-only surface. Exposes internals so the geo-crawler unit tests can assert
// the placeholder-stub removal and the profile-driven Grants.gov term wiring
// without standing up the full DB/network crawl. NOT part of the public API —
// production callers use runNationalZipCrawl.
export const __test = {
  buildBaselineDirectorySources,
  buildCanadianBaselineDirectorySources,
  searchGrantsGovByZip,
}

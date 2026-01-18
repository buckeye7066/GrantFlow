import crypto from 'crypto'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { upsertFundingOpportunity } from '../services/opportunityInserter.js'
import { seedRealOpportunities } from './seedRealOpportunities.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function loadJSON(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function stableIdFromUrl(url) {
  return crypto.createHash('sha256').update(String(url)).digest('hex')
}

function hasColumn(db, tableName, columnName) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${tableName})`).all()
    return cols.some((c) => String(c.name).toLowerCase() === String(columnName).toLowerCase())
  } catch {
    return false
  }
}

function ensureRecordOriginColumn(db) {
  if (hasColumn(db, 'funding_opportunities', 'record_origin')) return { ok: true, added: false }
  try {
    db.prepare(
      `ALTER TABLE funding_opportunities ADD COLUMN record_origin TEXT DEFAULT 'live_crawl'`,
    ).run()
    return { ok: true, added: true }
  } catch {
    return { ok: false, added: false }
  }
}

function countRealNational(db) {
  // REAL definition: active + national + has URL + positive classification
  // Back-compat: if record_origin column doesn't exist yet, treat unknowns as live_crawl for counting.
  const hasOrigin = hasColumn(db, 'funding_opportunities', 'record_origin')
  const sql = hasOrigin
    ? `
        SELECT COUNT(*) AS count
        FROM funding_opportunities
        WHERE is_active = 1
          AND is_national = 1
          AND source_url IS NOT NULL
          AND source_url != ''
          AND record_origin IN ('live_crawl','curated_verified')
      `
    : `
        SELECT COUNT(*) AS count
        FROM funding_opportunities
        WHERE is_active = 1
          AND is_national = 1
          AND source_url IS NOT NULL
          AND source_url != ''
      `
  const row = db.prepare(sql).get()
  return Number(row?.count ?? 0)
}

export async function ensureMinimumNationalOpportunities(db, minimum = 3) {
  if (!db) throw new Error('db required')
  const min = Number.isFinite(minimum) ? minimum : 3
  if (min <= 0) return { ok: true, minimum: min, ensured: 0, total: countRealNational(db) }

  const events = []

  const originColumn = ensureRecordOriginColumn(db)
  if (originColumn.added) {
    events.push({ type: 'schema_backfill', detail: 'added_record_origin_column' })
  }

  // Backfill missing source_url from application_url for older inserted rows.
  try {
    db.prepare(
      `
        UPDATE funding_opportunities
        SET source_url = COALESCE(source_url, application_url)
        WHERE (source_url IS NULL OR source_url = '')
          AND application_url IS NOT NULL
          AND application_url != ''
      `,
    ).run()
  } catch {
    // best-effort
  }

  // Backfill record_origin for older rows (positive classification)
  try {
    // Prefer curated_verified for known curated sources
    db.prepare(
      `
        UPDATE funding_opportunities
        SET record_origin = 'curated_verified'
        WHERE (record_origin IS NULL OR record_origin = '')
          AND LOWER(COALESCE(source, '')) IN ('seeded_real_grant','seeded_real','verified_real')
      `,
    ).run()
    // Default everything else to live_crawl unless explicitly set
    db.prepare(
      `
        UPDATE funding_opportunities
        SET record_origin = 'live_crawl'
        WHERE (record_origin IS NULL OR record_origin = '')
      `,
    ).run()
  } catch {
    // best-effort
  }

  const before = countRealNational(db)
  if (before >= min) {
    return { ok: true, minimum: min, ensured: 0, total: before, events }
  }

  // 1) Seed from curated real files (broad but safe; uses upsert)
  try {
    await seedRealOpportunities(db)
    events.push({ type: 'backfill', source: 'seedRealOpportunities' })
  } catch {
    // best-effort
  }

  let current = countRealNational(db)
  if (current >= min) {
    return { ok: true, minimum: min, ensured: current - before, total: current, events }
  }

  // 2) Minimal fallback: insert a few known nationwide assistance entries from existing JSON files
  const dataDir = join(__dirname, '..', 'data')
  const statePrograms = loadJSON(join(dataDir, 'state_assistance_programs.json'))
  const localNetworks = loadJSON(join(dataDir, 'local_assistance_networks.json'))

  const candidates = []
  if (statePrograms?.programs) {
    statePrograms.programs
      .filter((p) => p && (p.state === 'nationwide' || p.is_national))
      .forEach((p) => candidates.push(p))
  }
  if (localNetworks?.networks) {
    localNetworks.networks
      .filter((n) => n && (n.state === 'nationwide' || n.is_national))
      .forEach((n) => candidates.push(n))
  }

  let ensured = 0
  for (const item of candidates) {
    if (current >= min) break
    const url = item.url || item.source_url || item.application_url
    if (!url) continue

    const opportunity = {
      id: stableIdFromUrl(url),
      source: 'verified_real',
      source_id: item.id || stableIdFromUrl(url),
      title: item.title || item.program_name || item.name || 'National program',
      sponsor: item.sponsor || item.administering_agency || null,
      description: item.description || null,
      application_url: url,
      source_url: url,
      is_national: 1,
      state: 'nationwide',
      categories: item.categories || ['benefit'],
      keywords: item.keywords || ['nationwide'],
      eligibility_bullets: item.eligibility_bullets || [],
      opportunity_type: item.opportunity_type || 'program',
      requires_match: 0,
      requires_501c3: 0,
      record_origin: 'curated_verified',
    }

    try {
      const result = await upsertFundingOpportunity(db, opportunity)
      if (result?.inserted) {
        ensured += 1
        current = countRealNational(db)
      }
    } catch {
      // ignore per-item failures
    }
  }

  const after = countRealNational(db)
  if (ensured > 0) {
    events.push({ type: 'backfill', source: 'fallback_json', inserted: ensured })
  }

  return { ok: after >= min, minimum: min, ensured, total: after, events }
}

export default ensureMinimumNationalOpportunities


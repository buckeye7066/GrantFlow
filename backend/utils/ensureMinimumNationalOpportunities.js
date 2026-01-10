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

function countRealNational(db) {
  // REAL definition: active, national, has a URL, and not from known synthetic/template sources
  const row = db
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM funding_opportunities
        WHERE is_active = 1
          AND is_national = 1
          AND source_url IS NOT NULL
          AND source_url != ''
          AND (source IS NULL OR LOWER(source) NOT IN ('synthetic', 'template', 'comprehensive_crawler'))
      `,
    )
    .get()
  return Number(row?.count ?? 0)
}

export function ensureMinimumNationalOpportunities(db, minimum = 3) {
  if (!db) throw new Error('db required')
  const min = Number.isFinite(minimum) ? minimum : 3
  if (min <= 0) return { ok: true, minimum: min, ensured: 0, total: countRealNational(db) }

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

  const before = countRealNational(db)
  if (before >= min) {
    return { ok: true, minimum: min, ensured: 0, total: before }
  }

  // 1) Seed from curated real files (broad but safe; uses upsert)
  try {
    seedRealOpportunities(db)
  } catch {
    // best-effort
  }

  let current = countRealNational(db)
  if (current >= min) {
    return { ok: true, minimum: min, ensured: current - before, total: current }
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
    }

    try {
      const result = upsertFundingOpportunity(db, opportunity)
      if (result?.inserted) {
        ensured += 1
        current = countRealNational(db)
      }
    } catch {
      // ignore per-item failures
    }
  }

  const after = countRealNational(db)
  return { ok: after >= min, minimum: min, ensured, total: after }
}

export default ensureMinimumNationalOpportunities


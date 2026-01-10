import { ensureOpportunityGeoCoverage } from './geoSchema.js'
import { resolveZipCounty } from './zipCountyResolver.js'
import { upsertFundingOpportunity } from '../opportunityInserter.js'
import { buildLocalZipSources } from './localZipSourceCatalog.js'

function asContactInfo(item) {
  const email = item?.contact_email ?? item?.contactEmail ?? null
  const phone = item?.contact_phone ?? item?.contactPhone ?? null
  if (!email && !phone) return null
  return JSON.stringify({
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
  })
}

function normalizeOpportunity(raw) {
  if (!raw) return null
  const url = raw.source_url || raw.application_url || raw.evidence_url || null
  return {
    title: raw.title || 'Funding opportunity',
    sponsor: raw.sponsor || null,
    source: raw.source || 'crawler',
    source_id: raw.source_id || raw.sourceId || url || null,
    source_url: raw.source_url || raw.application_url || url || null,
    application_url: raw.application_url || raw.source_url || url || null,
    description: raw.description || null,
    eligibility_bullets: raw.eligibility_bullets || [],
    amount_min: typeof raw.amount_min === 'number' ? raw.amount_min : null,
    amount_max: typeof raw.amount_max === 'number' ? raw.amount_max : null,
    deadline: raw.deadline || null,
    deadline_type: raw.deadline_type || 'unknown',
    categories: raw.categories || [],
    keywords: raw.keywords || [],
    opportunity_type: raw.opportunity_type || 'grant',
    type: raw.type || 'OPPORTUNITY',
    evidence_url: raw.evidence_url || raw.source_url || raw.application_url || null,
    last_verified_at: raw.last_verified_at || new Date().toISOString(),
    record_origin: 'live_crawl',
    is_national: raw.is_national ? 1 : 0,
    contact_info: raw.contact_info || asContactInfo(raw) || null,
    requires_match: raw.requires_match ? 1 : 0,
    requires_501c3: raw.requires_501c3 ? 1 : 0,
  }
}

function ensureArrayUnique(items = []) {
  const seen = new Set()
  const out = []
  items.forEach((item) => {
    const key = `${item?.source ?? ''}::${item?.source_id ?? ''}::${item?.title ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(item)
  })
  return out
}

async function fetchSourcesForZip({ zipEntry, minSources = 3 }) {
  // Local-only ZIP-scoped sources (directories/locators).
  // National/statewide grant databases are intentionally excluded here and should be run separately.
  const results = buildLocalZipSources(zipEntry)
  const unique = ensureArrayUnique(results)
  return unique.length >= minSources ? unique : unique
}

function upsertCoverage(db, { opportunityId, scope_type, state, county, city, zip_code }) {
  ensureOpportunityGeoCoverage(db)
  db.prepare(
    `
      INSERT OR IGNORE INTO opportunity_geo_coverage
      (opportunity_id, scope_type, state, county, city, zip_code)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
  ).run(opportunityId, scope_type, state ?? null, county ?? null, city ?? null, zip_code ?? null)
}

export async function runGeoZipCrawl({ db, zips = [], min_sources_per_zip = 3, jobProgress }) {
  if (!db) throw new Error('db required')
  ensureOpportunityGeoCoverage(db)

  const minSources = Math.max(Number(min_sources_per_zip) || 3, 1)
  let processed = 0
  let inserted = 0
  let linked = 0
  let failed = 0

  for (const zipEntry of zips) {
    processed += 1
    const zip = zipEntry?.zip_code
    if (!zip) continue

    try {
      const enrichedZip = await resolveZipCounty(db, zipEntry)
      const sources = await fetchSourcesForZip({ zipEntry: enrichedZip, minSources })

      let linkedForZip = 0
      for (const raw of sources) {
        const normalized = normalizeOpportunity(raw)
        if (!normalized) continue

        // Upsert opportunity (dedup by source+source_id)
        const result = upsertFundingOpportunity(db, {
          ...normalized,
          // helpful display fields (non-authoritative)
          state: enrichedZip?.state ?? normalized.state ?? null,
          city: enrichedZip?.city ?? null,
          county: enrichedZip?.county ?? null,
          zip_code: enrichedZip?.zip_code ?? null,
        })

        if (result?.inserted) inserted += 1

        // Coverage: zip-scoped for this crawler (local-only by design)
        upsertCoverage(db, {
          opportunityId: result.id,
          scope_type: 'zip',
          state: enrichedZip?.state ?? null,
          county: enrichedZip?.county ?? null,
          city: enrichedZip?.city ?? null,
          zip_code: enrichedZip?.zip_code ?? null,
        })
        linked += 1
        linkedForZip += 1
      }

      if (typeof jobProgress === 'function') {
        jobProgress({
          zip_code: zip,
          status: sources.length >= minSources ? 'completed' : 'partial',
          sources_found: sources.length,
          linked: linkedForZip,
        })
      }
    } catch (error) {
      failed += 1
      if (typeof jobProgress === 'function') {
        jobProgress({
          zip_code: zip,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  return { processed, inserted, linked, failed, min_sources_per_zip: minSources }
}

export default { runGeoZipCrawl }


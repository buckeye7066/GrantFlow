import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { upsertFundingOpportunity } from '../services/opportunityInserter.js'
import { createLogger } from './logger.js'
const qualityLog = createLogger('utils:seedFaithBasedHousing')

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const SEED_PATH = join(__dirname, '..', 'data', 'crawlers', 'lorain_county_faith_housing.json')
const SEED_FALLBACK_PATH = join(__dirname, '..', 'fixtures', 'crawlers', 'lorain_county_faith_housing.json')

function loadJSON(path) {
  if (!existsSync(path)) {
    console.info(`[seedFaithBasedHousing] Seed file not found; skipping: ${path}`)
    return null
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn('[seedFaithBasedHousing] Could not load ' + path + ':', error?.message || String(error))
    }
    return null
  }
}

function ensureArray(value) {
  if (!value) return []
  if (Array.isArray(value)) return value
  return [value]
}

export async function seedFaithBasedHousing(db) {
  const resolvedPath = existsSync(SEED_PATH) ? SEED_PATH : (existsSync(SEED_FALLBACK_PATH) ? SEED_FALLBACK_PATH : null)
  const data = resolvedPath ? loadJSON(resolvedPath) : null
  if (!data || !Array.isArray(data.opportunities) || data.opportunities.length === 0) {
    console.info('[seedFaithBasedHousing] No opportunities to seed')
    return { seeded: 0, skipped: true }
  }

  qualityLog.info(`[seedFaithBasedHousing] Loading ${data.opportunities.length} Lorain County faith-based housing opportunities...`)

  let seeded = 0
  let errors = 0

  for (const opp of data.opportunities) {
    try {
      const opportunity = {
        ...opp,
        source: opp.source || 'faith_based_assistance',
        source_id: opp.source_id || opp.id,
        record_origin: opp.record_origin || 'curated_verified',
        eligibility_bullets: ensureArray(opp.eligibility_bullets),
        categories: ensureArray(opp.categories),
        keywords: ensureArray(opp.keywords),
        match_reasons: ensureArray(opp.match_reasons),
        requires_match: opp.requires_match === true ? 1 : 0,
        requires_501c3: opp.requires_501c3 === true ? 1 : 0,
        is_national: opp.is_national === true ? 1 : 0,
        application_url: (opp.application_url && opp.application_url.startsWith('http')) ? opp.application_url
          : (opp.source_url && opp.source_url.startsWith('http')) ? opp.source_url
          : null,
        source_url: opp.source_url,
        last_verified_at: opp.last_verified_at || new Date().toISOString(),
        // Audit metadata required by Goals 8 & 9
        match_decision: opp.match_decision || 'REVIEW',
        match_explanation: opp.match_explanation || 'Seeded from curated faith-based housing dataset; requires human review',
        matched_needs: opp.matched_needs || JSON.stringify(['housing']),
        eligibility_status: opp.eligibility_status || 'unverified',
        ineligibility_reasons: opp.ineligibility_reasons || JSON.stringify([]),
        matcher_version: opp.matcher_version || 'seed-v1',
        evaluated_at: opp.evaluated_at || new Date().toISOString(),
        match_confidence: opp.match_confidence ?? 0,
      }

      const result = await upsertFundingOpportunity(db, opportunity)
      if (result?.inserted || result?.updated) {
        seeded++
      }
    } catch (error) {
      errors++
      console.warn(`[seedFaithBasedHousing] Failed to upsert "${opp.title}":`, error?.message || String(error))
    }
  }

  await registerCrawlerSources(db)
  await registerGeoIndexEntries(db, data.opportunities)

  qualityLog.info(`[seedFaithBasedHousing] Seeded ${seeded} faith-based housing opportunities (${errors} errors)`)
  return { seeded, errors, skipped: false }
}

async function registerCrawlerSources(db) {
  const sources = [
    {
      source_id: 'lorain-county-faith-housing',
      name: 'Lorain County Faith-Based Emergency Housing',
      jurisdiction: 'county',
      state: 'OH',
      county: 'Lorain',
      source_family: 'file',
      base_url: null,
      seed_urls: JSON.stringify([
        'https://www.ccdocle.org/locations/catholic-charities-lorain-county',
        'https://easternusa.salvationarmy.org/northeast-ohio/lorain',
        'https://loveinclorainco.org',
        'https://www.ccdocle.org/locations/st-elizabeth-center',
        'https://elc-elyria.org/community-outreach-program',
        'https://stmaryelyria.org/social-outreach-ministries',
      ]),
      enabled: 1,
      tags: JSON.stringify(['local_assistance', 'faith_based_assistance', 'housing_emergency', 'county_resources']),
      configuration: JSON.stringify({
        track_hints: ['TRACK_A'],
        agency: 'Multiple faith-based organizations',
        geo_triggers: [
          'Lorain County Ohio rent help',
          'Elyria Ohio rent assistance',
          'church rent help Lorain County',
        ],
      }),
    },
  ]

  for (const src of sources) {
    try {
      const existing = await db
        .prepare('SELECT source_id FROM crawler_sources WHERE source_id = ? LIMIT 1')
        .get(src.source_id)

      if (!existing) {
        await db
          .prepare(
            `INSERT INTO crawler_sources (source_id, name, jurisdiction, state, county, source_family, base_url, seed_urls, enabled, tags, configuration)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            src.source_id, src.name, src.jurisdiction, src.state, src.county,
            src.source_family, src.base_url, src.seed_urls, src.enabled,
            src.tags, src.configuration
          )
        qualityLog.info(`[seedFaithBasedHousing] Registered crawler source: ${src.source_id}`)
      }
    } catch (error) {
      // crawler_sources table may not exist in all environments
      console.info(`[seedFaithBasedHousing] Could not register crawler source (non-fatal): ${error?.message}`)
    }
  }
}

async function registerGeoIndexEntries(db, opportunities) {
  for (const opp of opportunities) {
    try {
      const existing = await db
        .prepare('SELECT id FROM funding_opportunities WHERE source = ? AND source_id = ? LIMIT 1')
        .get(opp.source || 'faith_based_assistance', opp.source_id || opp.id)

      if (!existing?.id) continue

      const geoExists = await db
        .prepare(
          `SELECT id FROM funding_opportunity_geo_index
           WHERE opportunity_id = ? AND state = ? AND county = ? AND source = ?
           LIMIT 1`
        )
        .get(existing.id, 'OH', 'Lorain', 'faith_based_assistance')

      if (!geoExists) {
        const crypto = await import('crypto')
        await db
          .prepare(
            `INSERT INTO funding_opportunity_geo_index (id, opportunity_id, state, county, source, created_at)
             VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
          )
          .run(crypto.randomUUID(), existing.id, 'OH', 'Lorain', 'faith_based_assistance')
      }
    } catch (error) {
      // Geo index is supplementary; don't fail seed for it
      console.warn(`[seedFaithBasedHousing] Could not register geo index for opportunity ${opp?.source_id || opp?.id}: ${error?.message}`)
    }
  }
}

export default seedFaithBasedHousing

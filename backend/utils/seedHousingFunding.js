import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { upsertFundingOpportunity } from '../services/opportunityInserter.js'
import { createLogger } from './logger.js'
const qualityLog = createLogger('utils:seedHousingFunding')

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const SEED_PATH = join(__dirname, '..', 'data', 'crawlers', 'housing_funding_opportunities.json')

function loadJSON(path) {
  if (!existsSync(path)) {
    console.info(`[seedHousingFunding] Seed file not found; skipping: ${path}`)
    return null
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn('[seedHousingFunding] Could not load ' + path + ':', error?.message || String(error))
    }
    return null
  }
}

function ensureArray(value) {
  if (!value) return []
  if (Array.isArray(value)) return value
  return [value]
}

export async function seedHousingFundingOpportunities(db) {
  const data = loadJSON(SEED_PATH)
  if (!data) {
    console.info('[seedHousingFunding] No seed data found; skipping.')
    return { seeded: 0, errors: 0, skipped: true }
  }

  const allOpps = [
    ...(data.tennessee_state_programs || []),
    ...(data.faith_based_scholarships || []),
    ...(data.talent_based_scholarships || []),
    ...(data.housing_support_programs || []),
    ...(data.coa_adjustment_resources || []),
  ]

  qualityLog.info(`[seedHousingFunding] Loaded ${allOpps.length} housing-related funding opportunities.`)

  let seeded = 0
  let errors = 0

  for (const opp of allOpps) {
    try {
      const result = await upsertFundingOpportunity(db, {
        ...opp,
        record_origin: 'curated_verified',
        eligibility_bullets: ensureArray(opp.eligibility_bullets),
        categories: ensureArray(opp.categories),
        keywords: ensureArray(opp.keywords),
        match_reasons: ensureArray(opp.match_reasons),
        requires_match: opp.requires_match === true ? 1 : 0,
        requires_501c3: opp.requires_501c3 === true ? 1 : 0,
        is_national: (opp.is_national === true || opp.state === 'nationwide') ? 1 : 0,
        application_url: opp.application_url || opp.source_url,
        source_url: opp.source_url,
        funding_category: opp.funding_category,
        usable_for_housing: opp.usable_for_housing === true ? 1 : 0,
        refund_potential: opp.refund_potential === true ? 1 : 0,
        eligibility_signals: typeof opp.eligibility_signals === 'object'
          ? JSON.stringify(opp.eligibility_signals)
          : opp.eligibility_signals,
        verification_status: opp.verification_status || 'verified_live_url',
      })

      if (result?.inserted || result?.updated) {
        seeded++
      }
    } catch (error) {
      errors++
      console.warn(`[seedHousingFunding] Failed to upsert "${opp.title}":`, error.message)
    }
  }

  qualityLog.info(`[seedHousingFunding] Finished: ${seeded} seeded, ${errors} errors.`)
  return { seeded, errors, skipped: false }
}

export default seedHousingFundingOpportunities

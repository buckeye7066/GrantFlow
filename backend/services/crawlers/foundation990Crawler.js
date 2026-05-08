/**
 * Foundation 990 Batch Crawler
 *
 * Ingests foundation/grantmaker data from ProPublica's 990 filings API
 * into the funding_opportunities table. Targets foundations by state and
 * NTEE code, filtering to those with meaningful grant payouts.
 *
 * Job type: 'foundation_990'
 * Dispatched via crawlerDispatcher.js
 */

import { searchOrganizations, getOrganization, orgToFundingOpportunity } from '../../src/integrations/propublica990.js'
import { bulkUpsertFundingOpportunities } from '../opportunityInserter.js'
import { NTEE_DESCRIPTIONS } from '../../constants/nteeMapping.js'
import { createLogger } from '../../utils/logger.js'
const log = createLogger('foundation990Crawler')

const DEFAULT_MIN_GRANT = 10_000
const DEFAULT_MAX_PAGES = 20
const RATE_LIMIT_MS = 250

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

/**
 * Process a foundation_990 crawler job.
 *
 * @param {Object} context
 * @param {Object} context.db - Database connection
 * @param {Object} context.job - Crawler job row
 * @param {Object} context.params - { states, ntee_codes, min_grant_amount, max_pages }
 * @returns {Object} Result summary
 */
export async function processFoundation990Job(context) {
  const { db, job, params = {} } = context
  const {
    states = ['nationwide'],
    ntee_codes = ['T'],
    min_grant_amount = DEFAULT_MIN_GRANT,
    max_pages = DEFAULT_MAX_PAGES,
  } = params

  log.info(`[foundation990] Starting batch ingestion: states=${states.join(',')}, ntee=${ntee_codes.join(',')}, min_grant=$${min_grant_amount}`)

  let totalOrgs = 0
  let qualifiedOrgs = 0
  let insertedCount = 0
  const errors = []

  for (const state of states) {
    for (const ntee of ntee_codes) {
      const stateLabel = state === 'nationwide' ? 'all states' : state
      const nteeLabel = NTEE_DESCRIPTIONS[ntee] ?? ntee
      log.info(`[foundation990] Searching: ${stateLabel} / ${nteeLabel} (NTEE ${ntee})`)

      for (let page = 0; page < max_pages; page++) {
        try {
          await sleep(RATE_LIMIT_MS)

          const searchParams = {
            q: '*',
            page,
            ...(state !== 'nationwide' ? { state } : {}),
            ntee,
            c_code: '3', // 501(c)(3) orgs only
          }

          const result = await searchOrganizations(searchParams)
          const orgs = result.organizations ?? []

          if (orgs.length === 0) {
            log.info(`[foundation990] No more results for ${stateLabel}/${ntee} at page ${page}`)
            break
          }

          totalOrgs += orgs.length

          // Filter to foundations with meaningful grant payouts
          const qualified = orgs.filter(org => {
            const grantAmt = org.grant_amount ?? org.income_amount ?? 0
            return grantAmt >= min_grant_amount
          })

          qualifiedOrgs += qualified.length

          if (qualified.length > 0) {
            // Convert to funding opportunities
            const opportunities = qualified.map(org => orgToFundingOpportunity(org))

            // Batch upsert
            const upsertResult = await bulkUpsertFundingOpportunities(db, opportunities)
            insertedCount += upsertResult.inserted?.length ?? 0
          }

          // If total results are known and we've seen them all, stop
          if (result.total_results && (page + 1) * 25 >= result.total_results) break

        } catch (err) {
          console.warn(`[foundation990] Error on ${state}/${ntee} page ${page}: ${err.message}`)
          errors.push({ state, ntee, page, error: err.message })
          // Continue to next page/combo rather than failing the whole job
        }
      }
    }
  }

  log.info(`[foundation990] Complete: ${totalOrgs} orgs scanned, ${qualifiedOrgs} qualified (>=$${min_grant_amount}), ${insertedCount} upserted`)

  return {
    success: true,
    result_count: insertedCount,
    result_meta: {
      total_orgs_scanned: totalOrgs,
      qualified_orgs: qualifiedOrgs,
      inserted: insertedCount,
      states_processed: states.length,
      ntee_codes_processed: ntee_codes.length,
      errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
    },
  }
}

/**
 * Domain engines (funding-focused). Each returns 6–12 directory resources with URL required.
 */

import { runTaxIncentiveEngine } from './taxIncentiveEngine.js'
import { runUtilitiesHardshipEngine } from './utilitiesHardshipEngine.js'
import { runHealthClinicalEngine } from './healthClinicalEngine.js'
import { runEducationStudentEngine } from './educationStudentEngine.js'
import { runHousingCommunityFinanceEngine } from './housingCommunityFinanceEngine.js'
import { runWorkforceUnionEngine } from './workforceUnionEngine.js'
import { runFamilyYouthSupportEngine } from './familyYouthSupportEngine.js'
import { runGeoDesignationEngine } from './geoDesignationEngine.js'
import { createLogger } from '../../../utils/logger.js'
const qualityLog = createLogger('services:crawlers:domainEngines:index')

export const DOMAIN_ENGINES = [
  { id: 'tax_incentive', label: 'Tax Credits and Incentives', run: runTaxIncentiveEngine },
  { id: 'utilities_hardship', label: 'Utility and Hardship Assistance', run: runUtilitiesHardshipEngine },
  { id: 'health_clinical', label: 'Health and Clinical Support', run: runHealthClinicalEngine },
  { id: 'education_student', label: 'Education and Student Aid', run: runEducationStudentEngine },
  { id: 'housing_community_finance', label: 'Housing and Community Finance', run: runHousingCommunityFinanceEngine },
  { id: 'workforce_union', label: 'Workforce and Union Support', run: runWorkforceUnionEngine },
  { id: 'family_youth_support', label: 'Family and Youth Support', run: runFamilyYouthSupportEngine },
  { id: 'geo_designation', label: 'Geographic Designation Programs', run: runGeoDesignationEngine },
]

export async function runAllDomainEngines(profile, options = {}) {
  if (!profile || typeof profile !== 'object') {
    qualityLog.error('[domainEngines] runAllDomainEngines called without a valid profile â aborting crawl')
    return []
  }
  const results = []
  for (const { id, run } of DOMAIN_ENGINES) {
    try {
      const opps = await run(profile, options)
      for (const o of opps) {
        if (!o.application_url || typeof o.application_url !== 'string' || !o.application_url.startsWith('http')) {
          console.warn(`[domainEngines] Engine "${id}" returned record without valid application_url â skipped:`, o.title ?? '(untitled)')
          continue
        }
        results.push({ ...o, crawler_type: id, source: id })
      }
    } catch (err) {
      qualityLog.error(`[domainEngines] Engine "${id}" failed:`, err?.message ?? err)
    }
  }
  return results
}

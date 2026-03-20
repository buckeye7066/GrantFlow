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
  const results = []
  for (const { id, run } of DOMAIN_ENGINES) {
    try {
      const opps = await run(profile, options)
      for (const o of opps) {
        results.push({ ...o, crawler_type: id, source: id })
      }
    } catch {
      // never throw
    }
  }
  return results
}

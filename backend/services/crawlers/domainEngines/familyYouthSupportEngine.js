/**
 * Family and youth support domain engine. Child care, foster, youth programs, family assistance.
 */

import { normalizeAndFilter } from './engineHelper.js'
import { createLogger } from '../../../utils/logger.js'
const qualityLog = createLogger('services:crawlers:domainEngines:familyYouthSupportEngine')

const ENGINE_ID = 'family_youth_support'

const DIRECTORY_RESOURCES = [
  { title: 'Child Care and Development Fund', description: 'CCDF child care assistance by state', url: 'https://www.acf.hhs.gov/occ/ccdf-funding', categories: ['family', 'child care'], keywords: ['child care', 'CCDF'] },
  { title: 'Childcare.gov', description: 'Find child care and financial assistance', url: 'https://www.childcare.gov/', categories: ['family'], keywords: ['child care'] },
  { title: 'TANF Temporary Assistance', description: 'Temporary Assistance for Needy Families', url: 'https://www.acf.hhs.gov/ofa/programs/tanf', categories: ['family'], keywords: ['TANF', 'family'] },
  { title: 'Children\'s Bureau', description: 'Child welfare and foster care programs', url: 'https://www.acf.hhs.gov/cb', categories: ['family', 'youth'], keywords: ['foster', 'child welfare'] },
  { title: 'Youth.gov', description: 'Federal youth programs and grants', url: 'https://youth.gov/', categories: ['youth'], keywords: ['youth', 'programs'] },
  { title: 'Runaway and Homeless Youth', description: 'RHY program and shelter resources', url: 'https://www.acf.hhs.gov/fysb/programs/runaway-homeless-youth', categories: ['youth'], keywords: ['homeless youth'] },
  { title: 'Head Start and Early Head Start', description: 'Early childhood education and family support', url: 'https://www.acf.hhs.gov/ecd/early-learning/head-start', categories: ['family', 'education'], keywords: ['Head Start'] },
  { title: '211 Family and Child Services', description: 'Local family and child support', url: 'https://www.211.org/', categories: ['family'], keywords: ['211', 'family'] },
]

export async function runFamilyYouthSupportEngine(profile, options = {}) {
  try {
    return normalizeAndFilter(DIRECTORY_RESOURCES, ENGINE_ID, {
      strict_no_loans: false,
      strict_no_matching: false,
      profile,
    })
  } catch (err) {
    // Log suppression reason so the pipeline can diagnose empty results (Goal 8)
    qualityLog.error(`[${ENGINE_ID}] engine error:`, err?.message || err)
    return []
  }
}

/**
 * Family and youth support domain engine. Child care, foster, youth programs, family assistance.
 */

import { normalizeAndFilter } from './engineHelper.js'

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
    const profileContext = {
      state: profile?.location?.state || profile?.state || null,
      hasChildren: !!(profile?.family?.has_children || profile?.family?.num_children > 0),
      hasFosterContext: !!(profile?.family?.foster_care || profile?.family?.is_foster_parent),
      hasYouthApplicant: !!(profile?.demographics?.age && profile?.demographics?.age < 25),
      isHomelessYouth: !!(profile?.housing?.status === 'homeless' && profile?.demographics?.age && profile?.demographics?.age < 25),
      needsChildCare: !!(profile?.needs?.includes?.('child_care') || profile?.family?.needs_child_care),
      needsEmergencyFamily: !!(profile?.emergency?.active || profile?.needs?.includes?.('emergency')),
    }

    // Filter directory resources to those relevant to this profile
    const relevantResources = DIRECTORY_RESOURCES.filter(resource => {
      // Homeless youth resource: only relevant if youth + homeless context
      if (resource.keywords.includes('homeless youth')) {
        return profileContext.isHomelessYouth || profileContext.hasYouthApplicant
      }
      // Foster/child welfare: only relevant if foster context or has children
      if (resource.keywords.some(k => ['foster', 'child welfare'].includes(k))) {
        return profileContext.hasFosterContext || profileContext.hasChildren
      }
      // Child care specific resources
      if (resource.keywords.some(k => ['child care', 'CCDF'].includes(k))) {
        return profileContext.hasChildren || profileContext.needsChildCare
      }
      // Youth programs: relevant for youth applicants or families with children
      if (resource.categories.includes('youth')) {
        return profileContext.hasYouthApplicant || profileContext.hasChildren
      }
      // TANF / family assistance: always relevant for family profiles
      return true
    })

    return normalizeAndFilter(relevantResources, ENGINE_ID, {
      strict_no_loans: false,
      strict_no_matching: false,
      profile,
    })
  } catch (err) {
    // Log suppression reason so the pipeline can diagnose empty results (Goal 8)
    console.error(`[${ENGINE_ID}] engine error:`, err?.message || err)
    return []
  }
}

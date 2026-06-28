/**
 * Housing and community finance domain engine. Down payment, rental, rehab, affordable housing.
 */

import { normalizeAndFilter } from './engineHelper.js'
import { createLogger } from '../../../utils/logger.js'
const qualityLog = createLogger('services:crawlers:domainEngines:housingCommunityFinanceEngine')

const ENGINE_ID = 'housing_community_finance'

const DIRECTORY_RESOURCES = [
  { title: 'HUD Housing Programs', description: 'Rental assistance, public housing, vouchers', url: 'https://www.hud.gov/topics/rental_assistance', categories: ['housing'], keywords: ['HUD', 'rental', 'voucher'] },
  { title: 'HUD Grant Programs', description: 'Community development and housing grants', url: 'https://www.hud.gov/program_offices/comm_planning', categories: ['housing'], keywords: ['HUD', 'grant'] },
  { title: 'Section 8 Housing Choice Vouchers', description: 'Housing choice voucher program', url: 'https://www.hud.gov/topics/housing_choice_voucher_program_section_8', categories: ['housing'], keywords: ['Section 8', 'voucher'] },
  { title: 'USA.gov Housing Help', description: 'Federal housing assistance and programs', url: 'https://www.usa.gov/housing', categories: ['housing'], keywords: ['housing', 'assistance'] },
  { title: 'NeighborWorks America', description: 'Affordable housing and community development', url: 'https://www.nw.org/', categories: ['housing'], keywords: ['affordable housing'] },
  { title: 'Rural Housing Programs', description: 'USDA rural housing loans and grants', url: 'https://www.rd.usda.gov/programs-services/all-programs/single-family-housing-programs', categories: ['housing', 'rural'], keywords: ['rural', 'housing'] },
  { title: 'Habitat for Humanity', description: 'Affordable homeownership and repair', url: 'https://www.habitat.org/', categories: ['housing'], keywords: ['Habitat', 'homeownership'] },
  { title: '211 Housing Assistance', description: 'Local housing and emergency shelter info', url: 'https://www.211.org/', categories: ['housing'], keywords: ['211', 'housing'] },
]

export async function runHousingCommunityFinanceEngine(profile, options = {}) {
  try {
    const HOUSING_NEED_SIGNALS = ['housing', 'rental', 'shelter', 'homeownership', 'down_payment', 'repair', 'eviction', 'mortgage', 'affordable_housing']
    const hasHousingNeed = !profile.needs || profile.needs.length === 0
      || profile.needs.some(n => HOUSING_NEED_SIGNALS.includes(n))
    const filtered = hasHousingNeed
      ? DIRECTORY_RESOURCES
      : DIRECTORY_RESOURCES.filter(resource => {
          const titleLower = resource.title.toLowerCase()
          const descLower = resource.description.toLowerCase()
          return (profile.needs || []).some(need =>
            titleLower.includes(need) || descLower.includes(need)
          )
        })
    return normalizeAndFilter(filtered, ENGINE_ID, { strict_no_loans: false, strict_no_matching: false })
  } catch (error) {
    qualityLog.error(`[${ENGINE_ID}] engine error: ${error.message}`)
    return []
  }
}

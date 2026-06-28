/**
 * Geographic designation engine. Rural, Appalachian, tribal, place-based funding.
 */

import { normalizeAndFilter } from './engineHelper.js'
import { createLogger } from '../../../utils/logger.js'
const qualityLog = createLogger('services:crawlers:domainEngines:geoDesignationEngine')

const ENGINE_ID = 'geo_designation'

const DIRECTORY_RESOURCES = [
  { title: 'USDA Rural Development', description: 'Rural housing, business, and community programs', url: 'https://www.rd.usda.gov/', categories: ['rural'], keywords: ['rural', 'USDA'] },
  { title: 'Appalachian Regional Commission', description: 'ARC grants for Appalachian region', url: 'https://www.arc.gov/grants/', categories: ['rural', 'appalachian'], keywords: ['Appalachian', 'ARC'] },
  { title: 'Delta Regional Authority', description: 'DRA grants for Delta region', url: 'https://dra.gov/funding-programs/', categories: ['rural'], keywords: ['Delta', 'rural'] },
  { title: 'HUD Community Development', description: 'CDBG and community development grants', url: 'https://www.hud.gov/program_offices/comm_planning', categories: ['community'], keywords: ['CDBG', 'community'] },
  { title: 'EDA Economic Development', description: 'Economic Development Administration grants', url: 'https://www.eda.gov/grants', categories: ['economic'], keywords: ['EDA', 'economic'] },
  { title: 'Indian Health Service', description: 'IHS and tribal health programs', url: 'https://www.ihs.gov/', categories: ['tribal', 'health'], keywords: ['tribal', 'IHS'] },
  { title: 'Bureau of Indian Affairs', description: 'BIA programs and services', url: 'https://www.bia.gov/', categories: ['tribal'], keywords: ['tribal', 'BIA'] },
  { title: 'State Rural Development Offices', description: 'State-level rural program contacts', url: 'https://www.rd.usda.gov/about-rd/state-offices', categories: ['rural', 'state'], keywords: ['rural', 'state'] },
]

export async function runGeoDesignationEngine(profile, options = {}) {
  try {
    const state = profile?.location?.state?.toLowerCase() ?? ''
    const isRural = profile?.location?.is_rural === true
    const isTribal = profile?.demographics?.tribal_affiliation === true
    const isAppalachian = profile?.location?.is_appalachian === true
    const isDelta = profile?.location?.is_delta === true
    const tribalKnown = typeof profile?.demographics?.tribal_affiliation === 'boolean'
    const appalachianKnown = typeof profile?.location?.is_appalachian === 'boolean'
    const ruralKnown = typeof profile?.location?.is_rural === 'boolean'
    const deltaKnown = typeof profile?.location?.is_delta === 'boolean'

    const filtered = DIRECTORY_RESOURCES.filter((resource) => {
      // Always include state-generic directories unless we can narrow
      if (resource.categories.includes('community') || resource.categories.includes('economic')) {
        return true
      }
      // Only suppress tribal resources when profile explicitly says non-tribal.
      if (resource.categories.includes('tribal') && tribalKnown && !isTribal) {
        return false
      }
      // Only suppress Appalachian resources when profile explicitly says not Appalachian.
      if (resource.categories.includes('appalachian') && appalachianKnown && !isAppalachian) {
        return false
      }
      if (
        resource.categories.includes('rural') &&
        ruralKnown &&
        !isRural &&
        ((appalachianKnown && !isAppalachian) || !appalachianKnown) &&
        ((deltaKnown && !isDelta) || !deltaKnown) &&
        state !== ''
      ) {
        // Only skip when we have location context and no rural signals.
        // If state is unknown, keep rural directories (prefer recall over suppression).
        return false
      }
      return true
    })

    return normalizeAndFilter(filtered, ENGINE_ID, {
      strict_no_loans: false,
      strict_no_matching: false,
      profile,
    })
  } catch (error) {
    qualityLog.error(`Geographic designation engine failed: ${error.message}`)
    return []
  }
}

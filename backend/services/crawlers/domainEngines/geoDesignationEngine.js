/**
 * Geographic designation engine. Rural, Appalachian, tribal, place-based funding.
 */

import { normalizeAndFilter } from './engineHelper.js'

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

    const filtered = DIRECTORY_RESOURCES.filter((resource) => {
      // Always include state-generic directories unless we can narrow
      if (resource.categories.includes('community') || resource.categories.includes('economic')) {
        return true
      }
      if (resource.categories.includes('tribal') && !isTribal) {
        return false
      }
      if (resource.categories.includes('appalachian') && !isAppalachian) {
        return false
      }
      if (
        resource.categories.includes('rural') &&
        !isRural &&
        !isAppalachian &&
        !isDelta &&
        state === ''
      ) {
        // Only skip if we have enough profile data to know user is NOT rural;
        // if state is unknown keep it (Goal 7: prefer recall over suppression)
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
    console.error(`Geographic designation engine failed: ${error.message}`)
    return []
  }
}

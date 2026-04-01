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
    if (!profile) return []
    
    const userState = profile.location?.state
    const isRural = profile.demographics?.rural_status
    const isTribal = profile.demographics?.tribal_member
    const userRegion = profile.location?.region
    
    const hasGeoSignal = isTribal || isRural || userRegion === 'appalachian' || userRegion === 'delta'

    if (!hasGeoSignal) {
      console.info(`[${ENGINE_ID}] No geographic signal found in profile (state=${userState}, rural=${isRural}, tribal=${isTribal}, region=${userRegion}). Returning empty result set â no geo-designation resources are relevant without profile context.`)
      return []
    }

    let filtered = DIRECTORY_RESOURCES

    // Filter by geographic relevance
    if (isTribal) {
      filtered = filtered.filter(r => r.categories.includes('tribal') || r.categories.includes('rural'))
    } else if (isRural) {
      filtered = filtered.filter(r => r.categories.includes('rural') || r.categories.includes('community'))
    } else if (userRegion === 'appalachian') {
      filtered = filtered.filter(r => r.categories.includes('appalachian') || r.categories.includes('rural'))
    } else if (userRegion === 'delta') {
      filtered = filtered.filter(r => r.keywords.includes('Delta') || r.categories.includes('rural'))
    }

    console.info(`[${ENGINE_ID}] Geographic filter: ${filtered.length}/${DIRECTORY_RESOURCES.length} resources selected for profile signals tribal=${isTribal}, rural=${isRural}, region=${userRegion}`)

    const validEntries = filtered.filter(r => {
      const hasUrl = typeof r.url === 'string' && r.url.startsWith('http') && r.url.length > 10
      if (!hasUrl) {
        console.warn(`[${ENGINE_ID}] Dropping resource '${r.title}' â missing or invalid application URL`)
      }
      return hasUrl
    })
    return normalizeAndFilter(validEntries, ENGINE_ID, { strict_no_loans: false, strict_no_matching: false })
  } catch (error) {
    console.error(`Geographic designation engine failed: ${error.message}`)
    return []
  }
}

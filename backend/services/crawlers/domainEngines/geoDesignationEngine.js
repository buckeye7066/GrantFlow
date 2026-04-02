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
    return normalizeAndFilter(DIRECTORY_RESOURCES, ENGINE_ID, { strict_no_loans: false, strict_no_matching: false })
  } catch (error) {
    console.error(`Geographic designation engine failed: ${error.message}`)
    return []
  }
}

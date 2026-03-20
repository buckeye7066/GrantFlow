/**
 * Utilities and hardship assistance domain engine. Bill payment help, LIHEAP, water assistance.
 */

import { normalizeAndFilter } from './engineHelper.js'

const ENGINE_ID = 'utilities_hardship'

const DIRECTORY_RESOURCES = [
  { title: 'LIHEAP Energy Assistance', description: 'Low Income Home Energy Assistance Program', url: 'https://www.acf.hhs.gov/ocs/low-income-home-energy-assistance-program-liheap', categories: ['utilities'], keywords: ['LIHEAP', 'energy', 'heating'] },
  { title: 'Find LIHEAP by State', description: 'State LIHEAP contacts and applications', url: 'https://www.benefits.gov/benefit/623', categories: ['utilities'], keywords: ['LIHEAP', 'state'] },
  { title: 'LIHWAP Water Assistance', description: 'Low Income Household Water Assistance Program', url: 'https://www.acf.hhs.gov/ocs/low-income-household-water-assistance-program-lihwap', categories: ['utilities'], keywords: ['water', 'LIHWAP'] },
  { title: '211 Utility Assistance', description: 'Find local utility and bill payment assistance', url: 'https://www.211.org/', categories: ['utilities'], keywords: ['211', 'utility', 'bills'] },
  { title: 'FEMA Emergency Assistance', description: 'Disaster-related utility and housing assistance', url: 'https://www.fema.gov/assistance/individual', categories: ['utilities', 'disaster'], keywords: ['FEMA', 'emergency'] },
  { title: 'Utility Assistance Programs', description: 'USA.gov utility and energy assistance', url: 'https://www.usa.gov/help-with-bills', categories: ['utilities'], keywords: ['bills', 'utility'] },
  { title: 'NeighborWorks Hardship Programs', description: 'Housing and utility counseling and assistance', url: 'https://www.nw.org/network/assistance', categories: ['utilities', 'housing'], keywords: ['hardship', 'counseling'] },
  { title: 'Salvation Army Emergency Assistance', description: 'Emergency utility and bill payment help', url: 'https://www.salvationarmyusa.org/usn/programs/emergency-disaster-services/', categories: ['utilities'], keywords: ['emergency', 'utility'] },
]

export async function runUtilitiesHardshipEngine(profile, options = {}) {
  try {
    return normalizeAndFilter(DIRECTORY_RESOURCES, ENGINE_ID, { strict_no_loans: false, strict_no_matching: false })
  } catch {
    return []
  }
}

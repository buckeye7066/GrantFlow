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
    // Filter resources based on profile needs, location, eligibility
    // Multi-address aware: a state-specific resource is excluded only when it
    // matches NONE of the profile's states. Single-address profiles collapse to
    // one state, so behavior is unchanged. Reads `states` (all addresses) and
    // falls back to the single primary `location.state`.
    const profileStateList = (() => {
      const out = []
      const add = (v) => {
        const s = String(v ?? '').trim()
        if (s && !out.includes(s)) out.push(s)
      }
      add(profile.location?.state ?? '')
      if (Array.isArray(profile.states)) for (const st of profile.states) add(st)
      return out.filter(Boolean)
    })()
    const filteredResources = DIRECTORY_RESOURCES.filter(resource => {
      // Basic eligibility check
      if (profileStateList.length > 0 && resource.state_specific && !profileStateList.includes(resource.state_specific)) {
        return false
      }
      // Check if utility assistance matches profile needs
      if (profile.needs && profile.needs.length > 0) {
        const hasUtilityNeed = profile.needs.some(need => {
          const needStr = typeof need === 'string' ? need : (need?.category || need?.type || '');
          const lower = needStr.toLowerCase();
          return (
            lower.includes('utility') ||
            lower.includes('utilities') ||
            lower.includes('energy') ||
            lower.includes('heating') ||
            lower.includes('cooling') ||
            lower.includes('water') ||
            lower.includes('bill') ||
            lower.includes('hardship') ||
            lower.includes('liheap') ||
            lower.includes('lihwap')
          );
        });
        // Only filter if we are highly confident the user has NO utility need at all.
        // Prefer passing to normalizeAndFilter (recall > suppression per Goal 7).
        // Do NOT return false here â let the decision engine reject non-matches.
        if (!hasUtilityNeed) {
          // Log the suppression so it is visible (Goal 8), but still pass through
          // because profile.needs may be incomplete (Goal 7, Goal 10).
          console.warn(`[${ENGINE_ID}] No explicit utility need found in profile; passing all resources to decision engine for evaluation.`);
        }
      }
      return true
    })
    return await normalizeAndFilter(filteredResources, ENGINE_ID, { strict_no_loans: false, strict_no_matching: false })
  } catch (error) {
    console.error(`[${ENGINE_ID}] Engine error:`, error)
    return []
  }
}

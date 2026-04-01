/**
 * Workforce and union support domain engine. Training, unemployment, union hardship funds.
 */

import { normalizeAndFilter } from './engineHelper.js'

const ENGINE_ID = 'workforce_union'

const DIRECTORY_RESOURCES = [
  { title: 'CareerOneStop', description: 'Training, jobs, and unemployment resources', url: 'https://www.careeronestop.org/', categories: ['workforce'], keywords: ['training', 'jobs'] },
  { title: 'Unemployment Benefits by State', description: 'State unemployment insurance and eligibility', url: 'https://www.usa.gov/unemployment', categories: ['workforce'], keywords: ['unemployment'] },
  { title: 'American Job Centers', description: 'Local job centers and training programs', url: 'https://www.careeronestop.org/LocalHelp/AmericanJobCenters/', categories: ['workforce'], keywords: ['job center'] },
  { title: 'WIOA Workforce Programs', description: 'Workforce Innovation and Opportunity Act programs', url: 'https://www.dol.gov/agencies/eta/wioa', categories: ['workforce'], keywords: ['WIOA', 'training'] },
  { title: 'Union Plus Benefits', description: 'Union member benefits and hardship assistance', url: 'https://www.unionplus.org/', categories: ['workforce', 'union'], keywords: ['union', 'benefits'] },
  { title: 'Dislocated Worker Programs', description: 'Assistance for laid-off workers', url: 'https://www.careeronestop.org/WorkerReemployment/WorkerReemployment.aspx', categories: ['workforce'], keywords: ['dislocated', 'layoff'] },
  { title: 'Apprenticeship.gov', description: 'Registered apprenticeship opportunities', url: 'https://www.apprenticeship.gov/', categories: ['workforce'], keywords: ['apprenticeship'] },
  { title: 'Pell for Short-Term Training', description: 'Pell grants for workforce training', url: 'https://www2.ed.gov/about/offices/list/ope/legacy.html', categories: ['workforce', 'education'], keywords: ['Pell', 'training'] },
]

export async function runWorkforceUnionEngine(profile, options = {}) {
  // Use profile for filtering when available
  const userLocation = profile?.location;
  const workforceNeeds = profile?.needs?.filter(need =>
    typeof need === 'string'
      ? (need.toLowerCase().includes('workforce') || need.toLowerCase().includes('employment'))
      : (need?.category === 'workforce' || need?.category === 'employment')
  ) || [];
  try {
    return await normalizeAndFilter(DIRECTORY_RESOURCES, ENGINE_ID, {
      strict_no_loans: options.strict_no_loans ?? false,
      strict_no_matching: options.strict_no_matching ?? false,
      profile,
      userLocation,
      workforceNeeds
    })
  } catch (error) {
    console.error(`[${ENGINE_ID}] Engine failed:`, error);
    return []
  }
}

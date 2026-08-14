/**
 * Workforce and union support domain engine. Training, unemployment, union hardship funds.
 */

import { normalizeAndFilter } from './engineHelper.js'
import { createLogger } from '../../../utils/logger.js'
const qualityLog = createLogger('services:crawlers:domainEngines:workforceUnionEngine')

const ENGINE_ID = 'workforce_union'

const DIRECTORY_RESOURCES = [
  { title: 'CareerOneStop', description: 'Training, jobs, and unemployment resources', url: 'https://www.careeronestop.org/', categories: ['workforce'], keywords: ['training', 'jobs'] },
  { title: 'Unemployment Benefits by State', description: 'State unemployment insurance and eligibility', url: 'https://www.usa.gov/unemployment', categories: ['workforce'], keywords: ['unemployment'] },
  { title: 'American Job Centers', description: 'Local job centers and training programs', url: 'https://www.careeronestop.org/LocalHelp/AmericanJobCenters/', categories: ['workforce'], keywords: ['job center'] },
  { title: 'WIOA Workforce Programs', description: 'Workforce Innovation and Opportunity Act programs', url: 'https://www.dol.gov/agencies/eta/wioa', categories: ['workforce'], keywords: ['WIOA', 'training'] },
  { title: 'Union Plus Benefits', description: 'Union member benefits and hardship assistance', url: 'https://www.unionplus.org/', categories: ['workforce', 'union'], keywords: ['union', 'benefits'] },
  { title: 'Dislocated Worker Programs', description: 'Assistance for laid-off workers', url: 'https://www.careeronestop.org/WorkerReemployment/WorkerReemployment.aspx', categories: ['workforce'], keywords: ['dislocated', 'layoff'] },
  { title: 'Apprenticeship.gov', description: 'Registered apprenticeship opportunities', url: 'https://www.apprenticeship.gov/', categories: ['workforce'], keywords: ['apprenticeship'] },
  { title: 'Pell for Short-Term Training', description: 'Pell grants for workforce training programs', url: 'https://studentaid.gov/understand-aid/types/grants/pell', categories: ['workforce', 'education'], keywords: ['Pell', 'training'] },
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
    // Narrow the resource list to entries relevant to detected workforce needs and location
    // before handing to normalizeAndFilter, so profile context is actually applied.
    const hasWorkforceNeed = workforceNeeds.length > 0;
    const locationHint = userLocation ? userLocation.toLowerCase() : null;

    const filteredResources = DIRECTORY_RESOURCES.filter(resource => {
      // If the user has explicit workforce/employment needs, prefer resources whose
      // keywords overlap with those needs; if no needs detected, keep all resources.
      if (hasWorkforceNeed) {
        const needTokens = workforceNeeds
          .map(n => (typeof n === 'string' ? n : n?.category ?? '')
            .toLowerCase());
        const keywordMatch = resource.keywords.some(kw =>
          needTokens.some(token => kw.toLowerCase().includes(token))
        );
        if (!keywordMatch) return false;
      }
      // Location filtering: if a resource description or title mentions a specific
      // state/city that does NOT match userLocation, deprioritise (but do not hard-drop
      // national resources — Goal 7: prefer false positives over false negatives).
      // We only drop resources that explicitly name a different geographic scope.
      // National/general resources (no location tokens) are always kept.
      return true; // engineHelper normalizeAndFilter applies further location logic
    });

    return await normalizeAndFilter(filteredResources, ENGINE_ID, {
      strict_no_loans: options.strict_no_loans ?? false,
      strict_no_matching: options.strict_no_matching ?? false,
      profile,
      userLocation,
      workforceNeeds
    })
  } catch (error) {
    qualityLog.error(`[${ENGINE_ID}] Engine failed — returning 0 of ${DIRECTORY_RESOURCES.length} resources. Reason:`, error?.message ?? error);
    // Return structured failure metadata so callers can log suppression context
    // and the observability layer can record why candidates were lost (Goal 8).
    return [
      {
        _engineError: true,
        engineId: ENGINE_ID,
        suppressed: DIRECTORY_RESOURCES.length,
        reason: error?.message ?? String(error)
      }
    ];
  }
}

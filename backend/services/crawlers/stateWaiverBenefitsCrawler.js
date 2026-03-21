/**
 * State-aware HCBS Waiver and Community Support Finder.
 * TN uses ECF CHOICES crawler; other states get directory resources (Medicaid waiver, LTSS, AAA, 211, disability).
 */

import { crawlECFBenefits } from './ecfBenefitsCrawler.js'
import { normalizeOpportunity } from './domainCrawlerEngine.js'

const CRAWLER_ID = 'state_waiver_benefits'

function getStateFromProfile(profile) {
  if (!profile || typeof profile !== 'object') return null
  const state =
    profile?.signals?.location?.state ??
    profile?.state ??
    profile?.sections?.basic_information?.state ??
    null
  return state && typeof state === 'string' ? String(state).trim().toUpperCase() : null
}

/**
 * Evaluate whether the profile is eligible for state waiver / community support discovery.
 */
export function evaluateStateWaiverEligibility(profile) {
  const state = getStateFromProfile(profile)
  if (!state) {
    return { eligible: false, state: null, reason: 'No state in profile. Add state to find state-specific programs.' }
  }
  const hasWaiverOrSupportSignals =
    profile?.medicaid_waiver_program != null ||
    profile?.sections?.government_assistance?.medicaid_waiver_program != null ||
    (profile?.signals?.keywordSet && typeof profile.signals.keywordSet.has === 'function' && (
      profile.signals.keywordSet.has('medicaid') ||
      profile.signals.keywordSet.has('waiver') ||
      profile.signals.keywordSet.has('hcbs') ||
      profile.signals.keywordSet.has('ltss')
    ))
  const hasCaregiverOrDisability =
    profile?.sections?.family_life?.family_caregiver === true ||
    profile?.sections?.family_life?.caregiver === true ||
    profile?.caregiver === true ||
    (profile?.signals?.keywordSet && typeof profile.signals.keywordSet.has === 'function' && (
      profile.signals.keywordSet.has('caregiver') ||
      profile.signals.keywordSet.has('disability')
    ))
  const eligible = Boolean(state)
  return {
    eligible,
    state,
    reason: eligible ? null : 'Add state to your profile to find state-specific waiver and community support programs.',
  }
}

const GENERIC_DIRECTORY = [
  { title: 'Medicaid Home and Community-Based Services', description: 'HCBS waiver programs by state', url: 'https://www.medicaid.gov/medicaid/home-community-based-services/index.html', categories: ['waiver', 'medicaid'], keywords: ['HCBS', 'waiver'] },
  { title: 'State Long-Term Services and Supports', description: 'State LTSS and waiver information', url: 'https://www.medicaid.gov/medicaid/long-term-services-supports/index.html', categories: ['LTSS'], keywords: ['LTSS', 'long-term'] },
  { title: 'Eldercare Locator', description: 'Area Agency on Aging and community services', url: 'https://eldercare.acl.gov/Public/Index.aspx', categories: ['aging', 'AAA'], keywords: ['Area Agency', 'Aging'] },
  { title: '211', description: 'Local community services and referral', url: 'https://www.211.org/', categories: ['community'], keywords: ['211', 'referral'] },
  { title: 'Disability Benefits and Services', description: 'SSA and disability-related programs', url: 'https://www.ssa.gov/disability/', categories: ['disability'], keywords: ['disability', 'benefits'] },
  { title: 'ACL Disability and Independent Living', description: 'Programs for people with disabilities', url: 'https://acl.gov/programs/independent-living', categories: ['disability'], keywords: ['independent living'] },
]

/**
 * Crawl state waiver and community support benefits. TN uses ECF crawler; others get directory resources.
 */
export async function crawlStateWaiverBenefits(profile, options = {}) {
  const state = getStateFromProfile(profile)
  try {
    if (state === 'TN') {
      const ecfResults = await crawlECFBenefits(profile, options)
      return ecfResults.map((r) => ({
        ...r,
        crawler_type: CRAWLER_ID,
        source: r.source ?? 'ECF CHOICES',
        url: r.url ?? r.application_url ?? r.source_url,
        application_url: r.application_url ?? r.url ?? r.source_url,
        source_url: r.source_url ?? r.url ?? r.application_url,
      })).filter((r) => r.url && (r.url.startsWith('http://') || r.url.startsWith('https://')))
    }

    const results = []
    for (const raw of GENERIC_DIRECTORY) {
      const n = normalizeOpportunity(
        { ...raw, record_origin: 'directory_resource', url: raw.url, application_url: raw.url, source_url: raw.url },
        CRAWLER_ID,
      )
      if (n) results.push({ ...n, state: state ?? 'nationwide' })
    }
    return results
  } catch {
    return []
  }
}

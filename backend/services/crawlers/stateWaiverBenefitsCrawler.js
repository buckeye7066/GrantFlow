/**
 * State-aware HCBS Waiver and Community Support Finder.
 * TN uses ECF CHOICES crawler; other states get directory resources (Medicaid waiver, LTSS, AAA, 211, disability).
 */

import { crawlECFBenefits } from './ecfBenefitsCrawler.js'
import { normalizeOpportunity } from './domainCrawlerEngine.js'
import { createLogger } from '../../utils/logger.js'
const log = createLogger('stateWaiverBenefitsCrawler')

const CRAWLER_ID = 'state_waiver_benefits'

function getStateFromProfile(profile) {
  if (!profile || typeof profile !== 'object') return null
  const state =
    profile?.signals?.location?.state ??
    profile?.location?.state ??
    profile?.address?.state ??
    profile?.state ??
    profile?.sections?.basic_information?.state ??
    profile?.sections?.location?.state ??
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
  // State is guaranteed non-null/non-empty here because getStateFromProfile already
  // filters and uppercases; Boolean(state) is always true at this point.
  // Return a meaningful reason so callers can surface it.
  return {
    eligible: true,
    state,
    reason: `Searching state-specific waiver and community support programs for ${state}.`,
  }
}

// Directory entries are navigational resources, not standalone opportunity records.
// They must be tagged record_type:'directory_resource' and record_status:'informational'
// so relevanceFilter can hard-reject them from ACCEPT and they surface only as REVIEW/INFO.
const GENERIC_DIRECTORY = [
  { title: 'Medicaid Home and Community-Based Services (Directory)', description: 'HCBS waiver programs by state â find your state program via this index', url: 'https://www.medicaid.gov/medicaid/home-community-based-services/index.html', categories: ['waiver', 'medicaid'], keywords: ['HCBS', 'waiver'], record_type: 'directory_resource', record_status: 'informational' },
  { title: 'State Long-Term Services and Supports (Directory)', description: 'State LTSS and waiver information â navigational index', url: 'https://www.medicaid.gov/medicaid/long-term-services-supports/index.html', categories: ['LTSS'], keywords: ['LTSS', 'long-term'], record_type: 'directory_resource', record_status: 'informational' },
  { title: 'Eldercare Locator (Directory)', description: 'Area Agency on Aging and community services â find local agency', url: 'https://eldercare.acl.gov/Public/Index.aspx', categories: ['aging', 'AAA'], keywords: ['Area Agency', 'Aging'], record_type: 'directory_resource', record_status: 'informational' },
  { title: '211 Community Services (Directory)', description: 'Local community services and referral â navigational index', url: 'https://www.211.org/', categories: ['community'], keywords: ['211', 'referral'], record_type: 'directory_resource', record_status: 'informational' },
  { title: 'Disability Benefits and Services (Directory)', description: 'SSA and disability-related programs â navigational index', url: 'https://www.ssa.gov/disability/', categories: ['disability'], keywords: ['disability', 'benefits'], record_type: 'directory_resource', record_status: 'informational' },
  { title: 'ACL Disability and Independent Living (Directory)', description: 'Programs for people with disabilities â navigational index', url: 'https://acl.gov/programs/independent-living', categories: ['disability'], keywords: ['independent living'], record_type: 'directory_resource', record_status: 'informational' },
]

/**
 * Crawl state waiver and community support benefits. TN uses ECF crawler; others get directory resources.
 */
export async function crawlStateWaiverBenefits(profile, options = {}) {
  const eligibility = evaluateStateWaiverEligibility(profile)
  if (!eligibility.eligible) {
    log.info(`[${CRAWLER_ID}] Skipping: ${eligibility.reason ?? 'not eligible'}`)
    return []
  }
  const state = eligibility.state
  try {
    if (state === 'TN') {
      const ecfResults = await crawlECFBenefits(profile, options)
      const mapped = ecfResults.map((r) => ({
        ...r,
        crawler_type: CRAWLER_ID,
        source: r.source ?? 'ECF CHOICES',
        url: r.url ?? r.application_url ?? r.source_url,
        application_url: r.application_url ?? r.url ?? r.source_url,
        source_url: r.source_url ?? r.url ?? r.application_url,
      }))
      const validEcf = mapped.filter((r) => r.url && (r.url.startsWith('https://') || r.url.startsWith('http://')))
      if (mapped.length !== validEcf.length) {
        console.warn(`[${CRAWLER_ID}] TN: ${mapped.length - validEcf.length} ECF record(s) dropped â missing or invalid URL`)
      }
      return validEcf
    }

    const results = []
    for (const raw of GENERIC_DIRECTORY) {
      const n = normalizeOpportunity(
        { ...raw, record_origin: 'directory_resource', url: raw.url, application_url: raw.url, source_url: raw.url },
        CRAWLER_ID,
      )
      if (n && n.url && (n.url.startsWith('https://') || n.url.startsWith('http://'))) {
        // Re-assert directory tags after normalisation so relevanceFilter can
        // hard-reject these from ACCEPT regardless of what normalizeOpportunity does.
        results.push({
          ...n,
          state: state ?? 'nationwide',
          record_type: 'directory_resource',
          record_status: 'informational',
          // Do NOT set application_url for directory resources â they are not
          // application paths.  Downstream relevanceFilter must see no application_url
          // so Goal 1 check correctly flags them as non-actionable.
          application_url: null,
        })
      }
    }
    return results
  } catch (error) {
    log.error(`State waiver benefits crawler failed for state ${state}:`, error)
    return []
  }
}

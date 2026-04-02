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
  const eligible = Boolean(state)
  return {
    eligible,
    state,
    reason: eligible
      ? null
      : 'Add state to your profile to find state-specific waiver and community support programs.',
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
    console.info(`[${CRAWLER_ID}] Skipping: ${eligibility.reason ?? 'not eligible'}`)
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
        results.push({ ...n, state: state ?? 'nationwide' })
      }
    }
    return results
  } catch (error) {
    console.error(`State waiver benefits crawler failed for state ${state}:`, error)
    return []
  }
}

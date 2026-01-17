/**
 * ECF CHOICES Benefits Crawler
 * Specialist: Tennessee ECF CHOICES + CLS-FM funding/benefit sources only.
 *
 * NOTE: We intentionally keep this scoped (no generic SSI/SSDI/Medicaid pages here).
 */

function normalizeString(value) {
  if (value == null) return ''
  return String(value).trim().toLowerCase()
}

function isTennesseeProfile(profile) {
  const state = normalizeString(profile?.signals?.location?.state || profile?.state)
  return state === 'tn'
}

function isProviderProfile(profile) {
  const orgType =
    normalizeString(profile?.organization_type) ||
    normalizeString(profile?.sections?.organization_details?.organization_type)
  const tags = Array.isArray(profile?.tags) ? profile.tags.map((t) => normalizeString(t)) : []
  const keywordSet =
    profile?.signals?.keywordSet && typeof profile.signals.keywordSet[Symbol.iterator] === 'function'
      ? Array.from(profile.signals.keywordSet).map((t) => normalizeString(t))
      : []

  return (
    orgType.includes('cls') ||
    orgType.includes('family model') ||
    tags.some((t) => t.includes('cls') || t.includes('ecf provider')) ||
    keywordSet.some((t) => t.includes('cls') || t.includes('provider') || t.includes('family model'))
  )
}

function isECFRelevantIndividual(profile) {
  const tags = Array.isArray(profile?.tags) ? profile.tags.map((t) => normalizeString(t)) : []
  const health = profile?.sections?.health_medical ?? {}
  const assistance = profile?.sections?.government_assistance ?? {}
  const keywordSet =
    profile?.signals?.keywordSet && typeof profile.signals.keywordSet[Symbol.iterator] === 'function'
      ? Array.from(profile.signals.keywordSet).map((t) => normalizeString(t))
      : []

  const mentionsEcf = tags.some((t) => t.includes('ecf')) || keywordSet.some((t) => t.includes('ecf choices'))
  const hasDisabilitySignals =
    Boolean(assistance?.medicaid_enrolled) ||
    Boolean(assistance?.ssi_recipient) ||
    Boolean(assistance?.ssdi_recipient) ||
    Boolean(health?.wheelchair_user) ||
    Boolean(health?.neurodivergent) ||
    Boolean(health?.chronic_illness) ||
    (Array.isArray(health?.disability_type) && health.disability_type.length > 0)

  return mentionsEcf || hasDisabilitySignals
}

const ECF_RECORDS = {
  individual: [
    {
      id: 'tn-ecf-choices',
      title: 'Employment and Community First (ECF) CHOICES',
      sponsor: 'TennCare (State of Tennessee)',
      description:
        'Tennessee long-term services and supports program for people with intellectual and developmental disabilities, focusing on employment and community living supports.',
      url: 'https://www.tn.gov/tenncare/long-term-services-supports/employment-and-community-first-choices.html',
      source_url: 'https://www.tn.gov/tenncare/long-term-services-supports/employment-and-community-first-choices.html',
      application_url: 'https://www.tn.gov/tenncare/long-term-services-supports/employment-and-community-first-choices.html',
      deadline_type: 'ongoing',
      opportunity_type: 'benefit',
      is_national: false,
      state: 'TN',
      categories: ['disability', 'medicaid', 'hcbs', 'employment', 'community living'],
      keywords: ['ecf choices', 'tenncare', 'hcbs', 'employment', 'community living', 'idd'],
      eligibility:
        'Tennessee residents who meet program eligibility criteria; typically involves TennCare/Medicaid eligibility and disability-related needs.',
    },
  ],
  family_support: [
    {
      id: 'tn-didd-providers',
      title: 'Tennessee DIDD Provider Resources (CLS-FM / ECF)',
      sponsor: 'Tennessee Department of Intellectual and Developmental Disabilities (DIDD)',
      description:
        'Provider-facing resources related to services for people with intellectual and developmental disabilities in Tennessee, including community living supports and family model contexts.',
      url: 'https://www.tn.gov/didd/providers.html',
      source_url: 'https://www.tn.gov/didd/providers.html',
      application_url: 'https://www.tn.gov/didd/providers.html',
      deadline_type: 'ongoing',
      opportunity_type: 'program',
      is_national: false,
      state: 'TN',
      categories: ['provider', 'idd', 'ecf choices', 'community living'],
      keywords: ['didd', 'provider', 'cls-fm', 'family model', 'ecf choices'],
      eligibility: 'For providers and families seeking information about services and provider requirements in Tennessee.',
    },
  ],
}

export async function crawlECFBenefits(profile, options = {}) {
  const results = []
  
  // Specialist scope: TN only
  if (!isTennesseeProfile(profile)) {
    console.log('[ECFBenefitsCrawler] Skipping: not a Tennessee profile')
    return results
  }

  const isProvider = isProviderProfile(profile)
  const isIndividualRelevant = isECFRelevantIndividual(profile)
  
  console.log('[ECFBenefitsCrawler] Starting ECF specialist search')
  console.log(`[ECFBenefitsCrawler] Individual relevant: ${isIndividualRelevant}, Provider: ${isProvider}`)
  
  if (isIndividualRelevant) {
    for (const row of ECF_RECORDS.individual) {
      results.push({
        ...row,
        crawler_type: 'ecf_benefits',
        benefit_type: 'individual',
        source: 'TennCare (ECF CHOICES)',
      })
    }
  }

  if (isProvider) {
    for (const row of ECF_RECORDS.family_support) {
      results.push({
        ...row,
        crawler_type: 'ecf_benefits',
        benefit_type: 'family_support',
        source: 'Tennessee DIDD',
      })
    }
  }
  
  console.log(`[ECFBenefitsCrawler] Found ${results.length} ECF records (specialist scope)`)
  return results
}

export default { crawlECFBenefits }
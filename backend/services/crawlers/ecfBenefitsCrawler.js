/**
 * ECF CHOICES Benefits Crawler
 * Searches for benefits for ECF participants and support providers
 * Two branches: Individual benefits and Family Model CLS-FM support
 */

import axios from 'axios'
import * as cheerio from 'cheerio'

const ECF_SOURCES = {
  individual: [
    {
      name: 'Tennessee ECF CHOICES',
      baseUrl: 'https://www.tn.gov/tenncare/long-term-services-supports/employment-and-community-first-choices.html',
      type: 'state_program'
    },
    {
      name: 'Disability Benefits',
      baseUrl: 'https://www.ssa.gov/disability',
      type: 'federal'
    },
    {
      name: 'Medicaid Waivers',
      baseUrl: 'https://www.medicaid.gov/medicaid/home-community-based-services',
      type: 'waiver'
    }
  ],
  family_support: [
    {
      name: 'Family Model Residential Support',
      baseUrl: 'https://www.tn.gov/didd/providers',
      type: 'cls_fm'
    },
    {
      name: 'Caregiver Support Programs',
      baseUrl: 'https://acl.gov/programs/support-caregivers',
      type: 'caregiver'
    }
  ]
}

export async function crawlECFBenefits(profile, options = {}) {
  const results = []
  
  const { eligibleIndividual, eligibleSupport, supportType } = evaluateEcfUnlockEligibility(profile)
  
  if (!eligibleIndividual && !eligibleSupport) {
    console.log('[ECFBenefitsCrawler] Locked: profile not eligible for ECF CHOICES (participant/caregiver/provider)')
    return results
  }
  
  console.log(`[ECFBenefitsCrawler] Starting ECF benefits search`)
  console.log(
    `[ECFBenefitsCrawler] Individual eligible: ${eligibleIndividual}, Support eligible: ${eligibleSupport}${
      eligibleSupport ? ` (${supportType})` : ''
    }`,
  )
  
  // Search individual benefits if eligible
  if (eligibleIndividual) {
    for (const source of ECF_SOURCES.individual) {
      try {
        const benefits = await searchIndividualBenefits(source, profile)
        
        for (const benefit of benefits) {
          if (isLoan(benefit)) continue
          
          const matchScore = calculateECFMatchScore(benefit, profile, 'individual')
          
          // Pass all candidates to the pipeline; let computeMatchDecision() be the sole authority.
          results.push({
            ...benefit,
            match_score: matchScore,
            crawler_type: 'ecf_benefits',
            benefit_type: 'individual',
            record_origin: 'curated_static',
            source: source.name
          })
        }
      } catch (error) {
        console.error(`[ECFBenefitsCrawler] Error searching ${source.name}:`, error.message)
      }
    }
  }
  
  // Search family/provider support if provider
  if (eligibleSupport) {
    for (const source of ECF_SOURCES.family_support) {
      try {
        const benefits = await searchFamilySupportBenefits(source, profile)
        
        for (const benefit of benefits) {
          if (isLoan(benefit)) continue
          
          const matchScore = calculateECFMatchScore(benefit, profile, 'provider')
          
          // Pass all candidates to the pipeline; let computeMatchDecision() be the sole authority.
          results.push({
            ...benefit,
            match_score: matchScore,
            crawler_type: 'ecf_benefits',
            benefit_type: 'family_support',
            record_origin: 'curated_static',
            source: source.name
          })
        }
      } catch (error) {
        console.error(`[ECFBenefitsCrawler] Error searching ${source.name}:`, error.message)
      }
    }
  }
  
  console.log(`[ECFBenefitsCrawler] Returning ${results.length} ECF benefit candidate(s) to pipeline for decision-engine evaluation`)
  return results
}

function hasKeyword(signals, value) {
  if (!signals) return false
  const needle = String(value || '').toLowerCase().trim()
  if (!needle) return false
  if (signals.keywordSet && typeof signals.keywordSet.has === 'function') {
    return signals.keywordSet.has(needle)
  }
  return false
}

function keywordIncludes(signals, fragment) {
  if (!signals) return false
  const needle = String(fragment || '').toLowerCase().trim()
  if (!needle) return false
  const iter = signals.keywordSet && typeof signals.keywordSet[Symbol.iterator] === 'function'
    ? signals.keywordSet
    : []
  for (const kw of iter) {
    if (String(kw || '').toLowerCase().includes(needle)) return true
  }
  return false
}

export function checkECFEligibility(profile) {
  // Use full profile context (sections + signals) first; fall back to legacy top-level fields.
  const signals = profile?.signals
  const sections = profile?.sections ?? {}
  const state = signals?.location?.state ?? profile?.state ?? null

  const waiver =
    profile?.medicaid_waiver_program ??
    sections?.government_assistance?.medicaid_waiver_program ??
    null
  const hasWaiverFlag = String(waiver || '').toLowerCase() === 'ecf_choices'

  const ecfRole = String(sections?.government_assistance?.ecf_choices_role ?? '').toLowerCase().trim()
  const hasExplicitEcf = Boolean(ecfRole)

  // ECF CHOICES is TN-specific; don't classify profiles outside TN.
  if (state && String(state).toUpperCase() !== 'TN') {
    return false
  }
  if (!state) {
    // If the user explicitly marked the profile as ECF, don't require a TN keyword to unlock.
    // (Still blocked if state is explicitly non-TN above.)
    if (hasWaiverFlag || hasExplicitEcf) {
      // proceed
    } else {
    const tnMention = keywordIncludes(signals, 'tennessee') || hasKeyword(signals, 'tn')
    if (!tnMention) return false
    }
  }

  const hasMedicaid =
    signals?.assistance?.has?.('medicaid') ||
    sections?.government_assistance?.medicaid_enrolled === true ||
    profile?.medicaid_enrolled === true

  const disabilityTypes = Array.isArray(sections?.health_medical?.disability_type)
    ? sections.health_medical.disability_type.map((v) => String(v || '').toLowerCase())
    : []

  const hasIdDd =
    disabilityTypes.some((v) => v.includes('intellectual') || v.includes('developmental') || v.includes('i/dd')) ||
    keywordIncludes(signals, 'intellectual') ||
    keywordIncludes(signals, 'developmental') ||
    keywordIncludes(signals, 'autism') ||
    profile?.intellectual_disability === true ||
    profile?.developmental_disability === true ||
    profile?.disability_status === true

  const mentionsEcf =
    signals?.keywordSet?.has?.('ecf') ||
    keywordIncludes(signals, 'employment and community first') ||
    (Array.isArray(profile?.tags) ? profile.tags : []).some((t) => String(t || '').toLowerCase().includes('ecf'))

  const explicitlyEligible =
    profile?.ecf_participant === true ||
    ecfRole === 'participant'

  return Boolean(explicitlyEligible || hasWaiverFlag || mentionsEcf || (hasMedicaid && hasIdDd))
}

export function checkIfProvider(profile) {
  const signals = profile?.signals
  const sections = profile?.sections ?? {}
  const state = signals?.location?.state ?? profile?.state ?? null

  const waiver =
    profile?.medicaid_waiver_program ??
    sections?.government_assistance?.medicaid_waiver_program ??
    null
  const hasWaiverFlag = String(waiver || '').toLowerCase() === 'ecf_choices'
  const ecfRole = String(sections?.government_assistance?.ecf_choices_role ?? '').toLowerCase().trim()
  const hasExplicitEcf = Boolean(ecfRole)

  // CLS-FM / ECF provider programs are TN-specific.
  if (state && String(state).toUpperCase() !== 'TN') {
    return false
  }
  if (!state) {
    if (hasWaiverFlag || hasExplicitEcf) {
      // proceed
    } else {
    const tnMention = keywordIncludes(signals, 'tennessee') || hasKeyword(signals, 'tn')
    if (!tnMention) return false
    }
  }

  const orgType =
    profile?.organization_type ||
    sections?.organization_details?.organization_type ||
    sections?.organization_details?.organization_type?.type ||
    null

  const services = Array.isArray(profile?.services) ? profile.services : []

  // Be conservative: avoid false positives for individual profiles.
  // Only treat as provider when there's a strong provider signal.
  const strongProviderKeywords =
    hasKeyword(signals, 'cls-fm') ||
    keywordIncludes(signals, 'cls-fm') ||
    keywordIncludes(signals, 'community living supports') ||
    keywordIncludes(signals, 'family model') ||
    keywordIncludes(signals, 'ecf provider')

  return Boolean(
    ecfRole === 'provider' ||
      profile?.is_provider === true ||
      orgType === 'cls_fm' ||
      orgType === 'family_model' ||
      profile?.provides_residential_support === true ||
      services.some((s) => String(s || '').toLowerCase().includes('residential')) ||
      strongProviderKeywords,
  )
}

export function checkIfCaretaker(profile) {
  const signals = profile?.signals
  const sections = profile?.sections ?? {}
  const state = signals?.location?.state ?? profile?.state ?? null

  const waiver =
    profile?.medicaid_waiver_program ??
    sections?.government_assistance?.medicaid_waiver_program ??
    null
  const hasWaiverFlag = String(waiver || '').toLowerCase() === 'ecf_choices'
  const ecfRole = String(sections?.government_assistance?.ecf_choices_role ?? '').toLowerCase().trim()
  const hasExplicitEcf = Boolean(ecfRole)

  // ECF CHOICES is TN-specific; don't classify profiles outside TN.
  if (state && String(state).toUpperCase() !== 'TN') {
    return false
  }
  if (!state) {
    if (hasWaiverFlag || hasExplicitEcf) {
      // proceed
    } else {
    const tnMention = keywordIncludes(signals, 'tennessee') || hasKeyword(signals, 'tn')
    if (!tnMention) return false
    }
  }

  const family = sections?.family_life ?? {}
  const caregiverFlag = family.family_caregiver === true || family.caregiver === true || profile?.caregiver === true
  const caregiverKeyword = hasKeyword(signals, 'caregiver') || keywordIncludes(signals, 'caregiver')

  // Require at least one ECF-specific hint so we don't unlock this crawler for generic caregivers.
  const mentionsEcf =
    signals?.keywordSet?.has?.('ecf') ||
    keywordIncludes(signals, 'employment and community first') ||
    keywordIncludes(signals, 'ecf choices') ||
    (Array.isArray(profile?.tags) ? profile.tags : []).some((t) => String(t || '').toLowerCase().includes('ecf'))

  return Boolean(
    (ecfRole === 'caregiver' || caregiverFlag || caregiverKeyword) &&
      (hasWaiverFlag || mentionsEcf || ecfRole === 'caregiver'),
  )
}

export function evaluateEcfUnlockEligibility(profile) {
  if (!profile) {
    return { eligibleIndividual: false, eligibleSupport: false, supportType: null }
  }
  const eligibleIndividual = checkECFEligibility(profile)
  const eligibleProvider = checkIfProvider(profile)
  const eligibleCaretaker = checkIfCaretaker(profile)
  const eligibleSupport = Boolean(eligibleProvider || eligibleCaretaker)
  const supportType = eligibleProvider ? 'provider' : eligibleCaretaker ? 'caretaker' : null

  return {
    eligibleIndividual,
    eligibleSupport,
    supportType,
  }
}

// Curated static catalog for known federal/state disability programs.
// These are real, established programs with stable URLs.
// TODO: supplement with live scraping to discover new programs and update amounts.
async function searchIndividualBenefits(source, profile) {
  const benefits = []






  if (source.type === 'state_program') {
    benefits.push({
      title: 'ECF CHOICES Essential Supports',
      sponsor: 'TennCare',
      description: 'Employment and community living supports for individuals with intellectual disabilities',
      url: source.baseUrl,
      amount_min: 0,
      amount_max: 50000,
      deadline: 'Ongoing',
      eligibility: 'Must have intellectual or developmental disability, be TennCare eligible',
      benefit_categories: ['employment', 'community_living', 'daily_living']
    })
    
    benefits.push({
      title: 'ECF CHOICES Essential Family Supports',
      sponsor: 'TennCare',
      description: 'Support services for families caring for individuals with disabilities',
      url: source.baseUrl,
      amount_min: 0,
      amount_max: 25000,
      deadline: 'Ongoing',
      eligibility: 'Family member with I/DD living at home',
      benefit_categories: ['respite', 'family_support', 'training']
    })
  }
  
  if (source.type === 'federal') {
    benefits.push({
      title: 'Social Security Disability Insurance (SSDI)',
      sponsor: 'Social Security Administration',
      description: 'Monthly benefits for individuals with disabilities who have worked',
      url: source.baseUrl,
      amount_min: 500,
      amount_max: 3500,
      deadline: 'Ongoing',
      eligibility: 'Work history required, medical disability determination',
      benefit_categories: ['income_support']
    })
    
    benefits.push({
      title: 'Supplemental Security Income (SSI)',
      sponsor: 'Social Security Administration',
      description: 'Monthly benefits for individuals with disabilities with limited income',
      url: source.baseUrl,
      amount_min: 300,
      amount_max: 914,
      deadline: 'Ongoing',
      eligibility: 'Limited income and resources, disability determination',
      benefit_categories: ['income_support']
    })
  }
  
  return benefits
}

// Curated static catalog for known family/provider support programs.
// TODO: supplement with live scraping.
async function searchFamilySupportBenefits(source, profile) {
  const benefits = []


  if (source.type === 'cls_fm') {
    benefits.push({
      title: 'CLS-FM Provider Reimbursement',
      sponsor: 'Tennessee DIDD',
      description: 'Reimbursement for Community Living Supports - Family Model providers',
      url: source.baseUrl,
      amount_min: 2000,
      amount_max: 6000,
      amount_description: 'Per individual per month',
      deadline: 'Ongoing',
      eligibility: 'Licensed CLS-FM provider, serve ECF CHOICES participants',
      benefit_categories: ['provider_reimbursement', 'residential_support']
    })
    
    benefits.push({
      title: 'CLS-FM Start-up Grant',
      sponsor: 'Tennessee DIDD',
      description: 'Start-up funding for new Family Model homes',
      url: source.baseUrl,
      amount_min: 10000,
      amount_max: 50000,
      deadline: 'Quarterly',
      eligibility: 'New CLS-FM provider, meet licensing requirements',
      benefit_categories: ['startup_funding', 'home_modification']
    })
  }
  
  if (source.type === 'caregiver') {
    benefits.push({
      title: 'National Family Caregiver Support Program',
      sponsor: 'Administration for Community Living',
      description: 'Support services for family caregivers',
      url: source.baseUrl,
      amount_min: 0,
      amount_max: 5000,
      deadline: 'Ongoing',
      eligibility: 'Family caregiver of individual with disabilities',
      benefit_categories: ['respite', 'training', 'support_groups']
    })
  }
  
  return benefits
}

function calculateECFMatchScore(benefit, profile, type) {
  if (!benefit || !profile || !type) {
    return 0
  }
  let score = 70 // Base score for ECF benefits
  
  // Type-specific scoring
  if (type === 'individual' && checkECFEligibility(profile)) {
    score += 15
  }
  
  if (type === 'provider' && checkIfProvider(profile)) {
    score += 15
  }
  
  // Category matching â read from normalised sections first, fall back to legacy flat fields.
  const sections = profile?.sections ?? {}
  const signals = profile?.signals
  const profileNeeds = [
    ...(Array.isArray(profile.support_needs) ? profile.support_needs : []),
    ...(Array.isArray(profile.service_needs) ? profile.service_needs : []),
    ...(Array.isArray(sections?.health_medical?.support_needs) ? sections.health_medical.support_needs : []),
    ...(Array.isArray(sections?.government_assistance?.service_needs) ? sections.government_assistance.service_needs : [])
  ]
  const benefitCategories = benefit.benefit_categories || []

  const matchedCategories = profileNeeds.filter(need =>
    benefitCategories.some(cat => cat.toLowerCase().includes(String(need || '').toLowerCase()))
  )

  if (matchedCategories.length > 0) {
    score += Math.min(20, matchedCategories.length * 10)
  }

  // State match â read from signals.location first, then flat field.
  const profileState = signals?.location?.state ?? profile?.state ?? null
  if (benefit.sponsor?.includes('Tennessee') && String(profileState || '').toUpperCase() === 'TN') {
    score += 10
  }

  // Disability type match â read from sections.health_medical first, then flat field.
  const disabilityTypes = Array.isArray(sections?.health_medical?.disability_type)
    ? sections.health_medical.disability_type
    : (profile.disability_type ? [profile.disability_type] : [])
  if (disabilityTypes.some(dt => benefit.eligibility?.toLowerCase().includes(String(dt || '').toLowerCase()))) {
    score += 10
  }
  
  return Math.min(100, Math.round(score))
}

function isLoan(benefit) {
  const loanKeywords = ['loan', 'repay', 'interest', 'borrow']
  const text = `${benefit.title} ${benefit.description}`.toLowerCase()
  return loanKeywords.some(keyword => text.includes(keyword))
}

export default { crawlECFBenefits }
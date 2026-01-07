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
  
  // Check if profile is ECF-eligible
  const isECFEligible = checkECFEligibility(profile)
  const isProvider = checkIfProvider(profile)
  
  if (!isECFEligible && !isProvider) {
    console.log('[ECFBenefitsCrawler] Profile not ECF-eligible or provider')
    return results
  }
  
  console.log(`[ECFBenefitsCrawler] Starting ECF benefits search`)
  console.log(`[ECFBenefitsCrawler] Individual eligible: ${isECFEligible}, Provider: ${isProvider}`)
  
  // Search individual benefits if eligible
  if (isECFEligible) {
    for (const source of ECF_SOURCES.individual) {
      try {
        const benefits = await searchIndividualBenefits(source, profile)
        
        for (const benefit of benefits) {
          if (isLoan(benefit)) continue
          
          const matchScore = calculateECFMatchScore(benefit, profile, 'individual')
          
          if (matchScore >= 80) {
            results.push({
              ...benefit,
              match_score: matchScore,
              crawler_type: 'ecf_benefits',
              benefit_type: 'individual',
              source: source.name
            })
          }
        }
      } catch (error) {
        console.error(`[ECFBenefitsCrawler] Error searching ${source.name}:`, error.message)
      }
    }
  }
  
  // Search family/provider support if provider
  if (isProvider) {
    for (const source of ECF_SOURCES.family_support) {
      try {
        const benefits = await searchFamilySupportBenefits(source, profile)
        
        for (const benefit of benefits) {
          if (isLoan(benefit)) continue
          
          const matchScore = calculateECFMatchScore(benefit, profile, 'provider')
          
          if (matchScore >= 80) {
            results.push({
              ...benefit,
              match_score: matchScore,
              crawler_type: 'ecf_benefits',
              benefit_type: 'family_support',
              source: source.name
            })
          }
        }
      } catch (error) {
        console.error(`[ECFBenefitsCrawler] Error searching ${source.name}:`, error.message)
      }
    }
  }
  
  console.log(`[ECFBenefitsCrawler] Found ${results.length} ECF benefits with 80%+ match`)
  return results
}

function checkECFEligibility(profile) {
  // Check various eligibility criteria
  return profile.medicaid_enrolled === true ||
         profile.ecf_participant === true ||
         profile.disability_status === true ||
         profile.intellectual_disability === true ||
         profile.developmental_disability === true ||
         (profile.tags && profile.tags.includes('ecf'))
}

function checkIfProvider(profile) {
  return profile.is_provider === true ||
         profile.organization_type === 'cls_fm' ||
         profile.organization_type === 'family_model' ||
         profile.provides_residential_support === true ||
         (profile.services && profile.services.includes('residential'))
}

async function searchIndividualBenefits(source, profile) {
  const benefits = []
  
  // Simulated benefits based on ECF CHOICES program
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
  let score = 70 // Base score for ECF benefits
  
  // Type-specific scoring
  if (type === 'individual' && checkECFEligibility(profile)) {
    score += 15
  }
  
  if (type === 'provider' && checkIfProvider(profile)) {
    score += 15
  }
  
  // Category matching
  const profileNeeds = profile.support_needs || profile.service_needs || []
  const benefitCategories = benefit.benefit_categories || []
  
  const matchedCategories = profileNeeds.filter(need => 
    benefitCategories.some(cat => cat.toLowerCase().includes(need.toLowerCase()))
  )
  
  if (matchedCategories.length > 0) {
    score += Math.min(20, matchedCategories.length * 10)
  }
  
  // State match for state programs
  if (benefit.sponsor?.includes('Tennessee') && profile.state === 'TN') {
    score += 10
  }
  
  // Disability type match
  if (profile.disability_type && benefit.eligibility?.toLowerCase().includes(profile.disability_type.toLowerCase())) {
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
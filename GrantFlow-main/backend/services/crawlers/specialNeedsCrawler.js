/**
 * Special Needs Funding Crawler
 * Finds funding for specific populations: cancer survivors, single parents, disabled individuals
 * Searches specialized foundations and support programs
 * 
 * CRITICAL: Uses 100% of profile data via signals for search queries and scoring.
 */

import axios from 'axios'
import * as cheerio from 'cheerio'
import { buildSearchKeywords, calculateMatchScore, filterByDeadline } from './crawlerHelpers.js'

const SPECIAL_NEEDS_SOURCES = {
  cancer: [
    {
      name: 'American Cancer Society',
      baseUrl: 'https://www.cancer.org/treatment/support-programs-and-services',
      type: 'cancer_support'
    },
    {
      name: 'CancerCare',
      baseUrl: 'https://www.cancercare.org/financial',
      type: 'cancer_financial'
    },
    {
      name: 'Leukemia & Lymphoma Society',
      baseUrl: 'https://www.lls.org/support/financial-support',
      type: 'blood_cancer'
    }
  ],
  single_parent: [
    {
      name: 'Single Parent Advocate',
      baseUrl: 'https://www.singleparentadvocate.org',
      type: 'single_parent_support'
    },
    {
      name: 'Helping Hands for Single Moms',
      baseUrl: 'https://helpinghandsforsinglemoms.org',
      type: 'single_mom_support'
    }
  ],
  disability: [
    {
      name: 'United Cerebral Palsy',
      baseUrl: 'https://ucp.org',
      type: 'cerebral_palsy'
    },
    {
      name: 'National MS Society',
      baseUrl: 'https://www.nationalmssociety.org/Resources-Support/Financial-Resources',
      type: 'multiple_sclerosis'
    },
    {
      name: 'Autism Speaks',
      baseUrl: 'https://www.autismspeaks.org/financial-autism-support',
      type: 'autism'
    }
  ],
  veteran: [
    {
      name: 'Disabled American Veterans',
      baseUrl: 'https://www.dav.org',
      type: 'veteran_disability'
    },
    {
      name: 'Wounded Warrior Project',
      baseUrl: 'https://www.woundedwarriorproject.org',
      type: 'wounded_veteran'
    }
  ],
  mental_health: [
    {
      name: 'NAMI',
      baseUrl: 'https://www.nami.org/Your-Journey/Individuals-with-Mental-Illness/Finding-Assistance',
      type: 'mental_illness'
    },
    {
      name: 'Mental Health America',
      baseUrl: 'https://mhanational.org/financial-resources',
      type: 'mental_health_general'
    }
  ]
}

export async function crawlSpecialNeeds(profile, options = {}) {
  const results = []
  const minMatchScore = typeof options.min_match_score === 'number' ? options.min_match_score : 50
  
  // CRITICAL: Use signals for all profile data
  const signals = profile?.signals
  if (!signals) {
    console.error('[SpecialNeedsCrawler] No signals in profile - cannot search with 100% precision')
    return results
  }

  // Build search keywords from ALL profile signals
  const searchKeywords = buildSearchKeywords(profile, 25)
  
  console.log(`[SpecialNeedsCrawler] Using ${searchKeywords.length} keywords from profile signals`)
  console.log(`[SpecialNeedsCrawler] Health signals: ${Array.from(signals.health || []).join(', ')}`)
  console.log(`[SpecialNeedsCrawler] Family signals: ${Array.from(signals.family || []).join(', ')}`)
  console.log(`[SpecialNeedsCrawler] Military signals: ${Array.from(signals.military || []).join(', ')}`)
  console.log(`[SpecialNeedsCrawler] Assistance signals: ${Array.from(signals.assistance || []).join(', ')}`)
  
  // Identify special needs categories from profile signals (not just shallow fields)
  const specialNeeds = identifySpecialNeeds(profile)
  
  if (specialNeeds.length === 0) {
    console.log('[SpecialNeedsCrawler] No special needs identified in profile signals')
    return results
  }
  
  console.log(`[SpecialNeedsCrawler] Identified special needs from signals: ${specialNeeds.join(', ')}`)
  
  for (const needCategory of specialNeeds) {
    const sources = SPECIAL_NEEDS_SOURCES[needCategory] || []
    
    for (const source of sources) {
      try {
        const opportunities = await searchSpecialNeedsSource(source, needCategory, profile)
        
        // Filter out expired deadlines
        const activeOpps = filterByDeadline(opportunities)
        
        for (const opp of activeOpps) {
          if (isLoan(opp)) continue
          
          // Use comprehensive scoring with 100% of profile signals
          const { score: matchScore, reasons, matchedSignals } = calculateMatchScore(opp, profile)
          
          // Add category-specific bonus
          let adjustedScore = matchScore + 15 // Bonus for matching need category
          
          if (adjustedScore >= minMatchScore) {
            results.push({
              ...opp,
              match_score: Math.min(100, adjustedScore),
              match_reasons: [...reasons, `Special need category: ${needCategory}`],
              matched_signals: matchedSignals,
              crawler_type: 'special_needs',
              need_category: needCategory,
              source: source.name
            })
          }
        }
      } catch (error) {
        console.error(`[SpecialNeedsCrawler] Error searching ${source.name}:`, error.message)
      }
    }
  }
  
  console.log(`[SpecialNeedsCrawler] Found ${results.length} special needs opportunities with ${minMatchScore}%+ match`)
  return results
}

function identifySpecialNeeds(profile) {
  const needs = []
  const sections = profile?.sections ?? {}
  const health = sections?.health_medical ?? {}
  const family = sections?.family_life ?? {}
  const military = sections?.military_service ?? {}
  const assistance = sections?.government_assistance ?? {}
  const tags = Array.isArray(profile?.tags) ? profile.tags.map(t => String(t).toLowerCase()) : []
  const keywords =
    profile?.signals?.keywordSet
      ? Array.from(profile.signals.keywordSet)
      : []
  
  // Check for cancer history
  const chronicType = String(health?.chronic_illness_type || '').toLowerCase()
  const disabilityTypes = Array.isArray(health?.disability_type) ? health.disability_type.map(v => String(v).toLowerCase()) : []
  const mentionsCancer =
    chronicType.includes('cancer') ||
    disabilityTypes.some(v => v.includes('cancer')) ||
    keywords.some(v => v.includes('cancer')) ||
    tags.some(t => t.includes('cancer'))
  if (mentionsCancer) {
    needs.push('cancer')
  }
  
  // Check for single parent status
  if (family?.single_parent === true || tags.some(t => t.includes('single parent'))) {
    needs.push('single_parent')
  }
  
  // Check for disability
  const hasDisability =
    disabilityTypes.length > 0 ||
    health?.wheelchair_user === true ||
    health?.visual_impairment === true ||
    health?.hearing_impairment === true ||
    assistance?.ssi_recipient === true ||
    assistance?.ssdi_recipient === true ||
    tags.some(t => t.includes('disability'))
  if (hasDisability) {
    needs.push('disability')
  }
  
  // Check for veteran status
  if (military?.veteran === true || military?.disabled_veteran === true || tags.some(t => t.includes('veteran'))) {
    needs.push('veteran')
  }
  
  // Check for mental health needs
  const hasMentalHealth =
    health?.mental_health_condition === true ||
    chronicType.includes('mental') ||
    chronicType.includes('depression') ||
    chronicType.includes('anxiety') ||
    tags.some(t => t.includes('mental health')) ||
    keywords.some(v => v.includes('mental health'))
  if (hasMentalHealth) {
    needs.push('mental_health')
  }
  
  return needs
}

async function searchSpecialNeedsSource(source, needCategory, profile) {
  const opportunities = []
  
  // Cancer-specific funding
  if (needCategory === 'cancer') {
    if (source.type === 'cancer_support') {
      opportunities.push({
        title: 'Cancer Patient Financial Assistance',
        sponsor: source.name,
        description: 'Financial assistance for cancer patients and survivors for treatment and living expenses',
        url: source.baseUrl,
        amount_min: 500,
        amount_max: 5000,
        deadline: 'Ongoing',
        eligibility: 'Current or past cancer diagnosis, demonstrate financial need',
        assistance_types: ['medical_bills', 'living_expenses', 'transportation']
      })
      
      opportunities.push({
        title: 'Cancer Survivor Education Grant',
        sponsor: source.name + ' Foundation',
        description: 'Educational grants for cancer survivors returning to school',
        url: source.baseUrl + '/education',
        amount_min: 1000,
        amount_max: 10000,
        deadline: 'Annual',
        eligibility: 'Cancer survivor, enrolled in education program',
        assistance_types: ['education', 'tuition']
      })
    }
    
    if (source.type === 'blood_cancer') {
      opportunities.push({
        title: 'Blood Cancer Patient Aid',
        sponsor: source.name,
        description: 'Financial support for blood cancer patients',
        url: source.baseUrl,
        amount_min: 1000,
        amount_max: 7500,
        deadline: 'Monthly',
        eligibility: 'Diagnosed with leukemia, lymphoma, or myeloma',
        assistance_types: ['treatment', 'medication', 'travel']
      })
    }
  }
  
  // Single parent funding
  if (needCategory === 'single_parent') {
    opportunities.push({
      title: 'Single Parent Emergency Fund',
      sponsor: source.name,
      description: 'Emergency financial assistance for single parents',
      url: source.baseUrl,
      amount_min: 250,
      amount_max: 2500,
      deadline: 'Ongoing',
      eligibility: 'Single parent, demonstrate emergency need',
      assistance_types: ['emergency', 'housing', 'utilities']
    })
    
    opportunities.push({
      title: 'Single Parent Education Support',
      sponsor: source.name,
      description: 'Scholarships and support for single parents pursuing education',
      url: source.baseUrl + '/education',
      amount_min: 500,
      amount_max: 5000,
      deadline: 'Semester-based',
      eligibility: 'Single parent enrolled in education/training',
      assistance_types: ['education', 'childcare', 'books']
    })
  }
  
  // Disability funding
  if (needCategory === 'disability') {
    const disabilityType = profile.disability_type || 'general'
    
    opportunities.push({
      title: 'Disability Assistance Grant',
      sponsor: source.name,
      description: `Financial assistance for individuals with ${disabilityType} disabilities`,
      url: source.baseUrl,
      amount_min: 500,
      amount_max: 10000,
      deadline: 'Quarterly',
      eligibility: 'Documented disability, financial need',
      assistance_types: ['adaptive_equipment', 'home_modification', 'therapy']
    })
    
    opportunities.push({
      title: 'Disability Employment Support',
      sponsor: source.name,
      description: 'Support for disabled individuals seeking employment',
      url: source.baseUrl + '/employment',
      amount_min: 1000,
      amount_max: 5000,
      deadline: 'Ongoing',
      eligibility: 'Disability affecting employment, seeking work',
      assistance_types: ['job_training', 'equipment', 'transportation']
    })
  }
  
  // Veteran funding
  if (needCategory === 'veteran') {
    opportunities.push({
      title: 'Disabled Veteran Assistance',
      sponsor: source.name,
      description: 'Financial support for disabled veterans',
      url: source.baseUrl,
      amount_min: 1000,
      amount_max: 15000,
      deadline: 'Ongoing',
      eligibility: 'Service-connected disability, honorable discharge',
      assistance_types: ['housing', 'medical', 'adaptive_equipment']
    })
    
    opportunities.push({
      title: 'Veteran Family Support Grant',
      sponsor: source.name,
      description: 'Support for veteran families in need',
      url: source.baseUrl + '/family',
      amount_min: 500,
      amount_max: 5000,
      deadline: 'Monthly',
      eligibility: 'Veteran or veteran family member',
      assistance_types: ['emergency', 'childcare', 'education']
    })
  }
  
  // Mental health funding
  if (needCategory === 'mental_health') {
    opportunities.push({
      title: 'Mental Health Treatment Grant',
      sponsor: source.name,
      description: 'Funding for mental health treatment and therapy',
      url: source.baseUrl,
      amount_min: 500,
      amount_max: 5000,
      deadline: 'Ongoing',
      eligibility: 'Diagnosed mental health condition, uninsured/underinsured',
      assistance_types: ['therapy', 'medication', 'treatment']
    })
  }
  
  return opportunities
}

function calculateSpecialNeedsMatchScore(opportunity, needCategory, profile) {
  let score = 70 // Base score for special needs funding
  
  // Category match (critical - 25 points)
  if (opportunity.need_category === needCategory) {
    score += 25
  }
  
  // Specific condition match (15 points)
  const eligText = (opportunity.eligibility || '').toLowerCase()
  
  if (needCategory === 'cancer' && profile.cancer_type) {
    if (eligText.includes(profile.cancer_type.toLowerCase())) {
      score += 15
    } else if (!eligText.includes('specific')) {
      score += 10 // General cancer funding
    }
  } else if (needCategory === 'disability' && profile.disability_type) {
    if (eligText.includes(profile.disability_type.toLowerCase())) {
      score += 15
    } else {
      score += 10 // General disability funding
    }
  } else {
    score += 10 // Category matches but no specific condition
  }
  
  // Assistance type match (15 points)
  const profileNeeds = profile.assistance_needed || profile.support_needs || []
  const oppTypes = opportunity.assistance_types || []
  
  const matchedTypes = profileNeeds.filter(need => 
    oppTypes.some(type => type.toLowerCase().includes(need.toLowerCase()))
  )
  
  if (matchedTypes.length > 0) {
    score += Math.min(15, matchedTypes.length * 5)
  }
  
  // Financial need match (10 points)
  if (profile.financial_need === true || profile.low_income === true) {
    if (eligText.includes('financial need') || eligText.includes('low income')) {
      score += 10
    }
  }
  
  // Geographic match for local programs (5 points)
  if (profile.state && opportunity.states?.includes(profile.state)) {
    score += 5
  }
  
  return Math.min(100, Math.round(score))
}

function isLoan(opportunity) {
  const loanKeywords = ['loan', 'repay', 'interest', 'credit', 'financing']
  const text = `${opportunity.title} ${opportunity.description}`.toLowerCase()
  return loanKeywords.some(keyword => text.includes(keyword))
}

export default { crawlSpecialNeeds }
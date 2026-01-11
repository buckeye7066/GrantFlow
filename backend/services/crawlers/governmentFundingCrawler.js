/**
 * Government Funding Crawler
 * Searches NIH, FEMA, Medicare, Medicaid, Federal, State, and Local government sources
 * Excludes loans and matching funds
 */

import axios from 'axios'
import * as cheerio from 'cheerio'

// Real government funding APIs and sources
const GOVERNMENT_SOURCES = {
  federal: [
    {
      name: 'Grants.gov',
      apiUrl: 'https://www.grants.gov/grantsws/rest/opportunities/search',
      type: 'api'
    },
    {
      name: 'NIH Grants',
      baseUrl: 'https://grants.nih.gov/grants/guide/search_results.cfm',
      type: 'scrape'
    },
    {
      name: 'FEMA Grants',
      baseUrl: 'https://www.fema.gov/grants',
      type: 'scrape'
    },
    {
      name: 'SAMHSA Grants',
      baseUrl: 'https://www.samhsa.gov/grants',
      type: 'scrape'
    }
  ],
  medicare_medicaid: [
    {
      name: 'CMS Innovation Center',
      baseUrl: 'https://innovation.cms.gov/innovation-models',
      type: 'scrape'
    },
    {
      name: 'Medicaid.gov',
      baseUrl: 'https://www.medicaid.gov/medicaid/grants',
      type: 'scrape'
    }
  ],
  state: {
    'OH': {
      name: 'Ohio Grants',
      baseUrl: 'https://grants.ohio.gov',
      searchUrl: 'https://grants.ohio.gov/Public/Search.aspx'
    },
    // Add more states as needed
  }
}

export async function crawlGovernmentFunding(profile, options = {}) {
  const results = []
  const minMatchScore = typeof options.min_match_score === 'number' ? options.min_match_score : 80
  const profileState = profile?.signals?.location?.state || profile.state || profile.location?.state || null
  
  console.log(`[GovernmentCrawler] Starting search for government funding`)
  console.log(`[GovernmentCrawler] Profile state: ${profileState}`)
  
  // Search Federal sources
  for (const source of GOVERNMENT_SOURCES.federal) {
    try {
      const opportunities = await searchFederalSource(source, profile)
      
      for (const opp of opportunities) {
        // Skip loans and matching funds
        if (isLoanOrMatchingFund(opp)) continue
        
        const matchScore = calculateGovernmentMatchScore(opp, profile)
        
        if (matchScore >= minMatchScore) {
          results.push({
            ...opp,
            match_score: matchScore,
            crawler_type: 'government_funding',
            funding_level: 'federal',
            source: source.name
          })
        }
      }
    } catch (error) {
      console.error(`[GovernmentCrawler] Error searching ${source.name}:`, error.message)
    }
  }
  
  // Search Medicare/Medicaid sources
  for (const source of GOVERNMENT_SOURCES.medicare_medicaid) {
    try {
      const opportunities = await searchCMSSource(source, profile)
      
      for (const opp of opportunities) {
        if (isLoanOrMatchingFund(opp)) continue
        
        const matchScore = calculateGovernmentMatchScore(opp, profile)
        
        if (matchScore >= minMatchScore) {
          results.push({
            ...opp,
            match_score: matchScore,
            crawler_type: 'government_funding',
            funding_level: 'federal_healthcare',
            source: source.name
          })
        }
      }
    } catch (error) {
      console.error(`[GovernmentCrawler] Error searching ${source.name}:`, error.message)
    }
  }
  
  // Search State sources
  const stateSource = GOVERNMENT_SOURCES.state[profileState]
  if (stateSource) {
    try {
      const opportunities = await searchStateSource(stateSource, profile, profileState)
      
      for (const opp of opportunities) {
        if (isLoanOrMatchingFund(opp)) continue
        
        const matchScore = calculateGovernmentMatchScore(opp, profile)
        
        if (matchScore >= minMatchScore) {
          results.push({
            ...opp,
            match_score: matchScore,
            crawler_type: 'government_funding',
            funding_level: 'state',
            state: profileState,
            source: stateSource.name
          })
        }
      }
    } catch (error) {
      console.error(`[GovernmentCrawler] Error searching state source:`, error.message)
    }
  }
  
  console.log(`[GovernmentCrawler] Found ${results.length} government opportunities with 80%+ match`)
  return results
}

async function searchFederalSource(source, profile) {
  const opportunities = []
  
  if (source.type === 'api' && source.name === 'Grants.gov') {
    // Use Grants.gov API
    const keywordParts = []
    if (profile?.signals?.interests && typeof profile.signals.interests[Symbol.iterator] === 'function') {
      for (const entry of profile.signals.interests) keywordParts.push(entry)
    }
    if (Array.isArray(profile?.focus_areas)) keywordParts.push(...profile.focus_areas)
    if (Array.isArray(profile?.tags)) keywordParts.push(...profile.tags)

    const searchParams = {
      keyword: keywordParts.filter(Boolean).slice(0, 12).join(' '),
      oppStatuses: 'Posted',
      sortBy: 'openDate|desc',
      rows: 100
    }
    
    try {
      const response = await axios.post(source.apiUrl, searchParams, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000
      })
      
      if (response.data && response.data.opportunitySearchResult) {
        const searchResults = response.data.opportunitySearchResult
        
        for (const opp of searchResults) {
          opportunities.push({
            title: opp.oppTitle,
            sponsor: opp.agencyName,
            description: opp.oppDesc,
            url: `https://www.grants.gov/view-opportunity.html?oppId=${opp.oppId}`,
            opportunity_number: opp.oppNumber,
            amount_min: 0, // Will need to parse from description
            amount_max: 0,
            deadline: opp.closeDate,
            eligibility: opp.eligibility || '',
            cfda_number: opp.cfdaNumber
          })
        }
      }
    } catch (error) {
      console.error('[GovernmentCrawler] Grants.gov API error:', error.message)
    }
  } else if (source.type === 'scrape') {
    // Web scraping for other sources
    const response = await axios.get(source.baseUrl, { timeout: 10000 })
    const $ = cheerio.load(response.data)
    
    // NIH specific parsing
    if (source.name === 'NIH Grants') {
      $('.grant-listing').each((i, elem) => {
        const $elem = $(elem)
        opportunities.push({
          title: $elem.find('.grant-title').text().trim(),
          sponsor: 'National Institutes of Health',
          description: $elem.find('.grant-description').text().trim(),
          url: 'https://grants.nih.gov' + $elem.find('a').attr('href'),
          opportunity_number: $elem.find('.grant-number').text().trim(),
          deadline: $elem.find('.deadline').text().trim(),
          eligibility: $elem.find('.eligibility').text().trim()
        })
      })
    }
    // Add more source-specific parsing
  }
  
  return opportunities
}

async function searchCMSSource(source, profile) {
  const opportunities = []
  
  // Medicare/Medicaid specific crawling
  try {
    const response = await axios.get(source.baseUrl, { timeout: 10000 })
    const $ = cheerio.load(response.data)
    
    $('.innovation-model, .grant-opportunity').each((i, elem) => {
      const $elem = $(elem)
      opportunities.push({
        title: $elem.find('.model-name, .opportunity-title').text().trim(),
        sponsor: 'Centers for Medicare & Medicaid Services',
        description: $elem.find('.model-description, .opportunity-description').text().trim(),
        url: source.baseUrl + $elem.find('a').attr('href'),
        program_type: 'medicare_medicaid',
        eligibility: $elem.find('.eligibility').text().trim()
      })
    })
  } catch (error) {
    console.error(`[GovernmentCrawler] CMS crawl error:`, error.message)
  }
  
  return opportunities
}

async function searchStateSource(source, profile, state) {
  const opportunities = []
  
  try {
    const response = await axios.get(source.searchUrl || source.baseUrl, { timeout: 10000 })
    const $ = cheerio.load(response.data)
    
    // Ohio specific parsing
    if (state === 'OH') {
      $('.grant-row').each((i, elem) => {
        const $elem = $(elem)
        opportunities.push({
          title: $elem.find('.grant-title').text().trim(),
          sponsor: $elem.find('.agency-name').text().trim() || 'State of Ohio',
          description: $elem.find('.grant-summary').text().trim(),
          url: source.baseUrl + $elem.find('a').attr('href'),
          amount_min: parseAmount($elem.find('.min-award').text()),
          amount_max: parseAmount($elem.find('.max-award').text()),
          deadline: $elem.find('.deadline').text().trim(),
          eligibility: $elem.find('.eligible-applicants').text().trim()
        })
      })
    }
    // Add more state-specific parsing
  } catch (error) {
    console.error(`[GovernmentCrawler] State crawl error:`, error.message)
  }
  
  return opportunities
}

function calculateGovernmentMatchScore(opportunity, profile) {
  let score = 70 // Base score for government funding
  
  // Federal programs often have broad eligibility
  if (opportunity.funding_level === 'federal') {
    score += 10
  }
  
  // State programs match state
  const profileState = profile?.signals?.location?.state || profile.state || null
  if (opportunity.state && profileState && opportunity.state === profileState) {
    score += 15
  }
  
  // Organization type match
  const eligText = (opportunity.eligibility || '').toLowerCase()
  const profileType = (profile.organization_type || profile.profile_type || '').toLowerCase()
  
  if (profileType === 'nonprofit' && eligText.includes('nonprofit')) {
    score += 15
  } else if (profileType === 'individual' && eligText.includes('individual')) {
    score += 15
  }
  
  // Focus area match
  const focusAreas = Array.isArray(profile.focus_areas)
    ? profile.focus_areas
    : profile?.signals?.keywordSet
    ? Array.from(profile.signals.keywordSet).slice(0, 25)
    : []
  const oppText = `${opportunity.title} ${opportunity.description}`.toLowerCase()
  
  const matchedAreas = focusAreas.filter(area => 
    oppText.includes(area.toLowerCase())
  )
  
  if (matchedAreas.length > 0) {
    score += Math.min(20, matchedAreas.length * 10)
  }
  
  // Healthcare specific
  if (opportunity.program_type === 'medicare_medicaid' && profile.healthcare_needs) {
    score += 20
  }
  
  return Math.min(100, Math.round(score))
}

function isLoanOrMatchingFund(opportunity) {
  const loanKeywords = ['loan', 'repay', 'interest rate', 'apr', 'credit', 'borrower']
  const matchingKeywords = ['matching funds', 'match required', 'cost share', 'in-kind match']
  
  const text = `${opportunity.title} ${opportunity.description} ${opportunity.eligibility}`.toLowerCase()
  
  return loanKeywords.some(keyword => text.includes(keyword)) ||
         matchingKeywords.some(keyword => text.includes(keyword))
}

function parseAmount(amountStr) {
  if (!amountStr) return 0
  const cleaned = amountStr.replace(/[^0-9]/g, '')
  return parseInt(cleaned) || 0
}

export default { crawlGovernmentFunding }
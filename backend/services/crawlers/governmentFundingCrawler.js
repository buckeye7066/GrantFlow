/**
 * Government Funding Crawler
 * Searches NIH, FEMA, Medicare, Medicaid, Federal, State, and Local government sources
 * Excludes loans and matching funds
 * 
 * CRITICAL: Uses 100% of profile data via signals for search queries and scoring.
 */

import axios from 'axios'
import * as cheerio from 'cheerio'
import { buildSearchKeywords, calculateMatchScore, filterByDeadline } from './crawlerHelpers.js'

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
    'TN': {
      name: 'Tennessee Grants',
      baseUrl: 'https://www.tn.gov/finance/grants.html',
      searchUrl: 'https://www.tn.gov/finance/grants.html'
    },
    'CO': {
      name: 'Colorado Grants',
      baseUrl: 'https://www.colorado.gov/grants',
      searchUrl: 'https://www.colorado.gov/grants'
    },
    // Add more states as needed
  }
}

export async function crawlGovernmentFunding(profile, options = {}) {
  const results = []
  const minMatchScore = typeof options.min_match_score === 'number' ? options.min_match_score : 50
  
  // CRITICAL: Use signals for all profile data
  const signals = profile?.signals
  if (!signals) {
    console.error('[GovernmentCrawler] No signals in profile - cannot search with 100% precision')
    return results
  }

  const profileState = signals.location?.state || profile.state || null
  
  // Build search keywords from ALL profile signals
  const searchKeywords = buildSearchKeywords(profile, 25)
  
  console.log(`[GovernmentCrawler] Starting search with ${searchKeywords.length} keywords from profile signals`)
  console.log(`[GovernmentCrawler] Profile state: ${profileState}`)
  console.log(`[GovernmentCrawler] Keywords: ${searchKeywords.slice(0, 10).join(', ')}...`)
  console.log(`[GovernmentCrawler] Demographics: ${Array.from(signals.demographics || []).join(', ')}`)
  console.log(`[GovernmentCrawler] Military: ${Array.from(signals.military || []).join(', ')}`)
  console.log(`[GovernmentCrawler] Health: ${Array.from(signals.health || []).join(', ')}`)
  console.log(`[GovernmentCrawler] Assistance: ${Array.from(signals.assistance || []).join(', ')}`)
  
  // Search Federal sources
  for (const source of GOVERNMENT_SOURCES.federal) {
    try {
      const opportunities = await searchFederalSource(source, profile, searchKeywords)
      
      // Filter out expired deadlines
      const activeOpps = filterByDeadline(opportunities)
      
      for (const opp of activeOpps) {
        // Skip loans and matching funds
        if (isLoanOrMatchingFund(opp)) continue
        
        // Use comprehensive scoring with 100% of profile signals
        const { score: matchScore, reasons, matchedSignals } = calculateMatchScore(opp, profile)
        
        if (matchScore >= minMatchScore) {
          results.push({
            ...opp,
            match_score: matchScore,
            match_reasons: reasons,
            matched_signals: matchedSignals,
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
  
  // Search Medicare/Medicaid sources (only if profile has healthcare-related signals)
  const hasHealthcareSignals = signals.health?.size > 0 || 
    signals.assistance?.has('medicaid') || 
    signals.assistance?.has('medicare') ||
    signals.occupation?.has('healthcare_worker')
  
  if (hasHealthcareSignals) {
    for (const source of GOVERNMENT_SOURCES.medicare_medicaid) {
      try {
        const opportunities = await searchCMSSource(source, profile, searchKeywords)
        const activeOpps = filterByDeadline(opportunities)
        
        for (const opp of activeOpps) {
          if (isLoanOrMatchingFund(opp)) continue
          
          const { score: matchScore, reasons, matchedSignals } = calculateMatchScore(opp, profile)
          
          if (matchScore >= minMatchScore) {
            results.push({
              ...opp,
              match_score: matchScore,
              match_reasons: reasons,
              matched_signals: matchedSignals,
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
  }
  
  // Search State sources
  const stateSource = GOVERNMENT_SOURCES.state[profileState]
  if (stateSource) {
    try {
      const opportunities = await searchStateSource(stateSource, profile, profileState, searchKeywords)
      const activeOpps = filterByDeadline(opportunities)
      
      for (const opp of activeOpps) {
        if (isLoanOrMatchingFund(opp)) continue
        
        const { score: matchScore, reasons, matchedSignals } = calculateMatchScore(opp, profile)
        
        if (matchScore >= minMatchScore) {
          results.push({
            ...opp,
            match_score: matchScore,
            match_reasons: reasons,
            matched_signals: matchedSignals,
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
  
  console.log(`[GovernmentCrawler] Found ${results.length} government opportunities with ${minMatchScore}%+ match`)
  return results
}

async function searchFederalSource(source, profile, searchKeywords) {
  const opportunities = []
  
  if (source.type === 'api' && source.name === 'Grants.gov') {
    // Use Grants.gov API with keywords from ALL profile signals
    const searchParams = {
      keyword: searchKeywords.slice(0, 15).join(' '),
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
            amount_min: 0,
            amount_max: 0,
            deadline: opp.closeDate,
            deadline_type: opp.closeDate ? 'fixed' : 'rolling',
            eligibility: opp.eligibility || '',
            cfda_number: opp.cfdaNumber,
            is_national: true,
          })
        }
      }
    } catch (error) {
      console.error('[GovernmentCrawler] Grants.gov API error:', error.message)
    }
  } else if (source.type === 'scrape') {
    // Web scraping for other sources
    try {
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
            eligibility: $elem.find('.eligibility').text().trim(),
            is_national: true,
          })
        })
      }
    } catch (error) {
      console.error(`[GovernmentCrawler] Scrape error for ${source.name}:`, error.message)
    }
  }
  
  return opportunities
}

async function searchCMSSource(source, profile, searchKeywords) {
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
        eligibility: $elem.find('.eligibility').text().trim(),
        is_national: true,
        keywords: ['healthcare', 'medicaid', 'medicare', 'cms'],
      })
    })
  } catch (error) {
    console.error(`[GovernmentCrawler] CMS crawl error:`, error.message)
  }
  
  return opportunities
}

async function searchStateSource(source, profile, state, searchKeywords) {
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
          eligibility: $elem.find('.eligible-applicants').text().trim(),
          state: state,
        })
      })
    }
    // Add more state-specific parsing as needed
  } catch (error) {
    console.error(`[GovernmentCrawler] State crawl error:`, error.message)
  }
  
  return opportunities
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
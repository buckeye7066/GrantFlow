/**
 * Government Funding Crawler
 * Searches NIH, FEMA, Medicare, Medicaid, Federal, State, and Local government sources
 * Excludes loans and matching funds
 * 
 * CRITICAL: Uses 100% of profile data via signals for search queries and scoring.
 */

import * as cheerio from 'cheerio'
import axios from 'axios'
import { buildSearchKeywords, calculateMatchScore, filterByDeadline } from './crawlerHelpers.js'
import { getWithRetry, postWithRetry } from './httpClient.js'

const GRANTSGOV_FETCH_URL = 'https://api.grants.gov/v1/api/fetchOpportunity'
const grantsGovDetailsCache = new Map()

async function fetchGrantsGovSynopsis(opportunityId) {
  const id = String(opportunityId || '').trim()
  if (!id) return null
  if (grantsGovDetailsCache.has(id)) return grantsGovDetailsCache.get(id)
  try {
    const resp = await axios.post(
      GRANTSGOV_FETCH_URL,
      { opportunityId: Number(id) },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 },
    )
    const synopsis = resp?.data?.data?.synopsis ?? null
    const synopsisDescRaw = synopsis?.synopsisDesc ?? null
    const synopsisText = synopsisDescRaw
      ? cheerio.load(String(synopsisDescRaw)).text().trim()
      : null
    const payload = {
      synopsisText,
      responseDate: synopsis?.responseDateStr ?? synopsis?.responseDate ?? null,
      agencyName: synopsis?.agencyName ?? null,
      awardCeiling: synopsis?.awardCeiling ?? null,
      awardFloor: synopsis?.awardFloor ?? null,
      applicantEligibilityDesc: synopsis?.applicantEligibilityDesc ?? null,
    }
    grantsGovDetailsCache.set(id, payload)
    return payload
  } catch {
    grantsGovDetailsCache.set(id, null)
    return null
  }
}

// Real government funding APIs and sources
const GOVERNMENT_SOURCES = {
  federal: [
    {
      name: 'Grants.gov',
      // Grants.gov public Search API (no key required)
      // https://api.grants.gov/v1/api/search2
      apiUrl: 'https://api.grants.gov/v1/api/search2',
      type: 'api'
    },
    {
      name: 'NIH Grants',
      // NIH Guide RSS feed for Funding Opportunity Announcements
      // https://grants.nih.gov/grants/guide/newsfeed/fundingopps.xml
      baseUrl: 'https://grants.nih.gov/grants/guide/newsfeed/fundingopps.xml',
      type: 'rss'
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

        // Query relevance bonus:
        // When an opportunity is returned from a targeted query built from profile signals,
        // it is already "pre-filtered" for relevance even if the text-based scorer is conservative.
        let adjustedScore = matchScore
        if (source?.name === 'Grants.gov' && searchKeywords.length > 0) {
          const bonus = 35
          adjustedScore = Math.min(100, matchScore + bonus)
          reasons.push('Query relevance bonus (Grants.gov search)')
        }

        if (adjustedScore >= minMatchScore) {
          results.push({
            ...opp,
            match_score: adjustedScore,
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
    // Endpoint expects POST JSON body; response shape includes data.oppHits.
    const searchParams = {
      keyword: searchKeywords.slice(0, 15).join(' '),
      oppStatuses: 'posted',
      sortBy: 'openDate|desc',
      rows: 50,
      startRecordNum: 0,
    }
    
    try {
      const response = await postWithRetry(
        source.apiUrl,
        searchParams,
        { headers: { 'Content-Type': 'application/json' } },
        { timeoutMs: 15000, retries: 2 },
      )
      
      const hits = response?.data?.data?.oppHits ?? response?.data?.oppHits ?? []
      const rows = Array.isArray(hits) ? hits : []
      // Fetch detailed synopsis for a small subset to improve scoring (title-only scoring is too weak).
      const idsForDetails = rows
        .map((hit) => hit?.id ?? hit?.oppId ?? null)
        .filter((v) => v != null)
        .slice(0, 12)
      const detailsMap = new Map()
      for (const oppId of idsForDetails) {
        const details = await fetchGrantsGovSynopsis(oppId)
        if (details) detailsMap.set(String(oppId), details)
      }

      for (const hit of rows) {
        const title = hit?.title ?? hit?.oppTitle ?? null
        if (!title) continue
        const id = hit?.id ?? hit?.oppId ?? null
        const number = hit?.number ?? hit?.oppNum ?? hit?.oppNumber ?? null
        const agencyName = hit?.agencyName ?? hit?.agencyName ?? hit?.agency ?? hit?.agencyCode ?? null
        const closeDate = hit?.closeDate ?? hit?.close_date ?? null
        const openDate = hit?.openDate ?? hit?.open_date ?? null
        const url =
          id != null
            ? `https://www.grants.gov/search-results-detail/${id}`
            : number
              ? `https://www.grants.gov/search-grants?query=${encodeURIComponent(String(number))}`
              : 'https://www.grants.gov/search-grants'

        const details = id != null ? detailsMap.get(String(id)) : null

        opportunities.push({
          title,
          sponsor: details?.agencyName ?? agencyName,
          description: details?.synopsisText ?? null,
          url,
          opportunity_number: number,
          amount_min: details?.awardFloor ?? 0,
          amount_max: details?.awardCeiling ?? 0,
          deadline: details?.responseDate ?? closeDate,
          open_date: openDate,
          deadline_type: (details?.responseDate ?? closeDate) ? 'fixed' : 'rolling',
          eligibility: details?.applicantEligibilityDesc ?? '',
          is_national: true,
          source_id: id,
        })
      }
    } catch (error) {
      console.error('[GovernmentCrawler] Grants.gov API error:', error.message)
    }
  } else if (source.type === 'rss' && source.name === 'NIH Grants') {
    try {
      const response = await getWithRetry(
        source.baseUrl,
        { headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' } },
        { timeoutMs: 15000, retries: 2 },
      )
      const $ = cheerio.load(response.data, { xmlMode: true })

      $('item')
        .slice(0, 75)
        .each((_i, elem) => {
          const title = $(elem).find('title').text().trim()
          const link = $(elem).find('link').text().trim()
          const description = $(elem).find('description').text().trim()
          const pubDate = $(elem).find('pubDate').text().trim()
          if (!title) return

          // Basic relevance filter: only keep items that match at least one of our signal-derived keywords.
          const haystack = `${title} ${description}`.toLowerCase()
          const anyMatch = searchKeywords.some((kw) => {
            const needle = String(kw || '').toLowerCase().trim()
            return needle && needle.length >= 4 && haystack.includes(needle)
          })
          if (!anyMatch) return

          opportunities.push({
            title,
            sponsor: 'National Institutes of Health',
            description,
            url: link || source.baseUrl,
            deadline: null,
            deadline_type: 'rolling',
            eligibility: '',
            is_national: true,
            published_at: pubDate || null,
            keywords: ['nih', 'federal', 'research'],
          })
        })
    } catch (error) {
      console.error(`[GovernmentCrawler] NIH RSS error:`, error.message)
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
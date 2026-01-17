/**
 * Local Funding Crawler
 * Searches for funding opportunities within 50 mile radius of profile location
 * Excludes loans and matching funds
 * 
 * CRITICAL: Uses 100% of profile data via signals for search queries and scoring.
 */

import axios from 'axios'
import * as cheerio from 'cheerio'
import zipcodes from 'zipcodes'
import { buildSearchKeywords, calculateMatchScore, filterByDeadline } from './crawlerHelpers.js'
import { extractStudentCampusZip } from '../profileHelpers.js'

// Calculate distance between two coordinates (in miles)
const calculateDistance = (lat1, lng1, lat2, lng2) => {
  const R = 3959 // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
  return R * c
}

const SEARCH_RADIUS_MILES = 50

// Real funding source URLs to crawl
const LOCAL_FUNDING_SOURCES = [
  {
    name: 'Community Foundation Locator',
    baseUrl: 'https://www.cof.org/foundation-locator',
    type: 'community_foundation'
  },
  {
    name: 'United Way',
    baseUrl: 'https://www.unitedway.org/find-your-united-way',
    type: 'united_way'
  },
  {
    name: 'Local Grants Network',
    baseUrl: 'https://www.grants.gov/search-grants',
    params: { locationType: 'local' }
  }
]

export async function crawlLocalFunding(profile, options = {}) {
  const results = []
  const minMatchScore = typeof options.min_match_score === 'number' ? options.min_match_score : 50
  
  // CRITICAL: Use signals for all profile data
  const signals = profile?.signals
  if (!signals) {
    console.error('[LocalFundingCrawler] No signals in profile - cannot search with 100% precision')
    return results
  }

  const studentTypes = new Set(['student', 'high_school_student', 'college_student', 'graduate_student'])
  const applicantTypes = signals?.applicantTypes ? Array.from(signals.applicantTypes) : []
  const isStudent =
    applicantTypes.some((t) => studentTypes.has(String(t))) ||
    studentTypes.has(String(profile?.primary_type || ''))

  // Get ZIP from signals (extracted from all profile sections),
  // but for students prefer the campus/target school ZIP when available.
  const campusZip = extractStudentCampusZip({ sections: profile?.sections ?? signals?.rawSections ?? {}, jobParameters: options })
  const targetZip =
    (isStudent && campusZip) ||
    signals.location?.zip ||
    profile.zip_code ||
    profile.zip ||
    profile.postal_code
  const profileState = signals.location?.state || profile.state
  const profileCity = signals.location?.city || profile.city
  
  if (!targetZip) {
    console.warn('[LocalFundingCrawler] No ZIP code found in profile signals')
    return results
  }

  // Build search keywords from ALL profile signals
  const searchKeywords = buildSearchKeywords(profile, 25)

  console.log(
    `[LocalFundingCrawler] Searching within ${SEARCH_RADIUS_MILES} miles of ${targetZip}` +
      (isStudent && campusZip ? ' (student campus/target ZIP)' : ''),
  )
  console.log(`[LocalFundingCrawler] Location: ${profileCity}, ${profileState} ${targetZip}`)
  console.log(`[LocalFundingCrawler] Using ${searchKeywords.length} keywords from profile signals`)
  console.log(`[LocalFundingCrawler] Keywords: ${searchKeywords.slice(0, 10).join(', ')}...`)
  console.log(`[LocalFundingCrawler] Interests: ${Array.from(signals.interests || []).slice(0, 5).join(', ')}`)
  console.log(`[LocalFundingCrawler] Demographics: ${Array.from(signals.demographics || []).join(', ')}`)

  // Get coordinates for ZIP code
  const coords = await getZipCoordinates(targetZip)
  if (!coords) {
    console.error('[LocalFundingCrawler] Could not get coordinates for ZIP:', targetZip)
    return results
  }

  // Search each source
  for (const source of LOCAL_FUNDING_SOURCES) {
    try {
      const opportunities = await searchLocalSource(source, coords, profile, searchKeywords)
      
      // Filter out expired deadlines
      const activeOpps = filterByDeadline(opportunities)
      
      // Score each opportunity using 100% of profile signals
      for (const opp of activeOpps) {
        // Skip loans and matching funds
        if (isLoanOrMatchingFund(opp)) continue
        
        // Calculate distance if coordinates available
        let distance = null
        if (opp.latitude && opp.longitude) {
          distance = calculateDistance(coords.lat, coords.lng, opp.latitude, opp.longitude)
          if (distance > SEARCH_RADIUS_MILES) continue // Skip if too far
        }
        
        // Use comprehensive scoring with 100% of profile signals
        const { score: matchScore, reasons, matchedSignals } = calculateMatchScore(opp, profile)
        
        // Add distance bonus (closer = better)
        let adjustedScore = matchScore
        if (distance !== null) {
          const distanceBonus = Math.max(0, 10 - Math.floor(distance / 5)) // Up to +10 for nearby
          adjustedScore += distanceBonus
          if (distanceBonus > 0) {
            reasons.push(`Proximity bonus: ${Math.round(distance)} miles away`)
          }
        }
        
        if (adjustedScore >= minMatchScore) {
          results.push({
            ...opp,
            match_score: Math.min(100, adjustedScore),
            match_reasons: reasons,
            matched_signals: matchedSignals,
            distance_miles: distance !== null ? Math.round(distance) : null,
            crawler_type: 'local_funding',
            source: source.name,
            state: opp.state || profileState,
          })
        }
      }
    } catch (error) {
      console.error(`[LocalFundingCrawler] Error searching ${source.name}:`, error.message)
    }
  }

  console.log(`[LocalFundingCrawler] Found ${results.length} local opportunities with ${minMatchScore}%+ match`)
  return results
}

async function searchLocalSource(source, coords, profile, searchKeywords) {
  const opportunities = []
  
  if (source.type === 'community_foundation') {
    try {
      // Search community foundations near coordinates
      const url = `${source.baseUrl}?lat=${coords.lat}&lng=${coords.lng}&radius=50`
      const response = await axios.get(url, { timeout: 10000 })
      const $ = cheerio.load(response.data)
      
      $('.foundation-result').each((i, elem) => {
        const $elem = $(elem)
        opportunities.push({
          title: $elem.find('.foundation-name').text().trim(),
          sponsor: $elem.find('.foundation-org').text().trim(),
          description: $elem.find('.foundation-desc').text().trim(),
          url: $elem.find('a').attr('href'),
          amount_min: parseAmount($elem.find('.grant-range-min').text()),
          amount_max: parseAmount($elem.find('.grant-range-max').text()),
          deadline: $elem.find('.deadline').text().trim(),
          eligibility: $elem.find('.eligibility').text().trim(),
          latitude: parseFloat($elem.data('lat')),
          longitude: parseFloat($elem.data('lng')),
          keywords: ['community foundation', 'local grant'],
        })
      })
    } catch (error) {
      console.error(`[LocalFundingCrawler] Community foundation search error:`, error.message)
    }
  }
  
  // Add more source-specific crawling logic here
  
  return opportunities
}

function isLoanOrMatchingFund(opportunity) {
  const oppType = String(opportunity?.opportunity_type ?? opportunity?.type ?? '').toLowerCase()
  if (['loan', 'loan_program', 'microloan'].includes(oppType)) return true
  if (opportunity?.requires_match === true) return true
  const matchPct = Number(opportunity?.match_percentage)
  if (Number.isFinite(matchPct) && matchPct > 0) return true

  const loanKeywords = ['loan', 'repay', 'interest', 'apr', 'credit']
  const matchingKeywords = ['matching funds', 'match required', '1:1 match', 'dollar for dollar', 'cost share', 'cost-sharing', 'matching requirement']
  
  const text = `${opportunity.title} ${opportunity.description} ${opportunity.eligibility}`.toLowerCase()
  
  return loanKeywords.some(keyword => text.includes(keyword)) ||
         matchingKeywords.some(keyword => text.includes(keyword))
}

async function getZipCoordinates(zip) {
  try {
    // Prefer local dataset to avoid network flakiness and "skipped" ZIP handling.
    const local = zipcodes.lookup(zip)
    if (local) {
      return {
        lat: parseFloat(local.latitude),
        lng: parseFloat(local.longitude),
        city: local.city,
        state: local.state
      }
    }

    // Use a geocoding service or database
    const response = await axios.get(`https://api.zippopotam.us/us/${zip}`, { timeout: 5000 })
    if (response.data && response.data.places && response.data.places[0]) {
      return {
        lat: parseFloat(response.data.places[0].latitude),
        lng: parseFloat(response.data.places[0].longitude),
        city: response.data.places[0]['place name'],
        state: response.data.places[0]['state abbreviation']
      }
    }
  } catch (error) {
    // Previously this threw and surfaced as a 500 at `/api/real-crawlers/run`.
    // Fail gracefully: return null so the caller can stop this crawler without crashing the whole run.
    console.warn('[LocalFundingCrawler] Geocoding failed; returning 0 local results for this run:', error.message)
    return null
  }
  return null
}

function parseAmount(amountStr) {
  if (!amountStr) return 0
  const cleaned = amountStr.replace(/[^0-9]/g, '')
  return parseInt(cleaned) || 0
}

export default { crawlLocalFunding }
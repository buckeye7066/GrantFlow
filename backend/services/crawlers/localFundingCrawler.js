/**
 * Local Funding Crawler
 * Searches for funding opportunities within 50 mile radius of profile location
 * Excludes loans and matching funds
 */

// Use mock data if external dependencies aren't available
let axios, cheerio
try {
  const axiosModule = await import('axios')
  axios = axiosModule.default
  cheerio = await import('cheerio')
} catch (error) {
  console.log('[LocalFundingCrawler] Using mock data (axios/cheerio not installed)')
}

import { mockLocalFunding } from './mockCrawlerData.js'

// Mock calculateDistance if geoUtils doesn't exist
const calculateDistance = (lat1, lng1, lat2, lng2) => {
  // Simple distance calculation
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
  const profileZip = profile.zip || profile.postal_code || profile.location?.zip
  const schoolZip = profile.student_info?.school_zip
  const targetZip = schoolZip || profileZip
  
  if (!targetZip) {
    console.warn('[LocalFundingCrawler] No ZIP code found in profile')
    return results
  }

  console.log(`[LocalFundingCrawler] Searching within ${SEARCH_RADIUS_MILES} miles of ${targetZip}`)

  // Get coordinates for ZIP code
  const coords = await getZipCoordinates(targetZip)
  if (!coords) {
    console.error('[LocalFundingCrawler] Could not get coordinates for ZIP:', targetZip)
    return results
  }

  // Search each source
  for (const source of LOCAL_FUNDING_SOURCES) {
    try {
      const opportunities = await searchLocalSource(source, coords, profile)
      
      // Filter and score each opportunity
      for (const opp of opportunities) {
        // Skip loans and matching funds
        if (isLoanOrMatchingFund(opp)) continue
        
        // Calculate distance
        const distance = calculateDistance(
          coords.lat, coords.lng,
          opp.latitude, opp.longitude
        )
        
        if (distance <= SEARCH_RADIUS_MILES) {
          // Calculate match score
          const matchScore = calculateLocalMatchScore(opp, profile, distance)
          
          if (matchScore >= 80) {
            results.push({
              ...opp,
              match_score: matchScore,
              distance_miles: Math.round(distance),
              crawler_type: 'local_funding',
              source: source.name
            })
          }
        }
      }
    } catch (error) {
      console.error(`[LocalFundingCrawler] Error searching ${source.name}:`, error.message)
    }
  }

  console.log(`[LocalFundingCrawler] Found ${results.length} local opportunities with 80%+ match`)
  return results
}

async function searchLocalSource(source, coords, profile) {
  const opportunities = []
  
  // Use mock data if axios/cheerio not available
  if (!axios || !cheerio) {
    return mockLocalFunding.map(opp => ({
      ...opp,
      latitude: opp.latitude || coords.lat,
      longitude: opp.longitude || coords.lng
    }))
  }
  
  if (source.type === 'community_foundation') {
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
        longitude: parseFloat($elem.data('lng'))
      })
    })
  }
  
  // Add more source-specific crawling logic here
  
  return opportunities
}

function calculateLocalMatchScore(opportunity, profile, distance) {
  let score = 100 // Start with 100%
  
  // Distance factor (closer = higher score)
  const distanceScore = Math.max(0, 100 - (distance * 2)) // -2% per mile
  score = (score * 0.3) + (distanceScore * 0.3) // 30% weight for distance
  
  // Profile type match
  if (matchesProfileType(opportunity, profile)) {
    score += 20
  }
  
  // Focus area match
  if (matchesFocusArea(opportunity, profile)) {
    score += 20
  }
  
  // Eligibility match
  if (matchesEligibility(opportunity, profile)) {
    score += 20
  }
  
  return Math.min(100, Math.round(score))
}

function isLoanOrMatchingFund(opportunity) {
  const loanKeywords = ['loan', 'repay', 'interest', 'apr', 'credit']
  const matchingKeywords = ['matching funds', 'match required', '1:1 match', 'dollar for dollar']
  
  const text = `${opportunity.title} ${opportunity.description} ${opportunity.eligibility}`.toLowerCase()
  
  return loanKeywords.some(keyword => text.includes(keyword)) ||
         matchingKeywords.some(keyword => text.includes(keyword))
}

function matchesProfileType(opportunity, profile) {
  const profileType = profile.organization_type || profile.profile_type
  const oppText = `${opportunity.eligibility} ${opportunity.description}`.toLowerCase()
  
  const typeMap = {
    'nonprofit': ['501c3', '501(c)(3)', 'nonprofit', 'non-profit'],
    'individual': ['individual', 'personal', 'resident'],
    'student': ['student', 'education', 'academic'],
    'business': ['business', 'company', 'enterprise']
  }
  
  const keywords = typeMap[profileType?.toLowerCase()] || []
  return keywords.some(keyword => oppText.includes(keyword))
}

function matchesFocusArea(opportunity, profile) {
  const focusAreas = profile.focus_areas || profile.interests || []
  const oppText = `${opportunity.title} ${opportunity.description}`.toLowerCase()
  
  return focusAreas.some(area => 
    oppText.includes(area.toLowerCase())
  )
}

function matchesEligibility(opportunity, profile) {
  // Complex eligibility matching logic
  return true // Simplified for now
}

async function getZipCoordinates(zip) {
  try {
    // Use a geocoding service or database
    const response = await axios.get(`https://api.zippopotam.us/us/${zip}`)
    if (response.data && response.data.places && response.data.places[0]) {
      return {
        lat: parseFloat(response.data.places[0].latitude),
        lng: parseFloat(response.data.places[0].longitude),
        city: response.data.places[0]['place name'],
        state: response.data.places[0]['state abbreviation']
      }
    }
  } catch (error) {
    console.error('[LocalFundingCrawler] Geocoding error:', error.message)
  }
  return null
}

function parseAmount(amountStr) {
  if (!amountStr) return 0
  const cleaned = amountStr.replace(/[^0-9]/g, '')
  return parseInt(cleaned) || 0
}

export default { crawlLocalFunding }
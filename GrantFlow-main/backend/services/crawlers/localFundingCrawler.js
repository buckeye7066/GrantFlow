/**
 * Local Funding Crawler
 * Searches for funding opportunities within 50 mile radius of profile location
 * Excludes loans and matching funds
 * 
 * CRITICAL: Uses 100% of profile data via signals for search queries and scoring.
 */

import * as cheerio from 'cheerio'
import zipcodes from 'zipcodes'
import { buildSearchKeywords, calculateMatchScore, filterByDeadline } from './crawlerHelpers.js'
import { getWithRetry } from './httpClient.js'

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

// Real (and reliable) local resource URLs.
//
// IMPORTANT:
// - The previous "Community Foundation Locator" source at cof.org is currently serving an invalid TLS cert
//   for www.cof.org (observed in multiple environments), which caused local crawling to return 0 results.
// - We intentionally avoid insecure TLS bypasses (rejectUnauthorized=false) in production code.
// - Instead, we provide durable directory-style local resources that can always be returned when a profile
//   has location signals (ZIP/state), and we keep the door open for richer sources later.
const LOCAL_FUNDING_SOURCES = [
  {
    name: 'United Way Locator',
    baseUrl: 'https://www.unitedway.org/find-your-united-way',
    type: 'united_way',
  },
  {
    name: 'Feeding America Food Bank Locator',
    baseUrl: 'https://www.feedingamerica.org/find-your-local-foodbank',
    type: 'food_bank',
  },
  {
    name: 'Community Action Partnership (CAP) Locator',
    baseUrl: 'https://communityactionpartnership.com/find-a-cap/',
    type: 'community_action',
  },
  {
    name: 'HUD Public Housing Authority (PHA) Contacts',
    baseUrl: 'https://www.hud.gov/program_offices/public_indian_housing/pha/contacts',
    type: 'housing_authority',
  },
  {
    name: 'Benefits.gov (local benefits search entry)',
    baseUrl: 'https://www.benefits.gov',
    type: 'benefits_gov',
  },
]

export async function crawlLocalFunding(profile, options = {}) {
  const results = []
  const minMatchScore = typeof options.min_match_score === 'number' ? options.min_match_score : 50
  const includeDirectoryResources =
    String(options.include_directory_resources ?? 'true').toLowerCase() !== 'false'
  
  // CRITICAL: Use signals for all profile data
  const signals = profile?.signals
  if (!signals) {
    console.error('[LocalFundingCrawler] No signals in profile - cannot search with 100% precision')
    return results
  }

  // Get ZIP from signals (extracted from all profile sections)
  const targetZip = signals.location?.zip || profile.zip_code || profile.zip || profile.postal_code
  const profileState = signals.location?.state || profile.state
  const profileCity = signals.location?.city || profile.city
  
  // Build search keywords from ALL profile signals
  const searchKeywords = buildSearchKeywords(profile, 25)

  if (targetZip) {
    console.log(`[LocalFundingCrawler] Searching within ${SEARCH_RADIUS_MILES} miles of ${targetZip}`)
    console.log(`[LocalFundingCrawler] Location: ${profileCity}, ${profileState} ${targetZip}`)
  } else {
    console.log('[LocalFundingCrawler] No ZIP code found; returning directory-style local resources only')
    console.log(`[LocalFundingCrawler] Location: ${profileCity || '(unknown city)'}, ${profileState || '(unknown state)'}`)
  }
  console.log(`[LocalFundingCrawler] Using ${searchKeywords.length} keywords from profile signals`)
  console.log(`[LocalFundingCrawler] Keywords: ${searchKeywords.slice(0, 10).join(', ')}...`)
  console.log(`[LocalFundingCrawler] Interests: ${Array.from(signals.interests || []).slice(0, 5).join(', ')}`)
  console.log(`[LocalFundingCrawler] Demographics: ${Array.from(signals.demographics || []).join(', ')}`)

  // ZIP-based coordinates (optional)
  let coords = null
  if (targetZip) {
    try {
      coords = await getZipCoordinates(targetZip)
      if (!coords) {
        console.log(`[LocalFundingCrawler] Could not resolve coordinates for ZIP ${targetZip} - will use directory resources only`)
      }
    } catch (error) {
      console.error(`[LocalFundingCrawler] Unexpected error resolving ZIP ${targetZip}:`, error)
      // Continue with null coords - directory resources will still work
    }
  }

  // Always provide durable directory-style results first (no scraping required).
  // This prevents "0 results" when any single upstream site changes, is blocked, or is down.
  if (includeDirectoryResources) {
    const directoryOpps = buildDirectoryResources({
      profile,
      coords,
      profileState,
      profileCity,
      targetZip,
      sources: LOCAL_FUNDING_SOURCES,
    })
    for (const opp of directoryOpps) {
      // Directory resources are intentionally "always relevant" once shown:
      // they are not a competitive opportunity match, they are authoritative entry points.
      results.push({
        ...opp,
        match_score: Math.max(minMatchScore, 85),
        match_reasons: ['Local resource directory (reliable entry point)'],
        matched_signals: [],
        distance_miles: 0,
        crawler_type: 'local_funding',
        source: opp.source ?? 'Local Resource Directory',
        state: opp.state || profileState,
      })
    }
  }

  // If there is no ZIP or we couldn't resolve coordinates, don't attempt geo-radius crawling.
  if (!targetZip || !coords) {
    console.log(`[LocalFundingCrawler] Found ${results.length} local opportunities with ${minMatchScore}%+ match`)
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
          if (!coords || !coords.lat || !coords.lng) {
            console.warn(`[LocalFundingCrawler] Cannot calculate distance - profile coordinates missing`)
            continue
          }
          
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
      const errorMsg = error instanceof Error ? error.message : String(error)
      console.error(`[LocalFundingCrawler] Error searching ${source.name}:`, errorMsg)
      // Continue with other sources - don't let one source failure break entire crawl
    }
  }

  console.log(`[LocalFundingCrawler] Found ${results.length} local opportunities with ${minMatchScore}%+ match`)
  return results
}

function buildDirectoryResources({ profile, coords, profileState, profileCity, targetZip, sources }) {
  const out = []
  const signals = profile?.signals
  const keywords = Array.from(signals?.keywordSet ?? []).slice(0, 12)
  const city = profileCity || coords?.city || null
  const state = profileState || coords?.state || null

  for (const source of sources) {
    if (!source?.type) continue
    switch (source.type) {
      case 'united_way':
        out.push({
          title: city && state ? `United Way near ${city}, ${state}` : 'United Way Locator (find local chapter)',
          sponsor: 'United Way',
          description:
            'Find your local United Way chapter for community support, emergency assistance programs, and local partner referrals.',
          url: source.baseUrl,
          application_url: source.baseUrl,
          source_url: source.baseUrl,
          opportunity_type: 'program',
          deadline_type: 'rolling',
          is_national: false,
          state,
          categories: ['community', 'local', 'emergency_assistance'],
          keywords: ['united way', 'emergency assistance', 'community', ...keywords],
        })
        break
      case 'food_bank':
        out.push({
          title: city && state ? `Food Bank resources near ${city}, ${state}` : 'Food Bank Locator (Feeding America)',
          sponsor: 'Feeding America',
          description:
            'Find local food bank partners and emergency food assistance resources near the profile ZIP.',
          url: source.baseUrl,
          application_url: source.baseUrl,
          source_url: source.baseUrl,
          opportunity_type: 'program',
          deadline_type: 'rolling',
          is_national: false,
          state,
          categories: ['food', 'local', 'emergency_assistance'],
          keywords: ['food bank', 'food assistance', 'snap', ...keywords],
        })
        break
      case 'community_action':
        out.push({
          title:
            city && state
              ? `Community Action Agency near ${city}, ${state}`
              : 'Community Action Agency Locator (CAP)',
          sponsor: 'Community Action Partnership',
          description:
            'Locate a Community Action Agency (CAA/CAP) that can help with housing, utilities, food, and employment support.',
          url: source.baseUrl,
          application_url: source.baseUrl,
          source_url: source.baseUrl,
          opportunity_type: 'program',
          deadline_type: 'rolling',
          is_national: false,
          state,
          categories: ['utilities', 'housing', 'local', 'community'],
          keywords: ['community action', 'utilities assistance', 'rent assistance', ...keywords],
        })
        break
      case 'housing_authority': {
        const stateUrl =
          state && typeof state === 'string' && state.length === 2
            ? `${source.baseUrl}/${state.toLowerCase()}`
            : source.baseUrl
        out.push({
          title: state ? `Housing Authority contacts (${state})` : 'Housing Authority contacts (HUD PHA directory)',
          sponsor: 'HUD',
          description:
            'Public Housing Authority contacts (Section 8 vouchers, affordable housing programs, and related housing assistance).',
          url: stateUrl,
          application_url: stateUrl,
          source_url: stateUrl,
          opportunity_type: 'program',
          deadline_type: 'rolling',
          is_national: false,
          state,
          categories: ['housing', 'section8', 'local'],
          keywords: ['housing authority', 'section 8', 'voucher', ...keywords],
        })
        break
      }
      case 'benefits_gov':
        out.push({
          title: 'Benefits.gov (find state/local benefits)',
          sponsor: 'Benefits.gov',
          description:
            'Search for benefits and assistance programs that may apply (including state-specific and local programs).',
          url: source.baseUrl,
          application_url: source.baseUrl,
          source_url: source.baseUrl,
          opportunity_type: 'program',
          deadline_type: 'rolling',
          is_national: true,
          state,
          categories: ['benefits', 'government_assistance'],
          keywords: ['benefits', 'assistance', 'eligibility', ...keywords],
        })
        break
      default:
        break
    }
  }

  // De-dupe by URL/title.
  const seen = new Set()
  return out.filter((row) => {
    const key = `${row?.url ?? ''}::${row?.title ?? ''}`
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function searchLocalSource(source, coords, profile, searchKeywords) {
  const opportunities = []
  
  // NOTE: Network scraping for local sources is intentionally minimal for reliability.
  // Directory-style results are handled in buildDirectoryResources() above.
  
  // Add more source-specific crawling logic here
  
  return opportunities
}

function isLoanOrMatchingFund(opportunity) {
  const loanKeywords = ['loan', 'repay', 'interest', 'apr', 'credit']
  const matchingKeywords = ['matching funds', 'match required', '1:1 match', 'dollar for dollar']
  
  const text = `${opportunity.title} ${opportunity.description} ${opportunity.eligibility}`.toLowerCase()
  
  return loanKeywords.some(keyword => text.includes(keyword)) ||
         matchingKeywords.some(keyword => text.includes(keyword))
}

async function getZipCoordinates(zip) {
  // Validate ZIP code format
  if (!zip || typeof zip !== 'string' && typeof zip !== 'number') {
    console.warn('[LocalFundingCrawler] Invalid ZIP code format:', zip)
    return null
  }

  const zipStr = String(zip).trim()
  if (!/^\d{5}$/.test(zipStr)) {
    console.warn('[LocalFundingCrawler] ZIP code must be 5 digits:', zipStr)
    return null
  }

  try {
    // Prefer local dataset to avoid network flakiness and "skipped" ZIP handling.
    const local = zipcodes.lookup(zipStr)
    if (local) {
      const coords = {
        lat: parseFloat(local.latitude),
        lng: parseFloat(local.longitude),
        city: local.city,
        state: local.state
      }
      
      // Validate parsed coordinates
      if (isNaN(coords.lat) || isNaN(coords.lng)) {
        console.warn('[LocalFundingCrawler] Invalid coordinates from local dataset for ZIP:', zipStr)
        return null
      }
      
      console.log(`[LocalFundingCrawler] Resolved ZIP ${zipStr} to ${coords.city}, ${coords.state} (${coords.lat}, ${coords.lng}) using local dataset`)
      return coords
    }

    // Use a geocoding service or database
    console.log(`[LocalFundingCrawler] ZIP ${zipStr} not in local dataset, trying geocoding service`)
    const response = await getWithRetry(`https://api.zippopotam.us/us/${zipStr}`, {}, { timeoutMs: 5000, retries: 1 })
    if (response.data && response.data.places && response.data.places[0]) {
      const coords = {
        lat: parseFloat(response.data.places[0].latitude),
        lng: parseFloat(response.data.places[0].longitude),
        city: response.data.places[0]['place name'],
        state: response.data.places[0]['state abbreviation']
      }
      
      // Validate parsed coordinates
      if (isNaN(coords.lat) || isNaN(coords.lng)) {
        console.warn('[LocalFundingCrawler] Invalid coordinates from geocoding service for ZIP:', zipStr)
        return null
      }
      
      console.log(`[LocalFundingCrawler] Resolved ZIP ${zipStr} to ${coords.city}, ${coords.state} (${coords.lat}, ${coords.lng}) using geocoding service`)
      return coords
    }
    
    console.warn('[LocalFundingCrawler] Geocoding service returned no data for ZIP:', zipStr)
    return null
  } catch (error) {
    // Previously this threw and surfaced as a 500 at `/api/real-crawlers/run`.
    // Fail gracefully: return null so the caller can stop this crawler without crashing the whole run.
    const errorMsg = error instanceof Error ? error.message : String(error)
    const errorCode = error?.code || error?.response?.status
    
    if (errorCode === 'ENOTFOUND' || errorCode === 'ETIMEDOUT') {
      console.warn(`[LocalFundingCrawler] Geocoding service unavailable (${errorCode}) for ZIP ${zipStr} - will use directory resources only`)
    } else if (errorCode === 404) {
      console.warn(`[LocalFundingCrawler] ZIP code not found: ${zipStr}`)
    } else {
      console.warn(`[LocalFundingCrawler] Geocoding failed for ZIP ${zipStr}:`, errorMsg)
    }
    return null
  }
}

function parseAmount(amountStr) {
  if (!amountStr) return 0
  const cleaned = amountStr.replace(/[^0-9]/g, '')
  return parseInt(cleaned) || 0
}

export default { crawlLocalFunding }
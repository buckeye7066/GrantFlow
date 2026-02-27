/**
 * Local Funding Crawler
 * Searches for funding opportunities within 25 mile radius of profile location
 * Excludes loans and matching funds
 * 
 * CRITICAL: Uses 100% of profile data via signals for search queries and scoring.
 */

import * as cheerio from 'cheerio'
import zipcodes from 'zipcodes'
import { buildSearchKeywords, calculateMatchScore, filterByDeadline } from './crawlerHelpers.js'
import { getWithRetry } from './httpClient.js'
import { planCrawlerQueries } from './queryPlanner.js'
import {
  resolveCrawlerContext,
  mergePlanKeywords,
  enforceCrawlerOpportunityContract,
} from './crawlerOpportunityContract.js'

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

const DEFAULT_SEARCH_RADIUS_MILES = 25

const STATE_NAME_TO_ABBREV_LOCAL = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
  ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV',
  wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC',
}

function normalizeStateAbbrev(value) {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (!raw) return null
  const upper = raw.toUpperCase().replace(/[^A-Z]/g, '')
  if (upper.length === 2) return upper
  return STATE_NAME_TO_ABBREV_LOCAL[raw.toLowerCase()] ?? null
}

function normalizeZip(value) {
  if (value === null || value === undefined) return null
  const s = String(value).trim()
  const match = s.match(/(\d{5})/)
  return match ? match[1] : null
}

function extractInterestedSchoolZips(profile) {
  const out = []
  const sections = profile?.sections ?? {}
  const signals = profile?.signals ?? null

  // Only add these anchors for student profiles (or profiles that have explicit university applications).
  const applicantTypes = signals?.applicantTypes ? Array.from(signals.applicantTypes) : []
  const isStudent =
    applicantTypes.some((t) => String(t || '').toLowerCase().includes('student')) ||
    Boolean(signals?.academics?.gpa || signals?.academics?.sat || signals?.academics?.act)

  const applications = Array.isArray(sections?.university_applications?.applications)
    ? sections.university_applications.applications
    : []

  if (!isStudent && applications.length === 0) return []

  for (const app of applications) {
    if (!app || typeof app !== 'object') continue
    const candidates = [
      app.school_zip,
      app.zip,
      app.zip_code,
      app.postal_code,
      app.campus_zip,
      app.campus_zip_code,
    ]
    for (const c of candidates) {
      const z = normalizeZip(c)
      if (z) out.push(z)
    }
    // Also scan any location-ish strings
    const locationText = [app.location, app.address, app.city_state_zip, app.campus_location]
      .filter(Boolean)
      .map((v) => String(v))
      .join(' ')
    const z2 = normalizeZip(locationText)
    if (z2) out.push(z2)
  }

  // Some profiles may store interested schools in education section with optional zip fields.
  const education = sections?.education ?? {}
  const interested = Array.isArray(education?.interested_schools) ? education.interested_schools : []
  for (const entry of interested) {
    if (!entry) continue
    if (typeof entry === 'string') {
      const z = normalizeZip(entry)
      if (z) out.push(z)
      continue
    }
    if (typeof entry === 'object') {
      const z = normalizeZip(entry.zip || entry.zip_code || entry.postal_code || entry.school_zip)
      if (z) out.push(z)
      const z2 = normalizeZip(entry.location || entry.address || '')
      if (z2) out.push(z2)
    }
  }

  // De-dupe while preserving order.
  const seen = new Set()
  return out.filter((z) => {
    if (!z) return false
    if (seen.has(z)) return false
    seen.add(z)
    return true
  })
}

function minDistanceToAnchors({ anchors, latitude, longitude }) {
  if (!Array.isArray(anchors) || anchors.length === 0) return { distance: null, anchorZip: null }
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return { distance: null, anchorZip: null }

  let best = { distance: null, anchorZip: null }
  for (const a of anchors) {
    if (!a?.coords?.lat || !a?.coords?.lng) continue
    const d = calculateDistance(a.coords.lat, a.coords.lng, latitude, longitude)
    if (best.distance === null || d < best.distance) {
      best = { distance: d, anchorZip: a.zip }
    }
  }
  return best
}

// Real (and reliable) local resource URLs.
//
// NOTE: Use community-foundation-locator (not foundation-locator); the latter had invalid TLS.
// Directory-style links only—no scraping—so TLS on user click is acceptable.
const LOCAL_FUNDING_SOURCES = [
  {
    name: 'Community Foundation Locator',
    baseUrl: 'https://www.cof.org/community-foundation-locator',
    type: 'community_foundation',
  },
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

function finalizeLocalResults(rows, { facets, queryPlan }) {
  return rows
    .map((row) =>
      enforceCrawlerOpportunityContract(row, {
        crawlerType: 'local_funding',
        facets,
        queryPlan,
        sourceFallback: row?.source ?? 'Local Funding',
      }),
    )
    .filter(Boolean)
}

export async function crawlLocalFunding(profileInput, options = {}) {
  const { profile, signals, facets, queryPlan: queryPlanFromContext } = resolveCrawlerContext(profileInput, options)
  const queryPlan =
    queryPlanFromContext ??
    planCrawlerQueries({
      crawlerType: 'local_funding',
      facets,
      location: facets?.geo ?? signals?.location ?? {},
    })
  const results = []
  const minMatchScore = typeof options.min_match_score === 'number' ? options.min_match_score : 60
  // Product rule: local crawler radius is always exactly 25 miles — not caller-overridable.
  const radiusMiles = DEFAULT_SEARCH_RADIUS_MILES
  const includeDirectoryResources =
    String(options.include_directory_resources ?? 'true').toLowerCase() !== 'false'

  // Validate profile
  if (!profile || typeof profile !== 'object') {
    console.error('[LocalFundingCrawler] Invalid profile: profile must be a non-null object')
    return results
  }
  // Build minimal signals from profile when missing (null/undefined must not disqualify)
  const sections = profile?.sections ?? {}
  const basicInfo = sections?.basic_information ?? {}
  const locationFocus = sections?.location_focus ?? {}
  const effectiveSignals = profile?.signals ?? {
    location: {
      zip: basicInfo?.zip_code || basicInfo?.postal_code || profile?.zip_code || profile?.zip || profile?.postal_code || null,
      state: normalizeStateAbbrev(basicInfo?.state || locationFocus?.state || profile?.state) || null,
      city: basicInfo?.city || locationFocus?.city || profile?.city || null,
    },
    keywordSet: new Set(),
    interests: new Set(),
    demographics: new Set(),
  }

  // Build location with multi-level fallback. Profile top-level (from DB) is authoritative when present.
  const sectionZip = basicInfo?.zip_code || basicInfo?.postal_code || basicInfo?.zip
  const sectionState = normalizeStateAbbrev(basicInfo?.state || locationFocus?.state || locationFocus?.primary_state)
  const sectionCity = basicInfo?.city || locationFocus?.city
  const targetZipRaw = normalizeZip(
    profile.zip_code || profile.zip || profile.postal_code || effectiveSignals?.location?.zip || sectionZip
  )
  const profileState =
    normalizeStateAbbrev(profile.state) ||
    effectiveSignals?.location?.state ||
    sectionState ||
    null
  const profileCity =
    (profile.city && String(profile.city).trim()) ||
    effectiveSignals?.location?.city ||
    sectionCity ||
    null

  if (!targetZipRaw && !profileState) {
    console.warn('[LocalFundingCrawler] No ZIP or state in profile - returning directory resources only. Add location (ZIP or state) for better local matches.')
  } else if (targetZipRaw && !/^\d{5}$/.test(targetZipRaw)) {
    console.warn('[LocalFundingCrawler] Invalid ZIP format (expected 5 digits):', targetZipRaw)
  }
  console.log('[LocalFundingCrawler] Location resolution:', `city=${profileCity}, state=${profileState}, zip=${targetZipRaw}`)

  const targetZip = targetZipRaw

  // Ensure profile has signals for buildSearchKeywords (uses fallback when missing)
  const profileForKeywords = profile.signals ? profile : { ...profile, signals: effectiveSignals }

  // Build search keywords from ALL profile signals
  const searchKeywords = mergePlanKeywords(buildSearchKeywords(profileForKeywords, 25), queryPlan).slice(0, 35)
  const schoolZips = extractInterestedSchoolZips(profile)

  // Anchor ZIPs: profile ZIP + up to 3 interested-school ZIPs (student profiles).
  const anchorZips = [targetZip, ...schoolZips].filter(Boolean)
  const anchorZipLimit = typeof options.anchor_zip_limit === 'number' ? options.anchor_zip_limit : 4
  const limitedAnchorZips = anchorZips.slice(0, Math.max(1, anchorZipLimit))

  if (targetZip) {
    console.log(
      `[LocalFundingCrawler] Searching within ${radiusMiles} miles of ZIP anchors: ${limitedAnchorZips.join(', ')}`,
    )
    console.log(`[LocalFundingCrawler] Primary location: ${profileCity}, ${profileState} ${targetZip}`)
  } else {
    console.log('[LocalFundingCrawler] No ZIP code found; returning directory-style local resources only')
    console.log(`[LocalFundingCrawler] Location: ${profileCity || '(unknown city)'}, ${profileState || '(unknown state)'}`)
  }
  console.log(`[LocalFundingCrawler] Using ${searchKeywords.length} keywords from profile signals`)
  console.log(`[LocalFundingCrawler] Keywords: ${searchKeywords.slice(0, 10).join(', ')}...`)
  console.log(`[LocalFundingCrawler] Interests: ${Array.from(effectiveSignals.interests || []).slice(0, 5).join(', ')}`)
  console.log(`[LocalFundingCrawler] Demographics: ${Array.from(effectiveSignals.demographics || []).join(', ')}`)
  if (schoolZips.length > 0) {
    console.log(
      `[LocalFundingCrawler] Student school ZIP anchors (interested schools): ${schoolZips.slice(0, 8).join(', ')}${
        schoolZips.length > 8 ? '…' : ''
      }`,
    )
  }

  // ZIP-based coordinates for each anchor ZIP (optional)
  const anchors = []
  for (const zip of limitedAnchorZips) {
    try {
      const coords = await getZipCoordinates(zip)
      if (!coords) {
        console.log(`[LocalFundingCrawler] Could not resolve coordinates for ZIP ${zip}`)
        continue
      }
      anchors.push({
        zip,
        coords,
        kind: zip === targetZip ? 'profile' : 'school',
      })
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      console.error(`[LocalFundingCrawler] Unexpected error resolving ZIP ${zip}:`, errMsg)
      if (error instanceof Error && error.stack) {
        console.error(`[LocalFundingCrawler] ZIP resolution stack:\n`, error.stack)
      }
    }
  }

  // Always provide durable directory-style results first (no scraping required).
  // This prevents "0 results" when any single upstream site changes, is blocked, or is down.
  if (includeDirectoryResources) {
    const directoryOpps = buildDirectoryResources({
      profile,
      anchors,
      profileState,
      profileCity,
      targetZip,
      sources: LOCAL_FUNDING_SOURCES,
      facets,
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
        distance_anchor_zip: opp.local_anchor_zip ?? targetZip ?? null,
        crawler_type: 'local_funding',
        source: opp.source ?? 'Local Resource Directory',
        state: opp.state || profileState,
      })
    }
  }

  // If there is no ZIP or we couldn't resolve any coordinates, don't attempt geo-radius crawling.
  if (!targetZip || anchors.length === 0) {
    console.log(`[LocalFundingCrawler] Found ${results.length} local opportunities with ${minMatchScore}%+ match`)
    return finalizeLocalResults(results, { facets, queryPlan })
  }

  // Search each source
  for (const source of LOCAL_FUNDING_SOURCES) {
    try {
      const opportunities = []
      // Run geo searches for each anchor (profile ZIP + interested-school ZIPs)
      for (const anchor of anchors) {
        const fromAnchor = await searchLocalSource(source, anchor.coords, profile, searchKeywords, {
          anchor_zip: anchor.zip,
          anchor_kind: anchor.kind,
          radius_miles: radiusMiles,
        })
        for (const o of fromAnchor) opportunities.push(o)
      }
      
      // Filter out expired deadlines
      const activeOpps = filterByDeadline(opportunities)
      
      // Score each opportunity using 100% of profile signals
      for (const opp of activeOpps) {
        // Skip loans and matching funds
        if (isLoanOrMatchingFund(opp)) continue
        
        // Calculate minimum distance to any anchor (profile ZIP or interested-school ZIPs).
        let distance = null
        let distanceAnchorZip = null
        if (typeof opp.latitude === 'number' && typeof opp.longitude === 'number') {
          const best = minDistanceToAnchors({ anchors, latitude: opp.latitude, longitude: opp.longitude })
          distance = best.distance
          distanceAnchorZip = best.anchorZip
          if (distance !== null && distance > radiusMiles) continue // Hard radius gate
        } else if (opp.zip || opp.zip_code || opp.postal_code) {
          // If the opportunity has a ZIP but no coordinates, use ZIP distance (in miles) when possible.
          const oppZip = normalizeZip(opp.zip || opp.zip_code || opp.postal_code)
          if (oppZip) {
            let best = { distance: null, anchorZip: null }
            for (const a of anchors) {
              try {
                const d = zipcodes.distance(String(a.zip), String(oppZip))
                if (typeof d === 'number' && (best.distance === null || d < best.distance)) {
                  best = { distance: d, anchorZip: a.zip }
                }
              } catch {
                // Ignore; fallback to other anchors.
              }
            }
            distance = best.distance
            distanceAnchorZip = best.anchorZip
            if (distance !== null && distance > radiusMiles) continue // Hard radius gate
          }
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
            distance_anchor_zip: distanceAnchorZip,
            crawler_type: 'local_funding',
            source: source.name,
            state: opp.state || profileState,
          })
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      console.error(`[LocalFundingCrawler] Error searching ${source.name} (${source.baseUrl}):`, errorMsg)
      if (error instanceof Error && error.stack) {
        console.error(`[LocalFundingCrawler] Source ${source.name} stack:\n`, error.stack)
      }
      // Continue with other sources - don't let one source failure break entire crawl
    }
  }

  console.log(`[LocalFundingCrawler] Found ${results.length} local opportunities with ${minMatchScore}%+ match`)
  return finalizeLocalResults(results, { facets, queryPlan })
}

function buildDirectoryResources({ profile, anchors, profileState, profileCity, targetZip, sources, facets = {} }) {
  const out = []

  const signals = profile?.signals
  // Detect business-oriented profiles to suppress irrelevant assistance resources
  const profileText = [
    ...Array.from(signals?.interests || []),
    ...Array.from(signals?.keywordSet || []),
    ...(signals?.applicantTypes ? Array.from(signals.applicantTypes) : []),
  ].join(' ').toLowerCase();
  const isBusinessProfile =
    String(facets?.intent?.primary_need_category || '') === 'business_startup' ||
    /food\s*truck|small\s*business|startup|entrepreneur|business\s*funding|mobile\s*food|food\s*vendor|catering\s*business/.test(
      profileText,
    )
  const keywords = Array.from(signals?.keywordSet ?? []).slice(0, 12)
  const anchorList = Array.isArray(anchors) && anchors.length > 0 ? anchors : []
  const fallbackCity = profileCity || null
  const fallbackState = profileState || null
  // Always include at least one anchor so directory resources (Benefits.gov, United Way, etc.) are returned
  // even when profile has no ZIP/state/city (per rule: directory-style resources must survive).
  const fallbackAnchor = {
    zip: targetZip ?? null,
    coords: { city: fallbackCity, state: fallbackState },
    kind: 'profile',
  }
  const effectiveAnchors =
    anchorList.length > 0
      ? anchorList
      : fallbackAnchor.zip || fallbackAnchor.coords?.city || fallbackAnchor.coords?.state
        ? [fallbackAnchor]
        : [fallbackAnchor] // No location: still emit one anchor so we return national/state-agnostic directory entries

  for (const anchor of effectiveAnchors) {
    const city = anchor?.coords?.city || fallbackCity || null
    const state = anchor?.coords?.state || fallbackState || null
    const anchorLabel =
      anchor?.kind === 'school'
        ? city && state
          ? `Interested school area: ${city}, ${state}`
          : anchor?.zip
          ? `Interested school ZIP ${anchor.zip}`
          : 'Interested school area'
        : city && state
        ? `${city}, ${state}`
        : anchor?.zip
        ? `ZIP ${anchor.zip}`
        : 'Profile area'

    for (const source of sources) {
      if (!source?.type) continue
      switch (source.type) {
        case 'united_way':
          out.push({
            title: city && state ? `United Way near ${city}, ${state}` : `United Way Locator (${anchorLabel})`,
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
            local_anchor_zip: anchor?.zip ?? null,
            local_anchor_kind: anchor?.kind ?? null,
          })
          break
        case 'food_bank':
          if (isBusinessProfile) break; // Skip food bank for business profiles
          out.push({
            title: city && state ? `Food Bank resources near ${city}, ${state}` : `Food Bank Locator (${anchorLabel})`,
            sponsor: 'Feeding America',
            description:
              'Find local food bank partners and emergency food assistance resources near the selected ZIP anchor.',
            url: source.baseUrl,
            application_url: source.baseUrl,
            source_url: source.baseUrl,
            opportunity_type: 'program',
            deadline_type: 'rolling',
            is_national: false,
            state,
            categories: ['food', 'local', 'emergency_assistance'],
            keywords: ['food bank', 'food assistance', 'snap', ...keywords],
            local_anchor_zip: anchor?.zip ?? null,
            local_anchor_kind: anchor?.kind ?? null,
          })
          break
        case 'community_action':
          out.push({
            title:
              city && state
                ? `Community Action Agency near ${city}, ${state}`
                : `Community Action Agency Locator (${anchorLabel})`,
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
            local_anchor_zip: anchor?.zip ?? null,
            local_anchor_kind: anchor?.kind ?? null,
          })
          break
        case 'community_foundation':
          out.push({
            title:
              city && state
                ? `Community Foundation Locator near ${city}, ${state}`
                : `Community Foundation Locator (${anchorLabel})`,
            sponsor: 'Council on Foundations',
            description:
              'Find community foundations in your area. Search by state or use the map to locate accredited foundations.',
            url: state
              ? `${source.baseUrl}?state=${encodeURIComponent(state)}`
              : source.baseUrl,
            application_url: state
              ? `${source.baseUrl}?state=${encodeURIComponent(state)}`
              : source.baseUrl,
            source_url: source.baseUrl,
            opportunity_type: 'program',
            deadline_type: 'rolling',
            is_national: false,
            state,
            categories: ['foundation', 'philanthropy', 'local', 'community'],
            keywords: ['community foundation', 'philanthropy', 'foundation locator', ...keywords],
            local_anchor_zip: anchor?.zip ?? null,
            local_anchor_kind: anchor?.kind ?? null,
          })
          break
        case 'housing_authority': {
          const stateUrl =
            state && typeof state === 'string' && state.length === 2
              ? `${source.baseUrl}/${state.toLowerCase()}`
              : source.baseUrl
          out.push({
            title: state ? `Housing Authority contacts (${state})` : `Housing Authority contacts (${anchorLabel})`,
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
            local_anchor_zip: anchor?.zip ?? null,
            local_anchor_kind: anchor?.kind ?? null,
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
            local_anchor_zip: anchor?.zip ?? null,
            local_anchor_kind: anchor?.kind ?? null,
          })
          break
        default:
          break
      }
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

async function searchLocalSource(source, coords, profile, searchKeywords, meta = {}) {
  const opportunities = []
  const anchorZip = meta?.anchor_zip ?? null
  const profileState = coords?.state ?? null
  const profileCity = coords?.city ?? null
  const signals = profile?.signals ?? {}

  try {
    switch (source.type) {
      case 'benefits_gov': {
        // Benefits.gov eligibility API - search for programs by state
        if (!profileState) break
        const stateParam = encodeURIComponent(profileState)
        // Use Benefits.gov program search - filter by state
        const url = `https://www.benefits.gov/api/benefits?state=${stateParam}&pageSize=20`
        const response = await getWithRetry(url, {}, { timeoutMs: 8000, retries: 1 })
        const programs = response?.data?.programs ?? response?.data ?? []
        if (!Array.isArray(programs)) break
        for (const prog of programs.slice(0, 15)) {
          if (!prog?.title && !prog?.name) continue
          opportunities.push({
            title: prog.title || prog.name,
            sponsor: prog.agency || prog.agencyName || 'Benefits.gov',
            description: prog.summary || prog.description || 'State/local assistance program. Visit Benefits.gov for eligibility details.',
            url: prog.url || prog.applyUrl || `https://www.benefits.gov/benefit/${prog.id || ''}`,
            application_url: prog.applyUrl || prog.url || 'https://www.benefits.gov',
            source_url: prog.url || 'https://www.benefits.gov',
            state: profileState,
            opportunity_type: 'program',
            deadline_type: 'rolling',
            is_national: false,
            categories: prog.categories || ['local', 'assistance'],
            keywords: [profileState, 'benefits', 'assistance', ...(searchKeywords.slice(0, 5))],
            latitude: coords?.lat ?? null,
            longitude: coords?.lng ?? null,
          })
        }
        break
      }

      case 'community_foundation': {
        // Query Grants.gov API for community/local grants in this state
        if (!profileState) break
        const stateKeyword = `${profileState} community foundation grant`
        const payload = {
          rows: 15,
          oppStatuses: 'posted|forecasted',
          keyword: stateKeyword,
          startRecordNum: 0,
        }
        const response = await getWithRetry(
          'https://api.grants.gov/v1/api/search2',
          { method: 'POST', data: payload, headers: { 'Content-Type': 'application/json' } },
          { timeoutMs: 10000, retries: 1 }
        )
        const hits = response?.data?.oppHits ?? response?.data?.data?.oppHits ?? []
        for (const opp of (Array.isArray(hits) ? hits : []).slice(0, 10)) {
          if (!opp?.title) continue
          opportunities.push({
            title: opp.title || opp.opportunityTitle,
            sponsor: opp.agencyName || opp.agency || 'Federal/State Agency',
            description: opp.synopsis || opp.description || 'Federal grant opportunity. Visit Grants.gov for details.',
            url: opp.id ? `https://www.grants.gov/search-results-detail/${opp.id}` : 'https://www.grants.gov',
            application_url: opp.id ? `https://www.grants.gov/search-results-detail/${opp.id}` : 'https://www.grants.gov',
            source_url: opp.id ? `https://www.grants.gov/search-results-detail/${opp.id}` : 'https://www.grants.gov',
            state: profileState,
            opportunity_type: 'grant',
            deadline_type: opp.closeDate ? 'fixed' : 'rolling',
            deadline: opp.closeDate || null,
            is_national: false,
            categories: ['community', 'foundation', 'local'],
            keywords: [profileState, 'community', 'grant', ...(searchKeywords.slice(0, 4))],
            latitude: coords?.lat ?? null,
            longitude: coords?.lng ?? null,
          })
        }
        break
      }

      case 'community_action': {
        // Search Grants.gov for CSBG (Community Services Block Grant) and CAP-related funding
        if (!profileState) break
        const keyword = `${profileState} community services block grant assistance`
        const payload = { rows: 10, oppStatuses: 'posted|forecasted', keyword, startRecordNum: 0 }
        const response = await getWithRetry(
          'https://api.grants.gov/v1/api/search2',
          { method: 'POST', data: payload, headers: { 'Content-Type': 'application/json' } },
          { timeoutMs: 10000, retries: 1 }
        )
        const hits = response?.data?.oppHits ?? response?.data?.data?.oppHits ?? []
        for (const opp of (Array.isArray(hits) ? hits : []).slice(0, 8)) {
          if (!opp?.title) continue
          opportunities.push({
            title: opp.title,
            sponsor: opp.agencyName || 'HHS / Community Action',
            description: opp.synopsis || 'Community action grant. Visit Grants.gov for eligibility and application details.',
            url: opp.id ? `https://www.grants.gov/search-results-detail/${opp.id}` : 'https://www.grants.gov',
            application_url: opp.id ? `https://www.grants.gov/search-results-detail/${opp.id}` : 'https://www.grants.gov',
            source_url: opp.id ? `https://www.grants.gov/search-results-detail/${opp.id}` : 'https://www.grants.gov',
            state: profileState,
            opportunity_type: 'grant',
            deadline_type: opp.closeDate ? 'fixed' : 'rolling',
            deadline: opp.closeDate || null,
            is_national: false,
            categories: ['community', 'action', 'local', 'assistance'],
            keywords: ['community action', 'CSBG', profileState, ...(searchKeywords.slice(0, 4))],
            latitude: coords?.lat ?? null,
            longitude: coords?.lng ?? null,
          })
        }
        break
      }

      case 'housing_authority': {
        // Search Grants.gov for HUD housing programs in this state
        if (!profileState) break
        const keyword = `${profileState} HUD housing assistance voucher`
        const payload = { rows: 10, oppStatuses: 'posted|forecasted', keyword, startRecordNum: 0 }
        const response = await getWithRetry(
          'https://api.grants.gov/v1/api/search2',
          { method: 'POST', data: payload, headers: { 'Content-Type': 'application/json' } },
          { timeoutMs: 10000, retries: 1 }
        )
        const hits = response?.data?.oppHits ?? response?.data?.data?.oppHits ?? []
        for (const opp of (Array.isArray(hits) ? hits : []).slice(0, 8)) {
          if (!opp?.title) continue
          opportunities.push({
            title: opp.title,
            sponsor: opp.agencyName || 'HUD',
            description: opp.synopsis || 'HUD housing assistance program. Visit Grants.gov for eligibility.',
            url: opp.id ? `https://www.grants.gov/search-results-detail/${opp.id}` : 'https://www.grants.gov',
            application_url: opp.id ? `https://www.grants.gov/search-results-detail/${opp.id}` : 'https://www.grants.gov',
            source_url: opp.id ? `https://www.grants.gov/search-results-detail/${opp.id}` : 'https://www.grants.gov',
            state: profileState,
            opportunity_type: 'program',
            deadline_type: opp.closeDate ? 'fixed' : 'rolling',
            deadline: opp.closeDate || null,
            is_national: false,
            categories: ['housing', 'local', 'HUD'],
            keywords: ['housing', 'HUD', 'voucher', profileState, ...(searchKeywords.slice(0, 3))],
            latitude: coords?.lat ?? null,
            longitude: coords?.lng ?? null,
          })
        }
        break
      }

      case 'united_way':
      case 'food_bank':
      default:
        // These are directory-only sources — handled by buildDirectoryResources()
        break
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error(`[LocalFundingCrawler] searchLocalSource error for ${source.type}:`, msg)
  }

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

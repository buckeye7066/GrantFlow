/**
 * Government Funding Crawler
 * Profile-Driven Discovery: Exhaustively uses ALL profile signals to construct
 * the maximum number of targeted search queries against Grants.gov and other
 * government funding APIs.
 *
 * DESIGN PRINCIPLE: If someone depends on these funds for survival, we cannot
 * afford to miss a single relevant opportunity. Every signal category in the
 * profile generates its own search strategy. We cast a wide net with targeted
 * queries and let the scoring engine determine final relevance.
 *
 * STRATEGY: Instead of cherry-picking a few signals, we:
 * 1. Generate a strategy for EVERY non-empty signal category
 * 2. Generate cross-signal combination strategies (e.g., veteran + disability)
 * 3. Generate phrase-based strategies from the profile's own words
 * 4. Run ALL strategies in parallel against Grants.gov
 * 5. De-duplicate across strategies
 * 6. Score with full profile context - NO artificial bonuses
 *
 * CRITICAL: Uses 100% of profile data via signals for search queries and scoring.
 */
import * as cheerio from 'cheerio'
import { buildSearchKeywords, calculateMatchScore, filterByDeadline } from './crawlerHelpers.js'
import { getWithRetry, postWithRetry } from './httpClient.js'
import { searchGrants, searchGrantsBatch, GRANTS_GOV_DETAIL } from './grantsGovClient.js'
import { planCrawlerQueries } from './queryPlanner.js'
import {
  resolveCrawlerContext,
  mergePlanKeywords,
  enforceCrawlerOpportunityContract,
} from './crawlerOpportunityContract.js'
import { enforceOpportunityPolicy } from './opportunityPolicy.js'

const GRANTS_GOV_API = 'https://api.grants.gov/v1/api/search2'

const NIH_RSS_URL = 'https://grants.nih.gov/grants/guide/newsfeed/fundingopps.xml'

// State grant portals (expandable)
const STATE_PORTALS = {
        OH: { name: 'Ohio Grants', searchUrl: 'https://grants.ohio.gov/Public/Search.aspx' },
        TN: { name: 'Tennessee Grants', searchUrl: 'https://www.tn.gov/finance/grants.html' },
        CO: { name: 'Colorado Grants', searchUrl: 'https://www.colorado.gov/grants' },
        TX: { name: 'Texas Grants', searchUrl: 'https://www.texasagriculture.gov/Grants-Services' },
        CA: { name: 'California Grants', searchUrl: 'https://www.grants.ca.gov/' },
        NY: { name: 'New York Grants', searchUrl: 'https://grantsmanagement.ny.gov/' },
        FL: { name: 'Florida Grants', searchUrl: 'https://www.myflorida.com/apps/vbs/vbs_www.main_menu' },
        PA: { name: 'Pennsylvania Grants', searchUrl: 'https://www.esa.dced.state.pa.us/Login.aspx' },
        IL: { name: 'Illinois Grants', searchUrl: 'https://www2.illinois.gov/sites/GATA/Grants' },
        MI: { name: 'Michigan Grants', searchUrl: 'https://www.michigan.gov/leo/bureaus-agencies/ogl' },
        WV: { name: 'West Virginia Grants', searchUrl: 'https://grants.wv.gov/' },
        VA: { name: 'Virginia Grants', searchUrl: 'https://www.dhcd.virginia.gov/community-development-block-grant' },
        NC: { name: 'North Carolina Grants', searchUrl: 'https://www.nc.gov/services/grants' },
        GA: { name: 'Georgia Grants', searchUrl: 'https://opb.georgia.gov/state-grants' },
        NJ: { name: 'New Jersey Grants', searchUrl: 'https://www.nj.gov/state/dos_grants.html' },
        MA: { name: 'Massachusetts Grants', searchUrl: 'https://www.mass.gov/topics/grants-for-individuals' },
        WA: { name: 'Washington Grants', searchUrl: 'https://ofm.wa.gov/budget/state-budgets-prior-prior/grants' },
        AZ: { name: 'Arizona Grants', searchUrl: 'https://grants.az.gov/' },
        IN: { name: 'Indiana Grants', searchUrl: 'https://www.in.gov/ifa/grants/' },
        MN: { name: 'Minnesota Grants', searchUrl: 'https://mn.gov/admin/government/grants/' },
        MO: { name: 'Missouri Grants', searchUrl: 'https://oa.mo.gov/accounting/state-grants' },
        WI: { name: 'Wisconsin Grants', searchUrl: 'https://doa.wi.gov/Pages/StateFinances/GrantsAndLoans.aspx' },
        MD: { name: 'Maryland Grants', searchUrl: 'https://grants.maryland.gov/' },
        SC: { name: 'South Carolina Grants', searchUrl: 'https://admin.sc.gov/statewide-grants' },
        AL: { name: 'Alabama Grants', searchUrl: 'https://comptroller.alabama.gov/grants/' },
        KY: { name: 'Kentucky Grants', searchUrl: 'https://finance.ky.gov/offices/grants/' },
        OR: { name: 'Oregon Grants', searchUrl: 'https://www.oregon.gov/biz/programs/grants/pages/default.aspx' },
        CT: { name: 'Connecticut Grants', searchUrl: 'https://portal.ct.gov/opm/budget/grants-management' },
        LA: { name: 'Louisiana Grants', searchUrl: 'https://www.doa.la.gov/Pages/osp/Grants/Index.aspx' },
        OK: { name: 'Oklahoma Grants', searchUrl: 'https://grants.ok.gov/' },
}

/**
       * Build EXHAUSTIVE search strategies from ALL profile signals.
       * Every non-empty signal category gets at least one strategy.
       * Cross-signal combinations catch opportunities that span categories.
       * Phrases from the profile's own words catch specific programs.
       */
export function buildExhaustiveStrategies(profile) {
        const signals = profile?.signals
        if (!signals) return [{ label: 'fallback', query: 'grant assistance program' }]

  const strategies = []

          const toArray = (set) => set && typeof set[Symbol.iterator] === 'function' ? Array.from(set) : []
                  const clean = (s) => String(s || '').replace(/_/g, ' ').trim()

  const applicantTypes = toArray(signals.applicantTypes).map(clean).filter(Boolean)
        const interests = toArray(signals.interests).map(clean).filter(Boolean)
        const demographics = toArray(signals.demographics).map(clean).filter(Boolean)
        const health = toArray(signals.health).map(clean).filter(Boolean)
        const assistance = toArray(signals.assistance).map(clean).filter(Boolean)
        const family = toArray(signals.family).map(clean).filter(Boolean)
        const military = toArray(signals.military).map(clean).filter(Boolean)
        const occupation = toArray(signals.occupation).map(clean).filter(Boolean)
        const phrases = toArray(signals.phrases).filter(p => p.length >= 8 && p.length <= 60)

  // === CATEGORY-SPECIFIC STRATEGIES (one per non-empty category) ===

  // Applicant type strategies (e.g., "nonprofit community health grant")
  if (applicantTypes.length > 0) {
            for (const appType of applicantTypes.slice(0, 3)) {
                        const topInterest = interests[0] || ''
                        const q = `${appType} ${topInterest} grant`.trim()
                        strategies.push({ label: `applicant:${appType}`, query: q.slice(0, 80) })
            }
  }

  // Interest/focus area strategies (e.g., "education youth development funding")
  if (interests.length > 0) {
            // Each interest gets its own query for maximum coverage
          for (const interest of interests.slice(0, 5)) {
                      strategies.push({ label: `interest:${interest}`, query: `${interest} grant funding`.slice(0, 80) })
          }
            // Combined top interests
          if (interests.length >= 2) {
                      const combined = interests.slice(0, 3).join(' ')
                      strategies.push({ label: 'interests-combined', query: `${combined} program`.slice(0, 80) })
          }
  }

  // Demographic strategies (e.g., "african american women grant", "first generation")
  if (demographics.length > 0) {
            for (const demo of demographics.slice(0, 4)) {
                        strategies.push({ label: `demo:${demo}`, query: `${demo} grant assistance`.slice(0, 80) })
            }
  }

  // Health/disability strategies - CRITICAL for survival funding
  if (health.length > 0) {
            for (const condition of health.slice(0, 5)) {
                        strategies.push({ label: `health:${condition}`, query: `${condition} assistance grant program`.slice(0, 80) })
            }
            // Combined health + assistance
          if (assistance.length > 0) {
                      const q = `${health[0]} ${assistance[0]} support program`
                      strategies.push({ label: 'health+assist', query: q.slice(0, 80) })
          }
  }

  // Assistance program strategies (e.g., "medicaid low income housing assistance")
  if (assistance.length > 0) {
            for (const assist of assistance.slice(0, 4)) {
                        strategies.push({ label: `assist:${assist}`, query: `${assist} benefits program grant`.slice(0, 80) })
            }
  }

  // Family situation strategies (e.g., "single parent childcare grant")
  if (family.length > 0) {
            for (const fam of family.slice(0, 3)) {
                        strategies.push({ label: `family:${fam}`, query: `${fam} family assistance grant`.slice(0, 80) })
            }
  }

  // Military/veteran strategies - CRITICAL for veteran benefits
  if (military.length > 0) {
            for (const mil of military.slice(0, 3)) {
                        strategies.push({ label: `military:${mil}`, query: `${mil} grant benefits program`.slice(0, 80) })
            }
            // Cross: veteran + health
          if (health.length > 0) {
                      const q = `${military[0]} ${health[0]} assistance`
                      strategies.push({ label: 'military+health', query: q.slice(0, 80) })
          }
            // Cross: veteran + family
          if (family.length > 0) {
                      const q = `${military[0]} ${family[0]} support`
                      strategies.push({ label: 'military+family', query: q.slice(0, 80) })
          }
  }

  // Occupation strategies (e.g., "healthcare worker grant", "teacher funding")
  if (occupation.length > 0) {
            for (const occ of occupation.slice(0, 3)) {
                        strategies.push({ label: `occupation:${occ}`, query: `${occ} workforce grant program`.slice(0, 80) })
            }
  }

  // === CROSS-SIGNAL COMBINATION STRATEGIES ===

  // Demographics + health (e.g., "african american cancer support")
  if (demographics.length > 0 && health.length > 0) {
            const q = `${demographics[0]} ${health[0]} support grant`
            strategies.push({ label: 'demo+health', query: q.slice(0, 80) })
  }

  // Demographics + family (e.g., "hispanic single parent assistance")
  if (demographics.length > 0 && family.length > 0) {
            const q = `${demographics[0]} ${family[0]} assistance`
            strategies.push({ label: 'demo+family', query: q.slice(0, 80) })
  }

  // Applicant type + health (e.g., "nonprofit disability services grant")
  if (applicantTypes.length > 0 && health.length > 0) {
            const q = `${applicantTypes[0]} ${health[0]} services grant`
            strategies.push({ label: 'type+health', query: q.slice(0, 80) })
  }

  // Assistance + family (e.g., "low income single parent housing")
  if (assistance.length > 0 && family.length > 0) {
            const q = `${assistance[0]} ${family[0]} program`
            strategies.push({ label: 'assist+family', query: q.slice(0, 80) })
  }

  // === PHRASE STRATEGIES (user's own words) ===
  for (const phrase of phrases.slice(0, 5)) {
            strategies.push({ label: `phrase:${phrase.slice(0, 20)}`, query: phrase })
  }

  // === LOCATION-AWARE STRATEGIES ===
  const state = signals.location?.state
        const city = signals.location?.city
        if (state) {
                  // State + top interest
          if (interests.length > 0) {
                      strategies.push({ label: `state+interest`, query: `${state} ${interests[0]} grant program`.slice(0, 80) })
          }
                  // State + health
          if (health.length > 0) {
                      strategies.push({ label: `state+health`, query: `${state} ${health[0]} assistance`.slice(0, 80) })
          }
                  // State + demographics
          if (demographics.length > 0) {
                      strategies.push({ label: `state+demo`, query: `${state} ${demographics[0]} grant`.slice(0, 80) })
          }
        }

  // === INDIVIDUAL-FOCUSED STRATEGIES ===
  // Grants.gov mostly funds organizations, but many programs directly serve individuals.
  // For individual/family profiles, add searches for these programs explicitly.
  const isIndividualProfile =
    applicantTypes.some(t => ['individual', 'individual_need', 'family', 'medical_assistance'].includes(t)) ||
    clean(signals?.profileType || '').includes('individual')

  if (isIndividualProfile) {
    // Core assistance programs that serve individuals
    const individualPrograms = [
      { label: 'ind:health-center', query: 'community health center' },
      { label: 'ind:mental-health', query: 'mental health services grant' },
      { label: 'ind:disability', query: 'disability services independent living' },
      { label: 'ind:housing', query: 'housing assistance homeless prevention' },
      { label: 'ind:energy', query: 'LIHEAP energy assistance low income' },
      { label: 'ind:food', query: 'food assistance nutrition program' },
      { label: 'ind:workforce', query: 'workforce development job training' },
      { label: 'ind:substance', query: 'substance abuse treatment services' },
      { label: 'ind:childcare', query: 'child care head start early childhood' },
    ]

    // State-specific individual programs
    if (state) {
      individualPrograms.push(
        { label: 'ind:state-assist', query: `${state} assistance benefits program` },
        { label: 'ind:state-health', query: `${state} health services community` },
        { label: 'ind:state-housing', query: `${state} housing community development` },
      )
    }

    // Add Appalachian-specific for WV, KY, TN, VA, NC, GA, AL, MS, OH, PA, MD, SC
    const appalachianStates = new Set(['WV', 'KY', 'TN', 'VA', 'NC', 'GA', 'AL', 'MS', 'OH', 'PA', 'MD', 'SC'])
    if (state && appalachianStates.has(state)) {
      individualPrograms.push(
        { label: 'ind:appalachian', query: 'Appalachian regional commission community' },
        { label: 'ind:rural', query: 'rural development community facilities' },
      )
    }

    // Cross with health/disability signals
    if (health.length > 0) {
      individualPrograms.push(
        { label: 'ind:health-specific', query: `${health[0]} patient assistance program` },
      )
    }

    for (const prog of individualPrograms) {
      strategies.push(prog)
    }
  }

  // === FALLBACK ===
  if (strategies.length === 0) {
            const allKeywords = buildSearchKeywords(profile, 10)
            strategies.push({ label: 'broad-keywords', query: allKeywords.join(' ').slice(0, 80) })
  }

  // De-duplicate by query text (case-insensitive)
  const seen = new Set()
        const unique = strategies.filter(s => {
                  const key = s.query.toLowerCase().trim()
                  if (seen.has(key)) return false
                  seen.add(key)
                  return true
        })

  // Cap at 20 strategies to stay within timeout budget (batch of 3, ~400ms delay, ~20s total with dual API)
  return unique.slice(0, 20)
}

function finalizeGovernmentResults(rows, { facets, queryPlan }) {
  return rows
    .map((row) =>
      enforceCrawlerOpportunityContract(row, {
        crawlerType: 'government_funding',
        facets,
        queryPlan,
        sourceFallback: row?.source ?? 'Government funding',
      }),
    )
    .filter(Boolean)
}

export async function crawlGovernmentFunding(profileInput, options = {}) {
        const { profile, signals, facets, queryPlan: queryPlanFromContext } = resolveCrawlerContext(profileInput, options)
        const queryPlan =
                  queryPlanFromContext ??
                  planCrawlerQueries({
                            crawlerType: 'government_funding',
                            facets,
                            location: facets?.geo ?? signals?.location ?? {},
                  })
        const results = []
                const minMatchScore = typeof options.min_match_score === 'number' ? options.min_match_score : 60

  // Null/missing signals must not disqualify; use minimal fallback
  const effectiveSignals = signals ?? profile?.signals ?? {
    location: { state: profile?.state || null },
    keywordSet: new Set(),
    demographics: new Set(),
    health: new Set(),
    assistance: new Set(),
    occupation: new Set(),
  }
  const profileForCrawler = profile.signals ? profile : { ...profile, signals: effectiveSignals }
  const profileState = effectiveSignals.location?.state || profile.state || null
        const strategies = buildExhaustiveStrategies(profileForCrawler)
        const searchKeywords = mergePlanKeywords(buildSearchKeywords(profileForCrawler, 25), queryPlan).slice(0, 35)

  console.log(`[GovernmentCrawler] Exhaustive discovery with ${strategies.length} strategies`)
        console.log(`[GovernmentCrawler] Strategies: ${strategies.map(s => s.label).join(', ')}`)
        console.log(`[GovernmentCrawler] Profile state: ${profileState}`)

  // De-dupe tracker across all sources
  const seenTitles = new Set()
  // Below-threshold fallback: when no results pass min_score, return top by score (avoid 0 when we have candidates)
  const belowThreshold = []

  // === GRANTS.GOV: Run ALL strategies in parallel ===
  let grantsGovTotal = 0
  try {
    const grantsGovResults = await searchGrantsGovExhaustive(strategies)
    grantsGovTotal = grantsGovResults.length

    const activeOpps = filterByDeadline(grantsGovResults)
    for (const opp of activeOpps) {
      if (!enforceOpportunityPolicy(opp).ok) continue

      const titleKey = (opp.title || '').toLowerCase().trim()
      if (titleKey && seenTitles.has(titleKey)) continue
      if (titleKey) seenTitles.add(titleKey)

      const { score: matchScore, reasons, matchedSignals } = calculateMatchScore(opp, profileForCrawler)
      const row = {
        ...opp,
        match_score: matchScore,
        match_reasons: reasons,
        matched_signals: matchedSignals,
        crawler_type: 'government_funding',
        funding_level: 'federal',
        source: 'Grants.gov',
      }
      if (matchScore >= minMatchScore) {
        results.push(row)
      } else {
        belowThreshold.push(row)
      }
    }
  } catch (error) {
    console.error(`[GovernmentCrawler] Grants.gov error:`, error.message)
  }

  // === BROAD FALLBACK: If all specific strategies returned 0, try a single broad query ===
  if (grantsGovTotal === 0 && profileState) {
    try {
      console.log('[GovernmentCrawler] All strategies returned 0 — running broad state fallback')
      const broadQuery = `${profileState} grant assistance`
      const response = await postWithRetry(
        GRANTS_GOV_API,
        { keyword: broadQuery, oppStatuses: 'forecasted|posted', rows: 25 },
        { headers: { 'Content-Type': 'application/json' } },
        { timeoutMs: 15000, retries: 2 },
      )
      let parsed = response?.data
      if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed) } catch { parsed = null } }
      const hits = parsed?.data?.oppHits ?? parsed?.oppHits ?? parsed?.data?.opportunities ?? parsed?.opportunities ?? []
      const rows = Array.isArray(hits) ? hits : []
      console.log(`[GovernmentCrawler] Broad fallback returned ${rows.length} raw hits`)
      for (const hit of rows) {
        const title = hit?.title ?? hit?.oppTitle ?? hit?.opportunityTitle ?? null
        if (!title) continue
        const titleKey = title.toLowerCase().trim()
        if (titleKey && seenTitles.has(titleKey)) continue
        if (titleKey) seenTitles.add(titleKey)
        const id = hit?.id ?? hit?.oppId ?? null
        const number = hit?.number ?? hit?.oppNum ?? hit?.oppNumber ?? null
        const rawDesc = hit?.synopsis ?? hit?.description ?? null
        const agencyFb = hit?.agencyName ?? hit?.agency ?? null
        const opp = {
          title,
          sponsor: agencyFb,
          description: rawDesc || `Federal grant opportunity: ${title}.${agencyFb ? ` Funded by ${agencyFb}.` : ''}${number ? ` Opportunity ${number}.` : ''} Visit Grants.gov for full details.`,
          url: id != null ? `${GRANTS_GOV_DETAIL}${id}` : 'https://www.grants.gov/search-grants',
          opportunity_number: number,
          amount_min: 0, amount_max: 0, amount_description: null,
          deadline: hit?.closeDate ?? null,
          deadline_type: hit?.closeDate ? 'fixed' : 'rolling',
          eligibility: '', is_national: true, source_id: id,
          _discovery_strategy: 'broad_state_fallback',
        }
        if (!enforceOpportunityPolicy(opp).ok) continue
        const { score: matchScore, reasons, matchedSignals } = calculateMatchScore(opp, profileForCrawler)
        belowThreshold.push({
          ...opp, match_score: matchScore, match_reasons: reasons, matched_signals: matchedSignals,
          crawler_type: 'government_funding', funding_level: 'federal', source: 'Grants.gov',
        })
      }
    } catch (broadErr) {
      console.error(`[GovernmentCrawler] Broad fallback error:`, broadErr.message, broadErr.requestUrl || '')
    }
  }

  // === NIH RSS ===
  try {
            const nihResults = await searchNIHRSS(searchKeywords)
            const activeOpps = filterByDeadline(nihResults)
            for (const opp of activeOpps) {
                        if (!enforceOpportunityPolicy(opp).ok) continue

              const titleKey = (opp.title || '').toLowerCase().trim()
                        if (titleKey && seenTitles.has(titleKey)) continue
                        if (titleKey) seenTitles.add(titleKey)

              const { score: matchScore, reasons, matchedSignals } = calculateMatchScore(opp, profileForCrawler)

              if (matchScore >= minMatchScore) {
                            results.push({
                                            ...opp,
                                            match_score: matchScore,
                                            match_reasons: reasons,
                                            matched_signals: matchedSignals,
                                            crawler_type: 'government_funding',
                                            funding_level: 'federal',
                                            source: 'NIH Grants',
                            })
              }
            }
  } catch (error) {
            console.error(`[GovernmentCrawler] NIH RSS error:`, error.message)
  }

  // === HEALTHCARE-SPECIFIC (only if profile has healthcare signals) ===
  const hasHealthcareSignals = effectiveSignals.health?.size > 0 ||
            effectiveSignals.assistance?.has('medicaid') ||
            effectiveSignals.assistance?.has('medicare') ||
            effectiveSignals.occupation?.has('healthcare_worker')

  if (hasHealthcareSignals) {
            try {
                        const cmsResults = await searchCMSSources(profile, searchKeywords)
                        for (const opp of cmsResults) {
                                      if (!enforceOpportunityPolicy(opp).ok) continue
                                      const titleKey = (opp.title || '').toLowerCase().trim()
                                      if (titleKey && seenTitles.has(titleKey)) continue
                                      if (titleKey) seenTitles.add(titleKey)

                          const { score: matchScore, reasons, matchedSignals } = calculateMatchScore(opp, profileForCrawler)
                                      if (matchScore >= minMatchScore) {
                                                      results.push({
                                                                        ...opp,
                                                                        match_score: matchScore,
                                                                        match_reasons: reasons,
                                                                        matched_signals: matchedSignals,
                                                                        crawler_type: 'government_funding',
                                                                        funding_level: 'federal_healthcare',
                                                                        source: 'CMS',
                                                      })
                                      }
                        }
            } catch (error) {
                        console.error(`[GovernmentCrawler] CMS error:`, error.message)
            }
  }

  // === STATE PORTAL (if state is known and has a portal) ===
  const statePortal = STATE_PORTALS[profileState]
        if (statePortal) {
                  try {
                              const stateResults = await searchStatePortal(statePortal, profileState, searchKeywords)
                              for (const opp of stateResults) {
                                            if (!enforceOpportunityPolicy(opp).ok) continue
                                            const titleKey = (opp.title || '').toLowerCase().trim()
                                            if (titleKey && seenTitles.has(titleKey)) continue
                                            if (titleKey) seenTitles.add(titleKey)

                                const { score: matchScore, reasons, matchedSignals } = calculateMatchScore(opp, profileForCrawler)
                                            if (matchScore >= minMatchScore) {
                                                            results.push({
                                                                              ...opp,
                                                                              match_score: matchScore,
                                                                              match_reasons: reasons,
                                                                              matched_signals: matchedSignals,
                                                                              crawler_type: 'government_funding',
                                                                              funding_level: 'state',
                                                                              state: profileState,
                                                                              source: statePortal.name,
                                                            })
                                            }
                              }
                  } catch (error) {
                              console.error(`[GovernmentCrawler] State portal error for ${profileState}:`, error.message)
                  }
        }

  // When no results pass threshold but we have Grants.gov candidates, return top by score (avoid 0)
  if (results.length === 0 && belowThreshold.length > 0) {
    belowThreshold.sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
    const top = belowThreshold.slice(0, 20)
    results.push(...top)
    console.log(`[GovernmentCrawler] Score fallback: ${top.length} opportunities (best score ${top[0]?.match_score ?? 0}, min_score=${minMatchScore})`)
  }

  // Sort by match score
  results.sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))

  console.log(`[GovernmentCrawler] Exhaustive discovery found ${results.length} matching opportunities (min_score=${minMatchScore})`)
  return finalizeGovernmentResults(results, { facets, queryPlan })
}

/**
 * Run ALL strategies against Grants.gov in parallel.
 * Each strategy gets its own API call with focused keywords.
 */
async function searchGrantsGovExhaustive(strategies) {
  // Delegate to the dual-API client (legacy + simpler.grants.gov)
  const { opportunities, diagnostics } = await searchGrantsBatch(strategies, {
    batchSize: 3,
    batchDelayMs: 400,
    rowsPerQuery: 25,
  })

  console.log(`[GovernmentCrawler] Dual-API batch: ${opportunities.length} unique results from ${strategies.length} strategies`)
  if (diagnostics?.per_strategy) {
    const summary = Object.entries(diagnostics.per_strategy)
      .map(([label, info]) => `${label}=${info.count}`)
      .join(', ')
    console.log(`[GovernmentCrawler] Per-strategy: ${summary}`)
  }

  return opportunities
}

/**
 * Search NIH RSS feed with keyword filtering
 */
async function searchNIHRSS(searchKeywords) {
        const opportunities = []
                try {
                          const response = await getWithRetry(
                                      NIH_RSS_URL,
                                { headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' } },
                                { timeoutMs: 10000, retries: 1 },
                                    )

          const $ = cheerio.load(response.data, { xmlMode: true })
                          $('item').slice(0, 50).each((_i, elem) => {
                                      const title = $(elem).find('title').text().trim()
                                      const link = $(elem).find('link').text().trim()
                                      const description = $(elem).find('description').text().trim()
                                      const pubDate = $(elem).find('pubDate').text().trim()

                                                            if (!title) return

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
                                                                          url: link || NIH_RSS_URL,
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
        return opportunities
}

/**
 * Search CMS/Medicare/Medicaid sources
 */
async function searchCMSSources(profile, searchKeywords) {
        const opportunities = []
                const cmsUrls = [
                          'https://innovation.cms.gov/innovation-models',
                          'https://www.medicaid.gov/medicaid/grants',
                        ]

  for (const url of cmsUrls) {
            try {
                        const response = await getWithRetry(url, {}, { timeoutMs: 10000, retries: 1 })
                        const $ = cheerio.load(response.data)

              $('.innovation-model, .grant-opportunity, .views-row').each((i, elem) => {
                            const $elem = $(elem)
                            const title = $elem.find('.model-name, .opportunity-title, h3, h4').first().text().trim()
                            if (!title) return

                                                                                  opportunities.push({
                                                                                                  title,
                                                                                                  sponsor: 'Centers for Medicare & Medicaid Services',
                                                                                                  description: $elem.find('.model-description, .opportunity-description, p').first().text().trim(),
                                                                                                  url: url + ($elem.find('a').attr('href') || ''),
                                                                                                  program_type: 'medicare_medicaid',
                                                                                                  eligibility: $elem.find('.eligibility').text().trim(),
                                                                                                  is_national: true,
                                                                                                  keywords: ['healthcare', 'medicaid', 'medicare', 'cms'],
                                                                                  })
              })
            } catch (error) {
                        console.error(`[GovernmentCrawler] CMS crawl error for ${url}:`, error.message)
            }
  }
        return opportunities
}

/**
 * Search state grant portal
 */
async function searchStatePortal(portal, state, searchKeywords) {
        const opportunities = []
                try {
                          const response = await getWithRetry(portal.searchUrl, {}, { timeoutMs: 10000, retries: 1 })
                          const $ = cheerio.load(response.data)

          // Generic scraping selectors that work across multiple state sites
          $('tr, .grant-row, .opportunity-row, .list-item').each((i, elem) => {
                      const $elem = $(elem)
                      const title = $elem.find('a, .grant-title, .title').first().text().trim()
                      if (!title || title.length < 10) return

                                                                       const href = $elem.find('a').first().attr('href') || ''
                      const fullUrl = href.startsWith('http') ? href : (portal.searchUrl.replace(/\/[^/]*$/, '/') + href)

                                                                       opportunities.push({
                                                                                     title,
                                                                                     sponsor: $elem.find('.agency-name, .agency, .sponsor').first().text().trim() || `State of ${state}`,
                                                                                     description: $elem.find('.grant-summary, .description, .summary').first().text().trim(),
                                                                                     url: fullUrl,
                                                                                     amount_min: parseAmount($elem.find('.min-award, .amount-min').text()),
                                                                                     amount_max: parseAmount($elem.find('.max-award, .amount-max').text()),
                                                                                     deadline: $elem.find('.deadline, .close-date').first().text().trim(),
                                                                                     eligibility: $elem.find('.eligible-applicants, .eligibility').first().text().trim(),
                                                                                     state: state,
                                                                                     is_national: false,
                                                                       })
          })
                } catch (error) {
                          console.error(`[GovernmentCrawler] State portal error for ${state}:`, error.message)
                }
        return opportunities
}

// Loan/matching-fund detection is now handled centrally by enforceOpportunityPolicy().

function parseAmount(amountStr) {
        if (!amountStr) return 0
        const cleaned = amountStr.replace(/[^0-9]/g, '')
        return parseInt(cleaned) || 0
}

export default { crawlGovernmentFunding }

/**
 * Government Funding Crawler
 * Profile-Driven Discovery: Uses profile signals to construct targeted search queries
 * against Grants.gov and other government funding APIs.
 *
 * KEY CHANGE: Instead of dumping all keywords into one search, we now:
 * 1. Build multiple focused query strategies from profile signals
 * 2. Run parallel searches with different signal combinations
 * 3. Score results AT DISCOVERY TIME using full profile context
 * 4. Only return results that genuinely match the profile
 *
 * CRITICAL: Uses 100% of profile data via signals for search queries and scoring.
 */
import * as cheerio from 'cheerio'
import { buildSearchKeywords, calculateMatchScore, filterByDeadline } from './crawlerHelpers.js'
import { getWithRetry, postWithRetry } from './httpClient.js'

// Real government funding APIs and sources
const GOVERNMENT_SOURCES = {
      federal: [
          {
                    name: 'Grants.gov',
                    apiUrl: 'https://api.grants.gov/v1/api/search2',
                    type: 'api'
          },
          {
                    name: 'NIH Grants',
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
              'OH': { name: 'Ohio Grants', baseUrl: 'https://grants.ohio.gov', searchUrl: 'https://grants.ohio.gov/Public/Search.aspx' },
              'TN': { name: 'Tennessee Grants', baseUrl: 'https://www.tn.gov/finance/grants.html', searchUrl: 'https://www.tn.gov/finance/grants.html' },
              'CO': { name: 'Colorado Grants', baseUrl: 'https://www.colorado.gov/grants', searchUrl: 'https://www.colorado.gov/grants' },
      }
}

/**
     * Build multiple targeted search strategies from profile signals.
     * Each strategy is a focused query string designed to find relevant opportunities.
     * This replaces the old approach of dumping all keywords into one query.
     */
function buildTargetedSearchStrategies(profile) {
      const signals = profile?.signals
      if (!signals) return [{ label: 'fallback', query: 'grant assistance' }]

  const strategies = []

        // Strategy 1: Applicant type + primary interest (most specific)
        const applicantTypes = signals.applicantTypes ? Array.from(signals.applicantTypes) : []
              const interests = signals.interests ? Array.from(signals.interests) : []
                    const demographics = signals.demographics ? Array.from(signals.demographics) : []
                          const health = signals.health ? Array.from(signals.health) : []
                                const assistance = signals.assistance ? Array.from(signals.assistance) : []
                                      const family = signals.family ? Array.from(signals.family) : []
                                            const occupation = signals.occupation ? Array.from(signals.occupation) : []
                                                  const military = signals.military ? Array.from(signals.military) : []

                                                        // Build primary identity query: who is this person?
                                                        if (applicantTypes.length > 0) {
                                                                const primaryType = applicantTypes[0].replace(/_/g, ' ')
                                                                // Combine with top interests for specificity
        const topInterests = interests.slice(0, 2).map(i => i.replace(/_/g, ' '))
                                                                const query = [primaryType, ...topInterests].filter(Boolean).join(' ')
                                                                if (query.trim().length >= 4) {
                                                                          strategies.push({ label: `identity:${primaryType}`, query: query.slice(0, 80) })
                                                                }
                                                        }

  // Strategy 2: Health/disability-focused (if applicable)
  if (health.length > 0) {
          const healthTerms = health.slice(0, 3).map(h => h.replace(/_/g, ' '))
          const query = [...healthTerms, 'assistance', 'grant'].join(' ')
          strategies.push({ label: 'health-needs', query: query.slice(0, 80) })
  }

  // Strategy 3: Demographic-focused search
  if (demographics.length > 0) {
          const demoTerms = demographics.slice(0, 3).map(d => d.replace(/_/g, ' '))
          const demoQuery = [...demoTerms, 'grant funding'].join(' ')
          strategies.push({ label: 'demographic', query: demoQuery.slice(0, 80) })
  }

  // Strategy 4: Assistance programs the person is already on
  if (assistance.length > 0) {
          const assistTerms = assistance.slice(0, 3).map(a => a.replace(/_/g, ' '))
          const assistQuery = [...assistTerms, 'benefits program'].join(' ')
          strategies.push({ label: 'assistance', query: assistQuery.slice(0, 80) })
  }

  // Strategy 5: Family situation
  if (family.length > 0) {
          const familyTerms = family.slice(0, 2).map(f => f.replace(/_/g, ' '))
          const familyQuery = [...familyTerms, 'family assistance grant'].join(' ')
          strategies.push({ label: 'family', query: familyQuery.slice(0, 80) })
  }

  // Strategy 6: Military/veteran (if applicable)
  if (military.length > 0) {
          const milTerms = military.slice(0, 2).map(m => m.replace(/_/g, ' '))
          const milQuery = [...milTerms, 'veteran grant'].join(' ')
          strategies.push({ label: 'military', query: milQuery.slice(0, 80) })
  }

  // Strategy 7: Occupation-specific
  if (occupation.length > 0) {
          const occTerms = occupation.slice(0, 2).map(o => o.replace(/_/g, ' '))
          const occQuery = [...occTerms, 'workforce grant'].join(' ')
          strategies.push({ label: 'occupation', query: occQuery.slice(0, 80) })
  }

  // Strategy 8: Top phrases from profile (very specific multi-word matches)
  if (signals.phrases?.size > 0) {
          const topPhrases = Array.from(signals.phrases).slice(0, 3)
          for (const phrase of topPhrases) {
                    if (phrase.length >= 8 && phrase.length <= 60) {
                                strategies.push({ label: `phrase:${phrase.slice(0, 20)}`, query: phrase })
                    }
          }
  }

  // Fallback: broad keyword search (old behavior, but capped)
  if (strategies.length === 0) {
          const allKeywords = buildSearchKeywords(profile, 8)
          strategies.push({ label: 'broad-keywords', query: allKeywords.join(' ').slice(0, 80) })
  }

  // Cap at 5 strategies to stay within timeout budget
  return strategies.slice(0, 5)
}

export async function crawlGovernmentFunding(profile, options = {}) {
      const results = []
            const minMatchScore = typeof options.min_match_score === 'number' ? options.min_match_score : 50

  const signals = profile?.signals
      if (!signals) {
              console.error('[GovernmentCrawler] No signals in profile - cannot search with 100% precision')
              return results
      }

  const profileState = signals.location?.state || profile.state || null
      const searchStrategies = buildTargetedSearchStrategies(profile)
      const searchKeywords = buildSearchKeywords(profile, 25)

  console.log(`[GovernmentCrawler] Profile-driven discovery with ${searchStrategies.length} targeted strategies`)
      console.log(`[GovernmentCrawler] Strategies: ${searchStrategies.map(s => s.label).join(', ')}`)
      console.log(`[GovernmentCrawler] Profile state: ${profileState}`)

  // De-dupe tracker across all strategies
  const seenTitles = new Set()

  // Search Federal sources with TARGETED strategies
  for (const source of GOVERNMENT_SOURCES.federal) {
          try {
                    let opportunities = []

                              if (source.type === 'api' && source.name === 'Grants.gov') {
                                          // NEW: Run multiple targeted queries in parallel instead of one broad search
                      opportunities = await searchGrantsGovWithStrategies(source, profile, searchStrategies)
                              } else if (source.type === 'rss' && source.name === 'NIH Grants') {
                                          opportunities = await searchNIHRSS(source, searchKeywords)
                              } else {
                                          // Other sources: use keyword-based scraping
                      opportunities = await searchFederalSource(source, profile, searchKeywords)
                              }

            const activeOpps = filterByDeadline(opportunities)

            for (const opp of activeOpps) {
                        if (isLoanOrMatchingFund(opp)) continue

                      // De-dupe by title across strategies
                      const titleKey = (opp.title || '').toLowerCase().trim()
                        if (titleKey && seenTitles.has(titleKey)) continue
                        if (titleKey) seenTitles.add(titleKey)

                      // Score using full profile signals - NO artificial bonuses
                      const { score: matchScore, reasons, matchedSignals } = calculateMatchScore(opp, profile)

                      // Only include if the score genuinely meets the threshold
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
          signals.assistance?.has('medicaid') || signals.assistance?.has('medicare') ||
          signals.occupation?.has('healthcare_worker')

  if (hasHealthcareSignals) {
          for (const source of GOVERNMENT_SOURCES.medicare_medicaid) {
                    try {
                                const opportunities = await searchCMSSource(source, profile, searchKeywords)
                                const activeOpps = filterByDeadline(opportunities)
                                for (const opp of activeOpps) {
                                              if (isLoanOrMatchingFund(opp)) continue
                                              const titleKey = (opp.title || '').toLowerCase().trim()
                                              if (titleKey && seenTitles.has(titleKey)) continue
                                              if (titleKey) seenTitles.add(titleKey)
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
                                    const titleKey = (opp.title || '').toLowerCase().trim()
                                    if (titleKey && seenTitles.has(titleKey)) continue
                                    if (titleKey) seenTitles.add(titleKey)
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

  // Sort by match score descending so best matches are first
  results.sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))

  console.log(`[GovernmentCrawler] Profile-driven discovery found ${results.length} matching opportunities (min_score=${minMatchScore})`)
      return results
}

/**
 * NEW: Profile-driven Grants.gov search using multiple targeted strategies.
 * Runs focused queries in parallel, de-dupes, and returns combined results.
 */
async function searchGrantsGovWithStrategies(source, profile, strategies) {
      const allOpportunities = []
            const seenIds = new Set()

  // Run all strategy queries concurrently (with individual timeouts)
  const queryPromises = strategies.map(async (strategy) => {
          try {
                    console.log(`[GovernmentCrawler] Grants.gov strategy "${strategy.label}": "${strategy.query}"`)

            const searchParams = {
                        keyword: strategy.query,
                        oppStatuses: 'posted',
                        sortBy: 'openDate|desc',
                        rows: 15,
                        startRecordNum: 0,
            }

            const response = await postWithRetry(
                        source.apiUrl,
                        searchParams,
                { headers: { 'Content-Type': 'application/json' } },
                { timeoutMs: 8000, retries: 1 },
                      )

            let parsed = response?.data
                    if (typeof parsed === 'string') {
                                try { parsed = JSON.parse(parsed) } catch { return [] }
                    }

            const hits = parsed?.data?.oppHits ?? parsed?.oppHits ?? []
                      const rows = Array.isArray(hits) ? hits : []

                                const results = []
                                          for (const hit of rows) {
                                                      const title = hit?.title ?? hit?.oppTitle ?? null
                                                      if (!title) continue
                                                      const id = hit?.id ?? hit?.oppId ?? null

                      // De-dupe across strategies by ID
                      const idKey = String(id ?? title)
                                                      if (seenIds.has(idKey)) continue
                                                      seenIds.add(idKey)

                      const number = hit?.number ?? hit?.oppNum ?? hit?.oppNumber ?? null
                                                      const agencyName = hit?.agencyName ?? hit?.agency ?? hit?.agencyCode ?? null
                                                      const closeDate = hit?.closeDate ?? hit?.close_date ?? null
                                                      const openDate = hit?.openDate ?? hit?.open_date ?? null
                                                      const description = hit?.synopsis ?? hit?.description ?? null
                                                      const url = id != null
                                                        ? `https://www.grants.gov/search-results-detail/${id}`
                                                                    : number
                                                          ? `https://www.grants.gov/search-grants?query=${encodeURIComponent(String(number))}`
                                                                      : 'https://www.grants.gov/search-grants'

                      results.push({
                                    title,
                                    sponsor: agencyName,
                                    description,
                                    url,
                                    opportunity_number: number,
                                    amount_min: 0,
                                    amount_max: 0,
                                    amount_description: null,
                                    deadline: closeDate,
                                    open_date: openDate,
                                    deadline_type: closeDate ? 'fixed' : 'rolling',
                                    eligibility: '',
                                    is_national: true,
                                    source_id: id,
                                    _discovery_strategy: strategy.label,
                      })
                                          }

            console.log(`[GovernmentCrawler] Strategy "${strategy.label}" returned ${results.length} results`)
                    return results
          } catch (error) {
                    console.error(`[GovernmentCrawler] Strategy "${strategy.label}" failed:`, error.message)
                    return []
          }
  })

  const strategyResults = await Promise.allSettled(queryPromises)
      for (const result of strategyResults) {
              if (result.status === 'fulfilled' && Array.isArray(result.value)) {
                        allOpportunities.push(...result.value)
              }
      }

  console.log(`[GovernmentCrawler] Combined ${allOpportunities.length} unique results from ${strategies.length} strategies`)
      return allOpportunities
}

/**
 * Search NIH RSS feed with keyword filtering
 */
async function searchNIHRSS(source, searchKeywords) {
      const opportunities = []
            try {
                    const response = await getWithRetry(
                              source.baseUrl,
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
      return opportunities
}

async function searchFederalSource(source, profile, searchKeywords) {
      // Placeholder for additional federal sources (FEMA, SAMHSA scraping)
  return []
}

async function searchCMSSource(source, profile, searchKeywords) {
      const opportunities = []
            try {
                    const response = await getWithRetry(source.baseUrl, {}, { timeoutMs: 10000, retries: 1 })
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
                    const response = await getWithRetry(source.searchUrl || source.baseUrl, {}, { timeoutMs: 10000, retries: 1 })
                    const $ = cheerio.load(response.data)
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

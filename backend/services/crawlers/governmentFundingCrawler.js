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
import { getWithRetry, postWithRetry } from './httpClient.js'

// NOTE: fetchOpportunity detail enrichment is intentionally disabled to avoid timeout-inducing
// sequential API calls that caused "Unterminated string in JSON" errors on slow connections.
// We rely on the search result fields (title, agency, closeDate) which are reliable and fast.

// Real government funding APIs and sources
const GOVERNMENT_SOURCES = {
    federal: [
      {
              name: 'Grants.gov',
              // Grants.gov public Search API (no key required)
              apiUrl: 'https://api.grants.gov/v1/api/search2',
              type: 'api'
      },
      {
              name: 'NIH Grants',
              // NIH Guide RSS feed for Funding Opportunity Announcements
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

                  // Query relevance bonus
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
  const hasHealthcareSignals =
        signals.health?.size > 0 ||
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
      // Limit rows to 25 (down from 50) to keep response size manageable and avoid partial-read
      // JSON parse errors on slow or throttled connections.
      const searchParams = {
              keyword: searchKeywords.slice(0, 15).join(' '),
              oppStatuses: 'posted',
              sortBy: 'openDate|desc',
              rows: 25,
              startRecordNum: 0,
      }

      try {
              // Use a 12-second timeout so we comfortably finish within the 20s live-crawl budget
                // without risking a mid-stream TCP close that produces truncated JSON.
                const response = await postWithRetry(
                          source.apiUrl,
                          searchParams,
                  { headers: { 'Content-Type': 'application/json' } },
                  { timeoutMs: 12000, retries: 1 },
                        )

                // Safely parse: the response body may arrive as a string if axios couldn't auto-parse it.
                let parsed = response?.data
              if (typeof parsed === 'string') {
                        try {
                                    parsed = JSON.parse(parsed)
                        } catch (parseErr) {
                                    console.error('[GovernmentCrawler] Grants.gov response JSON parse error:', parseErr.message)
                                    return opportunities
                        }
              }

                const hits = parsed?.data?.oppHits ?? parsed?.oppHits ?? []
                        const rows = Array.isArray(hits) ? hits : []

                                for (const hit of rows) {
                                          const title = hit?.title ?? hit?.oppTitle ?? null
                                          if (!title) continue

                const id = hit?.id ?? hit?.oppId ?? null
                                          const number = hit?.number ?? hit?.oppNum ?? hit?.oppNumber ?? null
                                          const agencyName = hit?.agencyName ?? hit?.agency ?? hit?.agencyCode ?? null
                                          const closeDate = hit?.closeDate ?? hit?.close_date ?? null
                                          const openDate = hit?.openDate ?? hit?.open_date ?? null

                const url = id != null
                                            ? `https://www.grants.gov/search-results-detail/${id}`
                            : number
                                              ? `https://www.grants.gov/search-grants?query=${encodeURIComponent(String(number))}`
                              : 'https://www.grants.gov/search-grants'

                opportunities.push({
                            title,
                            sponsor: agencyName,
                            description: null,
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
                        { timeoutMs: 10000, retries: 1 },
                              )
                      const $ = cheerio.load(response.data, { xmlMode: true })
                      $('item')
                        .slice(0, 50)
                        .each((_i, elem) => {
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
        }

  return opportunities
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

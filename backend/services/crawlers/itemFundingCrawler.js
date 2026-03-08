/**
 * Item-Specific Funding Crawler
 * REAL web discovery for specific items, services, or training.
 *
 * DESIGN PRINCIPLE: When someone needs a 15-passenger Ford van, we don't just
 * link to a generic "vehicle donation" page. We actively search the web for
 * real organizations that provide that specific item, and return results with
 * real URLs the user can click and apply to.
 *
 * When someone needs CPR/First Aid training, we find real providers offering
 * that specific class - free or funded.
 *
 * HOW IT WORKS:
 * 1. Parse the item request to understand what's being asked for
 * 2. Search Google (via scraping) for real sources that donate/provide/fund that item
 * 3. Search known item-specific organizations
 * 4. Combine profile signals for targeted searches (e.g., "veteran van donation")
 * 5. Return ONLY results with real, clickable URLs
 *
 * CRITICAL: No fabricated data. Every result must have a real URL.
 */
import * as cheerio from 'cheerio'
import { calculateMatchScore } from '../matchingEngine.js'

function buildSearchKeywords(profile, maxKeywords = 10) {
  const kw = new Set();
  const signals = profile?.signals || {};
  if (signals.keywordSet instanceof Set) signals.keywordSet.forEach(k => kw.add(k));
  if (signals.interests instanceof Set) signals.interests.forEach(k => kw.add(k));
  const loc = signals.location || {};
  if (loc.state) kw.add(loc.state);
  if (loc.city) kw.add(loc.city);
  const name = profile?.display_name || profile?.name || '';
  if (name) kw.add(name.split(/\s+/)[0]);
  return [...kw].slice(0, maxKeywords);
}
import { getWithRetry } from './httpClient.js'
import { planCrawlerQueries } from './queryPlanner.js'
import {
  resolveCrawlerContext,
  mergePlanKeywords,
  enforceCrawlerOpportunityContract,
} from './crawlerOpportunityContract.js'
import { enforceOpportunityPolicy } from './opportunityPolicy.js'

/**
   * Known organizations that provide specific item categories.
   * These are verified, real organizations with real programs.
   */
const KNOWN_ITEM_SOURCES = {
    vehicle: [
      {
              name: 'Vehicles for Change',
              url: 'https://www.vehiclesforchange.org/',
              description: 'Provides affordable vehicles to families in need. Serves multiple states. Vehicles are repaired and sold at low cost.',
              keywords: ['vehicle', 'car', 'transportation'],
      },
      {
              name: '1-800-Charity Cars',
              url: 'https://www.800charitycars.org/',
              description: 'Donates vehicles to struggling families, single parents, and domestic violence survivors nationwide.',
              keywords: ['vehicle', 'car', 'donation', 'free car'],
      },
      {
              name: 'Working Cars for Working People',
              url: 'https://www.workingcarsforworkingpeople.org/',
              description: 'Provides donated vehicles to low-income working individuals and families.',
              keywords: ['vehicle', 'car', 'working', 'low income'],
      },
      {
              name: 'Good News Garage',
              url: 'https://www.goodnewsgarage.org/',
              description: 'Donates refurbished vehicles to people in need. Partners with social service agencies.',
              keywords: ['vehicle', 'car', 'donation', 'refurbished'],
      },
      {
              name: 'Free Charity Cars',
              url: 'https://freecharitycars.com/',
              description: 'Free cars for people in need. Application-based program accepting requests nationwide.',
              keywords: ['vehicle', 'car', 'free', 'donation'],
      },
        ],
    van: [
      {
              name: 'Vans for Disabled Veterans',
              url: 'https://www.va.gov/health-care/about-va-health-benefits/vision-care/blind-low-vision-rehab-services/',
              description: 'VA automobile allowance and adaptive equipment grants for eligible veterans with disabilities.',
              keywords: ['van', 'veteran', 'disability', 'adaptive'],
      },
      {
              name: 'National Mobility Equipment Dealers Association (NMEDA)',
              url: 'https://www.nmeda.com/consumer-resources/',
              description: 'Resources for adaptive vehicles including wheelchair-accessible vans and mobility equipment.',
              keywords: ['van', 'wheelchair', 'accessible', 'mobility', 'adaptive'],
      },
      {
              name: 'Braun Ability Assistance',
              url: 'https://www.braunability.com/',
              description: 'Wheelchair accessible vehicles and conversion vans. Has financing and assistance programs.',
              keywords: ['van', 'wheelchair', 'accessible', 'conversion'],
      },
        ],
    technology: [
      {
              name: 'TechSoup',
              url: 'https://www.techsoup.org/',
              description: 'Deeply discounted and donated technology products for nonprofits. Software, hardware, and cloud services.',
              keywords: ['technology', 'software', 'hardware', 'computers', 'nonprofit'],
      },
      {
              name: 'PCs for People',
              url: 'https://www.pcsforpeople.org/',
              description: 'Refurbished computers and low-cost internet for qualifying low-income individuals and nonprofits.',
              keywords: ['computer', 'laptop', 'internet', 'low income'],
      },
      {
              name: 'World Computer Exchange',
              url: 'https://www.worldcomputerexchange.org/',
              description: 'Refurbished computers for educational institutions and nonprofits.',
              keywords: ['computer', 'education', 'nonprofit', 'refurbished'],
      },
      {
              name: 'Human-I-T',
              url: 'https://www.human-i-t.org/',
              description: 'Free and low-cost computers, internet, and digital literacy training for underserved communities.',
              keywords: ['computer', 'internet', 'digital literacy', 'low income'],
      },
      {
              name: 'EveryoneOn',
              url: 'https://www.everyoneon.org/',
              description: 'Low-cost internet and computers for qualifying households.',
              keywords: ['internet', 'computer', 'affordable', 'low income'],
      },
        ],
    equipment: [
      {
              name: 'Good360',
              url: 'https://good360.org/',
              description: 'Product philanthropy platform connecting donated goods (equipment, supplies, furniture) with nonprofits in need.',
              keywords: ['equipment', 'supplies', 'furniture', 'donation', 'nonprofit'],
      },
      {
              name: 'GrantWatch Equipment Grants',
              url: 'https://www.grantwatch.com/cat/3/equipment-grants.html',
              description: 'Curated listings of equipment grants from foundations, government, and corporate sources.',
              keywords: ['equipment', 'grant', 'machinery', 'tools'],
      },
      {
              name: 'USDA Equipment Grants (Rural)',
              url: 'https://www.rd.usda.gov/programs-services/all-programs',
              description: 'USDA programs for rural community equipment, including Community Facilities grants.',
              keywords: ['equipment', 'rural', 'community', 'usda'],
      },
        ],
    training: [
      {
              name: 'American Red Cross (CPR/First Aid)',
              url: 'https://www.redcross.org/take-a-class',
              description: 'CPR, First Aid, AED, and other safety training classes available nationwide. Online and in-person.',
              keywords: ['cpr', 'first aid', 'training', 'certification', 'red cross'],
      },
      {
              name: 'American Heart Association Training',
              url: 'https://cpr.heart.org/en/courses',
              description: 'CPR, First Aid, and ACLS courses. Instructor-led and online. Widely recognized certification.',
              keywords: ['cpr', 'first aid', 'training', 'aha', 'certification'],
      },
      {
              name: 'OSHA Training Institute (Free/Low-Cost)',
              url: 'https://www.osha.gov/training/outreach',
              description: 'OSHA safety training including OSHA 10 and OSHA 30 courses through authorized trainers.',
              keywords: ['osha', 'safety', 'training', 'workplace', 'certification'],
      },
      {
              name: 'CareerOneStop (DOL)',
              url: 'https://www.careeronestop.org/LocalHelp/local-help.aspx',
              description: 'U.S. Department of Labor career centers offering free job training, certifications, and workforce development.',
              keywords: ['training', 'job training', 'workforce', 'career', 'certification', 'free'],
      },
      {
              name: 'Coursera for Campus / Community',
              url: 'https://www.coursera.org/for-campus',
              description: 'Free and low-cost online courses and professional certificates from top universities.',
              keywords: ['training', 'online course', 'certificate', 'education', 'free'],
      },
        ],
    furniture: [
      {
              name: 'Habitat for Humanity ReStore',
              url: 'https://www.habitat.org/restores',
              description: 'Affordable furniture, appliances, and building materials. Proceeds support Habitat homebuilding.',
              keywords: ['furniture', 'appliances', 'affordable', 'habitat'],
      },
      {
              name: 'Furniture Bank Network',
              url: 'https://www.furniturebanks.org/',
              description: 'Network of furniture banks providing free furniture to people transitioning out of homelessness or crisis.',
              keywords: ['furniture', 'free', 'donation', 'crisis'],
      },
        ],
    medical_equipment: [
      {
              name: 'MedShare',
              url: 'https://www.medshare.org/',
              description: 'Recovers surplus medical supplies and equipment for redistribution to communities in need.',
              keywords: ['medical equipment', 'medical supplies', 'healthcare'],
      },
      {
              name: 'Project C.U.R.E.',
              url: 'https://projectcure.org/',
              description: 'Collects and distributes donated medical supplies and equipment.',
              keywords: ['medical equipment', 'medical supplies', 'donation'],
      },
        ],
    adaptive_equipment: [
      {
              name: 'AbleData',
              url: 'https://abledata.acl.gov/',
              description: 'Database of assistive technology products and where to find them, funded by U.S. ACL/NIDILRR.',
              keywords: ['assistive technology', 'adaptive equipment', 'disability', 'accessibility'],
      },
      {
              name: 'United Spinal Association',
              url: 'https://www.unitedspinal.org/',
              description: 'Resources and equipment assistance for spinal cord injury and wheelchair users.',
              keywords: ['wheelchair', 'spinal cord', 'adaptive', 'mobility'],
      },
        ],
    food: [
      {
              name: 'Feeding America',
              url: 'https://www.feedingamerica.org/find-your-local-foodbank',
              description: 'Find local food banks, food pantries, and meal programs nationwide.',
              keywords: ['food', 'food bank', 'pantry', 'meals', 'hunger'],
      },
      {
              name: 'USDA Food Programs',
              url: 'https://www.fns.usda.gov/programs',
              description: 'Federal food assistance programs including SNAP, WIC, school meals, and commodity programs.',
              keywords: ['food', 'snap', 'wic', 'school meals', 'usda'],
      },
        ],
    food_truck: [
      {
        name: 'SBA Small Business Grants & Loans',
        url: 'https://www.sba.gov/funding-programs',
        description: 'SBA funding programs for starting or expanding a small business, including food trucks and mobile food vendors.',
        keywords: ['food truck', 'small business', 'sba', 'startup', 'mobile food'],
      },
      {
        name: 'SCORE Mentoring for Small Business',
        url: 'https://www.score.org/',
        description: 'Free mentoring and resources for small business owners including food truck operators.',
        keywords: ['food truck', 'small business', 'mentoring', 'startup'],
      },
      {
        name: 'Grants.gov Business Opportunities',
        url: 'https://www.grants.gov/search-grants?fundingCategories=BC',
        description: 'Federal grant opportunities for Business and Commerce, including food service and mobile vendor programs.',
        keywords: ['food truck', 'small business', 'grant', 'federal', 'commerce'],
      },
      {
        name: 'FedEx Small Business Grant Contest',
        url: 'https://www.fedex.com/en-us/small-business/grant-contest.html',
        description: 'Annual grant contest for small businesses. Food trucks and mobile food businesses are eligible.',
        keywords: ['food truck', 'small business', 'grant', 'contest'],
      },
    ],
  small_business: [
      {
        name: 'SBA Funding Programs',
        url: 'https://www.sba.gov/funding-programs',
        description: 'U.S. Small Business Administration funding programs including grants, loans, and investment capital.',
        keywords: ['small business', 'sba', 'startup', 'entrepreneur', 'funding'],
      },
      {
        name: 'Grants.gov Business & Commerce',
        url: 'https://www.grants.gov/search-grants?fundingCategories=BC',
        description: 'Federal grants for business and commerce development.',
        keywords: ['small business', 'grant', 'federal', 'commerce'],
      },
      {
        name: 'SCORE Free Business Mentoring',
        url: 'https://www.score.org/',
        description: 'Free mentoring, workshops, and resources for small business owners and entrepreneurs.',
        keywords: ['small business', 'mentoring', 'entrepreneur', 'startup'],
      },
      {
        name: 'Minority Business Development Agency',
        url: 'https://www.mbda.gov/',
        description: 'Resources and support for minority-owned businesses including grants, contracts, and capital.',
        keywords: ['small business', 'minority', 'grant', 'minority-owned'],
      },
    ],
    clothing: [
      {
              name: 'Dress for Success',
              url: 'https://dressforsuccess.org/',
              description: 'Professional clothing and career development for women entering or re-entering the workforce.',
              keywords: ['clothing', 'professional', 'women', 'career', 'interview'],
      },
      {
              name: 'Career Wardrobe',
              url: 'https://www.careerwardrobe.org/',
              description: 'Free professional and casual clothing for individuals transitioning to independence.',
              keywords: ['clothing', 'professional', 'free', 'workforce'],
      },
        ],
}

/**
   * Parse the item request to extract what's being asked for and build search queries.
   */
function parseItemRequest(request) {
    if (!request || typeof request !== 'string') {
          return { raw: '', type: 'general', categories: [], searchQueries: [] }
    }

  const lower = request.toLowerCase().trim()
    const categories = []
        const searchQueries = []

            // Detect categories
            const categoryMap = {
                  vehicle: ['van', 'bus', 'vehicle', 'car', 'truck', 'automobile', 'passenger', 'transport'],
                  van: ['van', '15 passenger', '15-passenger', 'cargo van', 'minivan', 'sprinter'],
                  technology: ['computer', 'laptop', 'software', 'printer', 'technology', 'tablet', 'ipad', 'chromebook', 'server'],
                  equipment: ['equipment', 'machine', 'tool', 'device', 'generator', 'mower', 'tractor'],
                  training: ['class', 'training', 'course', 'certification', 'cpr', 'first aid', 'osha', 'license'],
                  furniture: ['furniture', 'desk', 'chair', 'table', 'cabinet', 'bed', 'mattress', 'couch'],
                  medical_equipment: ['medical equipment', 'hospital bed', 'oxygen', 'nebulizer', 'stethoscope', 'wheelchair', 'walker', 'crutch'],
                  adaptive_equipment: ['adaptive', 'assistive', 'wheelchair ramp', 'stairlift', 'hearing aid', 'braille'],
                  food_truck: ['food truck', 'food cart', 'mobile food', 'food vendor', 'catering business', 'food trailer'],
    small_business: ['small business', 'startup', 'entrepreneur', 'business funding', 'business grant', 'sba'],
    food: ['food', 'groceries', 'meals', 'pantry', 'nutrition'],
                  clothing: ['clothing', 'clothes', 'uniform', 'suit', 'professional attire', 'work clothes'],
            }

  for (const [category, keywords] of Object.entries(categoryMap)) {
        if (keywords.some(kw => lower.includes(kw))) {
                categories.push(category)
        }
  }

  if (categories.length === 0) {
        categories.push('general')
  }

  // Build search queries from the actual item request
  // Primary query: exactly what was asked for + "free" or "donation" or "grant"
  searchQueries.push(`free ${request}`)
    searchQueries.push(`${request} donation program`)
    searchQueries.push(`${request} grant assistance`)
    searchQueries.push(`${request} nonprofit`)

  return {
        raw: request,
        type: categories[0],
        categories,
        searchQueries,
  }
}

/**
 * Search the web for real sources matching the item request.
 * Uses Google search scraping to find real organizations.
 */
async function searchWebForItem(itemRequest, profile) {
    const results = []
        const seenUrls = new Set()
    const signals = profile?.signals

  // Build targeted search queries
  const queries = []

      // Base queries from the item itself
      queries.push(`"${itemRequest}" free program`)
    queries.push(`"${itemRequest}" donation nonprofit`)
    queries.push(`"${itemRequest}" grant funding`)

  // Profile-enhanced queries
  const state = signals?.location?.state
    if (state) {
          queries.push(`"${itemRequest}" free ${state}`)
          queries.push(`"${itemRequest}" program ${state}`)
    }

  // Demographic-enhanced queries
  if (signals?.military?.size > 0) {
        queries.push(`"${itemRequest}" veteran`)
  }
    if (signals?.assistance?.has('low_income')) {
          queries.push(`"${itemRequest}" low income`)
    }
    if (signals?.health?.size > 0) {
          queries.push(`"${itemRequest}" disability`)
    }

  // Run searches (cap at 6 to stay within timeout)
  const searchPromises = queries.slice(0, 6).map(async (query) => {
        try {
                const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`

          const response = await getWithRetry(
                    searchUrl,
            {
                        headers: {
                                      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                                      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                                      'Accept-Language': 'en-US,en;q=0.5',
                        },
            },
            { timeoutMs: 8000, retries: 1 },
                  )

          if (!response?.data) return []

                  const $ = cheerio.load(response.data)
                const found = []

                        // DuckDuckGo HTML results
                        $('.result, .results_links').each((i, elem) => {
                                  if (i >= 8) return // Cap per query

                                                                  const $elem = $(elem)
                                  const titleElem = $elem.find('.result__title a, .result__a')
                                  const title = titleElem.text().trim()
                                  const href = titleElem.attr('href') || ''
                                  const snippet = $elem.find('.result__snippet').text().trim()

                                                                  if (!title || !href) return

                                                                  // Extract the actual URL from DuckDuckGo redirect
                                                                  let actualUrl = href
                                  if (href.includes('uddg=')) {
                                              try {
                                                            const urlParam = new URL(href, 'https://duckduckgo.com')
                                                            actualUrl = urlParam.searchParams.get('uddg') || href
                                              } catch {
                                                            actualUrl = href
                                              }
                                  }

                                                                  // Decode if needed
                                                                  try {
                                                                              actualUrl = decodeURIComponent(actualUrl)
                                                                  } catch {
                                                                              // keep as is
                                                                  }

                                                                  // Skip search engine results pages, ads, and non-useful URLs
                                                                  if (actualUrl.includes('google.com/search') ||
                                                                                  actualUrl.includes('bing.com/search') ||
                                                                                  actualUrl.includes('duckduckgo.com') ||
                                                                                  actualUrl.includes('youtube.com/watch') ||
                                                                                  actualUrl.includes('facebook.com') ||
                                                                                  actualUrl.includes('twitter.com') ||
                                                                                  actualUrl.includes('instagram.com') ||
                                                                                  actualUrl.includes('pinterest.com') ||
                                                                                  actualUrl.includes('amazon.com') ||
                                                                                  actualUrl.includes('ebay.com') ||
                                                                                  actualUrl.includes('walmart.com') ||
                                                                                  actualUrl.includes('target.com')) {
                                                                              return
                                                                  }

                                                                  // Skip if already seen
                                                                  const urlKey = actualUrl.toLowerCase().replace(/\/$/, '')
                                  if (seenUrls.has(urlKey)) return
                                  seenUrls.add(urlKey)

                                                                  found.push({
                                                                              title,
                                                                              url: actualUrl,
                                                                              description: snippet,
                                                                              _search_query: query,
                                                                  })
                        })

          return found
        } catch (error) {
                console.error(`[ItemFundingCrawler] Web search failed for "${query}":`, error.message)
                return []
        }
  })

  const settled = await Promise.allSettled(searchPromises)
    for (const result of settled) {
          if (result.status === 'fulfilled' && Array.isArray(result.value)) {
                  results.push(...result.value)
          }
    }

  return results
}

function finalizeItemResults(rows, { facets, queryPlan }) {
  return rows
    .map((row) =>
      enforceCrawlerOpportunityContract(row, {
        crawlerType: 'item_matching',
        facets,
        queryPlan,
        sourceFallback: row?.source ?? row?.sponsor ?? 'Item funding',
      }),
    )
    .filter(Boolean)
}

export async function crawlItemFunding(profileInput, options = {}) {
    const { profile, signals, facets, queryPlan: queryPlanFromContext } = resolveCrawlerContext(profileInput, options)
    const queryPlan =
        queryPlanFromContext ??
        planCrawlerQueries({
              crawlerType: 'item_matching',
              facets,
              location: facets?.geo ?? signals?.location ?? {},
        })
    const results = []
        const itemRequest = options.item_request

  if (!itemRequest) {
        console.log('[ItemFundingCrawler] No item request specified')
        return results
  }

    const searchKeywords = signals ? mergePlanKeywords(buildSearchKeywords(profile, 10), queryPlan).slice(0, 20) : []
        const parsed = parseItemRequest(itemRequest)

  console.log(`[ItemFundingCrawler] Searching for: "${itemRequest}"`)
    console.log(`[ItemFundingCrawler] Detected categories: ${parsed.categories.join(', ')}`)
    console.log(`[ItemFundingCrawler] Profile: ${profile.display_name || profile.name || 'Unknown'}`)

  const seenUrls = new Set()

  // === 1. KNOWN SOURCES for detected categories ===
  for (const category of parsed.categories) {
        const sources = KNOWN_ITEM_SOURCES[category] || []
              for (const source of sources) {
                      if (seenUrls.has(source.url)) continue
                      seenUrls.add(source.url)

          const opp = {
                    title: `${source.name} — ${category.replace(/_/g, ' ')}`,
                    sponsor: source.name,
                    description: source.description,
                    url: source.url,
                    application_url: source.url,
                    source_url: source.url,
                    amount_min: 0,
                    amount_max: 0,
                    amount_description: 'See source for program details',
                    deadline: null,
                    deadline_type: 'rolling',
                    eligibility: `See ${source.name} website for eligibility`,
                    is_national: true,
                    categories: [category, 'item_funding'],
                    keywords: [...(source.keywords || []), itemRequest.toLowerCase()],
                    opportunity_type: 'program',
                    item_requested: itemRequest,
          }

          // Apply centralized policy (URL, placeholder, loan, matching-funds) before scoring
          if (!enforceOpportunityPolicy(opp).ok) continue

          // Score using profile if available
          let matchScore = 60 // Base score for category match
          let reasons = [`Known source for ${category.replace(/_/g, ' ')}`]
                      let matchedSignals = []

                              if (signals) {
                                        const result = calculateMatchScore(opp, profile)
                                        matchScore = Math.max(matchScore, result.score)
                                        reasons = [...result.reasons, ...reasons]
                                        matchedSignals = result.matchedSignals || []
                              }

          results.push({
                    ...opp,
                    match_score: Math.min(100, matchScore + 10), // Category bonus
                    match_reasons: reasons,
                    matched_signals: matchedSignals,
                    crawler_type: 'item_funding',
                    source: source.name,
          })
              }
  }

  // === 2. LIVE WEB SEARCH for the specific item ===
  try {
        console.log(`[ItemFundingCrawler] Searching web for "${itemRequest}"...`)
        const rawWebResults = await searchWebForItem(itemRequest, profile)
        const webResults = Array.isArray(rawWebResults) ? rawWebResults : []

      console.log(`[ItemFundingCrawler] Web search found ${webResults.length} results`)

      for (const webResult of webResults) {
              const urlKey = (webResult.url || '').toLowerCase().replace(/\/$/, '')
              if (seenUrls.has(urlKey)) continue
              seenUrls.add(urlKey)

          const opp = {
                    title: webResult.title,
                    sponsor: extractDomain(webResult.url),
                    description: webResult.description || `Found via web search for "${itemRequest}"`,
                    url: webResult.url,
                    application_url: webResult.url,
                    source_url: webResult.url,
                    amount_min: 0,
                    amount_max: 0,
                    amount_description: 'See source for details',
                    deadline: null,
                    deadline_type: 'rolling',
                    eligibility: 'See source website',
                    is_national: true,
                    categories: [...parsed.categories, 'item_funding'],
                    keywords: [itemRequest.toLowerCase(), ...parsed.categories],
                    opportunity_type: 'program',
                    item_requested: itemRequest,
          }

          // Score: web results start lower and get boosted by profile match
          let matchScore = 50
              let reasons = [`Web search result for "${itemRequest}"`]
              let matchedSignals = []

                      if (signals) {
                                const result = calculateMatchScore(opp, profile)
                                matchScore = Math.max(matchScore, result.score)
                                reasons = [...result.reasons, ...reasons]
                                matchedSignals = result.matchedSignals || []
                      }

          // Boost if the title/description mentions the specific item
          const itemWords = itemRequest.toLowerCase().split(/\s+/).filter(w => w.length >= 3)
              const resultText = `${webResult.title} ${webResult.description}`.toLowerCase()
              const wordMatches = itemWords.filter(w => resultText.includes(w)).length
              const itemRelevance = itemWords.length > 0 ? wordMatches / itemWords.length : 0

          if (itemRelevance >= 0.5) {
                    matchScore = Math.min(100, matchScore + 15)
                    reasons.push(`High item relevance: ${Math.round(itemRelevance * 100)}% keyword match`)
          } else if (itemRelevance >= 0.25) {
                    matchScore = Math.min(100, matchScore + 8)
                    reasons.push(`Partial item relevance: ${Math.round(itemRelevance * 100)}% keyword match`)
          }

          if (matchScore >= 40) { // Lower threshold for web results - we want to show real finds
                results.push({
                            ...opp,
                            match_score: matchScore,
                            match_reasons: reasons,
                            matched_signals: matchedSignals,
                            crawler_type: 'item_funding',
                            source: 'Web Search',
                            _discovery_method: 'web_search',
                })
          }
      }
  } catch (error) {
        console.error(`[ItemFundingCrawler] Web search error:`, error.message)
  }

  // Sort by match score
  results.sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))

  // Cap results
  const capped = results.slice(0, 30)

  console.log(`[ItemFundingCrawler] Found ${capped.length} real sources for "${itemRequest}"`)
    return finalizeItemResults(capped, { facets, queryPlan })
}

function extractDomain(url) {
    try {
          const parsed = new URL(url)
          return parsed.hostname.replace('www.', '')
    } catch {
          return 'Unknown'
    }
}

function isLoan(opportunity) {
    const loanKeywords = ['loan', 'financing', 'lease', 'payment plan', 'interest rate']
    const text = `${opportunity.title} ${opportunity.description}`.toLowerCase()
    return loanKeywords.some(keyword => text.includes(keyword))
}

export { searchWebForItem, KNOWN_ITEM_SOURCES, parseItemRequest }
export default { crawlItemFunding, searchWebForItem, KNOWN_ITEM_SOURCES, parseItemRequest }

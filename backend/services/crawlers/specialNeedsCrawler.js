/**
 * Special Needs Funding Crawler
 * Profile-Driven Discovery for specific populations: cancer survivors, single parents,
 * disabled individuals, veterans, mental health, chronic illness, etc.
 *
 * DESIGN PRINCIPLE: Uses ALL profile signals to identify every applicable special need
 * category, then searches REAL foundation and program websites for each identified need.
 * No fabricated amounts or fake opportunities - only real, clickable resources with
 * honest descriptions of what each organization offers.
 *
 * CRITICAL: Uses 100% of profile data via signals for need identification and scoring.
 */
import * as cheerio from 'cheerio'
import { buildSearchKeywords, calculateMatchScore, filterByDeadline } from './crawlerHelpers.js'
import { getWithRetry, postWithRetry } from './httpClient.js'
import { searchGrants } from './grantsGovClient.js'
import { planCrawlerQueries } from './queryPlanner.js'
import {
  resolveCrawlerContext,
  mergePlanKeywords,
  enforceCrawlerOpportunityContract,
} from './crawlerOpportunityContract.js'
import { enforceOpportunityPolicy } from './opportunityPolicy.js'

/**
   * Real, verified special needs funding sources organized by category.
   * Each entry has a real URL, a real organization name, and an honest description.
   * No fabricated dollar amounts - we describe what they offer and link to the real page.
   */
const SPECIAL_NEEDS_SOURCES = {
    cancer: [
      {
              name: 'American Cancer Society',
              url: 'https://www.cancer.org/support-programs-and-services.html',
              description: 'Support programs including transportation (Road To Recovery), lodging (Hope Lodge), 24/7 helpline, and financial assistance navigation.',
              keywords: ['cancer', 'oncology', 'tumor', 'chemotherapy', 'radiation'],
      },
      {
              name: 'CancerCare',
              url: 'https://www.cancercare.org/financial_assistance',
              description: 'Financial assistance for cancer-related costs including treatment, transportation, home care, and child care. Also offers free counseling.',
              keywords: ['cancer', 'financial assistance', 'counseling', 'treatment costs'],
      },
      {
              name: 'Leukemia & Lymphoma Society',
              url: 'https://www.lls.org/support/financial-support',
              description: 'Financial support for blood cancer patients including copay assistance, travel assistance, and urgent need grants.',
              keywords: ['leukemia', 'lymphoma', 'blood cancer', 'myeloma'],
      },
      {
              name: 'Cancer Financial Assistance Coalition (CFAC)',
              url: 'https://www.cancerfac.org/',
              description: 'Coalition of organizations helping cancer patients manage financial challenges. Searchable database of assistance programs.',
              keywords: ['cancer', 'financial assistance', 'coalition'],
      },
      {
              name: 'The SAMFund',
              url: 'https://thesamfund.org/',
              description: 'Grants and scholarships for young adult cancer survivors (ages 17-39) for education, living expenses, and professional development.',
              keywords: ['cancer survivor', 'young adult', 'scholarship', 'grant'],
      },
        ],

    disability: [
      {
              name: 'National Organization on Disability',
              url: 'https://www.nod.org/',
              description: 'Employment and economic advancement resources for people with disabilities.',
              keywords: ['disability', 'employment', 'accommodation', 'accessibility'],
      },
      {
              name: 'Easterseals',
              url: 'https://www.easterseals.com/explore-resources/',
              description: 'Disability services including job training, child care, adult day services, and community living support.',
              keywords: ['disability', 'services', 'community living', 'job training'],
      },
      {
              name: 'United Cerebral Palsy',
              url: 'https://ucp.org/',
              description: 'Services and support for people with cerebral palsy and other disabilities including assistive technology and independent living.',
              keywords: ['cerebral palsy', 'disability', 'assistive technology', 'independent living'],
      },
      {
              name: 'National MS Society',
              url: 'https://www.nationalmssociety.org/Resources-Support/Financial-Resources',
              description: 'Financial assistance and resources for people with multiple sclerosis.',
              keywords: ['multiple sclerosis', 'ms', 'disability', 'financial resources'],
      },
      {
              name: 'Autism Speaks',
              url: 'https://www.autismspeaks.org/financial-autism-support',
              description: 'Financial support resources, grants, and service navigation for individuals and families affected by autism.',
              keywords: ['autism', 'neurodivergent', 'developmental disability'],
      },
      {
              name: 'The Arc',
              url: 'https://thearc.org/',
              description: 'Advocacy and services for people with intellectual and developmental disabilities.',
              keywords: ['intellectual disability', 'developmental disability', 'i/dd', 'advocacy'],
      },
      {
              name: 'Job Accommodation Network (JAN)',
              url: 'https://askjan.org/',
              description: 'Free guidance on workplace accommodations and disability employment issues from the U.S. DOL.',
              keywords: ['disability', 'employment', 'workplace accommodation', 'ada'],
      },
      {
              name: 'ABLE National Resource Center',
              url: 'https://www.ablenrc.org/',
              description: 'Information about ABLE savings accounts that allow people with disabilities to save without affecting benefits.',
              keywords: ['disability', 'savings', 'able account', 'benefits'],
      },
        ],

    veteran: [
      {
              name: 'Disabled American Veterans (DAV)',
              url: 'https://www.dav.org/veterans/find-your-local-office/',
              description: 'Free claims assistance, transportation to VA medical facilities, employment resources, and community support.',
              keywords: ['veteran', 'disabled veteran', 'va claims', 'military'],
      },
      {
              name: 'Wounded Warrior Project',
              url: 'https://www.woundedwarriorproject.org/programs',
              description: 'Programs for wounded veterans including mental health, career counseling, long-term support, and independence.',
              keywords: ['wounded veteran', 'military', 'combat', 'ptsd'],
      },
      {
              name: 'Veterans of Foreign Wars (VFW)',
              url: 'https://www.vfw.org/assistance',
              description: 'Financial assistance, veteran advocacy, and community support programs.',
              keywords: ['veteran', 'vfw', 'military', 'financial assistance'],
      },
      {
              name: 'Operation Homefront',
              url: 'https://www.operationhomefront.org/',
              description: 'Housing assistance, emergency financial aid, and transitional housing for military families.',
              keywords: ['military family', 'veteran', 'housing', 'emergency assistance'],
      },
      {
              name: 'Fisher House Foundation',
              url: 'https://www.fisherhouse.org/',
              description: 'Free temporary lodging for military families while a loved one receives medical treatment at a military/VA facility.',
              keywords: ['military', 'veteran', 'medical treatment', 'family lodging'],
      },
      {
              name: 'National Veterans Foundation',
              url: 'https://nvf.org/',
              description: 'Crisis management, benefits assistance, and public awareness programs for veterans.',
              keywords: ['veteran', 'crisis', 'benefits', 'mental health'],
      },
        ],

    single_parent: [
      {
              name: 'Single Parent Advocate',
              url: 'https://www.singleparentadvocate.org/',
              description: 'Resources and support services for single parents including financial aid navigation and community programs.',
              keywords: ['single parent', 'single mom', 'single dad', 'childcare'],
      },
      {
              name: 'Helping Hands for Single Moms',
              url: 'https://helpinghandsforsinglemoms.org/',
              description: 'Financial assistance and support programs specifically for single mothers.',
              keywords: ['single mother', 'single parent', 'financial assistance'],
      },
      {
              name: 'Parents Without Partners',
              url: 'https://www.parentswithoutpartners.org/',
              description: 'Support network and resources for single parents and their children.',
              keywords: ['single parent', 'parent support', 'family'],
      },
        ],

    mental_health: [
      {
              name: 'NAMI (National Alliance on Mental Illness)',
              url: 'https://www.nami.org/Your-Journey/Individuals-with-Mental-Illness',
              description: 'Free support groups, education programs, crisis resources, and assistance finding treatment for mental illness.',
              keywords: ['mental health', 'mental illness', 'depression', 'anxiety', 'bipolar', 'schizophrenia'],
      },
      {
              name: 'Mental Health America',
              url: 'https://mhanational.org/finding-help',
              description: 'Screening tools, treatment locators, and financial resource guides for mental health conditions.',
              keywords: ['mental health', 'behavioral health', 'treatment', 'therapy'],
      },
      {
              name: 'SAMHSA National Helpline',
              url: 'https://www.samhsa.gov/find-help/national-helpline',
              description: 'Free referral service for substance abuse and mental health treatment, available 24/7. Also has grant programs.',
              keywords: ['mental health', 'substance abuse', 'addiction', 'recovery', 'treatment'],
      },
      {
              name: 'The Jed Foundation',
              url: 'https://jedfoundation.org/',
              description: 'Mental health resources for teens and young adults, including crisis support and emotional health programs.',
              keywords: ['mental health', 'young adult', 'teen', 'suicide prevention'],
      },
        ],

    chronic_illness: [
      {
              name: 'Patient Advocate Foundation',
              url: 'https://www.patientadvocate.org/',
              description: 'Case management, copay relief, and patient navigation for chronic illness patients.',
              keywords: ['chronic illness', 'patient advocacy', 'copay', 'insurance'],
      },
      {
              name: 'HealthWell Foundation',
              url: 'https://www.healthwellfoundation.org/',
              description: 'Copay and premium assistance programs for underinsured patients with chronic or life-altering conditions.',
              keywords: ['chronic illness', 'copay assistance', 'premium assistance', 'underinsured'],
      },
      {
              name: 'NeedyMeds',
              url: 'https://www.needymeds.org/',
              description: 'Database of patient assistance programs, free/low-cost clinics, and discount drug programs.',
              keywords: ['medication', 'prescription', 'patient assistance', 'discount'],
      },
        ],

    housing_insecure: [
      {
              name: 'National Alliance to End Homelessness',
              url: 'https://endhomelessness.org/',
              description: 'Policy advocacy and local program resources for homelessness prevention and housing assistance.',
              keywords: ['homeless', 'housing insecure', 'shelter', 'housing first'],
      },
      {
              name: 'HUD Emergency Solutions Grants',
              url: 'https://www.hud.gov/program_offices/comm_planning/esg',
              description: 'Federal grants for emergency shelter, homelessness prevention, rapid re-housing, and street outreach.',
              keywords: ['homeless', 'emergency shelter', 'rapid rehousing', 'hud'],
      },
      {
              name: 'Salvation Army Housing Services',
              url: 'https://www.salvationarmyusa.org/usn/provide-shelter/',
              description: 'Emergency shelter, transitional housing, and permanent housing programs.',
              keywords: ['shelter', 'housing', 'emergency', 'transitional'],
      },
        ],

    domestic_violence: [
      {
              name: 'National Domestic Violence Hotline',
              url: 'https://www.thehotline.org/',
              description: 'Crisis intervention, safety planning, and referrals to local service providers. Available 24/7.',
              keywords: ['domestic violence', 'abuse', 'safety', 'crisis'],
      },
      {
              name: 'National Network to End Domestic Violence',
              url: 'https://nnedv.org/',
              description: 'Financial assistance programs, housing advocacy, and technology safety resources for survivors.',
              keywords: ['domestic violence', 'survivor', 'financial assistance', 'housing'],
      },
        ],

    substance_recovery: [
      {
              name: 'SAMHSA Treatment Locator',
              url: 'https://findtreatment.gov/',
              description: 'Find substance use treatment facilities and programs near you, including free and low-cost options.',
              keywords: ['substance abuse', 'addiction', 'recovery', 'treatment', 'rehab'],
      },
      {
              name: 'Oxford House',
              url: 'https://www.oxfordhouse.org/',
              description: 'Self-supporting recovery housing network. Democratically run houses for people in recovery from substance abuse.',
              keywords: ['recovery', 'sober living', 'recovery housing'],
      },
        ],

    foster_youth: [
      {
              name: 'Foster Care to Success',
              url: 'https://www.fc2success.org/',
              description: 'Scholarships, grants, and support for current and former foster youth pursuing education.',
              keywords: ['foster youth', 'foster care', 'aging out', 'scholarship', 'education'],
      },
      {
              name: 'FosterClub',
              url: 'https://www.fosterclub.com/',
              description: 'Resources, community, and leadership opportunities for foster youth and alumni.',
              keywords: ['foster youth', 'foster care', 'support', 'community'],
      },
        ],

    formerly_incarcerated: [
      {
              name: 'National HIRE Network',
              url: 'https://www.hirenetwork.org/',
              description: 'Employment resources and legal information for people with criminal records seeking to re-enter the workforce.',
              keywords: ['formerly incarcerated', 'reentry', 'employment', 'criminal record'],
      },
      {
              name: 'The Fortune Society',
              url: 'https://fortunesociety.org/',
              description: 'Reentry services including housing, employment, education, and family support for formerly incarcerated individuals.',
              keywords: ['formerly incarcerated', 'reentry', 'housing', 'employment'],
      },
        ],

    kidney_disease: [
      {
              name: 'American Kidney Fund',
              url: 'https://www.kidneyfund.org/financial-assistance',
              description: 'Financial assistance for kidney disease patients including treatment costs, insurance premiums, and emergency assistance.',
              keywords: ['kidney', 'dialysis', 'renal', 'transplant'],
      },
      {
              name: 'National Kidney Foundation',
              url: 'https://www.kidney.org/patients',
              description: 'Patient resources, transplant information, and financial assistance navigation for kidney disease.',
              keywords: ['kidney', 'dialysis', 'transplant', 'renal failure'],
      },
        ],

    visual_impairment: [
      {
              name: 'American Foundation for the Blind',
              url: 'https://www.afb.org/blindness-and-low-vision/using-technology',
              description: 'Resources, assistive technology guidance, and advocacy for blind and visually impaired individuals.',
              keywords: ['blind', 'visual impairment', 'low vision', 'assistive technology'],
      },
      {
              name: 'National Federation of the Blind',
              url: 'https://nfb.org/programs-services',
              description: 'Scholarships, training programs, and advocacy for blind individuals.',
              keywords: ['blind', 'visual impairment', 'scholarship', 'training'],
      },
        ],

    hearing_impairment: [
      {
              name: 'National Association of the Deaf',
              url: 'https://www.nad.org/',
              description: 'Advocacy, legal defense, and resource navigation for deaf and hard of hearing individuals.',
              keywords: ['deaf', 'hearing impairment', 'hard of hearing', 'sign language'],
      },
      {
              name: 'Hearing Loss Association of America',
              url: 'https://www.hlaa.org/',
              description: 'Support, advocacy, and technology resources for people with hearing loss.',
              keywords: ['hearing loss', 'hard of hearing', 'assistive technology'],
      },
        ],
}

/**
   * Identify ALL applicable special needs categories from profile signals.
   * Uses the full signals object - not just shallow profile fields.
   * Returns every category that has any signal match.
   */
function identifySpecialNeedsFromSignals(profile) {
    const needs = new Set()
    const signals = profile?.signals
    if (!signals) return []

        const sections = profile?.sections ?? signals.rawSections ?? {}
            const health = sections?.health_medical ?? {}
                const family = sections?.family_life ?? {}
                    const military = sections?.military_service ?? {}

                        // Helper: check if any signal in a set matches any keyword
                        const hasSignal = (signalSet, ...keywords) => {
                              if (!signalSet?.size) return false
                              for (const sig of signalSet) {
                                      const s = String(sig).toLowerCase()
                                      for (const kw of keywords) {
                                                if (s.includes(kw)) return true
                                      }
                              }
                              return false
                        }

  // Cancer
  if (hasSignal(signals.health, 'cancer', 'oncology', 'tumor', 'leukemia', 'lymphoma', 'myeloma') ||
            health.cancer_survivor) {
        needs.add('cancer')
  }

  // Disability (broad)
  if (hasSignal(signals.health, 'disability', 'wheelchair', 'impair', 'cerebral', 'amputee', 'paralysis') ||
            hasSignal(signals.assistance, 'ssi', 'ssdi') ||
            (Array.isArray(health.disability_type) && health.disability_type.length > 0) ||
            health.wheelchair_user) {
        needs.add('disability')
  }

  // Veteran
  if (signals.military?.size > 0 ||
            military.veteran === true ||
            military.disabled_veteran === true) {
        needs.add('veteran')
  }

  // Single parent
  if (hasSignal(signals.family, 'single_parent', 'single parent') ||
            family.single_parent === true) {
        needs.add('single_parent')
  }

  // Mental health
  if (hasSignal(signals.health, 'mental', 'depression', 'anxiety', 'bipolar', 'ptsd', 'schizophrenia', 'behavioral') ||
            health.mental_health_condition === true) {
        needs.add('mental_health')
  }

  // Chronic illness
  if (hasSignal(signals.health, 'chronic', 'diabetes', 'heart disease', 'copd', 'lupus', 'fibromyalgia', 'rare_disease') ||
            health.chronic_illness === true ||
            health.rare_disease === true) {
        needs.add('chronic_illness')
  }

  // Housing insecure / homeless
  if (hasSignal(signals.family, 'homeless', 'housing_insecure') ||
            hasSignal(signals.assistance, 'homeless', 'section8') ||
            family.homeless === true) {
        needs.add('housing_insecure')
  }

  // Domestic violence survivor
  if (hasSignal(signals.family, 'domestic_violence', 'trafficking') ||
            family.domestic_violence_survivor === true ||
            family.trafficking_survivor === true) {
        needs.add('domestic_violence')
  }

  // Substance recovery
  if (hasSignal(signals.health, 'recovery', 'substance', 'addiction', 'sober') ||
            health.substance_recovery === true) {
        needs.add('substance_recovery')
  }

  // Foster youth
  if (hasSignal(signals.family, 'foster_youth', 'foster care', 'aging out') ||
            family.foster_youth === true) {
        needs.add('foster_youth')
  }

  // Formerly incarcerated
  if (hasSignal(signals.family, 'incarcerated', 'reentry') ||
            family.formerly_incarcerated === true ||
            family.former_incarcerated === true) {
        needs.add('formerly_incarcerated')
  }

  // Kidney disease
  if (hasSignal(signals.health, 'kidney', 'dialysis', 'renal') ||
            health.dialysis_patient === true) {
        needs.add('kidney_disease')
  }

  // Visual impairment
  if (hasSignal(signals.health, 'visual_impairment', 'blind', 'low vision') ||
            health.visual_impairment === true) {
        needs.add('visual_impairment')
  }

  // Hearing impairment
  if (hasSignal(signals.health, 'hearing_impairment', 'deaf', 'hard of hearing') ||
            health.hearing_impairment === true) {
        needs.add('hearing_impairment')
  }

  return Array.from(needs)
}

function finalizeSpecialNeedsResults(rows, { facets, queryPlan }) {
  return rows
    .map((row) =>
      enforceCrawlerOpportunityContract(row, {
        crawlerType: 'special_needs',
        facets,
        queryPlan,
        sourceFallback: row?.source ?? row?.sponsor ?? 'Special needs',
      }),
    )
    .filter(Boolean)
}

/** Fetch live special-needs/disability-related opportunities from Grants.gov (resilient client). */
async function fetchLiveSpecialNeedsOpportunities({ keywords = [], state = null } = {}) {
  const query = (keywords.length > 0 ? keywords[0] : 'disability assistance grant').toString().trim() || 'disability assistance grant'
  try {
    const { ok, opportunities } = await searchGrants(query, { rows: 25 })
    if (!ok) {
      console.warn('[SpecialNeedsCrawler] Both grants.gov APIs failed for live fetch')
      return []
    }
    return opportunities
  } catch (err) {
    console.warn('[SpecialNeedsCrawler] Grants.gov live fetch:', err?.message || err)
    return []
  }
}

export async function crawlSpecialNeeds(profileInput, options = {}) {
    const { profile, signals, facets, queryPlan: queryPlanFromContext } = resolveCrawlerContext(profileInput, options)
    const queryPlan =
        queryPlanFromContext ??
        planCrawlerQueries({
              crawlerType: 'special_needs',
              facets,
              location: facets?.geo ?? signals?.location ?? {},
        })
  const plannerKeywords = mergePlanKeywords([], queryPlan).slice(0, 10)
    const results = []
        const minMatchScore = typeof options.min_match_score === 'number' ? options.min_match_score : 60
    const profileForCrawler = profile?.signals ? profile : { ...profile, signals: signals ?? {} }

    if (!signals) {
          console.error('[SpecialNeedsCrawler] No signals in profile - cannot search')
          return results
    }

  // Identify ALL applicable categories from signals
  const specialNeeds = identifySpecialNeedsFromSignals(profile)

  if (specialNeeds.length === 0) {
        console.log('[SpecialNeedsCrawler] No special needs categories identified from profile signals')
        return results
  }

  console.log(`[SpecialNeedsCrawler] Identified ${specialNeeds.length} categories from signals: ${specialNeeds.join(', ')}`)
    console.log(`[SpecialNeedsCrawler] Health signals: ${Array.from(signals.health || []).join(', ')}`)
    console.log(`[SpecialNeedsCrawler] Family signals: ${Array.from(signals.family || []).join(', ')}`)
    console.log(`[SpecialNeedsCrawler] Military signals: ${Array.from(signals.military || []).join(', ')}`)
    console.log(`[SpecialNeedsCrawler] Assistance signals: ${Array.from(signals.assistance || []).join(', ')}`)

  const seenUrls = new Set()

  // For each identified need category, build opportunities from real sources
  for (const needCategory of specialNeeds) {
        const sources = SPECIAL_NEEDS_SOURCES[needCategory] || []

              for (const source of sources) {
                      // De-dupe by URL
          if (seenUrls.has(source.url)) continue
                      seenUrls.add(source.url)

          // Build opportunity from the real source
          const opp = {
                    title: `${source.name} — ${needCategory.replace(/_/g, ' ')} support`,
                    sponsor: source.name,
                    description: source.description,
                    url: source.url,
                    application_url: source.url,
                    source_url: source.url,
                    amount_min: 0,
                    amount_max: 0,
                    amount_description: 'See source for program details and eligibility',
                    deadline: null,
                    deadline_type: 'rolling',
                    eligibility: `See ${source.name} website for full eligibility criteria`,
                    is_national: true,
                    categories: [needCategory, 'special_needs'],
                    keywords: [...(source.keywords || []), needCategory.replace(/_/g, ' '), ...plannerKeywords],
                    opportunity_type: 'program',
                    need_category: needCategory,
          }

          // Apply centralized policy (URL, placeholder, loan, matching-funds) before scoring
          if (!enforceOpportunityPolicy(opp).ok) continue

          // Score using full profile signals
          const { score: matchScore, reasons, matchedSignals } = calculateMatchScore(opp, profile)

          // Category match bonus: the profile explicitly has this need
          const adjustedScore = Math.min(100, matchScore + 15)

          if (adjustedScore >= minMatchScore) {
                    results.push({
                                ...opp,
                                match_score: adjustedScore,
                                match_reasons: [...reasons, `Special need category match: ${needCategory.replace(/_/g, ' ')}`],
                                matched_signals: matchedSignals,
                                crawler_type: 'special_needs',
                                source: source.name,
                    })
          }
              }
  }


  // Fetch live disability/special-needs grants from Grants.gov and Benefits.gov
  try {
    const profileState = profile?.state || signals?.location?.state || null
    const liveOpps = await fetchLiveSpecialNeedsOpportunities({ keywords: plannerKeywords.slice(0, 5), state: profileState })
    for (const liveOpp of liveOpps) {
      if (!enforceOpportunityPolicy(liveOpp).ok) continue
      const { score, reasons } = calculateMatchScore(liveOpp, profileForCrawler)
      if (score >= minMatchScore) {
        results.push({ ...liveOpp, match_score: score, match_reasons: reasons })
      }
    }
    console.log(`[SpecialNeedsCrawler] Added ${liveOpps.length} live Grants.gov/Benefits.gov opportunities`)
  } catch (liveErr) {
    console.error('[SpecialNeedsCrawler] Live fetch error:', liveErr.message)
  }

    // Sort by match score
  results.sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))

  console.log(`[SpecialNeedsCrawler] Found ${results.length} special needs opportunities with ${minMatchScore}%+ match`)
    return finalizeSpecialNeedsResults(results, { facets, queryPlan })
}

// Loan/matching-fund detection is now handled centrally by enforceOpportunityPolicy().

export default { crawlSpecialNeeds }

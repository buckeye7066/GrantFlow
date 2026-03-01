/**
 * Health Resources Crawler
 *
 * Goal:
 * - Provide reputable, informational health support resources (link-only when no structured program data exists).
 * - Use 100% of profile data via the signals object for matching/scoring (no shallow-only logic).
 * - Gate research studies/trials behind explicit consent_for_studies.
 *
 * Safety:
 * - Informational resources only. No diagnosis/treatment recommendations.
 */

import { calculateMatchScore, buildSearchKeywords } from './crawlerHelpers.js'
import { getWithRetry } from './httpClient.js'
import { searchGrants } from './grantsGovClient.js'
import { planCrawlerQueries } from './queryPlanner.js'
import {
  resolveCrawlerContext,
  mergePlanKeywords,
  enforceCrawlerOpportunityContract,
} from './crawlerOpportunityContract.js'

function normalizeString(value) {
  return String(value ?? '').trim()
}

function normalizeConditionNames(conditions) {
  if (!conditions) return []
  if (Array.isArray(conditions)) {
    return conditions
      .map((entry) => {
        if (!entry) return ''
        if (typeof entry === 'string') return entry
        if (typeof entry === 'object' && typeof entry.name === 'string') return entry.name
        return ''
      })
      .map((v) => normalizeString(v))
      .filter(Boolean)
  }
  if (typeof conditions === 'string') {
    return conditions
      .split(/[\n,;]+/)
      .map((v) => normalizeString(v))
      .filter(Boolean)
  }
  return []
}

function buildClinicalTrialsLinks({ conditionNames, state }) {
  const st = String(state || '').trim().toUpperCase()
  const base = 'https://clinicaltrials.gov/search'
  const conditions = Array.isArray(conditionNames) ? conditionNames.slice(0, 3) : []

  if (conditions.length === 0) {
    return [
      {
        title: st ? `ClinicalTrials.gov (near ${st})` : 'ClinicalTrials.gov (search)',
        url: st ? `${base}?locStr=${encodeURIComponent(st)}` : base,
        keywords: ['clinical trials', 'research studies', 'participants'],
      },
    ]
  }

  return conditions.map((name) => {
    const params = new URLSearchParams()
    params.set('cond', name)
    if (st) params.set('locStr', st)
    return {
      title: st ? `ClinicalTrials.gov: ${name} (near ${st})` : `ClinicalTrials.gov: ${name}`,
      url: `${base}?${params.toString()}`,
      keywords: ['clinical trials', 'research studies', 'participants', name],
    }
  })
}


/**
 * Fetch live health-related grant opportunities from Grants.gov (resilient client) and Benefits.gov.
 * Queries health-assistance keywords; Benefits.gov adds state-specific health programs.
 */
async function fetchLiveHealthOpportunities({ state, keywords = [], signals = {} }) {
  const results = []
  const baseKeyword = keywords.slice(0, 3).join(' ') || 'health assistance'

  try {
    const { ok, opportunities: grantOpps } = await searchGrants(baseKeyword, { rows: 25 })
    if (ok && Array.isArray(grantOpps)) {
      for (const opp of grantOpps.slice(0, 24)) {
        if (!opp?.title) continue
        results.push({
          title: opp.title,
          sponsor: opp.sponsor || 'Federal Agency',
          description: opp.description || 'Federal health assistance opportunity. Visit Grants.gov for eligibility and application details.',
          url: opp.url || opp.application_url || 'https://www.grants.gov',
          application_url: opp.application_url || opp.url || 'https://www.grants.gov',
          source_url: opp.source_url || opp.url || 'https://www.grants.gov',
          state: state || 'nationwide',
          is_national: true,
          opportunity_type: 'grant',
          deadline_type: opp.deadline_type || 'rolling',
          deadline: opp.deadline || null,
          categories: ['health', 'federal'],
          keywords: ['health', 'federal', 'grant', ...keywords.slice(0, 3)],
          source: 'grants.gov',
        })
      }
    } else if (!ok) {
      console.warn('[HealthResourcesCrawler] Grants.gov APIs failed for live fetch')
    }
  } catch (err) {
    console.error('[HealthResourcesCrawler] Grants.gov fetch error:', err.message)
  }

  // Also query Benefits.gov for health-related programs in the profile's state
  if (state) {
    try {
      const benefitsUrl = `https://www.benefits.gov/api/benefits?state=${encodeURIComponent(state)}&category=health&pageSize=10`
      const benefitsRes = await getWithRetry(benefitsUrl, {}, { timeoutMs: 15000, retries: 2 })
      const programs = benefitsRes?.data?.programs ?? benefitsRes?.data ?? []
      if (Array.isArray(programs)) {
        for (const prog of programs.slice(0, 8)) {
          if (!prog?.title && !prog?.name) continue
          results.push({
            title: prog.title || prog.name,
            sponsor: prog.agency || prog.agencyName || 'Benefits.gov',
            description: prog.summary || prog.description || 'State health assistance program. Visit Benefits.gov for eligibility details.',
            url: prog.url || `https://www.benefits.gov/benefit/${prog.id || ''}`,
            application_url: prog.applyUrl || prog.url || 'https://www.benefits.gov',
            source_url: prog.url || 'https://www.benefits.gov',
            state,
            is_national: false,
            opportunity_type: 'program',
            deadline_type: 'rolling',
            categories: ['health', 'state', 'assistance'],
            keywords: ['health', 'benefits', state, ...keywords.slice(0, 3)],
            source: 'benefits.gov',
          })
        }
      }
    } catch (err) {
      console.error('[HealthResourcesCrawler] Benefits.gov fetch error:', err.message)
    }
  }

  return results
}

export async function crawlHealthResources(profile, options = {}) {
  const { profile: resolvedProfile, signals, facets, queryPlan: queryPlanFromContext } = resolveCrawlerContext(
    profile,
    options,
  )
  profile = resolvedProfile
  const queryPlan =
    queryPlanFromContext ??
    planCrawlerQueries({
      crawlerType: 'health_resources',
      facets,
      location: facets?.geo ?? signals?.location ?? {},
    })
  const plannerKeywords = mergePlanKeywords([], queryPlan).slice(0, 12)
  const results = []
  const minMatchScore = typeof options.min_match_score === 'number' ? options.min_match_score : 60

  // Null/missing signals must not disqualify; use minimal fallback
  const effectiveSignals = signals ?? profile?.signals ?? {
    location: { state: profile?.state || null },
    keywordSet: new Set(),
    health: new Set(),
    demographics: new Set(),
  }
  const profileForCrawler = profile.signals ? profile : { ...profile, signals: effectiveSignals }

  const state = effectiveSignals.location?.state || profile.state || null
  const sections = profile?.sections || effectiveSignals.rawSections || {}
  const health = sections?.health_medical ?? {}

  const conditionNames = normalizeConditionNames(health?.conditions)
  const includeTrials =
    String(options.include_trials ?? '').toLowerCase() === 'true' ||
    options.include_trials === true ||
    Boolean(health?.consent_for_studies)

  const conditionBlob = conditionNames.join(' ').toLowerCase()

  const hasHiv = conditionBlob.includes('hiv') || conditionBlob.includes('aids')
  const hasTbi = conditionBlob.includes('tbi') || conditionBlob.includes('brain injury')
  const hasEpilepsy = conditionBlob.includes('epilepsy') || conditionBlob.includes('seizure')
    const hasCancer = conditionBlob.includes('cancer') || conditionBlob.includes('oncology') || conditionBlob.includes('tumor')
    const hasKidney = conditionBlob.includes('kidney') || conditionBlob.includes('dialysis') || conditionBlob.includes('renal')
  const hasNeurodivergent = conditionBlob.includes('autism') || conditionBlob.includes('adhd') || conditionBlob.includes('neurodiv')

  // Reputable, durable link-only resources (no mock amounts).
  const baseResources = [
    // Transportation
    {
      title: 'Medicaid: Non-Emergency Medical Transportation (NEMT)',
      sponsor: 'Medicaid.gov',
      description:
        'Informational overview of non-emergency medical transportation benefits and how states administer NEMT.',
      url: 'https://www.medicaid.gov/medicaid/benefits/assurance-of-transportation',
      categories: ['transportation_services', 'health_resources'],
      keywords: ['transportation', 'appointments', 'medicaid'],
      type: 'DIRECTORY',
      opportunity_type: 'benefit',
      is_national: true,
      state: 'nationwide',
    },
    {
      title: 'NeedyMeds: Transportation Assistance',
      sponsor: 'NeedyMeds',
      description:
        'Directory-style resource for medical transportation assistance and related support programs (informational listings).',
      url: 'https://www.needymeds.org/free_non_profit_clinics.taf?_function=transportation',
      categories: ['transportation_services', 'health_resources'],
      keywords: ['transportation', 'medical transportation', 'rides'],
      type: 'DIRECTORY',
      opportunity_type: 'benefit',
      is_national: true,
      state: 'nationwide',
    },
    {
      title: '211.org: Find local help (including transportation)',
      sponsor: '211',
      description: 'Local assistance directory. Search for transportation, caregiving support, and related services.',
      url: 'https://www.211.org/',
      categories: ['transportation_services', 'health_resources'],
      keywords: ['211', 'transportation', 'caregiver'],
      type: 'DIRECTORY',
      opportunity_type: 'directory',
      is_national: true,
      state: 'nationwide',
    },

    // Financial assistance / navigation
    {
      title: 'NeedyMeds: Patient Assistance Programs',
      sponsor: 'NeedyMeds',
      description:
        'Directory of patient assistance programs and discount resources (informational; eligibility varies).',
      url: 'https://www.needymeds.org/',
      categories: ['medical_financial_aid', 'health_resources'],
      keywords: ['patient assistance', 'copay', 'prescription assistance'],
      type: 'DIRECTORY',
      opportunity_type: 'benefit',
      is_national: true,
      state: 'nationwide',
    },
    {
      title: 'Patient Advocate Foundation',
      sponsor: 'Patient Advocate Foundation',
      description:
        'Case management and patient support navigation resources (informational).',
      url: 'https://www.patientadvocate.org/',
      categories: ['medical_financial_aid', 'health_resources'],
      keywords: ['case management', 'patient advocate', 'financial assistance'],
      type: 'DIRECTORY',
      opportunity_type: 'benefit',
      is_national: true,
      state: 'nationwide',
    },
    {
      title: 'HealthWell Foundation: Copay Assistance',
      sponsor: 'HealthWell Foundation',
      description:
        'Copay and premium assistance programs for eligible patients (informational).',
      url: 'https://www.healthwellfoundation.org/',
      categories: ['medical_financial_aid', 'health_resources'],
      keywords: ['copay assistance', 'premium assistance'],
      type: 'DIRECTORY',
      opportunity_type: 'benefit',
      is_national: true,
      state: 'nationwide',
    },
    {
      title: 'PAN Foundation: Copay Assistance',
      sponsor: 'PAN Foundation',
      description:
        'Copay assistance programs for eligible patients (informational).',
      url: 'https://www.panfoundation.org/',
      categories: ['medical_financial_aid', 'health_resources'],
      keywords: ['copay assistance', 'patient assistance'],
      type: 'DIRECTORY',
      opportunity_type: 'benefit',
      is_national: true,
      state: 'nationwide',
    },

    // Education (reputable sources)
    {
      title: 'MedlinePlus: Health Information',
      sponsor: 'U.S. National Library of Medicine (NIH)',
      description: 'Reliable patient education topics and resources (informational).',
      url: 'https://medlineplus.gov/',
      categories: ['patient_education', 'health_resources'],
      keywords: ['patient education', 'NIH', 'health information'],
      type: 'DIRECTORY',
      opportunity_type: 'directory',
      is_national: true,
      state: 'nationwide',
    },
    {
      title: 'CDC: Health Topics',
      sponsor: 'CDC',
      description: 'Public health education resources (informational).',
      url: 'https://www.cdc.gov/',
      categories: ['patient_education', 'health_resources'],
      keywords: ['CDC', 'health education'],
      type: 'DIRECTORY',
      opportunity_type: 'directory',
      is_national: true,
      state: 'nationwide',
    },

    // State enrichment (directory-style; not state-specific deep links)
    {
      title: 'Medicaid: Contact your state',
      sponsor: 'Medicaid.gov',
      description: 'State contact directory for Medicaid programs.',
      url: 'https://www.medicaid.gov/about-us/contact-us',
      categories: ['transportation_services', 'medical_financial_aid', 'health_resources'],
      keywords: ['medicaid', 'state contacts', state || 'state'],
      type: 'DIRECTORY',
      opportunity_type: 'directory',
      is_national: true,
      state: 'nationwide',
    },
  ]

  // Condition-aware additions (reputable, link-only).
  if (hasCancer) {
    baseResources.push(
      {
        title: 'American Cancer Society: Road To Recovery (rides to treatment)',
        sponsor: 'American Cancer Society',
        description: 'Transportation assistance program information (availability varies).',
        url: 'https://www.cancer.org/support-programs-and-services/road-to-recovery.html',
        categories: ['transportation_services', 'health_resources'],
        keywords: ['cancer', 'rides', 'transportation'],
        type: 'DIRECTORY',
        opportunity_type: 'benefit',
        is_national: true,
        state: 'nationwide',
      },
      {
        title: 'National Cancer Institute (NCI): Cancer Information',
        sponsor: 'NIH / NCI',
        description: 'Cancer education and guidance resources (informational).',
        url: 'https://www.cancer.gov/',
        categories: ['patient_education', 'health_resources'],
        keywords: ['cancer', 'oncology'],
        type: 'DIRECTORY',
        opportunity_type: 'directory',
        is_national: true,
        state: 'nationwide',
      },
    )
  }
  if (hasKidney) {
    baseResources.push({
      title: 'American Kidney Fund',
      sponsor: 'American Kidney Fund',
      description: 'Education and financial support resources for kidney disease (informational).',
      url: 'https://www.kidneyfund.org/',
      categories: ['medical_financial_aid', 'patient_education', 'health_resources'],
      keywords: ['kidney', 'dialysis', 'financial help'],
      type: 'DIRECTORY',
      opportunity_type: 'benefit',
      is_national: true,
      state: 'nationwide',
    })
  }
  if (hasHiv) {
    baseResources.push({
      title: 'AIDS United',
      sponsor: 'AIDS United',
      description: 'Resources and support navigation related to HIV (informational).',
      url: 'https://aidsunited.org/',
      categories: ['medical_financial_aid', 'patient_education', 'health_resources'],
      keywords: ['hiv', 'aids'],
      type: 'DIRECTORY',
      opportunity_type: 'directory',
      is_national: true,
      state: 'nationwide',
    })
  }
  if (hasEpilepsy) {
    baseResources.push({
      title: 'Epilepsy Foundation',
      sponsor: 'Epilepsy Foundation',
      description: 'Education and support resources for epilepsy (informational).',
      url: 'https://www.epilepsy.com/',
      categories: ['patient_education', 'health_resources'],
      keywords: ['epilepsy', 'seizures'],
      type: 'DIRECTORY',
      opportunity_type: 'directory',
      is_national: true,
      state: 'nationwide',
    })
  }
  if (hasTbi) {
    baseResources.push({
      title: 'CDC: Traumatic Brain Injury',
      sponsor: 'CDC',
      description: 'Education and resources about traumatic brain injury (informational).',
      url: 'https://www.cdc.gov/traumaticbraininjury/index.html',
      categories: ['patient_education', 'health_resources'],
      keywords: ['tbi', 'brain injury'],
      type: 'DIRECTORY',
      opportunity_type: 'directory',
      is_national: true,
      state: 'nationwide',
    })
  }
  if (hasNeurodivergent) {
    baseResources.push(
      {
        title: 'Autism Society',
        sponsor: 'Autism Society of America',
        description: 'Resources and education for autism (informational).',
        url: 'https://autismsociety.org/',
        categories: ['patient_education', 'health_resources'],
        keywords: ['autism', 'neurodivergent'],
        type: 'DIRECTORY',
        opportunity_type: 'directory',
        is_national: true,
        state: 'nationwide',
      },
      {
        title: 'Autistic Self Advocacy Network (ASAN)',
        sponsor: 'ASAN',
        description: 'Self-advocacy and informational resources (informational).',
        url: 'https://autisticadvocacy.org/',
        categories: ['patient_education', 'health_resources'],
        keywords: ['autism', 'self advocacy'],
        type: 'DIRECTORY',
        opportunity_type: 'directory',
        is_national: true,
        state: 'nationwide',
      },
    )
  }

  // Consent-gated research links.
  if (includeTrials) {
    const trialLinks = buildClinicalTrialsLinks({ conditionNames, state })
    trialLinks.forEach((link) => {
      baseResources.push({
        title: link.title,
        sponsor: 'ClinicalTrials.gov',
        description:
          'Research study/trial listing search (informational). Eligibility is determined by each study team.',
        url: link.url,
        categories: ['clinical_trials', 'health_resources'],
        // Use only resource-specific keywords for fair scoring.
        keywords: Array.from(new Set([...(link.keywords ?? []), ...plannerKeywords])),
        type: 'DIRECTORY',
        opportunity_type: 'directory',
        is_national: true,
        state: 'nationwide',
      })
    })
    baseResources.push({
      title: 'ResearchMatch: Volunteer Registry',
      sponsor: 'ResearchMatch',
      description: 'Volunteer registry connecting people with research studies (informational).',
      url: 'https://www.researchmatch.org/',
      categories: ['clinical_trials', 'health_resources'],
      keywords: ['research studies', 'participants'],
      type: 'DIRECTORY',
      opportunity_type: 'directory',
      is_national: true,
      state: 'nationwide',
    })
  }

  // Score + select deterministically, with a non-zero floor for directory-style resources.
  const scored = baseResources
    .map((opp) => {
      const keywords = Array.from(new Set([...(opp.keywords ?? []), ...plannerKeywords]))
      const { score, reasons } = calculateMatchScore(opp, profileForCrawler)
      return {
        ...opp,
        keywords,
        match_score: score,
        match_reasons: reasons,
        crawler_type: 'health_resources',
        // Normalize a few fields so downstream logic can attribute results consistently.
        source: opp.sponsor ?? 'Health resources',
        record_origin: 'directory:health_resources',
        is_directory_resource: true,
        source_url: opp.url,
        application_url: opp.url,
      }
    })
    .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))

  const thresholdCandidates = Array.from(new Set([minMatchScore, 80, 70, 60, 50, 0]))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => b - a)

  const targetMin = 6
  let selected = []
  for (const threshold of thresholdCandidates) {
    const candidate = scored.filter((row) => (row.match_score ?? 0) >= threshold)
    if (candidate.length >= targetMin || threshold === 0) {
      selected = candidate
      break
    }
  }

  // Ensure consent-gated trials are actually surfaced when opted in (deterministic).
  if (includeTrials) {
    const hasTrial = selected.some((row) => String(row.url || '').includes('clinicaltrials.gov'))
    if (!hasTrial) {
      const bestTrial = scored.find((row) => String(row.url || '').includes('clinicaltrials.gov')) ?? null
      if (bestTrial) {
        const deduped = []
        const seen = new Set()
        for (const row of [...selected, bestTrial]) {
          const key = String(row.url || row.source_url || row.application_url || row.title || '')
          if (!key || seen.has(key)) continue
          seen.add(key)
          deduped.push(row)
        }
        selected = deduped
      }
    }
  }

  // Cap output to keep UI readable; still deterministic.
  
  // Fetch live health opportunities from Grants.gov and Benefits.gov
  try {
    const profileState = resolvedProfile?.state || effectiveSignals?.location?.state || null
    const searchKws = buildSearchKeywords(profileForCrawler, 8)
    const liveOpps = await fetchLiveHealthOpportunities({ state: profileState, keywords: searchKws, signals: effectiveSignals })
    for (const liveOpp of liveOpps) {
      const { score, reasons } = calculateMatchScore(liveOpp, profileForCrawler)
      if (score >= minMatchScore) {
        const contracted = enforceCrawlerOpportunityContract(
          { ...liveOpp, match_score: score, match_reasons: reasons },
          { crawlerType: 'health_resources', facets, queryPlan },
        )
        if (contracted) selected.push(contracted)
      }
    }
  } catch (liveErr) {
    console.error('[HealthResourcesCrawler] Live fetch error:', liveErr.message)
  }

  return selected
    .slice(0, 20)
    .map((row) =>
      enforceCrawlerOpportunityContract(row, {
        crawlerType: 'health_resources',
        facets,
        queryPlan,
        sourceFallback: row?.source ?? row?.sponsor ?? 'Health resources',
      }),
    )
    .filter(Boolean)
}


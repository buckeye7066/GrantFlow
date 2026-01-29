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

import { buildSearchKeywords, calculateMatchScore } from './crawlerHelpers.js'

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

export async function crawlHealthResources(profile, options = {}) {
  const results = []
  const minMatchScore = typeof options.min_match_score === 'number' ? options.min_match_score : 50

  // CRITICAL: Use signals for all profile data.
  const signals = profile?.signals
  if (!signals) {
    console.error('[HealthResourcesCrawler] No signals in profile - cannot search with 100% precision')
    return results
  }

  const state = signals.location?.state || profile.state || null
  const sections = profile?.sections || signals.rawSections || {}
  const health = sections?.health_medical ?? {}

  const conditionNames = normalizeConditionNames(health?.conditions)
  const includeTrials =
    String(options.include_trials ?? '').toLowerCase() === 'true' ||
    options.include_trials === true ||
    Boolean(health?.consent_for_studies)

  // Build search keywords from ALL profile signals (deterministic).
  const searchKeywords = buildSearchKeywords(profile, 25)
  const conditionBlob = conditionNames.join(' ').toLowerCase()

  const hasCancer = conditionBlob.includes('cancer') || conditionBlob.includes('oncology') || conditionBlob.includes('tumor')
  const hasKidney = conditionBlob.includes('kidney') || conditionBlob.includes('dialysis') || conditionBlob.includes('renal')
  const hasHiv = conditionBlob.includes('hiv') || conditionBlob.includes('aids')
  const hasTbi = conditionBlob.includes('tbi') || conditionBlob.includes('brain injury')
  const hasEpilepsy = conditionBlob.includes('epilepsy') || conditionBlob.includes('seizure')
  const hasNeurodivergent = conditionBlob.includes('autism') || conditionBlob.includes('adhd') || conditionBlob.includes('neurodiv')

  // Reputable, durable link-only resources (no mock amounts).
  const baseResources = [
    // Transportation
    {
      title: 'Medicaid: Non-Emergency Medical Transportation (NEMT)',
      sponsor: 'Medicaid.gov',
      description:
        'Informational overview of non-emergency medical transportation benefits and how states administer NEMT.',
      url: 'https://www.medicaid.gov/medicaid/benefits/non-emergency-medical-transportation/index.html',
      categories: ['transportation_services', 'health_resources'],
      keywords: ['transportation', 'appointments', 'medicaid', ...searchKeywords],
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
      keywords: ['transportation', 'medical transportation', 'rides', ...searchKeywords],
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
      keywords: ['211', 'transportation', 'caregiver', ...searchKeywords],
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
      keywords: ['patient assistance', 'copay', 'prescription assistance', ...searchKeywords],
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
      keywords: ['case management', 'patient advocate', 'financial assistance', ...searchKeywords],
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
      keywords: ['copay assistance', 'premium assistance', ...searchKeywords],
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
      keywords: ['copay assistance', 'patient assistance', ...searchKeywords],
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
      keywords: ['patient education', 'NIH', 'health information', ...searchKeywords],
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
      keywords: ['CDC', 'health education', ...searchKeywords],
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
      url: 'https://www.medicaid.gov/about-us/contact-us/contact-state-page.html',
      categories: ['transportation_services', 'medical_financial_aid', 'health_resources'],
      keywords: ['medicaid', 'state contacts', state || 'state', ...searchKeywords],
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
        keywords: ['cancer', 'rides', 'transportation', ...searchKeywords],
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
        keywords: ['cancer', 'oncology', ...searchKeywords],
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
      keywords: ['kidney', 'dialysis', 'financial help', ...searchKeywords],
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
      keywords: ['hiv', 'aids', ...searchKeywords],
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
      keywords: ['epilepsy', 'seizures', ...searchKeywords],
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
      keywords: ['tbi', 'brain injury', ...searchKeywords],
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
        keywords: ['autism', 'neurodivergent', ...searchKeywords],
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
        keywords: ['autism', 'self advocacy', ...searchKeywords],
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
        // Include broad profile-derived keywords so these can score/rank for opted-in users.
        keywords: Array.from(new Set([...(link.keywords ?? []), ...searchKeywords])),
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
      keywords: ['research studies', 'participants', ...searchKeywords],
      type: 'DIRECTORY',
      opportunity_type: 'directory',
      is_national: true,
      state: 'nationwide',
    })
  }

  // Score + select deterministically, with a non-zero floor for directory-style resources.
  const scored = baseResources
    .map((opp) => {
      const { score, reasons } = calculateMatchScore(opp, profile)
      return {
        ...opp,
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

  const thresholdCandidates = Array.from(new Set([minMatchScore, 70, 60, 50, 40, 30, 0]))
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
  return selected.slice(0, 20)
}


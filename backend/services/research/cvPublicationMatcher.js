const DOI_RX = /\b10\.\d{4,9}\/[-._;()/:a-z0-9]+/gi
const YEAR_RX = /\b(?:19|20)\d{2}\b/g
const WORD_RX = /[a-z][a-z0-9-]{2,}/g
const STOP_WORDS = new Set([
  'about', 'after', 'also', 'among', 'analysis', 'and', 'are', 'article', 'award', 'based',
  'been', 'between', 'can', 'data', 'for', 'from', 'funding', 'grant', 'have', 'into',
  'journal', 'more', 'our', 'paper', 'program', 'project', 'research', 'results', 'study',
  'that', 'the', 'their', 'these', 'this', 'through', 'using', 'was', 'were', 'with',
])

const METHOD_PHRASES = [
  'case study',
  'clinical trial',
  'community based participatory research',
  'computational modeling',
  'deep learning',
  'ethnography',
  'genome wide association',
  'genomics',
  'geospatial analysis',
  'machine learning',
  'meta analysis',
  'mixed methods',
  'qualitative interviews',
  'randomized controlled trial',
  'single cell sequencing',
  'survey research',
]

const CAREER_PATTERNS = [
  ['undergraduate', /\bundergraduate|bachelor'?s? student\b/i],
  ['graduate_student', /\bgraduate student|master'?s? student|doctoral student|ph\.?d\.? candidate\b/i],
  ['postdoctoral', /\bpost-?doc(?:toral)?|research fellow\b/i],
  ['early_career', /\bearly[- ]career|new investigator|assistant professor\b/i],
  ['faculty', /\bfaculty|professor|principal investigator\b/i],
]

function plainText(value) {
  if (Array.isArray(value)) return value.map(plainText).filter(Boolean).join(' ')
  if (value && typeof value === 'object') return Object.values(value).map(plainText).filter(Boolean).join(' ')
  return String(value ?? '').trim()
}

function normalized(value) {
  return plainText(value).toLowerCase().replace(/[_/]+/g, ' ').replace(/[^a-z0-9\s-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function careerKey(value) {
  return normalized(value).replace(/[\s-]+/g, '_')
}

function uniqueSorted(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))].sort()
}

function words(value) {
  return (normalized(value).match(WORD_RX) || []).filter((word) => !STOP_WORDS.has(word))
}

function boundedText(value, maxLength, label) {
  const result = plainText(value)
  if (result.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters`)
  return result
}

function publicationYear(publication) {
  const direct = Number(publication?.year ?? publication?.publication_year)
  if (Number.isInteger(direct) && direct >= 1900 && direct <= 2100) return direct
  const match = plainText(publication?.date ?? publication?.published_at).match(YEAR_RX)
  return match ? Number(match[0]) : null
}

function publicationDoi(publication) {
  const text = plainText(publication?.doi ?? publication?.url ?? publication?.citation)
  const match = text.match(DOI_RX)
  return match?.[0]?.replace(/[.,;:)]+$/, '').toLowerCase() || null
}

function detectMethods(value) {
  const haystack = normalized(value)
  return METHOD_PHRASES.filter((method) => haystack.includes(method))
}

function detectCareerStages(value) {
  const text = plainText(value)
  return CAREER_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([stage]) => stage)
}

function explicitFunders(publications, cvText) {
  const values = publications.flatMap((publication) => [
    publication?.funder,
    publication?.funders,
    publication?.funding_agency,
    publication?.funding_agencies,
  ]).flatMap((value) => Array.isArray(value) ? value : [value])
  const acknowledgement = cvText.match(/\b(?:funded|supported) by\s+([^.;\n]{3,120})/gi) || []
  values.push(...acknowledgement.map((value) => value.replace(/^.*? by\s+/i, '')))
  return uniqueSorted(values.map((value) => plainText(value)).filter(Boolean)).slice(0, 50)
}

function rankedTopics(value, explicitTopics = [], limit = 60) {
  const counts = new Map()
  for (const token of words(value)) counts.set(token, (counts.get(token) || 0) + 1)
  for (const token of words(explicitTopics)) counts.set(token, (counts.get(token) || 0) + 4)
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([topic]) => topic)
}

export function buildResearchFingerprint({
  cvText = '',
  publications = [],
  profile = {},
  referenceYear = new Date().getUTCFullYear(),
} = {}) {
  const cv = boundedText(cvText, 500_000, 'cvText')
  if (!Array.isArray(publications) || publications.length > 500) {
    throw new Error('publications must be an array of at most 500 records')
  }
  const year = Number(referenceYear)
  if (!Number.isInteger(year) || year < 1900 || year > 2100) throw new Error('referenceYear is invalid')

  const normalizedPublications = publications.map((publication, index) => {
    const title = boundedText(publication?.title, 2_000, `publication ${index + 1} title`)
    const abstract = boundedText(publication?.abstract ?? publication?.summary, 20_000, `publication ${index + 1} abstract`)
    return {
      title,
      abstract,
      year: publicationYear(publication),
      doi: publicationDoi(publication),
      keywords: uniqueSorted(Array.isArray(publication?.keywords) ? publication.keywords : []),
      methods: uniqueSorted([
        ...(Array.isArray(publication?.methods) ? publication.methods.map(normalized) : []),
        ...detectMethods([title, abstract, publication?.methods]),
      ]),
    }
  })
  const publicationText = normalizedPublications.flatMap((publication) => [
    publication.title,
    publication.abstract,
    publication.keywords,
  ])
  const explicitTopics = [profile?.research_topics, profile?.disciplines, profile?.keywords]
  const stages = uniqueSorted([
    careerKey(profile?.career_stage),
    ...detectCareerStages([profile?.career_stage, profile?.title, cv]),
  ])
  const methods = uniqueSorted([
    ...(Array.isArray(profile?.research_methods) ? profile.research_methods.map(normalized) : []),
    ...normalizedPublications.flatMap((publication) => publication.methods),
    ...detectMethods([cv, publicationText]),
  ])
  const years = normalizedPublications.map((publication) => publication.year).filter(Boolean).sort()
  const dois = uniqueSorted([
    ...(cv.match(DOI_RX) || []).map((doi) => doi.replace(/[.,;:)]+$/, '').toLowerCase()),
    ...normalizedPublications.map((publication) => publication.doi),
  ])

  return {
    schema_version: 'grantflow-research-fingerprint-v1',
    reference_year: year,
    topics: rankedTopics([cv, publicationText], explicitTopics),
    methods,
    career_stages: stages,
    funder_history: explicitFunders(publications, cv),
    identifiers: {
      dois,
      orcids: uniqueSorted((cv.match(/\b\d{4}-\d{4}-\d{4}-\d{3}[\dX]\b/gi) || []).map((id) => id.toUpperCase())),
    },
    publication_evidence: {
      publication_count: normalizedPublications.length,
      identified_publication_count: normalizedPublications.filter((publication) => publication.doi).length,
      recent_publication_count: normalizedPublications.filter((publication) => publication.year && publication.year >= year - 5).length,
      first_publication_year: years[0] || null,
      latest_publication_year: years.at(-1) || null,
    },
  }
}

function canonicalDecision(opportunity) {
  const value = normalized(
    opportunity?.canonical_decision
    ?? opportunity?.match_decision
    ?? opportunity?.eligibility_decision
    ?? 'review',
  ).toUpperCase()
  return ['ACCEPT', 'REVIEW', 'REJECT'].includes(value) ? value : 'REVIEW'
}

function opportunityCareerStages(opportunity) {
  return uniqueSorted([
    ...(Array.isArray(opportunity?.career_stages) ? opportunity.career_stages.map(careerKey) : []),
    ...detectCareerStages([opportunity?.title, opportunity?.description, opportunity?.eligibility]),
  ])
}

function intersect(left, right) {
  const rightSet = new Set(right)
  return left.filter((value) => rightSet.has(value))
}

function opportunityId(opportunity, index) {
  return plainText(opportunity?.id ?? opportunity?.opportunity_id) || `row-${index + 1}`
}

function rankOne(fingerprint, opportunity, index) {
  const id = opportunityId(opportunity, index)
  const decision = canonicalDecision(opportunity)
  const topicHits = intersect(fingerprint.topics, uniqueSorted(words([
    opportunity?.title,
    opportunity?.description,
    opportunity?.focus_areas,
    opportunity?.topics,
    opportunity?.keywords,
    opportunity?.categories,
  ])))
  const methodHits = intersect(fingerprint.methods, detectMethods([
    opportunity?.title,
    opportunity?.description,
    opportunity?.methods,
  ]).concat(
    Array.isArray(opportunity?.methods) ? opportunity.methods.map(normalized) : [],
  ))
  const expectedStages = opportunityCareerStages(opportunity)
  const stageHits = intersect(fingerprint.career_stages, expectedStages)
  const sponsor = normalized(opportunity?.funder ?? opportunity?.sponsor ?? opportunity?.agency)
  const priorFunders = fingerprint.funder_history.map(normalized)
  const priorFunder = sponsor && priorFunders.some((funder) => funder === sponsor || funder.includes(sponsor) || sponsor.includes(funder))
  const minimumPublications = Number(opportunity?.minimum_publications ?? 0)
  const asksForPublicationRecord = minimumPublications > 0 || /\bpublication record|peer-reviewed publications|research track record\b/i.test(plainText([
    opportunity?.description,
    opportunity?.eligibility,
  ]))
  const publicationCount = fingerprint.publication_evidence.publication_count
  const publicationEvidenceFit = asksForPublicationRecord && publicationCount >= Math.max(1, minimumPublications)

  let score = 0
  score += Math.min(50, topicHits.length * 12)
  score += Math.min(20, methodHits.length * 10)
  if (expectedStages.length > 0) score += stageHits.length > 0 ? 15 : -10
  if (priorFunder) score += 8
  if (publicationEvidenceFit) score += 10
  if (decision === 'ACCEPT') score += 2
  score = Math.max(0, Math.min(100, score))

  return {
    id,
    title: plainText(opportunity?.title),
    score,
    canonical_decision: decision,
    requires_canonical_eligibility: decision !== 'ACCEPT',
    evidence: {
      topic_overlap: topicHits,
      method_overlap: methodHits,
      career_stage_overlap: stageHits,
      expected_career_stages: expectedStages,
      prior_funder: priorFunder ? plainText(opportunity?.funder ?? opportunity?.sponsor ?? opportunity?.agency) : null,
      publication_record_fit: publicationEvidenceFit,
    },
  }
}

export function rankResearchOpportunities({ fingerprint, opportunities = [], limit = 100 } = {}) {
  if (!fingerprint || fingerprint.schema_version !== 'grantflow-research-fingerprint-v1') {
    throw new Error('a GrantFlow research fingerprint is required')
  }
  if (!Array.isArray(opportunities) || opportunities.length > 2_000) {
    throw new Error('opportunities must be an array of at most 2000 records')
  }
  const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 100))
  const excluded = []
  const ranked = []
  opportunities.forEach((opportunity, index) => {
    const id = opportunityId(opportunity, index)
    const decision = canonicalDecision(opportunity)
    if (decision === 'REJECT' || opportunity?.canonical_eligible === false) {
      excluded.push({ id, reason: 'canonical_eligibility_reject' })
      return
    }
    ranked.push(rankOne(fingerprint, opportunity, index))
  })
  ranked.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
  return {
    schema_version: 'grantflow-research-ranking-v1',
    ranked: ranked.slice(0, boundedLimit).map((result, index) => ({ ...result, rank: index + 1 })),
    excluded,
  }
}

function roundMetric(value) {
  return Math.round(value * 1_000_000) / 1_000_000
}

export function benchmarkResearchRanking({ cases = [], k = 5 } = {}) {
  if (!Array.isArray(cases) || cases.length === 0) throw new Error('benchmark cases are required')
  const cutoff = Math.max(1, Math.min(100, Number(k) || 5))
  const outcomes = cases.map((testCase, index) => {
    const relevant = new Set((testCase?.relevant_ids || []).map(String))
    if (relevant.size === 0) throw new Error(`benchmark case ${index + 1} has no relevant_ids`)
    const fingerprint = testCase.fingerprint || buildResearchFingerprint(testCase)
    const ranking = rankResearchOpportunities({ fingerprint, opportunities: testCase.opportunities, limit: cutoff })
    const rankedIds = ranking.ranked.map((result) => result.id)
    const relevantRanks = rankedIds.map((id, rank) => relevant.has(id) ? rank + 1 : null).filter(Boolean)
    const firstRank = relevantRanks[0] || null
    const dcg = relevantRanks.reduce((sum, rank) => sum + (1 / Math.log2(rank + 1)), 0)
    const idealCount = Math.min(relevant.size, cutoff)
    const idealDcg = Array.from({ length: idealCount }, (_, rank) => 1 / Math.log2(rank + 2))
      .reduce((sum, value) => sum + value, 0)
    return {
      id: plainText(testCase?.id) || `case-${index + 1}`,
      first_relevant_rank: firstRank,
      reciprocal_rank: firstRank ? roundMetric(1 / firstRank) : 0,
      recall_at_k: roundMetric(relevantRanks.length / relevant.size),
      ndcg_at_k: idealDcg ? roundMetric(dcg / idealDcg) : 0,
      ranked_ids: rankedIds,
    }
  })
  const mean = (key) => roundMetric(outcomes.reduce((sum, outcome) => sum + outcome[key], 0) / outcomes.length)
  return {
    schema_version: 'grantflow-research-ranking-benchmark-v1',
    k: cutoff,
    case_count: outcomes.length,
    metrics: {
      mrr: mean('reciprocal_rank'),
      recall_at_k: mean('recall_at_k'),
      ndcg_at_k: mean('ndcg_at_k'),
    },
    cases: outcomes,
  }
}

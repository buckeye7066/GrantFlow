import { describe, expect, it } from 'vitest'
import {
  benchmarkResearchRanking,
  buildResearchFingerprint,
  rankResearchOpportunities,
} from '../services/research/cvPublicationMatcher.js'

const researcher = {
  cvText: [
    'Assistant Professor of Cancer Genomics. ORCID 0000-0002-1825-0097.',
    'Methods include machine learning and single cell sequencing.',
    'Supported by National Cancer Institute.',
    'Selected publication DOI: 10.1000/ABC.123.',
  ].join('\n'),
  profile: {
    career_stage: 'early_career',
    research_topics: ['cancer genomics', 'precision oncology'],
    research_methods: ['machine learning'],
  },
  publications: [
    {
      title: 'Single-cell genomics for precision oncology',
      abstract: 'Machine learning identifies tumor response signatures.',
      year: 2025,
      doi: 'https://doi.org/10.1000/abc.123',
      funder: 'National Cancer Institute',
      keywords: ['oncology', 'genomics'],
    },
    {
      title: 'Computational biomarkers in cancer',
      year: 2023,
      doi: '10.1000/DEF.456',
      methods: ['machine learning'],
    },
  ],
  referenceYear: 2026,
}

const opportunities = [
  {
    id: 'relevant',
    title: 'Early-Career Cancer Genomics Investigator Award',
    description: 'Precision oncology using machine learning and single cell sequencing. A strong publication record is expected.',
    sponsor: 'National Cancer Institute',
    career_stages: ['early_career'],
    canonical_decision: 'ACCEPT',
  },
  {
    id: 'irrelevant',
    title: 'Medieval Art History Fellowship',
    description: 'Archival humanities research for faculty.',
    career_stages: ['faculty'],
    canonical_decision: 'REVIEW',
  },
  {
    id: 'ineligible-perfect-topic',
    title: 'Cancer Genomics Machine Learning Award',
    description: 'Single cell oncology research.',
    canonical_decision: 'REJECT',
  },
]

describe('CV and publication recommendation matching', () => {
  it('builds a stable evidence fingerprint without inventing publication signals', () => {
    const first = buildResearchFingerprint(researcher)
    const second = buildResearchFingerprint(researcher)

    expect(second).toEqual(first)
    expect(first.identifiers.dois).toEqual(['10.1000/abc.123', '10.1000/def.456'])
    expect(first.identifiers.orcids).toEqual(['0000-0002-1825-0097'])
    expect(first.methods).toEqual(expect.arrayContaining(['machine learning', 'single cell sequencing']))
    expect(first.career_stages).toContain('early_career')
    expect(first.funder_history).toEqual(['National Cancer Institute'])
    expect(first.publication_evidence).toEqual({
      publication_count: 2,
      identified_publication_count: 2,
      recent_publication_count: 2,
      first_publication_year: 2023,
      latest_publication_year: 2025,
    })
  })

  it('ranks with explicit evidence and never overrides a canonical rejection', () => {
    const fingerprint = buildResearchFingerprint(researcher)
    const result = rankResearchOpportunities({ fingerprint, opportunities })

    expect(result.ranked.map((row) => row.id)).toEqual(['relevant', 'irrelevant'])
    expect(result.ranked[0].score).toBeGreaterThan(result.ranked[1].score)
    expect(result.ranked[0].evidence).toMatchObject({
      method_overlap: expect.arrayContaining(['machine learning', 'single cell sequencing']),
      career_stage_overlap: expect.arrayContaining(['early_career']),
      prior_funder: 'National Cancer Institute',
      publication_record_fit: true,
    })
    expect(result.excluded).toEqual([{
      id: 'ineligible-perfect-topic',
      reason: 'canonical_eligibility_reject',
    }])
  })

  it('publishes deterministic golden quality metrics for recommendation regressions', () => {
    const benchmark = benchmarkResearchRanking({
      k: 2,
      cases: [{
        id: 'oncology-researcher',
        ...researcher,
        opportunities,
        relevant_ids: ['relevant'],
      }],
    })

    expect(benchmark.metrics).toEqual({ mrr: 1, recall_at_k: 1, ndcg_at_k: 1 })
    expect(benchmark.cases[0]).toMatchObject({
      first_relevant_rank: 1,
      ranked_ids: ['relevant', 'irrelevant'],
    })
  })

  it('enforces bounded inputs and a validated research fingerprint contract', () => {
    expect(() => buildResearchFingerprint({ publications: Array(501).fill({}) })).toThrow(/at most 500/)
    expect(() => rankResearchOpportunities({ fingerprint: {}, opportunities: [] })).toThrow(/fingerprint is required/)
    expect(() => benchmarkResearchRanking({ cases: [] })).toThrow(/cases are required/)
  })
})

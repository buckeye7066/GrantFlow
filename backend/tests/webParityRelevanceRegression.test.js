import { describe, expect, it } from 'vitest'
import {
  classifyWebResults,
  isBenchmarkRelevantHit,
  isForeignGovernmentHit,
} from '../services/webParityBenchmark.js'

const INDIVIDUAL_DISABILITY_CONTEXT = {
  needs: ['disability', 'medical assistance', 'transportation'],
  applicantTypes: ['individual', 'disabled_adult'],
  state: 'TN',
}

const STORED = [{
  id: 'stored-1',
  title: 'Tennessee Disability Assistance Program',
  sponsor: 'Tennessee Support Network',
  application_url: 'https://tnsupport.example/apply',
}]

describe('web parity relevance regression', () => {
  it('rejects foreign public-sector pages from a US profile benchmark', () => {
    const hit = {
      url: 'https://vlada.gov.cz/en/ppov/vvozp/government-board-for-persons-with-disabilities-19629/',
      title: 'Government Board for Persons with Disabilities',
      snippet: 'Government programs and benefits for persons with disabilities.',
    }
    expect(isForeignGovernmentHit(hit.url)).toBe(true)
    expect(isBenchmarkRelevantHit(hit, INDIVIDUAL_DISABILITY_CONTEXT)).toBe(false)
  })

  it('rejects generic search, index, and historical-award pages', () => {
    const noise = [
      {
        url: 'https://www.grants.gov/search-grants',
        title: 'Search Grants | Grants.gov',
        snippet: 'Search the federal grants database for funding opportunities.',
      },
      {
        url: 'https://www.nps.gov/subjects/grants/index.htm',
        title: 'Grants (U.S. National Park Service)',
        snippet: 'Learn about National Park Service grants and funded programs.',
      },
      {
        url: 'https://gabriellesangels.org/our-grantees/',
        title: "Our Grantees - Gabrielle's Angel Foundation",
        snippet: 'Meet past grant recipients and funded research projects.',
      },
    ]

    for (const hit of noise) {
      expect(isBenchmarkRelevantHit(hit, INDIVIDUAL_DISABILITY_CONTEXT)).toBe(false)
    }
  })

  it('keeps actionable disability and mobility assistance for individuals', () => {
    const hits = [
      {
        url: 'https://www.themobilityresource.com/financing-handicap-accessible-vehicles/state-grants/tennessee-disability-grants/',
        title: 'Wheelchair Van Grants in Tennessee | The Mobility Resource',
        snippet: 'Financial assistance and grants help individuals with disabilities obtain wheelchair accessible vans.',
      },
      {
        url: 'https://www.disability-grants.org/grants-for-individual-occupations.html',
        title: 'Grants for Individual Occupations',
        snippet: 'Disability grants and financial assistance for individuals who need adaptive equipment and mobility support.',
      },
    ]

    for (const hit of hits) {
      expect(isBenchmarkRelevantHit(hit, INDIVIDUAL_DISABILITY_CONTEXT)).toBe(true)
    }
  })

  it('does not count profile-irrelevant pages as web-only misses', () => {
    const hits = [
      {
        url: 'https://vlada.gov.cz/en/ppov/vvozp/',
        title: 'Government Board for Persons with Disabilities',
        snippet: 'Government disability benefits.',
      },
      {
        url: 'https://www.grants.gov/search-grants',
        title: 'Search Grants | Grants.gov',
        snippet: 'Search grants and funding opportunities.',
      },
      {
        url: 'https://www.themobilityresource.com/tennessee-disability-grants/',
        title: 'Wheelchair Van Grants in Tennessee',
        snippet: 'Financial assistance for individuals with disabilities who need an accessible vehicle.',
      },
    ]

    const result = classifyWebResults(hits, STORED, INDIVIDUAL_DISABILITY_CONTEXT)
    expect(result.web_only).toHaveLength(1)
    expect(result.web_only[0].domain).toBe('themobilityresource.com')
    expect(result.web_real).toBe(1)
  })

  it('preserves identity-confirmed overlap even when its snippet is sparse', () => {
    const result = classifyWebResults([
      {
        url: 'https://tnsupport.example/apply',
        title: 'Tennessee Disability Assistance Program',
        snippet: 'Official page.',
      },
    ], STORED, INDIVIDUAL_DISABILITY_CONTEXT)

    expect(result.overlap).toHaveLength(1)
    expect(result.web_only).toHaveLength(0)
    expect(result.grantflow_only).toBe(0)
  })

  it('keeps organization funding when the benchmarked applicant is an organization', () => {
    const hit = {
      url: 'https://communityfoundation.example/nonprofit-grants/apply',
      title: 'Community Nonprofit Grant Program',
      snippet: 'Eligible nonprofit organizations may apply for community program funding before the deadline.',
    }
    expect(isBenchmarkRelevantHit(hit, {
      needs: ['community programs'],
      applicantTypes: ['nonprofit'],
      state: 'TN',
    })).toBe(true)
  })
})

import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  appendGapCandidates,
  classifyWebResults,
  isBenchmarkDirectFundingHit,
  isBenchmarkRelevantHit,
  isForeignGovernmentHit,
  isGenericFundingPortalHit,
  readWebParityGapQueue,
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

function createDb() {
  const raw = new Database(':memory:')
  return {
    raw,
    prepare(sql) {
      const stmt = raw.prepare(sql)
      return {
        run: (...args) => stmt.run(...args),
        get: (...args) => stmt.get(...args),
        all: (...args) => stmt.all(...args),
      }
    },
  }
}

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
      expect(isBenchmarkDirectFundingHit(hit, INDIVIDUAL_DISABILITY_CONTEXT)).toBe(false)
    }
  })

  it('rejects paywalled grant databases, foreign directories, and dealer referrals', () => {
    const noise = [
      {
        url: 'https://tennessee.thegrantportal.com/health-and-medical',
        title: 'Grants for Health & Medical in Tennessee',
        snippet: 'Browse thousands of available grants and sign in to see details.',
      },
      {
        url: 'https://www.disability-grants.org/grants-for-individual-occupations.html',
        title: 'Grants for Individual Occupations',
        snippet: 'A directory of occupational charities and grant-making trusts.',
      },
      {
        url: 'https://www.themobilityresource.com/financing-handicap-accessible-vehicles/state-grants/tennessee-disability-grants/',
        title: 'Wheelchair Van Grants in Tennessee | The Mobility Resource',
        snippet: 'A mobility dealer referral page listing organizations that may offer assistance.',
      },
    ]

    for (const hit of noise) {
      expect(isBenchmarkRelevantHit(hit, INDIVIDUAL_DISABILITY_CONTEXT)).toBe(false)
      expect(isBenchmarkDirectFundingHit(hit, INDIVIDUAL_DISABILITY_CONTEXT)).toBe(false)
    }
  })

  it('rejects the Grants.gov homepage but keeps a specific actionable opportunity', () => {
    const homepage = {
      url: 'https://www.grants.gov/',
      title: 'Home | Grants.gov',
      snippet: 'Find and apply for federal grants and funding opportunities.',
    }
    expect(isGenericFundingPortalHit(homepage)).toBe(true)
    expect(isBenchmarkDirectFundingHit(homepage, INDIVIDUAL_DISABILITY_CONTEXT)).toBe(false)

    const opportunity = {
      url: 'https://www.grants.gov/search-results-detail/354321',
      title: 'Community Health Access Grant',
      snippet: 'Eligible nonprofit organizations may apply for community health program funding before the deadline.',
    }
    expect(isGenericFundingPortalHit(opportunity)).toBe(false)
    expect(isBenchmarkDirectFundingHit(opportunity, {
      needs: ['community health'],
      applicantTypes: ['nonprofit'],
      state: 'TN',
    })).toBe(true)
  })

  it('counts only a direct profile-relevant program as a web-only miss', () => {
    const hits = [
      {
        url: 'https://vlada.gov.cz/en/ppov/vvozp/',
        title: 'Government Board for Persons with Disabilities',
        snippet: 'Government disability benefits.',
      },
      {
        url: 'https://www.grants.gov/',
        title: 'Home | Grants.gov',
        snippet: 'Find grants and funding opportunities.',
      },
      {
        url: 'https://tennessee.thegrantportal.com/health-and-medical',
        title: 'Grants for Health & Medical in Tennessee',
        snippet: 'Search a database of medical grants.',
      },
      {
        url: 'https://directhelp.example/apply/disability-equipment',
        title: 'Disability Equipment Assistance Grant',
        snippet: 'Tennessee individuals with disabilities may apply for mobility equipment assistance.',
      },
    ]

    const result = classifyWebResults(hits, STORED, INDIVIDUAL_DISABILITY_CONTEXT)
    expect(result.web_only).toHaveLength(1)
    expect(result.web_only[0].domain).toBe('directhelp.example')
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
    expect(isBenchmarkDirectFundingHit(hit, {
      needs: ['community programs'],
      applicantTypes: ['nonprofit'],
      state: 'TN',
    })).toBe(true)
  })

  it('refreshes scoped pending benchmark candidates and preserves terminal or foreign-owned rows', async () => {
    const db = createDb()
    const oldAt = '2026-07-28T00:00:00.000Z'
    const newAt = '2026-07-30T00:00:00.000Z'
    db.raw.exec('CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)')
    db.raw.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(
      'web_parity_gap_queue',
      JSON.stringify({
        updated_at: oldAt,
        candidates: [
          {
            profile_id: 'profile-a',
            url: 'https://www.grants.gov/',
            title: 'Home | Grants.gov',
            source: 'web_parity_benchmark',
            status: 'candidate',
            found_at: oldAt,
          },
          {
            profile_id: 'profile-a',
            url: 'https://directhelp.example/apply/current',
            title: 'Old title',
            source: 'web_parity_benchmark',
            status: 'candidate',
            found_at: oldAt,
          },
          {
            profile_id: 'profile-a',
            url: 'https://terminal.example/adopted',
            title: 'Already adopted',
            source: 'web_parity_benchmark',
            status: 'adopted',
            found_at: oldAt,
          },
          {
            profile_id: 'profile-a',
            url: 'https://condition.example/epilepsy',
            title: 'Condition source candidate',
            source: 'condition_source_search',
            status: 'candidate',
            found_at: oldAt,
          },
          {
            profile_id: 'profile-b',
            url: 'https://outside.example/pending',
            title: 'Outside scoped profile',
            source: 'web_parity_benchmark',
            status: 'candidate',
            found_at: oldAt,
          },
        ],
      }),
      oldAt,
    )

    const result = await appendGapCandidates(db, [
      {
        profile_id: 'profile-a',
        url: 'https://directhelp.example/apply/current',
        title: 'Refreshed direct program',
        need: 'disability',
        domain: 'directhelp.example',
      },
      {
        profile_id: 'profile-a',
        url: 'https://newhelp.example/apply',
        title: 'New direct program',
        need: 'medical',
        domain: 'newhelp.example',
      },
    ], {
      now: new Date(newAt),
      profileIds: ['profile-a'],
    })

    expect(result).toMatchObject({
      appended: 1,
      refreshed: 1,
      pruned: 1,
      scoped_profiles: 1,
      total: 5,
    })

    const queue = await readWebParityGapQueue(db)
    const urls = queue.map((entry) => entry.url)
    expect(urls).not.toContain('https://www.grants.gov/')
    expect(urls).toContain('https://terminal.example/adopted')
    expect(urls).toContain('https://condition.example/epilepsy')
    expect(urls).toContain('https://outside.example/pending')
    expect(urls).toContain('https://directhelp.example/apply/current')
    expect(urls).toContain('https://newhelp.example/apply')

    const refreshed = queue.find((entry) => entry.url === 'https://directhelp.example/apply/current')
    expect(refreshed).toMatchObject({
      title: 'Refreshed direct program',
      status: 'candidate',
      source: 'web_parity_benchmark',
      found_at: newAt,
    })
  })
})

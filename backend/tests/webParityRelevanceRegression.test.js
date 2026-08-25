import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  appendGapCandidates,
  classifyWebResults,
  computeFleetParitySample,
  isBenchmarkDirectFundingHit,
  isBenchmarkRelevantHit,
  isForeignGovernmentHit,
  isGenericFundingPortalHit,
  readWebParityGapQueue,
} from '../services/webParityBenchmark.js'
import { summarizeCoverageGaps, summarizeWebParity } from '../services/anya/anyaDailyOwnerReport.js'
import { getCheckById } from '../services/sam/samRegistry.js'

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
  it('weights qualified fleet parity by verified denominator', () => {
    const sample = computeFleetParitySample([
      { parity: 100, overlap_count: 1, web_only_count: 0 },
      { parity: 0, overlap_count: 0, web_only_count: 19 },
    ])
    expect(sample).toMatchObject({
      measurement_status: 'scored',
      verified_denominator: 20,
      sample_qualified: true,
      scored_profiles_parity: 50,
      fleet_parity: 5,
    })
  })

  it('keeps fleet parity null until a complete sample clears the denominator floor', () => {
    expect(computeFleetParitySample([
      { parity: 100, overlap_count: 1, web_only_count: 0 },
    ])).toMatchObject({ sample_qualified: false, fleet_parity: null })
    expect(computeFleetParitySample([
      { parity: 100, overlap_count: 20, web_only_count: 0 },
      { parity: null, overlap_count: null, web_only_count: null },
    ])).toMatchObject({ measurement_status: 'partial', sample_qualified: false, fleet_parity: null })
  })

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

  it('filters the two non-funding web-only hits from the August 25 owner report', () => {
    const noise = [
      {
        url: 'https://www.causeiq.com/organizations/the-caring-place,621571247/',
        title: 'The Caring Place | Cleveland, TN | Cause IQ',
        snippet: 'Organization profile, revenue, and nonprofit information.',
      },
      {
        url: 'https://spcabctn.org/',
        title: 'HOME | SPCA Bradley County',
        snippet: 'Animal shelter services and community resources in Bradley County.',
      },
    ]
    for (const hit of noise) {
      expect(isBenchmarkDirectFundingHit(hit, INDIVIDUAL_DISABILITY_CONTEXT)).toBe(false)
    }
  })

  it('recognizes SSA disability apply and program pages as the same covered program', () => {
    const stored = [{
      title: 'Social Security disability benefits (SSDI / SSI)',
      sponsor: 'Social Security Administration',
      source_url: 'https://www.ssa.gov/disability',
    }]
    const hits = [{
      url: 'https://www.ssa.gov/applyfordisability/',
      title: 'Apply Online for Disability Benefits | SSA',
      snippet: 'People with disabilities can apply for Social Security disability benefits online.',
    }]
    const result = classifyWebResults(hits, stored, INDIVIDUAL_DISABILITY_CONTEXT)
    expect(result.overlap).toHaveLength(1)
    expect(result.web_only).toHaveLength(0)
    expect(result.grantflow_only).toBe(0)
  })

  it('does not publish a 0/100 fleet claim from the six-result August 25 sample', () => {
    const summary = summarizeWebParity({
      runs: [],
      latest: {
        generated_at: new Date().toISOString(),
        semantics_version: 2,
        sample_qualified: false,
        verified_denominator: 6,
        minimum_verified_denominator: 20,
        fleet_parity: 0,
        per_profile: [{
          profile_id: 'gilbert',
          label: 'Gilbert',
          parity: 0,
          overlap_count: 0,
          web_only_count: 6,
          grantflow_only: 20,
        }],
      },
    })
    expect(summary.headline).toMatch(/6 verified result/i)
    expect(summary.headline).toMatch(/no fleet score or regression claim/i)
    expect(summary.headline).not.toMatch(/Fleet parity 0\/100/i)
    expect(summary.perProfile[0]).toMatch(/observed parity 0\/100/i)
  })

  it('labels a complete-denominator partial run as partial and keeps null profile parity unscored', () => {
    const summary = summarizeWebParity({
      runs: [],
      latest: {
        generated_at: new Date().toISOString(),
        semantics_version: 3,
        measurement_status: 'partial',
        sample_qualified: false,
        verified_denominator: 25,
        minimum_verified_denominator: 20,
        profiles_total: 2,
        profiles_scored: 1,
        fleet_parity: null,
        per_profile: [
          { profile_id: 'measured', parity: 60, overlap_count: 15, web_only_count: 10 },
          { profile_id: 'missing', parity: null, error: 'provider_unavailable' },
        ],
      },
    })
    expect(summary.headline).toMatch(/PARTIAL.*1\/2/i)
    expect(summary.headline).not.toMatch(/below.*threshold|Fleet parity/i)
    expect(summary.perProfile[1]).toMatch(/not scored.*provider_unavailable/i)
    expect(summary.perProfile[1]).not.toMatch(/0\/100/)
  })

  it('does not raise a regression finding for a fresh underpowered sample', async () => {
    const db = createDb()
    db.raw.exec('CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)')
    const generatedAt = new Date().toISOString()
    db.raw.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(
      'web_parity_benchmark',
      JSON.stringify({
        generated_at: generatedAt,
        runs: [],
        latest: {
          generated_at: generatedAt,
          semantics_version: 2,
          sample_status: 'insufficient_sample',
          sample_qualified: false,
          verified_denominator: 6,
          minimum_verified_denominator: 20,
          fleet_parity: 0,
          per_profile: [],
        },
      }),
      generatedAt,
    )
    const result = await getCheckById('coverage.webParityBenchmark').run({ db })
    expect(result.ok).toBe(true)
    expect(result.summary).toMatch(/not trend-qualified/i)
    expect(result.summary).toMatch(/6\/20/)
  })

  it.each(['partial', 'unscored'])('fails a fresh %s run before considering sample qualification', async (measurementStatus) => {
    const generatedAt = new Date().toISOString()
    const scored = measurementStatus === 'partial' ? 1 : 0
    const store = {
      generated_at: generatedAt,
      runs: [],
      latest: {
        generated_at: generatedAt,
        semantics_version: 3,
        measurement_status: measurementStatus,
        sample_qualified: false,
        verified_denominator: 25,
        minimum_verified_denominator: 20,
        profiles_total: 2,
        profiles_scored: scored,
        profiles_unscored: 2 - scored,
        fleet_parity: null,
        per_profile: [],
      },
    }
    const db = {
      prepare: () => ({ get: async () => ({ value: JSON.stringify(store) }) }),
    }
    const result = await getCheckById('coverage.webParityBenchmark').run({ db })
    expect(result.ok).toBe(false)
    expect(result.summary).toMatch(new RegExp(measurementStatus, 'i'))
    expect(result.summary).not.toMatch(/not trend-qualified/i)
  })

  it('lists one owner-digest change when an idempotent scheduler emits it repeatedly', () => {
    const duplicate = {
      agent_name: 'amy',
      event_type: 'coverage.refreshed',
      status: 'succeeded',
      title: 'Amy refreshed the fleet coverage-gap scoreboard',
    }
    const summary = summarizeCoverageGaps({ events: Array.from({ length: 5 }, () => ({ ...duplicate })) })
    expect(summary.changed).toEqual(['[amy] Amy refreshed the fleet coverage-gap scoreboard'])
  })

  it('keeps same-titled telemetry for distinct entities while deduping each identity', () => {
    const base = {
      agent_name: 'amy',
      event_type: 'source.repaired',
      status: 'succeeded',
      title: 'Source repaired',
      entity_type: 'source',
    }
    const summary = summarizeCoverageGaps({ events: [
      { ...base, entity_id: 'source-a' },
      { ...base, entity_id: 'source-a' },
      { ...base, entity_id: 'source-b' },
    ] })
    expect(summary.changed).toEqual([
      '[amy] Source repaired [source:source-a]',
      '[amy] Source repaired [source:source-b]',
    ])
  })

  it('suppresses stale web-parity numbers and old web-only findings', () => {
    const summary = summarizeWebParity({
      latest: {
        generated_at: '2026-08-20T08:00:00.000Z',
        semantics_version: 3,
        measurement_status: 'scored',
        sample_qualified: true,
        fleet_parity: 77,
        per_profile: [{ profile_id: 'old', parity: 77, web_only_top: [{ title: 'Old miss' }] }],
      },
    }, { now: new Date('2026-08-25T09:00:00.000Z') })
    expect(summary.stale).toBe(true)
    expect(summary.headline).toMatch(/STALE.*suppressed/i)
    expect(summary.headline).not.toMatch(/77/)
    expect(summary.perProfile).toEqual([])
    expect(summary.webOnlyTop).toEqual([])
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

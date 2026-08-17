import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  buildGrantsGovSearchPayload,
  normalizeGrantsGovDate,
  transformGrantsGovOpportunity,
} from '../services/shared/grantsGovApiClient.js'
import { createGrantsGovAdapter } from '../crawler-os/adapters/grantsGovAdapter.js'
import { normalize } from '../crawler-os/normalizer.js'
import { createMemoryStore } from '../crawler-os/store.js'
import { upsertOpportunity } from '../crawler-os/storage.js'

describe('canonical Grants.gov authority', () => {
  it('builds Search2 payloads and normalizes official calendar dates once', () => {
    expect(buildGrantsGovSearchPayload({
      keyword: 'housing',
      oppStatus: 'posted',
      rows: 10,
      startRow: 5,
      eligibilities: ['12', '99'],
    })).toMatchObject({
      keyword: 'housing',
      oppStatuses: 'posted',
      rows: 10,
      startRecordNum: 5,
      eligibilities: '12|99',
    })
    expect(normalizeGrantsGovDate('8/7/2026')).toBe('2026-08-07')
  })

  it('gives id-only records a stable source id and authoritative detail URL', () => {
    const first = transformGrantsGovOpportunity({
      id: 43210,
      title: 'Federal Community Program',
      agency: 'Department of Example Programs',
      openDate: '8/1/2026',
      closeDate: '9/30/2026',
      oppStatus: 'posted',
    })
    const second = transformGrantsGovOpportunity({
      id: 43210,
      title: 'Federal Community Program',
      agency: 'Department of Example Programs',
      oppStatus: 'posted',
    })

    expect(first.source_id).toBe('43210')
    expect(second.source_id).toBe(first.source_id)
    expect(first.source_url).toBe('https://www.grants.gov/search-results-detail/43210')
    expect(first.application_url).toBe(first.source_url)
    expect(first.open_date).toBe('2026-08-01')
    expect(first.deadline).toBe('2026-09-30')
    expect(first.current_status).toBe('open')
  })

  it('uses the public opportunity number as source identity while retaining the internal id for the detail URL', () => {
    const transformed = transformGrantsGovOpportunity({
      id: 98765,
      number: 'PUBLIC-2026-77',
      title: 'Federal Resilience Opportunity',
      agency: 'Federal Resilience Agency',
      oppStatus: 'posted',
    })

    expect(transformed.source_id).toBe('PUBLIC-2026-77')
    expect(transformed.id).toBe('grants-gov-PUBLIC-2026-77')
    expect(transformed.source_url).toBe('https://www.grants.gov/search-results-detail/98765')
  })

  it('keeps the legacy crawler as orchestration-only delegation', async () => {
    const source = await readFile(new URL('../services/grantsDotGovCrawler.js', import.meta.url), 'utf8')
    expect(source).toContain("from './shared/grantsGovApiClient.js'")
    expect(source).not.toContain("from 'axios'")
    expect(source).not.toContain('function parseAmount')
  })

  it('preserves official open date and status through the scheduled Crawler OS path', () => {
    const adapter = createGrantsGovAdapter()
    const source = {
      source_id: 'grants_gov',
      trust_tier: 'OFFICIAL_API',
      geography: { national: true, states: [] },
    }
    const candidate = adapter.mapCandidate({
      external_id: 7654,
      number: 'FED-2026-01',
      title: 'Federal Resilience Opportunity',
      sponsor: 'Federal Resilience Agency',
      open_date: '8/1/2026',
      deadline: '10/1/2026',
      opp_status: 'posted',
    }, { source })
    const opportunity = normalize(candidate, {
      kind: 'DIRECT_GRANT',
      reality_status: 'verified',
    }, { source })

    expect(opportunity.external_id).toBe('FED-2026-01')
    expect(opportunity.apply_url).toBe('https://www.grants.gov/search-results-detail/7654')
    expect(opportunity.open_date).toBe('2026-08-01')
    expect(opportunity.deadline).toBe('2026-10-01')
    expect(opportunity.source_status).toBe('open')
    expect(opportunity.application_method).toBe('grants.gov')

    const store = createMemoryStore()
    expect(upsertOpportunity(store, opportunity).stored).toBe(true)
    expect(store.get('funding_opportunities', { id: opportunity.id })).toMatchObject({
      open_date: '2026-08-01',
      source_status: 'open',
      application_method: 'grants.gov',
    })
  })
})

/**
 * backend/services/crawlers/domainCorpusCrawler.js — profile-context wiring.
 *
 * The domain engines (healthClinicalEngine, housingCommunityFinanceEngine,
 * utilitiesHardshipEngine, ...) read `profile.needs` / `profile.health.conditions`
 * / `profile.location` / `profile.states` directly off the profile object passed
 * to runAllDomainEngines — NOT off `signals`. Before this fix, runDomainCorpusCrawl
 * handed runAllDomainEngines only `{ signals }`, so every engine saw an empty
 * needs/health/location profile regardless of what the profile actually declared
 * (the entire profile-aware domain engine layer was inert). This proves the real
 * profile context reaches the engines, with `needs`/`health.conditions` converted
 * from Sets (as they exist on `signals`) to plain arrays the engines can
 * `.length`/`.some()` over.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const runAllDomainEnginesMock = vi.fn(async () => [])

vi.mock('../services/crawlers/domainEngines/index.js', () => ({
  runAllDomainEngines: (...args) => runAllDomainEnginesMock(...args),
  DOMAIN_ENGINES: [],
}))

vi.mock('../services/crawlers/domainCrawlerRegistry.js', () => ({
  DOMAIN_CRAWLER_REGISTRY: [],
  selectRelevantDomainIds: () => [],
}))

vi.mock('../services/opportunityInserter.js', () => ({
  bulkUpsertFundingOpportunities: vi.fn(async () => []),
}))

vi.mock('../services/shared/httpClient.js', () => ({
  headForVerification: vi.fn(async () => ({ ok: true })),
}))

const { runDomainCorpusCrawl } = await import('../services/crawlers/domainCorpusCrawler.js')

const fakeDb = { dialect: 'sqlite' }

beforeEach(() => {
  runAllDomainEnginesMock.mockClear()
})

describe('runDomainCorpusCrawl profile context', () => {
  it('passes needs (as an array), health.conditions (as an array), location, and states through to the domain engines', async () => {
    const signals = {
      needs: new Set(['housing', 'utilities']),
      health_conditions: new Set(['diabetes']),
      location: { state: 'TN', city: 'Nashville', zip: '37201' },
      states: ['TN'],
    }

    await runDomainCorpusCrawl(fakeDb, { signals })

    expect(runAllDomainEnginesMock).toHaveBeenCalledTimes(1)
    const [profileArg] = runAllDomainEnginesMock.mock.calls[0]

    expect(Array.isArray(profileArg.needs)).toBe(true)
    expect(profileArg.needs.sort()).toEqual(['housing', 'utilities'])

    expect(Array.isArray(profileArg.health.conditions)).toBe(true)
    expect(profileArg.health.conditions).toEqual(['diabetes'])

    expect(profileArg.location).toEqual({ state: 'TN', city: 'Nashville', zip: '37201' })
    expect(profileArg.states).toEqual(['TN'])
    expect(profileArg.signals).toBe(signals)
  })

  it('falls back to the minimal profile when no signals are supplied (admin nationwide sweep)', async () => {
    await runDomainCorpusCrawl(fakeDb, {})

    expect(runAllDomainEnginesMock).toHaveBeenCalledTimes(1)
    const [profileArg] = runAllDomainEnginesMock.mock.calls[0]
    expect(profileArg.needs).toBeUndefined()
    expect(profileArg.signals).toBeDefined()
  })
})

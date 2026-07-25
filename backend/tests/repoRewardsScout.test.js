/**
 * Unit tests for backend/services/amy/repoRewardsScout.js
 *
 * Proves Amy's Repo Rewards lane (owner directive 2026-07-25):
 *   - queries are derived from her OWN latest report: most-tripped gap types
 *     first, plus a needs-of-the-profile query for the worst-served archetype,
 *     falling back to base queries — bounded and deduped
 *   - searchRepoRewards maps the Repo Rewards SearchOutcome to the
 *     competitive-research hit shape, fully offline via injected fetch
 *   - transport/HTTP failures throw (the caller treats a source as non-fatal)
 *   - env gates: AMY_REPO_REWARDS / REPO_REWARDS_URL
 */

import { describe, it, expect, vi } from 'vitest'
import {
  buildRepoQueries,
  searchRepoRewards,
  isRepoRewardsEnabled,
  repoRewardsBaseUrl,
  GAP_QUERY_OF_FINDING,
  BASE_REPO_QUERIES,
  DEFAULT_REPO_REWARDS_URL,
  MAX_REPO_QUERIES,
} from '../services/amy/repoRewardsScout.js'

describe('buildRepoQueries', () => {
  it('falls back to base queries when there is no report', () => {
    expect(buildRepoQueries({ report: null })).toEqual([...BASE_REPO_QUERIES])
    expect(buildRepoQueries({})).toEqual([...BASE_REPO_QUERIES])
  })

  it('chases the most-tripped gap first and adds the worst-served archetype', () => {
    const report = { findings: [
      { type: 'amount_recall_miss', archetype: 'cancer_patient' },
      { type: 'hyperlocal_recall_miss', archetype: 'veteran' },
      { type: 'hyperlocal_recall_miss', archetype: 'veteran' },
      { type: 'hyperlocal_recall_miss', archetype: 'veteran' },
    ] }
    const qs = buildRepoQueries({ report })
    expect(qs[0]).toBe(GAP_QUERY_OF_FINDING.hyperlocal_recall_miss)
    expect(qs[1]).toBe(GAP_QUERY_OF_FINDING.amount_recall_miss)
    expect(qs.some((q) => q.includes('veteran'))).toBe(true)
    expect(qs.length).toBeLessThanOrEqual(MAX_REPO_QUERIES)
  })

  it('ignores finding types with no transferable-code query (config-tuning gaps)', () => {
    const report = { findings: [
      { type: 'scoring_floor_suppression' },
      { type: 'profile_field_mapping_miss' },
    ] }
    // nothing transferable → base queries only (no archetype in findings)
    expect(buildRepoQueries({ report })).toEqual([...BASE_REPO_QUERIES])
  })

  it('caps and dedupes', () => {
    const report = { findings: Object.keys(GAP_QUERY_OF_FINDING).map((type) => ({ type, archetype: 'veteran' })) }
    const qs = buildRepoQueries({ report, max: 3 })
    expect(qs).toHaveLength(3)
    expect(new Set(qs).size).toBe(3)
  })
})

describe('searchRepoRewards', () => {
  const outcome = {
    results: [
      {
        repo: { fullName: 'civic/fundfinder', htmlUrl: 'https://git.example.org/civic/fundfinder', description: 'Find money for people.', stars: 42, primaryLanguage: 'TypeScript' },
        finalScore: 82.4,
        safety: { verdict: 'safe' },
        ai: { purposeSummary: 'Aggregates local assistance programs into one index.' },
      },
      { repo: { fullName: 'no-url/skipped' } }, // no htmlUrl → dropped
      {
        repo: { fullName: 'acme/grant-crawler', htmlUrl: 'https://github.com/acme/grant-crawler', description: 'crawler', stars: 7 },
        finalScore: 61,
        safety: { verdict: 'safe' },
      },
    ],
  }

  it('maps the SearchOutcome to competitive-research hits (offline, injected fetch)', async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe('https://rr.test/api/search')
      const body = JSON.parse(init.body)
      expect(body.query).toBe('find funding crawlers')
      expect(body.lens).toBe('best')
      return { ok: true, json: async () => outcome }
    })
    const hits = await searchRepoRewards('find funding crawlers', { baseUrl: 'https://rr.test', fetchImpl })
    expect(hits).toHaveLength(2)
    expect(hits[0]).toMatchObject({
      url: 'https://git.example.org/civic/fundfinder',
      title: 'civic/fundfinder',
      via: 'repo_rewards',
      is_repo: true,
    })
    // snippet carries the AI purpose + the scores the owner can judge by
    expect(hits[0].snippet).toMatch(/Aggregates local assistance/)
    expect(hits[0].snippet).toMatch(/score 82/)
    expect(hits[0].snippet).toMatch(/safety safe/)
  })

  it('caps result count', async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => outcome })
    const hits = await searchRepoRewards('q', { baseUrl: 'https://rr.test', fetchImpl, count: 1 })
    expect(hits).toHaveLength(1)
  })

  it('throws on HTTP failure so the caller can count the outage', async () => {
    const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) })
    await expect(searchRepoRewards('q', { baseUrl: 'https://rr.test', fetchImpl })).rejects.toThrow(/503/)
  })
})

describe('env gates', () => {
  it('env gate: OFF by default under the test runner, explicit true/false win', () => {
    const prev = process.env.AMY_REPO_REWARDS
    try {
      // Under a test runner (VITEST set) the unset default is OFF — the lane's
      // default base URL is always reachable, so tests must opt in explicitly.
      delete process.env.AMY_REPO_REWARDS
      expect(isRepoRewardsEnabled()).toBe(false)
      process.env.AMY_REPO_REWARDS = 'true'
      expect(isRepoRewardsEnabled()).toBe(true)
      process.env.AMY_REPO_REWARDS = 'false'
      expect(isRepoRewardsEnabled()).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.AMY_REPO_REWARDS
      else process.env.AMY_REPO_REWARDS = prev
    }
  })

  it('REPO_REWARDS_URL overrides the prod default (trailing slash stripped)', () => {
    const prev = process.env.REPO_REWARDS_URL
    try {
      delete process.env.REPO_REWARDS_URL
      expect(repoRewardsBaseUrl()).toBe(DEFAULT_REPO_REWARDS_URL)
      process.env.REPO_REWARDS_URL = 'http://localhost:3000/'
      expect(repoRewardsBaseUrl()).toBe('http://localhost:3000')
    } finally {
      if (prev === undefined) delete process.env.REPO_REWARDS_URL
      else process.env.REPO_REWARDS_URL = prev
    }
  })
})

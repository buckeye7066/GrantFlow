import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { classifyFundingResult, nonGrantTitleLikePatterns } from '../config/fundingResultFilters.js'
import { RE_PROCEDURAL_NOTICE_TITLE } from '../services/opportunityNormalizer.js'
import { BENCHMARK_SEMANTICS_VERSION, classifyWebResults, isBenchmarkDirectFundingHit, runWebParityBenchmark, readWebParityGapQueue } from '../services/webParityBenchmark.js'

// The bulletin title is from the September 22 report. Paths and snippets below
// are isolated test fixtures, not claims that these pages were fetched live.
const context = { needs: ['medical', 'programs'], applicantTypes: ['individual'], state: 'TN' }
const bulletin = { title: 'Field Assistance Bulletin No. 2026-03 | U.S. Department of Labor', url: 'https://beta.dol.gov/fixture/bulletin', snippet: 'Guidance on medical leave benefits for employees.' }
const directory = { title: 'Medical Assistance Grant Directory', url: 'https://funding-fixture.test/directory', snippet: 'Find assistance programs for individuals with medical bills.' }
const award = { title: 'Medical Assistance Grant', url: 'https://funding-fixture.test/award', snippet: 'Individuals may apply for help with medical bills.' }

describe('September report funding evidence', () => {
  it('classifies numbered Field Assistance Bulletins through the canonical notice rule', () => {
    expect(RE_PROCEDURAL_NOTICE_TITLE.test(bulletin.title)).toBe(true)
    expect(classifyFundingResult({ ...bulletin, application_url: bulletin.url }).bucket).toBe('not_a_grant')
    const db = new Database(':memory:')
    try {
      const patterns = nonGrantTitleLikePatterns()
      expect(patterns.some(pattern => db.prepare('SELECT lower(?) LIKE ? AS hit').get(bulletin.title, pattern).hit === 1)).toBe(true)
    } finally { db.close() }
  })
  it.each([bulletin, directory])('does not count $title as missed direct funding', hit => {
    expect(isBenchmarkDirectFundingHit(hit, context)).toBe(false)
    expect(classifyWebResults([hit], [], context).web_real).toBe(0)
  })
  it('never improves overlap or GrantFlow-only coverage by storing known non-funding pages', () => {
    const stored = [bulletin, directory, award].map((hit, i) => ({ ...hit, id: `fixture-${i}`, application_url: hit.url }))
    const result = classifyWebResults([bulletin, directory, award], stored, context)
    expect(result.overlap.map(hit => hit.url)).toEqual([award.url])
    expect(result.web_only).toEqual([])
    expect(result.grantflow_only).toBe(0)
    expect(result.stored_non_funding_rows).toBe(2)
  })
  it('retains a plausible funding lead when its snippet lacks structured award fields', () => {
    expect(classifyFundingResult(award).reasons).toEqual(['no_fundable_signal'])
    expect(isBenchmarkDirectFundingHit(award, context)).toBe(true)
    expect(classifyWebResults([award], [], context).web_only).toHaveLength(1)
  })
  it('keeps real grants on the same agency host and does not blacklist bulletin as a topic', () => {
    const hit = { ...award, title: 'Field Research Medical Assistance Grant', url: 'https://beta.dol.gov/fixture/grant', snippet: 'Individuals may apply for medical assistance; see the bulletin for details.' }
    expect(RE_PROCEDURAL_NOTICE_TITLE.test(hit.title)).toBe(false)
    expect(isBenchmarkDirectFundingHit(hit, context)).toBe(true)
  })
  it('still recognizes an established award with a sparse new search snippet', () => {
    const stored = [{ ...award, id: 'known', application_url: award.url }]
    expect(classifyWebResults([{ url: award.url, title: 'Application', snippet: '' }], stored, context).overlap).toHaveLength(1)
  })
  it('does not compare revised funding-evidence scores with version 4 history', () => {
    expect(BENCHMARK_SEMANTICS_VERSION).toBeGreaterThan(4)
  })
  it('queues only remaining funding candidates and preserves historical gap evidence', async () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)')
    db.prepare('INSERT INTO system_kv VALUES (?, ?, ?)').run('web_parity_gap_queue', JSON.stringify({ candidates: [{ ...bulletin, profile_id: 'synthetic-report', status: 'candidate', source: 'web_parity_benchmark' }] }), '2026-09-21T00:00:00Z')
    try {
      const result = await runWebParityBenchmark(db, {
        now: new Date('2026-09-22T12:00:00Z'), maxQueriesPerProfile: 1,
        loadGolden: async () => [{ profile_id: 'synthetic-report', label: 'Synthetic report fixture' }],
        buildThesis: async () => ({ needs: context.needs, applicant_types: context.applicantTypes, location: { state: 'TN' } }),
        searchWeb: async () => [bulletin, directory, award],
        loadStoredMatches: async () => [], emitTelemetry: async () => {},
        loadLaneLedger: async () => ({ available: false }), lookupCanonicalDuplicate: async () => null,
      })
      expect(result.per_profile[0].web_only_count).toBe(1)
      expect(result.per_profile[0].web_only_top.map(hit => hit.url)).toEqual([award.url])
      expect(result.fleet_parity).toBeNull()
      const queue = await readWebParityGapQueue(db)
      expect(queue.some(hit => hit.url === award.url)).toBe(true)
      expect(queue.some(hit => hit.url === bulletin.url)).toBe(true)
      expect(queue.some(hit => hit.url === directory.url)).toBe(false)
    } finally { db.close() }
  })
})

import { expect, it, vi } from 'vitest'
const health = vi.hoisted(() => ({ value: null }))
vi.mock('../services/searchProviderHealth.js', () => ({ probeSearchProviderHealth: async () => health.value }))
import { DIAGNOSTIC_CHECKS } from '../services/sam/samRegistry.js'
import { buildOwnerReport } from '../services/anya/anyaDailyOwnerReport.js'
import { summarizeCrawlerResearch } from '../services/amy/crawlerCompetitiveResearch.js'

const now = new Date('2026-09-09T08:00:00Z')
const latest = { day: '2026-09-09', target: 50, evaluated: 50, clean: 24, issues: 26, complete: true,
  finding_types: { institution_recall_miss: 9 }, run_receipts: [{ recorded_at: now.toISOString() }] }
const db = { exec: async () => {}, prepare: () => ({ run: async () => ({}), get: async () => ({ value: JSON.stringify({ days: { '2026-09-09': latest } }) }) }) }

it.each([null, { verdict: 'healthy' }, { verdict: 'degraded', detail: 'limited search coverage' }])('requires run-specific evidence before attributing persistent cohort gaps (%j)', async state => {
  health.value = state
  const result = await DIAGNOSTIC_CHECKS.find(c => c.id === 'amy.flywheelCohort').run({ db, now })
  expect(result.ok).toBe(false)
  expect(result.evidence.finding_types.institution_recall_miss).toBe(9)
  expect(result.recommended_fix).toMatch(/exact.subject/i)
  expect(result.recommended_fix).toMatch(/unknown/i)
  expect(result.recommended_fix).not.toMatch(/needs? a code change|expect the next cohort to recover|route to buildWebQueries/i)
})

it('reports two operational warnings and unbenchmarked research without labeling them code defects or superior techniques', () => {
  const report = buildOwnerReport({ id: 'sam-final', health_score: 92, findings: [
    { id: 'coverage', severity: 'medium', title: 'Persistent coverage gaps' },
    { id: 'cohort', severity: 'medium', title: 'Cohort profiles have findings' },
  ] }, { now, eva: { run: { completed_at: now.toISOString() }, expectedAppIds: ['pending-app'] },
    research: { latest: { candidates_scanned: 24, findings: [
      { technique: 'Technique A', more_optimal: true }, { technique: 'Technique B', more_optimal: true },
    ] } } })
  expect(report.subject).toContain('2 findings (0C/0H)')
  expect(report.subject).toContain('user-tests incomplete')
  expect(report.stats.needsHuman).toBe(2)
  expect(report.text).toContain('Persistent coverage gaps')
  expect(report.text).toContain('Cohort profiles have findings')
  expect(report.text).toMatch(/2 competitor technique.*candidates for evaluation/i)
  expect(report.text + report.html).not.toMatch(/code issues?|MORE optimal|nothing beat|none beat/i)
})

it('an empty research shortlist makes no comparative superiority claim', () => {
  const summary = summarizeCrawlerResearch({ latest: { candidates_scanned: 24, findings: [] } })
  expect(summary.allClear).toBe(true)
  expect(summary.headline).toMatch(/no candidates for evaluation/i)
  expect(summary.headline).not.toMatch(/beat|optimal/i)
})

it('retains an explicitly evidenced per-item code correction', () => {
 const report=buildOwnerReport({id:'supported',findings:[{id:'import',severity:'high',title:'Broken import',recommended_fix:'Code change: correct the missing module import',affected_files:['backend/example.js']}]},{now})
 expect(report.stats.needsHuman).toBe(1)
 expect(report.text).toContain('Code change: correct the missing module import')
 expect(report.html).toContain('Code change: correct the missing module import')
})

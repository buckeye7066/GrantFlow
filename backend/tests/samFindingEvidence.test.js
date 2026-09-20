import { afterEach, describe, expect, it, vi } from 'vitest'
import { runDiagnostics } from '../services/sam/samDiagnostics.js'
import { getCheckById } from '../services/sam/samRegistry.js'
import { planForFinding } from '../services/sam/samRepairPlanner.js'
import { makeFinding } from '../services/sam/samTypes.js'

afterEach(() => vi.restoreAllMocks())

const finding = (extra = {}) => makeFinding({
  title: 'Extraction is degraded', category: 'crawler_reliability', ...extra,
})

describe('Sam finding-specific repair advice', () => {
  it('retains a specific recommendation instead of replacing it with category advice', () => {
    const advice = 'Inspect request deadlines and recorded cancellation reasons.'
    const plan = planForFinding(finding({ recommended_fix: advice }))
    expect(plan.patch_summary).toContain(advice)
    expect(plan.patch_summary).not.toContain('auto-diagnosed by crawler.searchProviderHealth')
    expect(plan.requires_admin_approval).toBe(true)
    expect(plan.risk_level).toBe('moderate')
  })
  it('retains category fallback when no specific advice is supplied', () => {
    for (const recommended_fix of ['', '  ', null, 42]) {
      const plan = planForFinding(finding({ recommended_fix }))
      expect(plan.patch_summary).toContain(plan.strategy)
    }
  })
})

describe('INTERNAL finding evidence reaches repair plans', () => {
  it('preserves explicit result file and route references without changing severity', async () => {
    const check = getCheckById('crawler.webLaneHealth')
    const affected_files = ['backend/services/webGrantExtractor.js']
    const affected_routes = ['/api/discovery']
    vi.spyOn(check, 'run').mockResolvedValue({
      ok: false, summary: 'Timed out', recommended_fix: 'Inspect the deadline.',
      affected_files, affected_routes,
    })
    const { findings } = await runDiagnostics({ checkIds: [check.id] })
    expect(findings).toHaveLength(1)
    expect(findings[0].affected_files).toEqual(affected_files)
    expect(findings[0].affected_routes).toEqual(affected_routes)
    expect(findings[0].severity).toBe('high')
    expect(planForFinding(findings[0]).files_to_change).toEqual(affected_files)
  })
  it('uses registered investigation references when the result has none', async () => {
    const check = getCheckById('crawler.webLaneHealth')
    vi.spyOn(check, 'run').mockResolvedValue({ ok: false, summary: 'Timed out' })
    const { findings } = await runDiagnostics({ checkIds: [check.id] })
    expect(findings[0].affected_files).toContain('backend/services/webGrantExtractor.js')
    expect(findings[0].affected_files).toContain('backend/services/sam/samRegistry.js')
  })
})

describe('Amount diagnosis does not outrun its evidence', () => {
  it('keeps an attempted-but-unanswered amount red without inventing a source failure', async () => {
    const db = {
      prepare(sql) {
        return {
          get() {
            if (sql.includes('AS carried')) return { unanswered_unreadable: 2, award_total: 30, award_with_value: 28 }
            if (sql.includes('AS with_value')) return { total: 30, with_value: 28 }
            if (sql.includes('AS with_amount')) return { total: 30, with_amount: 28 }
            return undefined
          },
          all: () => [],
          run: () => ({ changes: 1 }),
        }
      },
    }
    const result = await getCheckById('pipeline.amountCoverage').run({ db })
    expect(result.ok).toBe(false)
    expect(result.evidence.unanswered_unreadable).toBe(2)
    expect(result.summary).not.toMatch(/were READ|JS shell \/ dead page|they need an API adapter/)
    expect(result.summary).toMatch(/without an amount answer after/i)
    expect(result.recommended_fix).toMatch(/recorded.*evidence|failure.*evidence/i)
  })
})

describe('Registered investigation references', () => {
  it.each([
    ['crawler.webLaneHealth', 'backend/services/webGrantExtractor.js'],
    ['crawler.gapLearning', 'backend/services/coverageAudit/liveCrawlGapLearning.js'],
    ['amy.flywheelCohort', 'backend/services/amy/flywheelCohort.js'],
    ['pipeline.amountCoverage', 'backend/services/amountEnrichment.js'],
  ])('%s names its diagnostic and observed engine', (id, engine) => {
    expect(getCheckById(id).affected_files).toContain(engine)
    expect(getCheckById(id).affected_files).toContain('backend/services/sam/samRegistry.js')
  })
})

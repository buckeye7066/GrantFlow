import { describe, it, expect } from 'vitest'
import { evaluateDiscovery, buildAnyaHandoff } from '../services/amy/amyReport.js'
import { runAmyAnyaSamPipeline } from '../services/amy/amyPipeline.js'
import { buildApprovalQueue } from '../services/amy/crawlerTuner.js'
import { foldApprovalLedger, decorateApprovalQueue, hydrateApprovalLedger, normalizeApprovalItem } from '../services/amy/approvalLedger.js'
import { searchEvidence } from '../services/amy/searchAttribution.js'
import { buildOwnerReport } from '../services/anya/anyaDailyOwnerReport.js'
import { buildArchetypeLearningUpdate, learningSearchCoverage } from '../services/amy/archetypeLearning.js'

function evaluate(status, covered = false, empty = false) {
  return evaluateDiscovery({ scenario_id: 'fixture', category: 'college_university', label: 'Fixture' }, 'fixture-profile', {
    thesis: { is_student: true, schools: ['Example College'], location: { state: 'TN', county: 'Bradley County' } },
    run: { stored: empty ? 0 : 1, sources: [], recommendations: empty ? [] : [{ id: 'synthetic', title: covered ? 'Example College Bradley County scholarship' : 'National scholarship', kind: 'DIRECT_GRANT', decision: 'ACCEPT', match_score: 85 }],
      web_lane: { queries: ['Example College scholarships', 'Bradley County scholarships'], search_provenance: [0, 1].map(query_index => ({ query_index, provider: 'searxng', provenance: 'live', status, provider_mode: status === 'ok' ? 'default' : 'held_degenerate' })) } },
  })
}

describe('search degradation does not prove a query-builder defect', () => {
  it('learns from healthy profiles without learning from degraded or unknown siblings', () => {
    const healthy = evaluate('ok')
    const degraded = evaluate('degraded_results')
    const unknown = evaluate('ok'); delete unknown.search_evidence
    expect(buildArchetypeLearningUpdate([degraded, degraded, unknown, unknown])).toEqual({})
    const update = buildArchetypeLearningUpdate([healthy, healthy, degraded, unknown])
    expect(update.student.classes).toEqual(['institution_gap', 'hyperlocal_gap'])
    expect(update.student.evidence.profiles).toBe(2)
    expect(learningSearchCoverage([healthy, healthy, degraded]).clearable_counts).toEqual({})
    expect(learningSearchCoverage([healthy, healthy]).clearable_counts).toEqual({ student: 2 })
  })
  it('keeps legacy evidence unknown and retains healthy recall as code work', () => {
    const legacy = evaluate('ok')
    delete legacy.search_evidence
    const unknown = buildApprovalQueue([legacy]).filter(i => i.lever === 'query_breadth')
    expect(unknown.every(i => i.actionability === 'blocked')).toBe(true)
    expect(unknown[0].attribution.reason).toMatch(/missing or incomplete/)
    expect(buildApprovalQueue([evaluate('ok')]).filter(i => i.lever === 'query_breadth').every(i => i.actionability === 'code_change' && i.code_brief)).toBe(true)
  })
  it('does not let an unrelated degraded category sibling override healthy gap evidence', () => {
    const healthy = evaluate('ok')
    const covered = evaluate('degraded_results', true)
    expect(buildApprovalQueue([healthy, covered]).filter(i => i.lever === 'query_breadth').every(i => i.actionability === 'code_change')).toBe(true)
  })
  it('hydrates legacy subject evidence only from the matching old run, otherwise requires a targeted recheck', () => {
    const id = 'institution_recall_miss:college_university'
    const previous = { entries: { [id]: { id, lever: 'query_breadth', category: 'college_university', last_run_id: 'old', nights_open: 30 } } }
    const legacyItem = { id, lever: 'query_breadth', evidence: { subjects: ['Example College'] } }
    expect(decorateApprovalQueue([legacyItem], previous)[0].actionability).toBe('blocked')
    const wrong = hydrateApprovalLedger(previous, [{ run_id: 'different', items: [legacyItem] }])
    expect(wrong.entries[id].evidence).toBeUndefined()
    const preview = { ...legacyItem, evidence: { subjects: Array.from({ length: 6 }, (_, i) => `College ${i}`) } }
    expect(hydrateApprovalLedger(previous, [{ run_id: 'old', items: [preview] }]).entries[id].evidence.subject_history_incomplete).toBe(true)
    const held = foldApprovalLedger(wrong, { items: [], evaluations: [evaluate('ok', true)], runId: 'new' })
    expect(held.closed).toHaveLength(0)
    expect(held.decorated[0].rationale).toMatch(/Historical subject evidence is unavailable/)
    const recovered = hydrateApprovalLedger(previous, [{ run_id: 'old', items: [legacyItem] }])
    const verified = foldApprovalLedger(recovered, { items: [], evaluations: [evaluate('ok', true)], runId: 'new' })
    expect(verified.closed).toHaveLength(1)
  })
  it('treats a mixed query run as degraded and malformed provenance as unknown', () => {
    const ok = { provider: 'searxng', provenance: 'live', status: 'ok' }
    expect(searchEvidence({ search_provenance: [ok, { ...ok, status: 'degraded_results' }] }).status).toBe('degraded')
    expect(searchEvidence({ search_provenance: [ok, null] }).status).toBe('unknown')
    expect(searchEvidence(undefined).status).toBe('unknown')
    expect(searchEvidence({ search_provenance: [{ ...ok, provider: ' ' }] }).status).toBe('unknown')
    expect(searchEvidence({ search_provenance: [...Array(100).fill(ok), null] }).status).toBe('unknown')
  })
  it('shows inconclusive coverage in the owner report without a fabricated CODE instruction', () => {
    const queue = buildApprovalQueue([evaluate('degraded_results')])
    const { text } = buildOwnerReport({}, { now: new Date('2026-09-09T12:00:00Z'), amy: { report: { run_id: 'r1', completed_at: '2026-09-09T11:00:00Z', approval_queue: queue } } })
    expect(text).toMatch(/Coverage gap — cause unverified/)
    expect(text).toMatch(/college_university/)
    expect(text).not.toMatch(/Needs a CODE change.*query_breadth/)
  })
  it('retains real recall findings and the per-run provider evidence', () => {
    const e = evaluate('degraded_results')
    expect(e.search_evidence.status).toBe('degraded')
    expect(e.search_evidence.provenance[0].provider_mode).toBe('held_degenerate')
    expect(e.findings.some(f => f.type === 'institution_recall_miss')).toBe(true)
    const queue = buildApprovalQueue([e]).filter(i => i.lever === 'query_breadth')
    expect(queue).toHaveLength(2)
    expect(queue.every(i => i.actionability === 'blocked' && !i.code_brief)).toBe(true)
    expect(queue.every(i => i.attribution.status === 'inconclusive')).toBe(true)
  })
  it('does not hide mixed-provider cohort gaps behind healthy siblings', () => {
    const queue = buildApprovalQueue([evaluate('ok'), evaluate('degraded_results')]).filter(i => i.lever === 'query_breadth')
    expect(queue.every(i => i.actionability === 'blocked')).toBe(true)
    expect(queue[0].evidence.profiles).toBe(2)
  })
  it('keeps the same ledger keys and history through degradation and read decoration', () => {
    const first = foldApprovalLedger(null, { items: buildApprovalQueue([evaluate('ok')]), runId: 'r1', at: '2026-09-01T12:00:00Z' })
    const e = evaluate('degraded_results')
    const next = foldApprovalLedger(first.ledger, { items: buildApprovalQueue([e]), evaluations: [e], runId: 'r2', at: '2026-09-02T12:00:00Z' })
    expect(next.closed).toHaveLength(0)
    const recall = decorateApprovalQueue(next.decorated, next.ledger).filter(i => i.lever === 'query_breadth')
    expect(recall.every(i => i.actionability === 'blocked' && i.nights_open === 2)).toBe(true)
  })
  it('requires exact subject coverage even when the earlier and later searches were healthy', () => {
    const first = foldApprovalLedger(null, { items: buildApprovalQueue([evaluate('ok')]), runId: 'r1' })
    const unrelated = evaluate('ok', true)
    unrelated.recall_coverage = { institution_recall_miss: ['Other College'], hyperlocal_recall_miss: ['Other County'] }
    const held = foldApprovalLedger(first.ledger, { items: [], evaluations: [unrelated], runId: 'r2' })
    expect(held.closed).toHaveLength(0)
    expect(held.decorated.filter(i => i.lever === 'query_breadth')).toHaveLength(2)
  })
  it('retains an older missing subject when a different subject reproduces under the same key', () => {
    const first = foldApprovalLedger(null, { items: buildApprovalQueue([evaluate('ok')]), runId: 'r1' })
    const next = buildApprovalQueue([evaluate('ok')]).filter(i => i.finding_type === 'institution_recall_miss')
    next[0].evidence.subjects = ['Other College']
    const held = foldApprovalLedger(first.ledger, { items: next, evaluations: [evaluate('ok')], runId: 'r2' })
    expect(held.decorated.find(i => i.finding_type === 'institution_recall_miss').evidence.subjects).toEqual(['Other College', 'Example College'])
    const covered = evaluate('ok', true)
    const partial = foldApprovalLedger(held.ledger, { items: [], evaluations: [covered], runId: 'r3' })
    expect(partial.closed.some(i => i.finding_type === 'institution_recall_miss')).toBe(false)
  })
  it('remembers healthy partial subject recovery across successive runs', () => {
    const items = buildApprovalQueue([evaluate('ok')]).filter(i => i.finding_type === 'institution_recall_miss')
    items[0].evidence.subjects = ['Example College', 'Other College']
    const first = foldApprovalLedger(null, { items, runId: 'r1' })
    const partial = foldApprovalLedger(first.ledger, { items: [], evaluations: [evaluate('ok', true)], runId: 'r2' })
    expect(partial.decorated[0].evidence.subjects).toEqual(['Other College'])
    const healthy = evaluate('ok', true)
    healthy.recall_coverage.institution_recall_miss = ['Other College']
    const complete = foldApprovalLedger(partial.ledger, { items: [], evaluations: [healthy], runId: 'r3' })
    expect(complete.closed).toHaveLength(1)
  })
  it('cannot replace unknown legacy subject history with a fresh same-key finding', () => {
    const id = 'institution_recall_miss:college_university'
    const previous = { entries: { [id]: { id, lever: 'query_breadth', category: 'college_university', last_run_id: 'old', nights_open: 30 } } }
    const items = buildApprovalQueue([evaluate('ok')]).filter(i => i.id === id)
    const next = foldApprovalLedger(previous, { items, evaluations: [evaluate('ok')], runId: 'r2' })
    expect(next.ledger.entries[id].evidence.subject_history_incomplete).toBe(true)
    expect(next.decorated[0].actionability).toBe('blocked')
    const held = foldApprovalLedger(next.ledger, { items: [], evaluations: [evaluate('ok', true)], runId: 'r3' })
    expect(held.closed).toHaveLength(0)
    expect(held.decorated[0].evidence.subject_history_incomplete).toBe(true)
  })
  it('incomplete subject evidence blocks verified attribution at both construction and read boundaries', () => {
    const item = buildApprovalQueue([evaluate('ok')]).find(i => i.finding_type === 'institution_recall_miss')
    const normalized = normalizeApprovalItem({ ...item, evidence: { ...item.evidence, subject_history_incomplete: true } })
    expect(normalized.actionability).toBe('blocked')
    expect(normalized.attribution.status).toBe('inconclusive')
    expect(normalized.code_brief).toBeUndefined()
    const evaluation = evaluate('ok')
    evaluation.findings.find(f => f.type === 'institution_recall_miss').evidence.schools = Array.from({ length: 205 }, (_, i) => `College ${i}`)
    const oversized = buildApprovalQueue([evaluation]).find(i => i.finding_type === 'institution_recall_miss')
    expect(oversized.actionability).toBe('blocked')
    expect(oversized.code_brief).toBeUndefined()
  })
  it('retains more than six measured subjects instead of truncating closure evidence to a display preview', () => {
    const evaluation = evaluate('ok')
    const finding = evaluation.findings.find(f => f.type === 'institution_recall_miss')
    finding.evidence.schools = Array.from({ length: 8 }, (_, i) => `College ${i}`)
    const item = buildApprovalQueue([evaluation]).find(i => i.finding_type === 'institution_recall_miss')
    expect(item.evidence.subjects).toHaveLength(8)
  })
  it('keeps carried subjects inconclusive and refuses closure when bounded subject history is incomplete', () => {
    const items = buildApprovalQueue([evaluate('degraded_results')]).filter(i => i.finding_type === 'institution_recall_miss')
    items[0].evidence.subjects = Array.from({ length: 205 }, (_, i) => `College ${i}`)
    const first = foldApprovalLedger(null, { items, runId: 'r1' })
    const entry = first.ledger.entries[items[0].id]
    expect(entry.evidence.subjects).toHaveLength(200)
    expect(entry.evidence.subject_history_incomplete).toBe(true)
    const healthy = evaluate('ok', true)
    healthy.recall_coverage.institution_recall_miss = entry.evidence.subjects
    const held = foldApprovalLedger(first.ledger, { items: [], evaluations: [healthy], runId: 'r2' })
    expect(held.closed).toHaveLength(0)
    expect(held.decorated[0].rationale).toMatch(/subject history is incomplete/)

    const older = foldApprovalLedger(null, { items: buildApprovalQueue([evaluate('degraded_results')]), runId: 'r1' })
    const fresh = buildApprovalQueue([evaluate('ok')]).filter(i => i.finding_type === 'institution_recall_miss')
    fresh[0].evidence.subjects = ['Other College']
    const mixed = foldApprovalLedger(older.ledger, { items: fresh, evaluations: [evaluate('ok')], runId: 'r2' })
    expect(mixed.decorated.find(i => i.finding_type === 'institution_recall_miss').actionability).toBe('blocked')
  })
  it('preserves uncertain recall in the Anya handoff without dispatching its old query-builder target', async () => {
    for (const status of ['degraded_results', 'unknown']) {
      const evaluation = evaluate(status)
      if (status === 'unknown') delete evaluation.search_evidence
      evaluation.findings = evaluation.findings.filter(f => ['institution_recall_miss', 'hyperlocal_recall_miss'].includes(f.type))
      const report = buildAnyaHandoff({ runId: 'r1', evaluations: [evaluation] })
      expect(report.findings).toHaveLength(2)
      expect(report.findings.every(f => f.attribution?.status === 'inconclusive' && f.file === null)).toBe(true)
      expect(report.files_with_findings).toBe(0)
      expect(report.amy_summary.recommended_focus).toEqual([])
      const calls = []
      report.findings.push({ type: 'unrelated', file: 'backend/unrelated.js' })
      await runAmyAnyaSamPipeline({ amyResult: { report }, options: { samEnabled: false }, runAnya: async args => { calls.push(args); return {} }, logger: {} })
      expect(calls.map(call => call.pattern)).toEqual(['unrelated.js'])
    }
    const healthy = evaluate('ok')
    const report = buildAnyaHandoff({ runId: 'r2', evaluations: [healthy] })
    const recall = report.findings.filter(f => ['institution_recall_miss', 'hyperlocal_recall_miss'].includes(f.type))
    expect(recall.every(f => f.attribution.status === 'search_verified' && f.actionability === 'code_investigation')).toBe(true)
    expect(recall[0].message).toMatch(/does not establish a query-builder defect/)
  })
  it('does not close absent recall items on a degraded or empty run, and requires healthy subject coverage', () => {
    const initial = foldApprovalLedger(null, { items: buildApprovalQueue([evaluate('degraded_results')]), runId: 'r1' })
    const empty = evaluate('degraded_results', false, true)
    const held = foldApprovalLedger(initial.ledger, { items: buildApprovalQueue([empty]), evaluations: [empty], runId: 'r2' })
    expect(held.closed.filter(i => i.lever === 'query_breadth')).toHaveLength(0)
    expect(held.decorated.filter(i => i.lever === 'query_breadth')).toHaveLength(2)
    const healthyEmpty = evaluate('ok', false, true)
    const stillHeld = foldApprovalLedger(held.ledger, { items: buildApprovalQueue([healthyEmpty]), evaluations: [healthyEmpty], runId: 'r3' })
    expect(stillHeld.closed.filter(i => i.lever === 'query_breadth')).toHaveLength(0)
    const covered = evaluate('ok', true)
    const cleared = foldApprovalLedger(stillHeld.ledger, { items: buildApprovalQueue([covered]), evaluations: [covered], runId: 'r4' })
    expect(cleared.closed.filter(i => i.lever === 'query_breadth')).toHaveLength(2)
  })
})

/**
 * Sam — Anya onboarding conversation auditor (orchestrator).
 *
 * Public surface for the admin route layer and the Mission Control UI.
 *
 * Responsibilities:
 *   1. Run the question-contract checker on the canonical Anya tree
 *      (or any tree provided to runAudit).
 *   2. Run the synthetic branch walks.
 *   3. Pull a redacted transcript summary from runtime events (when the
 *      events table is present).
 *   4. Audit recently completed onboardings against readiness.
 *   5. Persist a summary row + findings into the audit tables (when
 *      they are present), or return an in-memory summary otherwise.
 *
 * Graceful-degradation rules:
 *   - All persistence goes through `tableExists` checks. If audit tables
 *     are not migrated yet the orchestrator still returns the full
 *     analysis and reports `persisted: false`.
 *   - Any failure inside one sub-auditor degrades that section to an
 *     empty result; other sections continue.
 */

import { withProfileScope } from '../../middleware/profileContext.js'
import {
  checkOnboardingContract,
  findIrrelevantQuestions,
  FINDING_SEVERITY,
} from './samOnboardingQuestionContract.js'
import {
  simulateAllBranches,
  verifyQuickStartContainsAllRequired,
} from './samOnboardingBranchTests.js'
import {
  summariseRecentOnboardings,
  findingsFromTranscriptSummary,
} from './samOnboardingTranscriptAuditor.js'
import {
  auditRecentCompletions,
} from './samOnboardingReadinessAudit.js'
import { ANYA_ONBOARDING_QUESTION_TREE } from '../anya/anyaOnboardingQuestionTree.js'
import { ANYA_ONBOARDING_INTAKE_CONTRACT, SUPPORTED_BRANCHES } from '../anya/anyaOnboardingIntakeContract.js'

const RUNS_TABLE = 'anya_onboarding_audit_runs'
const FINDINGS_TABLE = 'anya_onboarding_audit_findings'
const EVENTS_TABLE = 'anya_onboarding_events'

async function tableExists(db, table) {
  if (!db) return false
  try {
    if (db.dialect === 'pg' || db.dialect === 'postgres') {
      const r = await db
        .prepare("SELECT 1 FROM information_schema.tables WHERE table_name = $1 LIMIT 1")
        .get(table)
      return Boolean(r)
    }
    const r = await db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1")
      .get(table)
    return Boolean(r)
  } catch {
    return false
  }
}

/**
 * Run the full audit. Returns an in-memory summary even if persistence
 * is unavailable.
 */
export async function runAudit(db, options = {}) {
  const startedAt = new Date().toISOString()
  const tree = options.tree || ANYA_ONBOARDING_QUESTION_TREE
  const contract = options.contract || ANYA_ONBOARDING_INTAKE_CONTRACT

  const contractResult = safe(() => checkOnboardingContract({ contract, tree }), {
    findings: [],
    coverage: { universal: { total: 0, covered: 0, missing: [] }, branches: {} },
    fingerprint: null,
  })
  const irrelevant = safe(() => findIrrelevantQuestions({ contract, tree }), [])
  const branches = safe(() => simulateAllBranches(), { branches: {}, findings: [], summary: {} })
  const quickStart = safe(() => verifyQuickStartContainsAllRequired(), [])

  const transcript = await safeAsync(() =>
    summariseRecentOnboardings(db, { sinceDaysAgo: options.transcriptWindowDays || 30 }),
    { installed: false, sessions: [], completion_rate: 0, drop_off_points: [], sensitive_skip_rate: 0, average_questions_seen: 0 },
  )
  const transcriptFindings = findingsFromTranscriptSummary(transcript)

  // Recent completions readiness audit — defaults to empty unless caller
  // hands us profile ids (or a session table is wired in a later PR).
  const completionAudit = await safeAsync(
    () =>
      auditRecentCompletions(db, options.recentProfileIds || [], {
        branchFor: options.branchFor || (() => null),
        computeDetailedReadiness: options.computeDetailedReadiness,
      }),
    { audited: 0, summaries: [], avg_readiness: null, avg_robert_readiness: null, findings: [] },
  )

  const findings = [
    ...contractResult.findings,
    ...irrelevant,
    ...branches.findings,
    ...quickStart,
    ...transcriptFindings,
    ...completionAudit.findings,
  ]

  const completedAt = new Date().toISOString()
  const status = findings.some((f) => f.severity === FINDING_SEVERITY.CRITICAL) ? 'failed' : 'ok'

  const summary = {
    started_at: startedAt,
    completed_at: completedAt,
    status,
    flow_version: tree.version || 'unknown',
    fingerprint: contractResult.fingerprint,
    branches_checked: SUPPORTED_BRANCHES,
    coverage: contractResult.coverage,
    branch_walk: branches.summary,
    transcript,
    completion_audit: {
      audited: completionAudit.audited,
      avg_readiness: completionAudit.avg_readiness,
      avg_robert_readiness: completionAudit.avg_robert_readiness,
    },
    findings_summary: tallyFindings(findings),
  }

  // Persist if tables exist.
  let persisted = false
  let auditRunId = null
  if (db && options.persist !== false) {
    if (await tableExists(db, RUNS_TABLE)) {
      try {
        auditRunId = await persistRun(db, summary, findings)
        persisted = true
      } catch (err) {
        summary.persistence_error = err?.message || String(err)
      }
    } else {
      summary.persistence_error = 'audit tables not installed'
    }
  }

  return {
    audit_run_id: auditRunId,
    persisted,
    summary,
    findings,
    coverage: contractResult.coverage,
    irrelevant_questions: irrelevant,
    transcript,
    completion_audit: completionAudit,
    recommendations: deriveRecommendations(findings),
  }
}

function tallyFindings(findings) {
  const out = { critical: 0, high: 0, medium: 0, low: 0, info: 0, total: findings.length }
  for (const f of findings) {
    const sev = f.severity || 'info'
    if (sev in out) out[sev] += 1
  }
  return out
}

function deriveRecommendations(findings) {
  const seen = new Set()
  const recs = []
  for (const f of findings) {
    if (!f.recommended_fix) continue
    const key = `${f.category}:${f.recommended_fix}`
    if (seen.has(key)) continue
    seen.add(key)
    recs.push({
      severity: f.severity,
      category: f.category,
      branch: f.branch,
      question_id: f.question_id,
      action: f.recommended_fix,
    })
  }
  return recs
}

async function persistRun(db, summary, findings) {
  return withProfileScope({ bypass: true }, async () => {
    const id = `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const isPg = db.dialect === 'pg' || db.dialect === 'postgres'
    const json = (v) => (isPg ? v : JSON.stringify(v))
    const placeholders = isPg ? ['$1','$2','$3','$4','$5','$6','$7','$8','$9','$10'] : Array(10).fill('?')
    const sql = `
      INSERT INTO ${RUNS_TABLE}
        (id, started_at, completed_at, status, flow_version, branches_checked_json, coverage_json, findings_json, recommendations_json, error)
      VALUES (${placeholders.join(',')})
    `
    await db.prepare(sql).run(
      id,
      summary.started_at,
      summary.completed_at,
      summary.status,
      summary.flow_version,
      json(summary.branches_checked),
      json(summary.coverage),
      json(tallyFindings(findings)),
      json(deriveRecommendations(findings)),
      summary.persistence_error || null,
    )

    if (await tableExists(db, FINDINGS_TABLE)) {
      const f_placeholders = isPg
        ? ['$1','$2','$3','$4','$5','$6','$7','$8','$9','$10','$11']
        : Array(11).fill('?')
      const fsql = `
        INSERT INTO ${FINDINGS_TABLE}
          (id, audit_run_id, severity, category, branch, question_id, title, description, evidence_json, recommended_fix, status)
        VALUES (${f_placeholders.join(',')})
      `
      let i = 0
      for (const f of findings) {
        i += 1
        await db.prepare(fsql).run(
          `${id}_f${i}`,
          id,
          f.severity || 'info',
          f.category || 'unspecified',
          f.branch || null,
          f.question_id || null,
          f.title || '',
          f.description || '',
          json(f.evidence || {}),
          f.recommended_fix || null,
          'open',
        )
      }
    }
    return id
  })
}

/**
 * Read most recent audit run + its findings (for the admin dashboard).
 */
export async function getLatestAudit(db) {
  if (!db || !(await tableExists(db, RUNS_TABLE))) {
    return { installed: false, run: null, findings: [] }
  }
  return withProfileScope({ bypass: true }, async () => {
    const run = await db
      .prepare(`SELECT * FROM ${RUNS_TABLE} ORDER BY completed_at DESC LIMIT 1`)
      .get()
    if (!run) return { installed: true, run: null, findings: [] }
    let findings = []
    if (await tableExists(db, FINDINGS_TABLE)) {
      findings = await db
        .prepare(`SELECT * FROM ${FINDINGS_TABLE} WHERE audit_run_id = ? ORDER BY severity, created_at DESC`)
        .all(run.id)
    }
    return { installed: true, run: decodeRun(run), findings: findings.map(decodeFinding) }
  })
}

/**
 * Read findings (open + optionally include resolved/ignored).
 */
export async function listFindings(db, { status = 'open', limit = 200 } = {}) {
  if (!db || !(await tableExists(db, FINDINGS_TABLE))) {
    return { installed: false, items: [] }
  }
  return withProfileScope({ bypass: true }, async () => {
    const rows =
      status === 'all'
        ? await db.prepare(`SELECT * FROM ${FINDINGS_TABLE} ORDER BY severity, created_at DESC LIMIT ?`).all(limit)
        : await db
            .prepare(`SELECT * FROM ${FINDINGS_TABLE} WHERE status = ? ORDER BY severity, created_at DESC LIMIT ?`)
            .all(status, limit)
    return { installed: true, items: rows.map(decodeFinding) }
  })
}

export async function resolveFinding(db, id, action = 'resolved') {
  if (!db || !(await tableExists(db, FINDINGS_TABLE))) return { installed: false, ok: false }
  if (!['resolved', 'ignored'].includes(action)) return { ok: false, error: 'invalid_action' }
  return withProfileScope({ bypass: true }, async () => {
    await db
      .prepare(`UPDATE ${FINDINGS_TABLE} SET status = ?, updated_at = ? WHERE id = ?`)
      .run(action, new Date().toISOString(), id)
    return { ok: true, id, action }
  })
}

/**
 * Quick status read for Mission Control.
 */
export async function getStatus(db) {
  const result = {
    audit_installed: await tableExists(db, RUNS_TABLE),
    findings_installed: await tableExists(db, FINDINGS_TABLE),
    events_installed: await tableExists(db, EVENTS_TABLE),
    last_run: null,
    open_findings_by_severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  }
  if (!db) return result
  if (result.audit_installed) {
    const last = await withProfileScope({ bypass: true }, () =>
      db.prepare(`SELECT id, started_at, completed_at, status, flow_version FROM ${RUNS_TABLE} ORDER BY completed_at DESC LIMIT 1`).get(),
    )
    if (last) result.last_run = last
  }
  if (result.findings_installed) {
    const rows = await withProfileScope({ bypass: true }, () =>
      db.prepare(`SELECT severity, COUNT(*) AS n FROM ${FINDINGS_TABLE} WHERE status = 'open' GROUP BY severity`).all(),
    )
    for (const r of rows || []) {
      if (r.severity in result.open_findings_by_severity) {
        result.open_findings_by_severity[r.severity] = Number(r.n || 0)
      }
    }
  }
  return result
}

function decodeRun(row) {
  return {
    ...row,
    branches_checked: parseJson(row.branches_checked_json),
    coverage: parseJson(row.coverage_json),
    findings: parseJson(row.findings_json),
    recommendations: parseJson(row.recommendations_json),
  }
}

function decodeFinding(row) {
  return {
    ...row,
    evidence: parseJson(row.evidence_json),
  }
}

function parseJson(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'object') return v
  try { return JSON.parse(v) } catch { return null }
}

function safe(fn, fallback) {
  try { return fn() } catch { return fallback }
}
async function safeAsync(fn, fallback) {
  try { return await fn() } catch { return fallback }
}

export const __exposed = { tableExists, RUNS_TABLE, FINDINGS_TABLE, EVENTS_TABLE }

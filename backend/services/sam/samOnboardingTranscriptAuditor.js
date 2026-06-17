/**
 * Sam — runtime onboarding transcript auditor.
 *
 * Reads the `anya_onboarding_events` telemetry table (when present) and
 * produces redacted, privacy-preserving summaries.
 *
 * Privacy rules (enforced here):
 *   - Never echo `details_json` raw answers in the response.
 *   - Sensitive question events surface only `{ question_id, status,
 *     confidence }` — never the user's text.
 *   - Aggregations report counts, not transcripts.
 *
 * Graceful-degradation rules:
 *   - If the events table is missing, return a structured "not_installed"
 *     status and an empty summary — never throw.
 *   - If a session has no events, return an empty session record.
 *
 * This module reads via `withProfileScope({ bypass: true })` because Sam
 * is an admin auditor that operates cross-tenant.
 */

import { withProfileScope } from '../../middleware/profileContext.js'
import { FINDING_SEVERITY } from './samOnboardingQuestionContract.js'

const EVENTS_TABLE = 'anya_onboarding_events'

const SENSITIVE_INTAKE_FIELDS = new Set([
  'household_income_range',
  'disability_or_health_need',
  'veteran_status',
  'voluntary_demographics',
  'denomination',
  'gpa_or_test_scores',
  'minority_woman_veteran_ownership',
  'annual_revenue_range',
  'annual_budget',
])

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
 * Summarise events for a window. Returns a single structured payload —
 * never raw transcript text.
 */
export async function summariseRecentOnboardings(db, { sinceDaysAgo = 30, limit = 200 } = {}) {
  const empty = {
    installed: false,
    sessions: [],
    completion_rate: 0,
    drop_off_points: [],
    sensitive_skip_rate: 0,
    average_questions_seen: 0,
  }
  if (!(await tableExists(db, EVENTS_TABLE))) return empty

  return withProfileScope({ bypass: true }, async () => {
    const since = new Date(Date.now() - sinceDaysAgo * 86400 * 1000).toISOString()
    const rows = await db
      .prepare(
        `SELECT session_id, user_id, profile_id, branch, event_type, question_id, field_key, status, confidence, created_at
           FROM ${EVENTS_TABLE}
          WHERE created_at >= ?
          ORDER BY session_id, created_at`,
      )
      .all(since)

    return summariseFromRows(rows, { limit })
  })
}

/**
 * Pure, side-effect-free summariser. Exposed so unit tests can pass rows in
 * directly without standing up the table.
 */
export function summariseFromRows(rows, { limit = 200 } = {}) {
  const bySession = new Map()
  for (const r of rows || []) {
    if (!bySession.has(r.session_id)) bySession.set(r.session_id, [])
    bySession.get(r.session_id).push(r)
  }

  const sessions = []
  let completed = 0
  const dropOffByQuestion = new Map()
  let sensitiveAsked = 0
  let sensitiveSkipped = 0
  let totalQuestionsSeen = 0

  for (const [sessionId, events] of bySession.entries()) {
    if (sessions.length >= limit) break
    const branch = events.find((e) => e.event_type === 'branch_selected')?.branch || null
    const startedAt = events[0]?.created_at || null
    const lastEvent = events[events.length - 1]
    const completedEvent = events.find((e) => e.event_type === 'onboarding_completed')
    const isComplete = Boolean(completedEvent)
    if (isComplete) completed += 1

    const questionEvents = events.filter((e) => e.event_type === 'question_asked')
    totalQuestionsSeen += questionEvents.length

    for (const e of events) {
      const isSensitive =
        SENSITIVE_INTAKE_FIELDS.has(e.field_key || '') ||
        (e.question_id && /\.(household_income_range|disability_or_health_need|veteran_status|voluntary_demographics|denomination|gpa_or_test_scores|minority_woman_veteran_ownership|annual_revenue_range|annual_budget)$/.test(e.question_id))
      if (e.event_type === 'question_asked' && isSensitive) sensitiveAsked += 1
      if ((e.event_type === 'field_skipped' || e.status === 'skipped') && isSensitive) sensitiveSkipped += 1
    }

    if (!isComplete && lastEvent?.question_id) {
      dropOffByQuestion.set(
        lastEvent.question_id,
        (dropOffByQuestion.get(lastEvent.question_id) || 0) + 1,
      )
    }

    sessions.push({
      session_id: sessionId,
      user_id: events[0]?.user_id || null,
      profile_id: events.find((e) => e.profile_id)?.profile_id || null,
      branch,
      started_at: startedAt,
      last_event_at: lastEvent?.created_at || null,
      questions_asked: questionEvents.length,
      completed: isComplete,
      // Note: no question text, no answer text — only structural counts.
    })
  }

  const totalSessions = bySession.size
  const completion_rate = totalSessions ? Number((completed / totalSessions).toFixed(3)) : 0
  const sensitive_skip_rate = sensitiveAsked ? Number((sensitiveSkipped / sensitiveAsked).toFixed(3)) : 0
  const average_questions_seen = totalSessions ? Number((totalQuestionsSeen / totalSessions).toFixed(2)) : 0

  return {
    installed: true,
    sessions,
    completion_rate,
    drop_off_points: [...dropOffByQuestion.entries()]
      .map(([question_id, count]) => ({ question_id, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    sensitive_skip_rate,
    average_questions_seen,
  }
}

/**
 * Translate transcript-level patterns into Sam findings.
 */
export function findingsFromTranscriptSummary(summary) {
  const findings = []
  if (!summary || !summary.installed) return findings

  if (summary.completion_rate > 0 && summary.completion_rate < 0.5) {
    findings.push({
      severity: FINDING_SEVERITY.HIGH,
      category: 'low_onboarding_completion_rate',
      branch: null,
      question_id: null,
      title: `Onboarding completion rate is ${(summary.completion_rate * 100).toFixed(1)}%`,
      description: `Less than half of users who start onboarding finish it.`,
      recommended_fix: `Review the top drop-off questions and consider trimming, rewording, or making them optional.`,
      evidence: { completion_rate: summary.completion_rate, drop_off_points: summary.drop_off_points },
    })
  }

  for (const dop of summary.drop_off_points || []) {
    if (dop.count >= 5) {
      findings.push({
        severity: FINDING_SEVERITY.MEDIUM,
        category: 'frequent_drop_off',
        branch: null,
        question_id: dop.question_id,
        title: `Frequent drop-off at "${dop.question_id}"`,
        description: `${dop.count} sessions abandoned at this question in the audit window.`,
        recommended_fix: `Review the prompt wording, optionality, and surrounding context.`,
        evidence: { question_id: dop.question_id, count: dop.count },
      })
    }
  }

  if (summary.sensitive_skip_rate > 0.7) {
    findings.push({
      severity: FINDING_SEVERITY.LOW,
      category: 'high_sensitive_skip_rate',
      branch: null,
      question_id: null,
      title: `Users skip ${(summary.sensitive_skip_rate * 100).toFixed(0)}% of sensitive questions`,
      description: `Either users don't trust the rationale, the questions feel intrusive, or they're being asked too early.`,
      recommended_fix: `Improve rationale text and consider asking these only when matching benefits would clearly require them.`,
      evidence: { sensitive_skip_rate: summary.sensitive_skip_rate },
    })
  }

  return findings
}

export const __exposed = { tableExists, EVENTS_TABLE, SENSITIVE_INTAKE_FIELDS }

/**
 * anyaDailyOwnerReport.js — Anya's daily owner email at 09:00 ET.
 *
 * The second half of the Sam→Anya morning pipeline:
 *   05:00 ET  Sam runs the full code/function sweep. The deterministically
 *             auto-fixable issues are corrected by the sam-autofix GitHub Action
 *             (eslint --fix → PR → merge → prod). Everything Sam could NOT
 *             auto-fix is persisted to sam_runs as findings.
 *   09:00 ET  Anya (this module) reads that sweep's findings and emails the
 *             owner a plain-English digest of the code/function errors,
 *             weaknesses, and bugs that need a human — plus a short note on what
 *             was already auto-corrected.
 *
 * The two are linked by a system_kv pointer (sam_daily_code_sweep_run_id) set by
 * the 05:00 sweep; Anya falls back to the latest Sam run if the pointer is unset.
 *
 * Owner-facing email goes to ADMIN_EMAIL via Resend (backend/services/email.js).
 * Best-effort: never throws on the scheduler hot path. Disable with
 * ANYA_DAILY_REPORT_ENABLED=false.
 */

import { sendEmail as defaultSendEmail } from '../email.js'
import { ADMIN_EMAIL } from '../../config/constants.js'
import { maskSecrets, latestRun as defaultLatestRun, getRun as defaultGetRun } from '../sam/samAuditStore.js'
import { summarizeCrawlerResearch } from '../amy/crawlerCompetitiveResearch.js'
import { defaultLoadEvaPortfolioQa, summarizeEvaPortfolioQa } from '../eva/evaSummary.js'
import { renderEvaSection } from '../eva/evaReportSection.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('anyaDailyOwnerReport')

// Owner-email evidence must obey the same freshness boundary as the Sam checks.
// Otherwise a missed scheduler run turns yesterday's defects into a new-looking
// email every morning and sends the owner back through already-completed work.
export const OWNER_AMY_STALE_MS = 36 * 60 * 60 * 1000
export const OWNER_WEB_PARITY_STALE_MS = 48 * 60 * 60 * 1000
export const OWNER_EVIDENCE_FUTURE_TOLERANCE_MS = 60 * 60 * 1000

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function evidenceAgeMs(value, now = new Date()) {
  const observedMs = Date.parse(value || '')
  const currentMs = now instanceof Date ? now.getTime() : Date.parse(now)
  return Number.isFinite(observedMs) && Number.isFinite(currentMs)
    ? currentMs - observedMs
    : Number.POSITIVE_INFINITY
}

function amyEvidenceTimestamp(amy) {
  const receipts = Array.isArray(amy?.cohort?.run_receipts) ? amy.cohort.run_receipts : []
  if (amy?.cohort) return receipts.length ? receipts[receipts.length - 1]?.recorded_at : null
  return amy?.report?.completed_at || amy?.report?.generated_at || amy?.report?.created_at || null
}

function staleEvidenceLine(kind, ageMs, staleMs) {
  const age = !Number.isFinite(ageMs)
    ? 'missing a valid observation timestamp'
    : ageMs < 0
      ? 'timestamp is implausibly in the future'
      : `${Math.round(ageMs / 3600000)}h old`
  return `${kind} evidence is STALE (${age}; expected within ${Math.round(staleMs / 3600000)}h). Old measurements and findings were suppressed.`
}

export function isAnyaDailyReportEnabled() {
  return String(process.env.ANYA_DAILY_REPORT_ENABLED ?? 'true').toLowerCase() !== 'false'
}

function recipient() {
  const v = (process.env.ANYA_DAILY_REPORT_EMAIL || ADMIN_EMAIL || '').trim()
  return v || null
}

/**
 * Load the Amy-flywheel data for the digest: today's (or the most recent)
 * cohort day from the flywheel scoreboard + the latest Amy run report (the
 * autonomous-edit record). Best-effort — the digest sends without the section
 * when Amy has no data.
 */
async function defaultLoadAmy(db) {
  try {
    const [{ getFlywheelCohort }, { readLatestAmyReport }] = await Promise.all([
      import('../amy/flywheelCohort.js'),
      import('../amy/amyReportStore.js'),
    ])
    const [store, report] = await Promise.all([
      getFlywheelCohort(db).catch(() => null),
      readLatestAmyReport(db).catch(() => null),
    ])
    const days = store?.days && typeof store.days === 'object' ? store.days : {}
    const keys = Object.keys(days).sort()
    const cohort = keys.length ? days[keys[keys.length - 1]] : null
    if (!cohort && !report) return null
    return { cohort, goal_notified_at: store?.goal_notified_at ?? null, report }
  } catch {
    return null
  }
}

/**
 * Load the coverage-gap data for the digest: the fleet Coverage & Evidence
 * gap scoreboard (system_kv coverage_gap_scoreboard, refreshed by Amy's daily
 * gap-learning run) + the last 24h of unified agent activity for amy/sam/anya
 * (the Agent Observability Rule's "what changed overnight" record).
 * Best-effort — the digest sends without the section when neither exists.
 */
async function defaultLoadCoverageGaps(db, { now = null } = {}) {
  try {
    const [{ readGapScoreboard }, { readActivityEvents }] = await Promise.all([
      import('../coverageGapScoreboard.js'),
      import('../agentTelemetry/agentTelemetryStore.js'),
    ])
    const scoreboard = await readGapScoreboard(db).catch(() => null)
    const endMs = now instanceof Date ? now.getTime() : Date.now()
    const startIso = new Date(endMs - 24 * 60 * 60 * 1000).toISOString()
    const events = await readActivityEvents(db, { agents: ['amy', 'sam', 'anya'], startIso, limit: 60 }).catch(() => [])
    // What the wishlist consumer has actually tried per condition — this is what
    // turns "add a cipn source" (an ask the owner cannot action) into "we searched
    // 3× and found nothing; likely none exists" (a fact).
    const conditionSearch = await import('../coverageAudit/conditionSourceSearch.js')
      .then((m) => m.readConditionSearchEvidence(db))
      .catch(() => null)
    if (!scoreboard && (!Array.isArray(events) || events.length === 0)) return null
    return { scoreboard, events: Array.isArray(events) ? events : [], conditionSearch }
  } catch {
    return null
  }
}

/**
 * Load the Google-bar web-parity benchmark for the digest (system_kv
 * `web_parity_benchmark`, refreshed by the nightly maintenance sweep).
 * Best-effort — the digest sends without the section when it has never run.
 */
async function defaultLoadWebParity(db) {
  try {
    const { readWebParityBenchmark } = await import('../webParityBenchmark.js')
    const store = await readWebParityBenchmark(db).catch(() => null)
    return store?.latest ? store : null
  } catch {
    return null
  }
}

/**
 * Load Amy's competitive crawler research for the digest (system_kv
 * `amy_crawler_research`, refreshed by the throttled nightly research pass —
 * owner directive 2026-07-14). Best-effort — the section is omitted until the
 * research goal has run at least once.
 */
async function defaultLoadCrawlerResearch(db) {
  try {
    const { readCrawlerResearch } = await import('../amy/crawlerCompetitiveResearch.js')
    const store = await readCrawlerResearch(db).catch(() => null)
    return store?.latest ? store : null
  } catch {
    return null
  }
}

/**
 * Load the agent-mesh overview for the digest (system_kv agent_mesh_messages +
 * agent_mesh_lessons — the inter-agent message/lesson exchange). Best-effort —
 * the digest sends without the section until the mesh has been used once.
 */
async function defaultLoadAgentMesh(db, { now = null } = {}) {
  try {
    const { readMeshOverview } = await import('../agentMesh/agentMeshStore.js')
    return await readMeshOverview(db, { now: now || undefined })
  } catch {
    return null
  }
}

/**
 * Summarize the agent mesh for the owner: which agents talked to which, what
 * was taught, and — the bar that matters — which lessons another agent
 * actually CONSUMED (a lesson nobody folds into a run is a note, not
 * teaching). Pure; exported for tests.
 *
 * @param {{recent_messages?:Array, fresh_lessons?:Array}|null} meshOverview
 * @returns {{headline:string, messages:string[], lessons:string[]}|null}
 */
export function summarizeAgentMesh(meshOverview) {
  if (!meshOverview) return null
  const messages = Array.isArray(meshOverview.recent_messages) ? meshOverview.recent_messages : []
  const lessons = Array.isArray(meshOverview.fresh_lessons) ? meshOverview.fresh_lessons : []
  if (messages.length === 0 && lessons.length === 0) return null

  const consumedCount = lessons.filter((l) => Object.keys(l.consumed_by || {}).length > 0).length
  const headline = `${messages.length} message(s) exchanged in the last 24h; ${lessons.length} fresh lesson(s) on the board, ${consumedCount} consumed by another agent.`

  const messageLines = messages.slice(-8).map((m) => `${m.from} → ${m.to}: ${maskSecrets(m.body || m.kind || 'message')}`)
  const lessonLines = lessons.slice(0, 8).map((l) => {
    const consumers = Object.keys(l.consumed_by || {})
    const confirms = (l.confirmations || []).map((c) => c.agent)
    const refutes = (l.refutations || []).map((c) => c.agent)
    const tail = [
      consumers.length ? `consumed by ${consumers.join(', ')}` : 'not yet consumed',
      confirms.length ? `confirmed by ${confirms.join(', ')}` : null,
      refutes.length ? `refuted by ${refutes.join(', ')}` : null,
      (Number(l.times_seen) || 1) > 1 ? `seen ${l.times_seen}×` : null,
    ].filter(Boolean).join('; ')
    return `[${l.author} · ${l.topic}] ${maskSecrets(l.claim)} (${tail})`
  })

  return { headline, messages: messageLines, lessons: lessonLines }
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
const SEVERITY_LABEL = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
}
const SEVERITY_COLOR = {
  critical: '#b91c1c',
  high: '#c2410c',
  medium: '#a16207',
  low: '#2563eb',
  info: '#475569',
}

/** Sam's corrective intent for a finding: planned strategy, else recommended_fix. */
function fixHint(finding, planByFindingId) {
  const plan = planByFindingId.get(finding?.id)
  if (plan?.patch_summary) return plan.patch_summary
  if (plan?.strategy) return plan.strategy
  return finding?.recommended_fix || ''
}

/**
 * Summarize the Amy flywheel for the owner: what the daily synthetic cohort
 * found, which edits the learning loop applied autonomously, and what it could
 * NOT edit (approval queue + persistent gap classes) — the owner's standing
 * directive is that these three appear in the morning email. Pure; exported
 * for tests.
 *
 * @param {{cohort?:object|null, goal_notified_at?:string|null, report?:object|null}} amy
 * @returns {{cohortLine:string, edits:string[], couldNot:string[], goal:boolean}|null}
 */
export function summarizeAmyFlywheel(amy, { now = new Date() } = {}) {
  if (!amy || (!amy.cohort && !amy.report)) return null
  const ageMs = evidenceAgeMs(amyEvidenceTimestamp(amy), now)
  if (!Number.isFinite(ageMs) || ageMs > OWNER_AMY_STALE_MS || ageMs < -OWNER_EVIDENCE_FUTURE_TOLERANCE_MS) {
    return {
      cohortLine: staleEvidenceLine('Amy flywheel', ageMs, OWNER_AMY_STALE_MS),
      edits: [],
      couldNot: [],
      goal: false,
      stale: true,
    }
  }
  const day = amy.cohort || null
  const report = amy.report || {}

  const cohortLine = day
    ? `${day.clean}/${day.evaluated} synthetic profiles clean (target ${day.target}, ${day.issues} with issues) on ${day.day}`
    : 'No cohort data for today yet.'
  const goal = Boolean(day && day.complete && day.all_clean)

  const edits = []
  const tuning = report.tuning || {}
  if (tuning?.applied?.applied) edits.push(`Score floor tuned ${tuning.from} → ${tuning.to} (validated on the cohort).`)
  const wt = report.weight_tuning || {}
  if (wt?.validation?.kept) edits.push('Scoring weights re-tuned — re-crawl validated and KEPT.')
  else if (wt?.applied?.applied && wt?.validation && !wt.validation.kept) edits.push('Scoring weights trial did not improve quality — auto-REVERTED.')
  const cov = report.coverage_tuning || {}
  if (cov?.validation?.kept) {
    const n = Array.isArray(cov.additions) ? cov.additions.length : 0
    edits.push(`Source keyword coverage widened (${n} addition${n === 1 ? '' : 's'}) — re-crawl validated and KEPT.`)
  } else if (cov?.applied?.applied && cov?.validation && !cov.validation.kept) {
    edits.push('Source coverage trial did not improve quality — auto-REVERTED.')
  }
  const lessons = report.archetype_learning?.update || {}
  const lessonCount = Object.keys(lessons).length
  if (lessonCount > 0) edits.push(`Query-steering lessons recorded for ${lessonCount} profile archetype${lessonCount === 1 ? '' : 's'} (next crawls target the misses).`)

  // ── WHAT AMY WENT LOOKING FOR, and whether the search WIDENED (2026-08-02) ──
  // The owner's goal is "until her profiles no longer reveal gaps", whose
  // failure mode is a gap count that falls because the probing narrowed. So the
  // cohort line never stands alone: the probe breadth that produced it goes
  // beside it, and the convergence verdict says which of the two happened in
  // words that cannot be mistaken for each other.
  const probes = report.gap_probes || null
  if (probes?.enabled && Number(probes.built) > 0) {
    edits.push(
      `${probes.built} adversarial gap-probe profile${probes.built === 1 ? '' : 's'} built on the least-tested intersections`
      + `${Number.isFinite(Number(probes.pairs_targeted)) ? ` (targeting ${probes.pairs_targeted} never-probed axis pairs)` : ''}`
      + `${probes.pair_space_exhausted ? ' — the pair space is EXHAUSTED; probes are now stale-rechecks' : ''}.`,
    )
  }
  const conv = report.convergence || null
  if (conv?.statement) {
    const label = conv.trend === 'converging' ? 'CONVERGING' : String(conv.trend || '').toUpperCase()
    edits.push(`Gap trend — ${label}: ${conv.statement}`)
  }
  const proof = report.deletion_proof || null
  if (proof?.verdict) {
    if (proof.verdict === 'proven') {
      edits.push(`Synthetic profiles deleted and VERIFIED: ${proof.reported_deleted} reaped, ${proof.profiles_before} → ${proof.profiles_after} rows, zero past TTL.`)
    } else if (proof.verdict === 'leaked') {
      const leakedN = Number.isFinite(Number(proof.leaked_survivor_count)) && proof.leaked_survivor_count !== null
        ? proof.leaked_survivor_count
        : proof.expired_survivor_count
      edits.push(`Synthetic cleanup LEAKED: ${leakedN} profile(s) survived past their TTL with no guard holding them (${proof.profiles_after} Amy rows still live).`)
    } else if (proof.verdict === 'grace_held') {
      // NOT an alarm: the sweep is deliberately holding these under its own
      // documented grace (recently crawled/discovered, or inside the bounded
      // never-crawled window) and reaps them once the grace lapses.
      edits.push(`Synthetic cleanup: ${proof.grace_held_count} expired profile(s) held by the sweep's documented grace windows — by design, reaped after the grace lapses (${proof.profiles_after} Amy rows live).`)
    }
  }

  // ── PIPELINE GUARD-ESCAPE AUDIT (owner directive 2026-08-23) ────────────
  // At her reap Amy re-checks every REAL profile's pipeline against the canonical
  // four-gate criteria and removes sources that slipped past admission, learning
  // the blind spot that let each in. Zero escapes is an honest success line, not
  // silence — the guards are holding.
  const escape = report.pipeline_guard_escape_audit || null
  if (escape?.ran) {
    const escN = Number(escape.escapes_removed) || 0
    if (escN > 0) {
      const gates = Object.entries(escape.by_gate || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([g, c]) => `${g}×${c}`)
        .join(', ')
      edits.push(
        `Pipeline guard-escape audit — removed ${escN} source(s) that had slipped past admission across `
        + `${escape.profiles_with_escapes || 0} of ${escape.profiles_scanned || 0} real pipeline(s) (by gate: ${gates || 'n/a'}). `
        + `Each escape's admission blind spot is in the code-change items below.`,
      )
    } else {
      edits.push(
        `Pipeline guard-escape audit — scanned ${escape.profiles_scanned || 0} real pipeline(s), ZERO escapes: `
        + `the admission gates and the boot-net sweep are holding.`,
      )
    }
  }

  const couldNot = []
  const queue = Array.isArray(report.approval_queue) ? report.approval_queue.filter((q) => !q?.auto_applied) : []
  // A ledger CLOSE is the only proof this loop can converge — report it first,
  // above the open items, so an owner can see the queue moving at all.
  const closed = Array.isArray(report.approval_ledger?.closed) ? report.approval_ledger.closed : []
  if (closed.length > 0) {
    edits.push(`${closed.length} approval item(s) CLOSED — stopped reproducing after ${closed.map((c) => `${c.lever || 'change'}${c.category ? `/${c.category}` : ''} (${c.nights_open || 1}n)`).slice(0, 4).join(', ')}.`)
  }
  // ASK ONLY FOR WHAT AN APPROVAL CAN CLOSE (2026-08-01). An item on an AUTO
  // lever is Amy's own work and an item on a CODE_CHANGE lever cannot be closed
  // by any approval — rendering either as "Needs your approval" is a fake ask,
  // and six of them a night is how this queue became wallpaper (20 consecutive
  // runs with a non-empty queue and not one item ever actioned). Each line now
  // carries its AGE and the exact surface that closes it.
  const ownerAsks = queue.filter((q) => q?.requires_approval === true || q?.actionability === 'owner_api')
  const codeChanges = queue.filter((q) => q?.actionability === 'code_change')
  const age = (item) => {
    const n = Number(item?.nights_open)
    if (!Number.isFinite(n) || n <= 0) return ''
    return ` [open ${n} night${n === 1 ? '' : 's'}${item?.first_seen_at ? ` since ${String(item.first_seen_at).slice(0, 10)}` : ''}${item?.stale ? ' — STALE' : ''}]`
  }
  for (const item of ownerAsks.slice(0, 6)) {
    couldNot.push(
      `Needs your approval: ${item?.lever || 'change'}${item?.category ? ` for ${item.category}` : ''}${age(item)}`
      + `${item?.apply_surface ? ` → ${item.apply_surface}` : ''}`,
    )
  }
  if (ownerAsks.length > 6) couldNot.push(`…and ${ownerAsks.length - 6} more awaiting your approval.`)
  for (const item of codeChanges.slice(0, 4)) {
    // A code-change line now carries the BRIEF, so "no approval can close this"
    // is followed by exactly what to open and where — not just a refusal.
    const brief = item?.code_brief || null
    couldNot.push(
      `Needs a CODE change (no approval can close this): ${item?.lever || 'change'}${item?.category ? ` for ${item.category}` : ''}${age(item)}`
      + `${brief?.file ? ` → ${brief.file}${brief.line ? `:${brief.line}` : ''}` : ''}`
      + `${brief?.subjects?.length ? ` [${brief.subjects.slice(0, 3).join(', ')}]` : ''}`
      + `${item?.human_gate_reason ? ` — ${item.human_gate_reason}` : ''}`,
    )
  }
  if (codeChanges.length > 4) couldNot.push(`…and ${codeChanges.length - 4} more code-change items.`)
  if (day && day.issues > 0) {
    const types = Object.entries(day.finding_types || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, v]) => `${k} ×${v}`)
      .join(', ')
    couldNot.push(`Open gap classes the loop has not closed yet: ${types || 'n/a'} — persistent classes need a code change.`)
  }
  // The honest "this cannot finish itself" list, named rather than counted.
  for (const u of (Array.isArray(conv?.unclosable_by_any_lever) ? conv.unclosable_by_any_lever : []).slice(0, 3)) {
    couldNot.push(
      `NO LEVER CAN CLOSE THIS: ${u.finding_type}${u.category ? ` (${u.category})` : ''} open ${u.nights_open} nights`
      + `${u.file ? ` → ${u.file}` : ''} — ${u.human_action}`,
    )
  }

  return { cohortLine, edits, couldNot, goal }
}

/**
 * Summarize the fleet coverage gaps + overnight agent activity for the owner:
 * the top gaps from the Coverage & Evidence scoreboard, the adapter wishlist
 * (structural gaps only a code change can fix), and — from the unified
 * agent_activity_events telemetry — what the agents CHANGED autonomously
 * overnight vs what still needs the owner. Pure; exported for tests.
 *
 * @param {{scoreboard?:object|null, events?:Array|null}} gaps
 * @returns {{headline:string, topGaps:string[], wishlist:string[], changed:string[], needsOwner:string[]}|null}
 */
/**
 * What the wishlist consumer has actually TRIED for a condition.
 *
 * "Nobody has looked yet" and "we looked and there is nothing" are different facts,
 * and a wishlist that cannot tell them apart is asking the owner to adjudicate
 * blind. Mirrors the remaining-vs-exhausted distinction the amount sweep needed:
 * an entry that reads the same on night 1 and night 30 is not a finding, it is
 * wallpaper. Never suppresses the entry — a structural gap stays visible.
 */
function conditionSearchNote(detail, searchEvidence) {
  const key = String(detail || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const rec = searchEvidence?.[key]
  if (!rec) return ' [not yet searched]'
  const when = String(rec.searched_at || '').slice(0, 10)
  if (rec.candidates_queued > 0) {
    return ` [searched ${rec.queries_run} queries ${when} → ${rec.candidates_queued} candidate source(s) queued; pending the gates on the next crawl]`
  }
  if (rec.exhausted) {
    return ` [searched ${rec.attempts}× through ${when} → 0 real sources found; likely none exists]`
  }
  return ` [searched ${rec.queries_run} queries ${when} → 0 found; will retry]`
}

export function summarizeCoverageGaps(gaps) {
  if (!gaps || (!gaps.scoreboard && !(Array.isArray(gaps.events) && gaps.events.length > 0))) return null
  const board = gaps.scoreboard || null
  const events = Array.isArray(gaps.events) ? gaps.events : []
  const searchEvidence = gaps.conditionSearch || null

  const boardGaps = Array.isArray(board?.gaps) ? board.gaps : []
  const headline = board
    ? `${boardGaps.length} coverage gap class(es) across ${Number(board.profiles_scanned) || 0} scanned profile(s) (scoreboard ${board.generated_at || 'undated'}).`
    : 'No fleet gap scoreboard recorded yet — showing overnight agent activity only.'

  const topGaps = boardGaps.slice(0, 5).map((g) => `${g.count} profile(s): ${g.statement}`)
  const wishlist = (Array.isArray(board?.adapter_wishlist) ? board.adapter_wishlist : [])
    .slice(0, 5)
    .map((w) => {
      const note = w.gap_class === 'no_disease_source' ? conditionSearchNote(w.detail, searchEvidence) : ''
      return `${w.detail || w.lane || 'lane'} — ${w.statement} (${w.affected_profiles_count} profile(s); ${w.suggested_action || 'add a source adapter'})${note}`
    })

  // Autonomous vs needs-owner, straight from telemetry: succeeded events are
  // the changes the agents made themselves; blocked/failed events (plus the
  // wishlist above) are what still needs a human.
  const label = (e) => `[${e?.agent_name || 'agent'}] ${maskSecrets(e?.title || e?.event_type || 'activity')}`
  // Schedulers can legitimately emit the same idempotent success more than
  // once (the August 25 email listed one scoreboard refresh five times). An
  // owner digest is an inventory of distinct changes, not a raw event log.
  const eventIdentity = (event) => {
    const agent = String(event?.agent_name || 'agent')
    const eventType = String(event?.event_type || 'activity')
    const status = String(event?.status || '')
    const entityType = String(event?.entity_type || '')
    const entityId = String(event?.entity_id || '')
    // Entity identity wins when telemetry supplies it: two same-titled changes
    // to different profiles/sources are distinct. Without an entity, the event
    // type is the stable idempotency key, so repeated scheduler receipts collapse
    // even if each database row has a different surrogate id.
    return entityType || entityId
      ? `${agent}|${eventType}|${status}|${entityType}|${entityId}`
      : `${agent}|${eventType}|${status}`
  }
  const distinctLabels = (rows) => {
    const distinct = []
    const seen = new Set()
    for (const event of rows) {
      const identity = eventIdentity(event)
      if (seen.has(identity)) continue
      seen.add(identity)
      distinct.push({ event, rendered: label(event) })
      if (distinct.length >= 8) break
    }
    const counts = new Map()
    for (const item of distinct) counts.set(item.rendered, (counts.get(item.rendered) || 0) + 1)
    return distinct.map(({ event, rendered }) => {
      if ((counts.get(rendered) || 0) < 2) return rendered
      const entity = [event?.entity_type, event?.entity_id].filter(Boolean).join(':')
      return entity ? `${rendered} [${maskSecrets(entity)}]` : rendered
    })
  }
  const changed = distinctLabels(events.filter((e) => e?.status === 'succeeded'))
  const needsOwner = distinctLabels(events.filter((e) => e?.status === 'blocked' || e?.status === 'failed'))

  return { headline, topGaps, wishlist, changed, needsOwner }
}

/**
 * Summarize the Google-bar web-parity benchmark for the owner: the latest
 * parity per golden profile, the trend arrow vs the prior run, and the top
 * web-only finds awaiting the owner's judgment (candidates in the
 * web_parity_gap_queue — never auto-inserted). Pure; exported for tests.
 *
 * @param {{latest?:object|null, runs?:Array|null}} parity  the system_kv
 *        `web_parity_benchmark` store
 * @returns {{headline:string, perProfile:string[], webOnlyTop:string[]}|null}
 */
export function summarizeWebParity(parity, { now = new Date() } = {}) {
  const latest = parity?.latest
  if (!latest || !Array.isArray(latest.per_profile)) return null
  const ageMs = evidenceAgeMs(latest.generated_at || parity?.generated_at, now)
  if (!Number.isFinite(ageMs) || ageMs > OWNER_WEB_PARITY_STALE_MS || ageMs < -OWNER_EVIDENCE_FUTURE_TOLERANCE_MS) {
    return {
      headline: staleEvidenceLine('Web-parity benchmark', ageMs, OWNER_WEB_PARITY_STALE_MS),
      perProfile: [],
      webOnlyTop: [],
      stale: true,
    }
  }
  const runs = Array.isArray(parity.runs) ? parity.runs : []
  const semanticsVersion = Number(latest.semantics_version)
  const usesQualifiedSampleContract = Number.isFinite(semanticsVersion) && semanticsVersion >= 2
  const sampleQualified = latest.sample_qualified === true || (
    !usesQualifiedSampleContract &&
    (latest.sample_qualified === null || latest.sample_qualified === undefined)
  )
  const priorRuns = runs.slice(0, -1)
  const prev = [...priorRuns].reverse().find((run) => !usesQualifiedSampleContract || (
    Number(run?.semantics_version) === semanticsVersion && run?.sample_qualified === true
  )) || null

  const arrow = (nowVal, prevVal) => {
    if (!Number.isFinite(nowVal) || !Number.isFinite(prevVal)) return ''
    const d = Math.round((nowVal - prevVal) * 10) / 10
    if (d > 0) return ` ▲ +${d} vs prior`
    if (d < 0) return ` ▼ ${d} vs prior`
    return ' → unchanged vs prior'
  }

  const fleet = finiteNumber(latest.qualified_fleet_parity ?? latest.fleet_parity)
  const verifiedDenominator = finiteNumber(latest.verified_denominator)
  const minimumDenominator = finiteNumber(latest.minimum_verified_denominator)
  const measurementStatus = String(latest.measurement_status || '').toLowerCase()
  const measurementComplete = measurementStatus !== 'partial' && measurementStatus !== 'unscored'
  const trendQualified = measurementComplete && sampleQualified && Number.isFinite(fleet)
  const headline = measurementStatus === 'partial'
    ? `Benchmark produced only a PARTIAL measurement (${latest.profiles_scored ?? 'unknown'}/${latest.profiles_total ?? latest.per_profile.length} golden profile(s) scored); no fleet score or regression claim was published.`
    : measurementStatus === 'unscored'
      ? 'Benchmark ran but was UNSCORED; no fleet score or regression claim was published.'
      : usesQualifiedSampleContract && !sampleQualified
        ? `Benchmark observed ${Number.isFinite(verifiedDenominator) ? verifiedDenominator : 'an unknown number of'} verified result(s), below the ${Number.isFinite(minimumDenominator) ? minimumDenominator : 'required'}-result trend threshold; no fleet score or regression claim was published.`
        : Number.isFinite(fleet)
          ? `Fleet parity ${fleet}/100 vs a plain web-search session${arrow(fleet, finiteNumber(prev?.qualified_fleet_parity ?? prev?.fleet_parity))}.`
          : 'Benchmark ran but no golden profile could be scored.'

  const prevByProfile = new Map(
    (Array.isArray(prev?.per_profile) ? prev.per_profile : []).map((p) => [p.profile_id, finiteNumber(p.parity)]),
  )
  const perProfile = latest.per_profile.map((p) => {
    const name = p.label || p.profile_id
    const profileParity = finiteNumber(p.parity)
    if (!Number.isFinite(profileParity)) return `${name}: not scored (${p.error || 'error'})`
    const parityLabel = usesQualifiedSampleContract && !trendQualified ? 'observed parity' : 'parity'
    return (
      `${name}: ${parityLabel} ${profileParity}/100${trendQualified ? arrow(profileParity, prevByProfile.get(p.profile_id)) : ''}` +
      ` — ${p.overlap_count ?? 0} shared, ${p.web_only_count ?? 0} web-only, ${p.grantflow_only ?? 0} GrantFlow-only` +
      (p.web_outage_suspected ? ' (0 web results — provider outage suspected)' : '')
    )
  })

  const webOnlyTop = latest.per_profile
    .flatMap((p) => (Array.isArray(p.web_only_top) ? p.web_only_top.map((w) => ({ ...w, profile: p.label || p.profile_id })) : []))
    .slice(0, 3)
    .map((w) => `"${w.title || w.url}" (${w.domain || 'unknown site'}) — found for ${w.profile}${w.need ? `, need: ${w.need}` : ''}`)

  return { headline, perProfile, webOnlyTop }
}

/**
 * Build the owner email from a Sam run. Exported for tests.
 * `autoFixed` is an optional count of issues handled by the autofix Action.
 * `amy` (optional) adds the Amy-flywheel section (see summarizeAmyFlywheel).
 * `gaps` (optional) adds the "Coverage gaps & what changed overnight" section
 * (see summarizeCoverageGaps).
 * `parity` (optional) adds the "Google-bar benchmark" section
 * (see summarizeWebParity).
 * `research` (optional) adds the "Competitive crawler research" section — Amy's
 * scan of how other crawler codebases work + implementation suggestions
 * (see summarizeCrawlerResearch).
 */
export function buildOwnerReport(run = {}, { now = null, amy = null, gaps = null, parity = null, research = null, eva = undefined, agentMesh = null, samUnavailable = false } = {}) {
  const findings = Array.isArray(run?.findings) ? run.findings : []
  const repairPlan = Array.isArray(run?.repair_plan) ? run.repair_plan : []
  const planByFindingId = new Map(repairPlan.map((p) => [p?.finding_id, p]))

  // Split the handoff: what CI auto-corrects vs what needs a human. Info-level
  // findings (skipped checks, advisories) are not errors/weaknesses/bugs, so
  // they never land in the owner's "needs attention" list.
  const autoFixing = findings.filter((f) => f?.safe_auto_fix_available === true)
  const needsHuman = findings
    .filter((f) => f?.safe_auto_fix_available !== true && String(f?.severity || '').toLowerCase() !== 'info')
    .sort((a, b) => (SEVERITY_RANK[a?.severity] ?? 9) - (SEVERITY_RANK[b?.severity] ?? 9))

  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
  for (const f of needsHuman) if (counts[f?.severity] !== undefined) counts[f.severity] += 1

  const dateStr = (() => {
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      }).format(now || (run?.completed_at ? new Date(run.completed_at) : undefined))
    } catch { return '' }
  })()

  const clean = needsHuman.length === 0
  const headline = clean
    ? 'No code issues need your attention today'
    : counts.critical > 0
      ? `${counts.critical} critical code issue${counts.critical === 1 ? '' : 's'} need your attention`
      : `${needsHuman.length} code issue${needsHuman.length === 1 ? '' : 's'} for your review`

  // EVA portfolio user-journey section — rendered once, folded into the subject
  // and both bodies. The section renders whenever EVA loading was ATTEMPTED
  // (eva !== undefined), even if the data is null: renderEvaSection then emits
  // an explicit "not run / not a pass" block so missing functional testing can
  // never read as all-clear. Callers that don't pass `eva` (e.g. legacy tests)
  // get no section.
  const evaLoaded = eva !== undefined
  const evaSummary = evaLoaded ? summarizeEvaPortfolioQa(eva, { now }) : null
  const evaSection = evaLoaded ? renderEvaSection(evaSummary) : null
  const evaFailed = evaSummary ? evaSummary.journeys_failed : 0
  const evaFresh = evaSummary ? evaSummary.freshness === 'fresh' : false

  // Subject reflects BOTH code and functional findings, kept short enough to scan.
  // The functional part is only appended when EVA loading was attempted so legacy
  // callers (no eva) keep the original code-only subject.
  const codePart = clean ? 'all clear' : `${needsHuman.length} to review (${counts.critical}C/${counts.high}H/${counts.medium}M)`
  const evaPart = !evaLoaded
    ? null
    : !evaSummary
      ? 'user-tests: n/a'
      : evaFailed > 0
        ? `${evaFailed} user-journey fail${evaFailed === 1 ? '' : 's'}`
        : evaFresh
          ? 'user-journeys clear'
          : 'user-tests stale'
  const subject = evaPart
    ? `[GrantFlow] Anya daily — ${clean ? 'code clear' : `${needsHuman.length} code (${counts.critical}C/${counts.high}H)`} · ${evaPart}`
    : `[GrantFlow] Anya's daily code report — ${codePart}`

  // ----- plain text ---------------------------------------------------------
  const t = []
  t.push(`Good morning — here's Anya's daily code/function report.`)
  if (dateStr) t.push(dateStr)
  t.push('')
  if (samUnavailable) {
    t.push("Sam's overnight code sweep was UNAVAILABLE — no fresh run to report. The portfolio user-journey results below are unaffected.")
  }
  t.push(`Sam's overnight sweep: health ${run?.health_score ?? 'n/a'}/100, ${findings.length} finding(s) total.`)
  t.push(`  • ${autoFixing.length} fixed automatically overnight by Sam's CI (safe eslint/fixes → shipped to production when the test gate passed; left as an open PR if it didn't)`)
  t.push(`  • ${needsHuman.length} still need you: ${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low`)
  t.push('')
  if (clean) {
    t.push('Nothing needs your attention today. Everything Sam flagged is either clean or was auto-corrected overnight.')
  } else {
    t.push('NEEDS YOUR ATTENTION')
    t.push('====================')
    needsHuman.forEach((f, i) => {
      t.push(`${i + 1}. [${(SEVERITY_LABEL[f?.severity] || 'Info').toUpperCase()}] ${maskSecrets(f?.title || 'Untitled')}`)
      if (f?.category) t.push(`   area: ${f.category}`)
      if (f?.description) t.push(`   ${maskSecrets(f.description)}`)
      const where = (f?.affected_files || []).concat(f?.affected_routes || [])
      if (where.length) t.push(`   where: ${where.slice(0, 8).join(', ')}`)
      const hint = fixHint(f, planByFindingId)
      if (hint) t.push(`   suggested fix: ${maskSecrets(hint)}`)
    })
  }
  if (autoFixing.length) {
    t.push('')
    t.push(`FIXED AUTOMATICALLY OVERNIGHT (no action needed): ${autoFixing.map((f) => maskSecrets(f?.title || 'fix')).slice(0, 10).join('; ')}`)
  }
  const flywheel = summarizeAmyFlywheel(amy, { now: now || new Date() })
  if (flywheel) {
    t.push('')
    t.push('AMY CRAWLER FLYWHEEL')
    t.push('====================')
    t.push(flywheel.goal ? `🎯 GOAL: ${flywheel.cohortLine}` : flywheel.cohortLine)
    if (flywheel.edits.length) {
      t.push('Edits Amy applied autonomously:')
      flywheel.edits.forEach((e) => t.push(`  • ${e}`))
    } else {
      t.push('No autonomous edits were needed overnight.')
    }
    if (flywheel.couldNot.length) {
      t.push('Could NOT auto-edit (needs you):')
      flywheel.couldNot.forEach((e) => t.push(`  • ${e}`))
    }
  }
  const gapSummary = summarizeCoverageGaps(gaps)
  if (gapSummary) {
    t.push('')
    t.push('COVERAGE GAPS & WHAT CHANGED OVERNIGHT')
    t.push('======================================')
    t.push(gapSummary.headline)
    if (gapSummary.topGaps.length) {
      t.push('Top fleet coverage gaps (from the Coverage & Evidence scoreboard):')
      gapSummary.topGaps.forEach((g) => t.push(`  • ${g}`))
    }
    if (gapSummary.changed.length) {
      t.push('Changed autonomously overnight (agent telemetry):')
      gapSummary.changed.forEach((c) => t.push(`  • ${c}`))
    } else {
      t.push('No autonomous agent changes were recorded overnight.')
    }
    if (gapSummary.wishlist.length) {
      t.push('Adapter wishlist — needs you / a code change (Amy cannot add adapters):')
      gapSummary.wishlist.forEach((w) => t.push(`  • ${w}`))
    }
    if (gapSummary.needsOwner.length) {
      t.push('Blocked or failed (needs you):')
      gapSummary.needsOwner.forEach((n) => t.push(`  • ${n}`))
    }
  }
  const paritySummary = summarizeWebParity(parity, { now: now || new Date() })
  if (paritySummary) {
    t.push('')
    t.push('GOOGLE-BAR BENCHMARK (GrantFlow vs a web-search session)')
    t.push('========================================================')
    t.push(paritySummary.headline)
    paritySummary.perProfile.forEach((p) => t.push(`  • ${p}`))
    if (paritySummary.webOnlyTop.length) {
      // These are QUEUED FOR ADOPTION, not homework for the owner. Each is
      // seeded into the profile's next discovery run and added if — and only if
      // — the full gate stack (fetch → extract → reality gate → match engine)
      // accepts it; the run then marks it adopted or gated_out. Saying
      // "awaiting your judgment / nothing auto-added" here was true until the
      // seeding lane existed and would now be a lie in the owner's inbox.
      t.push('Top web-only finds (queued — seeded into each profile\'s next crawl, added if the gates accept):')
      paritySummary.webOnlyTop.forEach((w) => t.push(`  • ${w}`))
    } else {
      t.push('No real web-only finds — GrantFlow covered everything the web session produced.')
    }
  }
  const researchSummary = summarizeCrawlerResearch(research)
  if (researchSummary) {
    t.push('')
    t.push('COMPETITIVE CRAWLER RESEARCH (how other codebases do it)')
    t.push('========================================================')
    t.push(researchSummary.headline)
    if (researchSummary.findings.length) {
      t.push('Techniques worth stealing (candidates — nothing changed automatically):')
      researchSummary.findings.forEach((f) => t.push(`  • ${f}`))
    } else if (researchSummary.allClear) {
      t.push('Nothing beat our current crawler approach this run.')
    }
  }
  const meshSummary = summarizeAgentMesh(agentMesh)
  if (meshSummary) {
    t.push('')
    t.push('AGENT MESH (what the agents told each other)')
    t.push('============================================')
    t.push(meshSummary.headline)
    if (meshSummary.lessons.length) {
      t.push('Lessons on the shared board:')
      meshSummary.lessons.forEach((l) => t.push(`  • ${l}`))
    }
    if (meshSummary.messages.length) {
      t.push('Messages exchanged (last 24h):')
      meshSummary.messages.forEach((m) => t.push(`  • ${m}`))
    }
  }
  // EVA portfolio user-journey section (independent of Sam — always rendered
  // when EVA loading was attempted, even if it reports "not run / stale").
  if (evaSection) {
    t.push(evaSection.text)
  }
  t.push('')
  t.push(`— Anya · from Sam's run ${run?.id || 'n/a'}`)
  const text = t.join('\n')

  // ----- HTML ---------------------------------------------------------------
  const needsHumanHtml = clean
    ? '<p style="color:#16a34a;font-size:14px;">✅ Nothing needs your attention today. Everything Sam flagged is clean or was auto-corrected overnight.</p>'
    : `<table style="width:100%;border-collapse:collapse;font-size:13px;">${
        needsHuman.map((f) => {
          const color = SEVERITY_COLOR[f?.severity] || '#475569'
          const where = (f?.affected_files || []).concat(f?.affected_routes || [])
          const hint = fixHint(f, planByFindingId)
          return `
            <tr>
              <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;vertical-align:top;white-space:nowrap;">
                <span style="display:inline-block;font-size:11px;font-weight:700;color:#fff;background:${color};border-radius:4px;padding:2px 8px;text-transform:uppercase;">${esc(SEVERITY_LABEL[f?.severity] || 'Info')}</span>
              </td>
              <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;vertical-align:top;">
                <div style="font-weight:600;color:#0f172a;">${esc(maskSecrets(f?.title || 'Untitled'))}</div>
                ${f?.category ? `<div style="font-size:12px;color:#64748b;margin-top:2px;">${esc(f.category)}</div>` : ''}
                ${f?.description ? `<div style="font-size:13px;color:#334155;margin-top:6px;">${esc(maskSecrets(f.description))}</div>` : ''}
                ${where.length ? `<div style="font-size:12px;color:#64748b;margin-top:6px;"><strong>Where:</strong> ${esc(where.slice(0, 8).join(', '))}</div>` : ''}
                ${hint ? `<div style="font-size:13px;color:#065f46;margin-top:6px;"><strong>Suggested fix:</strong> ${esc(maskSecrets(hint))}</div>` : ''}
              </td>
            </tr>`
        }).join('')
      }</table>`

  const autoHtml = autoFixing.length
    ? `<div style="margin-top:18px;padding:12px 14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;font-size:13px;color:#166534;">
         <strong>Fixed automatically overnight (${autoFixing.length}) — no action needed.</strong> Sam's CI corrected these and shipped them to production (or left an open PR if the test gate failed):
         <div style="margin-top:6px;color:#15803d;">${esc(autoFixing.map((f) => maskSecrets(f?.title || 'fix')).slice(0, 10).join(' · '))}</div>
       </div>`
    : ''

  const scoreColor = (run?.health_score ?? 100) >= 85 ? '#16a34a' : (run?.health_score ?? 0) >= 60 ? '#a16207' : '#b91c1c'

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:720px;margin:0 auto;color:#0f172a;">
      <h2 style="margin:0 0 2px;">☀️ Anya's daily report</h2>
      <p style="margin:0 0 16px;color:#64748b;font-size:13px;">${esc(dateStr)} · ${esc(headline)}</p>
      ${samUnavailable ? '<p style="margin:0 0 12px;padding:10px 12px;background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;color:#92400e;font-size:13px;">Sam’s overnight <strong>code sweep was unavailable</strong> — no fresh run to report. The portfolio user-journey results below are unaffected.</p>' : ''}

      <table style="border-collapse:collapse;margin:0 0 18px;font-size:13px;">
        <tr>
          <td style="padding:6px 14px 6px 0;color:#64748b;">Sam health score</td>
          <td style="padding:6px 0;font-weight:700;color:${scoreColor};">${esc(run?.health_score ?? 'n/a')}/100</td>
        </tr>
        <tr>
          <td style="padding:6px 14px 6px 0;color:#64748b;">Fixed automatically overnight</td>
          <td style="padding:6px 0;font-weight:600;color:#16a34a;">${autoFixing.length}</td>
        </tr>
        <tr>
          <td style="padding:6px 14px 6px 0;color:#64748b;">Needs your attention</td>
          <td style="padding:6px 0;font-weight:700;">
            ${needsHuman.length} —
            <span style="color:#b91c1c;">${counts.critical} critical</span>,
            <span style="color:#c2410c;">${counts.high} high</span>,
            <span style="color:#a16207;">${counts.medium} medium</span>,
            ${counts.low} low
          </td>
        </tr>
      </table>

      <h3 style="margin:18px 0 8px;border-bottom:2px solid #0f172a;padding-bottom:4px;">Needs your attention</h3>
      ${needsHumanHtml}
      ${autoHtml}
      ${(() => {
        const fw = summarizeAmyFlywheel(amy, { now: now || new Date() })
        if (!fw) return ''
        const cohortColor = fw.goal ? '#16a34a' : '#334155'
        const editsHtml = fw.edits.length
          ? `<ul style="margin:6px 0 0;padding-left:18px;color:#334155;">${fw.edits.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`
          : '<div style="color:#64748b;margin-top:4px;">No autonomous edits were needed overnight.</div>'
        const couldNotHtml = fw.couldNot.length
          ? `<div style="margin-top:8px;"><strong style="color:#b45309;">Could not auto-edit (needs you):</strong>
               <ul style="margin:6px 0 0;padding-left:18px;color:#78350f;">${fw.couldNot.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`
          : ''
        return `
      <h3 style="margin:22px 0 8px;border-bottom:2px solid #0f172a;padding-bottom:4px;">Amy crawler flywheel</h3>
      <div style="font-size:13px;">
        <div style="font-weight:600;color:${cohortColor};">${fw.goal ? '🎯 GOAL: ' : ''}${esc(fw.cohortLine)}</div>
        <div style="margin-top:8px;"><strong>Edits Amy applied autonomously:</strong>${editsHtml}</div>
        ${couldNotHtml}
      </div>`
      })()}
      ${(() => {
        const gs = summarizeCoverageGaps(gaps)
        if (!gs) return ''
        const list = (items, color = '#334155') => `<ul style="margin:6px 0 0;padding-left:18px;color:${color};">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
        const topGapsHtml = gs.topGaps.length
          ? `<div style="margin-top:8px;"><strong>Top fleet coverage gaps:</strong>${list(gs.topGaps)}</div>`
          : ''
        const changedHtml = gs.changed.length
          ? `<div style="margin-top:8px;"><strong style="color:#166534;">Changed autonomously overnight:</strong>${list(gs.changed, '#166534')}</div>`
          : '<div style="margin-top:8px;color:#64748b;">No autonomous agent changes were recorded overnight.</div>'
        const wishlistHtml = gs.wishlist.length
          ? `<div style="margin-top:8px;"><strong style="color:#b45309;">Adapter wishlist — needs you / a code change:</strong>${list(gs.wishlist, '#78350f')}</div>`
          : ''
        const needsOwnerHtml = gs.needsOwner.length
          ? `<div style="margin-top:8px;"><strong style="color:#b91c1c;">Blocked or failed (needs you):</strong>${list(gs.needsOwner, '#7f1d1d')}</div>`
          : ''
        return `
      <h3 style="margin:22px 0 8px;border-bottom:2px solid #0f172a;padding-bottom:4px;">Coverage gaps &amp; what changed overnight</h3>
      <div style="font-size:13px;">
        <div style="color:#334155;">${esc(gs.headline)}</div>
        ${topGapsHtml}
        ${changedHtml}
        ${wishlistHtml}
        ${needsOwnerHtml}
      </div>`
      })()}
      ${(() => {
        const ps = summarizeWebParity(parity, { now: now || new Date() })
        if (!ps) return ''
        const list = (items, color = '#334155') => `<ul style="margin:6px 0 0;padding-left:18px;color:${color};">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
        const webOnlyHtml = ps.webOnlyTop.length
          ? `<div style="margin-top:8px;"><strong style="color:#b45309;">Top web-only finds (queued — seeded into each profile&rsquo;s next crawl, added if the gates accept):</strong>${list(ps.webOnlyTop, '#78350f')}</div>`
          : '<div style="margin-top:8px;color:#166534;">No real web-only finds — GrantFlow covered everything the web session produced.</div>'
        return `
      <h3 style="margin:22px 0 8px;border-bottom:2px solid #0f172a;padding-bottom:4px;">Google-bar benchmark</h3>
      <div style="font-size:13px;">
        <div style="font-weight:600;color:#334155;">${esc(ps.headline)}</div>
        ${list(ps.perProfile)}
        ${webOnlyHtml}
      </div>`
      })()}
      ${(() => {
        const rs = summarizeCrawlerResearch(research)
        if (!rs) return ''
        const list = (items, color = '#334155') => `<ul style="margin:6px 0 0;padding-left:18px;color:${color};">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
        const findingsHtml = rs.findings.length
          ? `<div style="margin-top:8px;"><strong style="color:#1d4ed8;">Techniques worth stealing (candidates — nothing changed automatically):</strong>${list(rs.findings, '#1e3a8a')}</div>`
          : rs.allClear
            ? '<div style="margin-top:8px;color:#166534;">Nothing beat our current crawler approach this run.</div>'
            : ''
        return `
      <h3 style="margin:22px 0 8px;border-bottom:2px solid #0f172a;padding-bottom:4px;">Competitive crawler research</h3>
      <div style="font-size:13px;">
        <div style="font-weight:600;color:#334155;">${esc(rs.headline)}</div>
        ${findingsHtml}
      </div>`
      })()}

      ${(() => {
        const ms = summarizeAgentMesh(agentMesh)
        if (!ms) return ''
        const list = (items, color = '#334155') => `<ul style="margin:6px 0 0;padding-left:18px;color:${color};">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
        const lessonsHtml = ms.lessons.length
          ? `<div style="margin-top:8px;"><strong style="color:#1d4ed8;">Lessons on the shared board:</strong>${list(ms.lessons, '#1e3a8a')}</div>`
          : ''
        const messagesHtml = ms.messages.length
          ? `<div style="margin-top:8px;"><strong>Messages exchanged (last 24h):</strong>${list(ms.messages)}</div>`
          : ''
        return `
      <h3 style="margin:22px 0 8px;border-bottom:2px solid #0f172a;padding-bottom:4px;">Agent mesh</h3>
      <div style="font-size:13px;">
        <div style="color:#334155;">${esc(ms.headline)}</div>
        ${lessonsHtml}
        ${messagesHtml}
      </div>`
      })()}

      ${evaSection ? evaSection.html : ''}

      <p style="margin:22px 0 0;color:#94a3b8;font-size:12px;">
        From Sam's overnight code/function sweep (run ${esc(run?.id || 'n/a')}). Auto-fixable issues are
        corrected by Sam's CI and shipped to production overnight (before this email); the items above need a human eye.
        To stop this email set <code>ANYA_DAILY_REPORT_ENABLED</code> to <code>false</code>.
        <!-- No "KEY=value" literals in email bodies: "=fa" is a quoted-printable
             hex pair and MIME decoding eats it ("ENABLED�lse" corruption). -->
      </p>
    </div>`

  return { subject, html, text, stats: { total: findings.length, autoFixing: autoFixing.length, needsHuman: needsHuman.length, ...counts } }
}

/**
 * Load the handoff run, build the email, send it. Best-effort; never throws.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {string} [opts.runId]      explicit Sam run id (from the kv pointer)
 * @param {Function} [opts.send]     injectable sender (defaults to email.sendEmail)
 * @param {Function} [opts.loadRun]  injectable (db,id)->run (defaults to samAuditStore)
 * @param {Function} [opts.loadLatest] injectable db->run (defaults to samAuditStore.latestRun)
 * @param {Function} [opts.loadGaps] injectable db->{scoreboard,events} (defaults to
 *        the gap scoreboard + 24h amy/sam/anya activity loader)
 * @param {Function} [opts.loadParity] injectable db->web_parity_benchmark store
 *        (defaults to the system_kv reader; section omitted when never run)
 * @param {Function} [opts.loadResearch] injectable db->amy_crawler_research store
 *        (defaults to the system_kv reader; section omitted until the research
 *        goal has run once)
 * @param {Date} [opts.now]
 * @returns {Promise<{ran:boolean, sent:boolean, reason?:string, run_id?:string|null, to?:string, stats?:object}>}
 */
export async function runAnyaDailyOwnerReport(db, {
  runId = null,
  send = defaultSendEmail,
  loadRun = defaultGetRun,
  loadLatest = defaultLatestRun,
  loadAmy = defaultLoadAmy,
  loadGaps = defaultLoadCoverageGaps,
  loadParity = defaultLoadWebParity,
  loadResearch = defaultLoadCrawlerResearch,
  loadEva = defaultLoadEvaPortfolioQa,
  loadAgentMesh = defaultLoadAgentMesh,
  now = null,
} = {}) {
  try {
    if (!isAnyaDailyReportEnabled()) return { ran: false, sent: false, reason: 'disabled' }
    if (!db?.prepare) return { ran: false, sent: false, reason: 'no_db' }

    let run = null
    if (runId) run = await loadRun(db, runId).catch(() => null)
    if (!run) run = await loadLatest(db).catch(() => null)

    // EVA loads INDEPENDENTLY of Sam. A missing Sam run must not suppress the
    // portfolio user-journey stream, and a missing EVA run must not suppress
    // Sam's — the two report streams never gate each other.
    const eva = await loadEva(db, { now }).catch(() => null)
    const evaHasData = !!(eva && (eva.run || (eva.findings && eva.findings.length) || eva.heartbeat))

    // Send only if AT LEAST ONE stream has something to say. If neither Sam nor
    // EVA has any data, there is genuinely nothing to send. (Reason kept as
    // 'no_sam_run' for backward compatibility; it now also implies no EVA data.)
    if (!run && !evaHasData) return { ran: true, sent: false, reason: 'no_sam_run' }

    const samUnavailable = !run
    const amy = run ? await loadAmy(db).catch(() => null) : null
    const gaps = run ? await loadGaps(db, { now }).catch(() => null) : null
    const parity = run ? await loadParity(db).catch(() => null) : null
    const research = run ? await loadResearch(db).catch(() => null) : null
    // The mesh is cross-agent, not Sam-derived — load it independently of Sam
    // (like EVA) so a missing Sam run never hides what the agents exchanged.
    const agentMesh = await loadAgentMesh(db, { now }).catch(() => null)
    const { subject, html, text, stats } = buildOwnerReport(run || {}, { now, amy, gaps, parity, research, eva, agentMesh, samUnavailable })
    const to = recipient()
    if (!to) return { ran: true, sent: false, reason: 'owner_email_not_configured', run_id: run?.id || null }
    const res = await send({ to, subject, html, text })
    if (res?.ok) {
      log.info('daily owner report sent', { to, run_id: run?.id || null, sam_unavailable: samUnavailable, ...stats })
      return { ran: true, sent: true, run_id: run?.id || null, sam_unavailable: samUnavailable, to, stats }
    }
    if (res?.skipped) return { ran: true, sent: false, reason: res.error || 'email_not_configured', run_id: run?.id || null }
    return { ran: true, sent: false, reason: 'send_failed', error: res?.error || 'unknown', run_id: run?.id || null }
  } catch (err) {
    log.warn('daily owner report failed', { error: err?.message })
    return { ran: false, sent: false, reason: 'exception', error: String(err?.message || err) }
  }
}

export const __testing__ = { isAnyaDailyReportEnabled, recipient, fixHint }

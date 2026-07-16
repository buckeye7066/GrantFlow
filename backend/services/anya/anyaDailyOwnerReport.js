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
import { createLogger } from '../../utils/logger.js'

const log = createLogger('anyaDailyOwnerReport')

export function isAnyaDailyReportEnabled() {
  return String(process.env.ANYA_DAILY_REPORT_ENABLED ?? 'true').toLowerCase() !== 'false'
}

function recipient() {
  const v = (process.env.ANYA_DAILY_REPORT_EMAIL || ADMIN_EMAIL || '').trim()
  return v || 'buckeye7066@gmail.com'
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
    if (!scoreboard && (!Array.isArray(events) || events.length === 0)) return null
    return { scoreboard, events: Array.isArray(events) ? events : [] }
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
export function summarizeAmyFlywheel(amy) {
  if (!amy || (!amy.cohort && !amy.report)) return null
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

  const couldNot = []
  const queue = Array.isArray(report.approval_queue) ? report.approval_queue.filter((q) => !q?.auto_applied) : []
  for (const item of queue.slice(0, 6)) {
    couldNot.push(`Needs your approval: ${item?.lever || 'change'}${item?.category ? ` for ${item.category}` : ''}${item?.reason ? ` — ${item.reason}` : ''}`)
  }
  if (queue.length > 6) couldNot.push(`…and ${queue.length - 6} more in the approval queue.`)
  if (day && day.issues > 0) {
    const types = Object.entries(day.finding_types || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, v]) => `${k} ×${v}`)
      .join(', ')
    couldNot.push(`Open gap classes the loop has not closed yet: ${types || 'n/a'} — persistent classes need a code change.`)
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
export function summarizeCoverageGaps(gaps) {
  if (!gaps || (!gaps.scoreboard && !(Array.isArray(gaps.events) && gaps.events.length > 0))) return null
  const board = gaps.scoreboard || null
  const events = Array.isArray(gaps.events) ? gaps.events : []

  const boardGaps = Array.isArray(board?.gaps) ? board.gaps : []
  const headline = board
    ? `${boardGaps.length} coverage gap class(es) across ${Number(board.profiles_scanned) || 0} scanned profile(s) (scoreboard ${board.generated_at || 'undated'}).`
    : 'No fleet gap scoreboard recorded yet — showing overnight agent activity only.'

  const topGaps = boardGaps.slice(0, 5).map((g) => `${g.count} profile(s): ${g.statement}`)
  const wishlist = (Array.isArray(board?.adapter_wishlist) ? board.adapter_wishlist : [])
    .slice(0, 5)
    .map((w) => `${w.detail || w.lane || 'lane'} — ${w.statement} (${w.affected_profiles_count} profile(s); ${w.suggested_action || 'add a source adapter'})`)

  // Autonomous vs needs-owner, straight from telemetry: succeeded events are
  // the changes the agents made themselves; blocked/failed events (plus the
  // wishlist above) are what still needs a human.
  const label = (e) => `[${e?.agent_name || 'agent'}] ${maskSecrets(e?.title || e?.event_type || 'activity')}`
  const changed = events.filter((e) => e?.status === 'succeeded').slice(0, 8).map(label)
  const needsOwner = events.filter((e) => e?.status === 'blocked' || e?.status === 'failed').slice(0, 8).map(label)

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
export function summarizeWebParity(parity) {
  const latest = parity?.latest
  if (!latest || !Array.isArray(latest.per_profile)) return null
  const runs = Array.isArray(parity.runs) ? parity.runs : []
  const prev = runs.length >= 2 ? runs[runs.length - 2] : null

  const arrow = (nowVal, prevVal) => {
    if (!Number.isFinite(nowVal) || !Number.isFinite(prevVal)) return ''
    const d = Math.round((nowVal - prevVal) * 10) / 10
    if (d > 0) return ` ▲ +${d} vs prior`
    if (d < 0) return ` ▼ ${d} vs prior`
    return ' → unchanged vs prior'
  }

  const fleet = Number(latest.fleet_parity)
  const headline = Number.isFinite(fleet)
    ? `Fleet parity ${fleet}/100 vs a plain web-search session${arrow(fleet, Number(prev?.fleet_parity))}.`
    : 'Benchmark ran but no golden profile could be scored.'

  const prevByProfile = new Map(
    (Array.isArray(prev?.per_profile) ? prev.per_profile : []).map((p) => [p.profile_id, Number(p.parity)]),
  )
  const perProfile = latest.per_profile.map((p) => {
    const name = p.label || p.profile_id
    if (!Number.isFinite(Number(p.parity))) return `${name}: not scored (${p.error || 'error'})`
    return (
      `${name}: parity ${p.parity}/100${arrow(Number(p.parity), prevByProfile.get(p.profile_id))}` +
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
export function buildOwnerReport(run = {}, { now = null, amy = null, gaps = null, parity = null, research = null } = {}) {
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

  const subject = `[GrantFlow] Anya's daily code report — ${clean ? 'all clear' : `${needsHuman.length} to review (${counts.critical}C/${counts.high}H/${counts.medium}M)`}`

  // ----- plain text ---------------------------------------------------------
  const t = []
  t.push(`Good morning — here's Anya's daily code/function report.`)
  if (dateStr) t.push(dateStr)
  t.push('')
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
  const flywheel = summarizeAmyFlywheel(amy)
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
  const paritySummary = summarizeWebParity(parity)
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
      <h2 style="margin:0 0 2px;">☀️ Anya's daily code report</h2>
      <p style="margin:0 0 16px;color:#64748b;font-size:13px;">${esc(dateStr)} · ${esc(headline)}</p>

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
        const fw = summarizeAmyFlywheel(amy)
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
        const ps = summarizeWebParity(parity)
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
  now = null,
} = {}) {
  try {
    if (!isAnyaDailyReportEnabled()) return { ran: false, sent: false, reason: 'disabled' }
    if (!db?.prepare) return { ran: false, sent: false, reason: 'no_db' }

    let run = null
    if (runId) run = await loadRun(db, runId).catch(() => null)
    if (!run) run = await loadLatest(db).catch(() => null)
    if (!run) return { ran: true, sent: false, reason: 'no_sam_run' }

    const amy = await loadAmy(db).catch(() => null)
    const gaps = await loadGaps(db, { now }).catch(() => null)
    const parity = await loadParity(db).catch(() => null)
    const research = await loadResearch(db).catch(() => null)
    const { subject, html, text, stats } = buildOwnerReport(run, { now, amy, gaps, parity, research })
    const to = recipient()
    const res = await send({ to, subject, html, text })
    if (res?.ok) {
      log.info('daily owner report sent', { to, run_id: run.id, ...stats })
      return { ran: true, sent: true, run_id: run.id, to, stats }
    }
    if (res?.skipped) return { ran: true, sent: false, reason: res.error || 'email_not_configured', run_id: run.id }
    return { ran: true, sent: false, reason: 'send_failed', error: res?.error || 'unknown', run_id: run.id }
  } catch (err) {
    log.warn('daily owner report failed', { error: err?.message })
    return { ran: false, sent: false, reason: 'exception', error: String(err?.message || err) }
  }
}

export const __testing__ = { isAnyaDailyReportEnabled, recipient, fixHint }

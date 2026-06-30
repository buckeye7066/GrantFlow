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
import { createLogger } from '../../utils/logger.js'

const log = createLogger('anyaDailyOwnerReport')

export function isAnyaDailyReportEnabled() {
  return String(process.env.ANYA_DAILY_REPORT_ENABLED ?? 'true').toLowerCase() !== 'false'
}

function recipient() {
  const v = (process.env.ANYA_DAILY_REPORT_EMAIL || ADMIN_EMAIL || '').trim()
  return v || 'buckeye7066@gmail.com'
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
 * Build the owner email from a Sam run. Exported for tests.
 * `autoFixed` is an optional count of issues handled by the autofix Action.
 */
export function buildOwnerReport(run = {}, { now = null } = {}) {
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

      <p style="margin:22px 0 0;color:#94a3b8;font-size:12px;">
        From Sam's overnight code/function sweep (run ${esc(run?.id || 'n/a')}). Auto-fixable issues are
        corrected by Sam's CI and shipped to production overnight (before this email); the items above need a human eye.
        To stop this email set <code>ANYA_DAILY_REPORT_ENABLED=false</code>.
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
 * @param {Date} [opts.now]
 * @returns {Promise<{ran:boolean, sent:boolean, reason?:string, run_id?:string|null, to?:string, stats?:object}>}
 */
export async function runAnyaDailyOwnerReport(db, {
  runId = null,
  send = defaultSendEmail,
  loadRun = defaultGetRun,
  loadLatest = defaultLatestRun,
  now = null,
} = {}) {
  try {
    if (!isAnyaDailyReportEnabled()) return { ran: false, sent: false, reason: 'disabled' }
    if (!db?.prepare) return { ran: false, sent: false, reason: 'no_db' }

    let run = null
    if (runId) run = await loadRun(db, runId).catch(() => null)
    if (!run) run = await loadLatest(db).catch(() => null)
    if (!run) return { ran: true, sent: false, reason: 'no_sam_run' }

    const { subject, html, text, stats } = buildOwnerReport(run, { now })
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

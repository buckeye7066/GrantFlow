/**
 * samEmailReport.js
 *
 * Emails a per-run report to the operator whenever a Sam sweep finds issues.
 *
 * Sam already (a) persists every run to `sam_runs`/`sam_findings`, and (b)
 * pushes an in-app notification on CRITICAL findings (samEscalation.js). This
 * module adds the third channel the owner asked for: a PUSH email — to
 * dr.johnwhite@axiombiolabs.org by default — listing the issues Sam found AND
 * the corrections he made, every time a sweep surfaces anything.
 *
 * Fires when a completed run has at least one finding, OR when a run crashed
 * (a crash is itself an issue worth surfacing). A perfectly clean run sends
 * nothing — so a daily green sweep never spams the inbox.
 *
 * Best-effort: this never throws and never affects the run result. Disable with
 * SAM_EMAIL_REPORTS=false. Override the recipient with SAM_REPORT_EMAIL.
 */

import { sendEmail as defaultSendEmail } from '../email.js'
import { maskSecrets } from './samAuditStore.js'

const DEFAULT_RECIPIENT = 'dr.johnwhite@axiombiolabs.org'

function reportsEnabled(env) {
  const raw = env?.SAM_EMAIL_REPORTS
  if (raw === null || raw === undefined || raw === '') return true // default ON
  return !/^(0|false|no|off)$/i.test(String(raw).trim())
}

function recipient(env) {
  const v = (env?.SAM_REPORT_EMAIL || env?.ADMIN_OPS_EMAIL || '').trim()
  return v || DEFAULT_RECIPIENT
}

/**
 * Decide whether a finished run is worth emailing. Returns true on any finding
 * or on a failed/errored run; false for a clean completed run.
 */
export function shouldEmail(run = {}) {
  const findings = Array.isArray(run?.findings) ? run.findings : []
  if (findings.length > 0) return true
  if (run?.status === 'failed' || run?.ok === false || run?.error) return true
  return false
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
const SEVERITY_COLOR = {
  critical: '#b91c1c',
  high: '#c2410c',
  medium: '#a16207',
  low: '#2563eb',
  info: '#475569',
}

function sortFindings(findings) {
  return [...findings].sort(
    (a, b) => (SEVERITY_RANK[a?.severity] ?? 9) - (SEVERITY_RANK[b?.severity] ?? 9),
  )
}

/** A finding's corrective intent: prefer the planned strategy, else its recommended_fix. */
function correctionFor(finding, planByFindingId) {
  const plan = planByFindingId.get(finding?.id)
  if (plan?.patch_summary) return plan.patch_summary
  if (plan?.strategy) return plan.strategy
  return finding?.recommended_fix || ''
}

/** Normalise an applied-fix entry into a human line. */
function appliedFixLine(fix) {
  const id = fix?.fix_id || 'fix'
  const file = fix?.evidence?.file ? ` (${fix.evidence.file})` : ''
  if (fix?.refused) return `REFUSED — ${id}: ${fix?.message || 'policy refusal'}`
  if (fix?.applied) return `APPLIED — ${id}${file}: ${fix?.message || 'applied'}`
  if (fix?.reverted) return `REVERTED — ${id}${file}: ${fix?.message || 'did not verify; reverted'}`
  return `NO-OP — ${id}${file}: ${fix?.message || 'no change'}`
}

/**
 * Build { subject, html, text } for a finished run. Exported for tests.
 */
export function buildReport(run = {}, env = process.env) {
  const findings = sortFindings(Array.isArray(run?.findings) ? run.findings : [])
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
  for (const f of findings) if (counts[f?.severity] !== undefined) counts[f.severity] += 1

  const repairPlan = Array.isArray(run?.repair_plan) ? run.repair_plan : []
  const planByFindingId = new Map(repairPlan.map((p) => [p?.finding_id, p]))

  const appliedFixes = (Array.isArray(run?.applied_fixes) ? run.applied_fixes : [])
  const appliedCount = appliedFixes.filter((f) => f?.applied === true).length

  const crashed = run?.status === 'failed' || run?.ok === false || Boolean(run?.error)
  const headline = crashed
    ? 'Sam sweep FAILED'
    : counts.critical > 0
      ? `Sam found ${counts.critical} critical issue${counts.critical === 1 ? '' : 's'}`
      : `Sam found ${findings.length} issue${findings.length === 1 ? '' : 's'}`

  const env_ = env || {}
  const tag = String(env_.RAILWAY_ENVIRONMENT || env_.NODE_ENV || 'prod')
  const subject = `[GrantFlow/Sam] ${headline} — ${counts.critical}C/${counts.high}H/${counts.medium}M (${tag})`

  // ----- plain text (always present; many clients prefer it) ----------------
  const textLines = []
  textLines.push(`Sam — GrantFlow code/function sweep`)
  textLines.push(`Run: ${run?.run_id || 'n/a'}  Mode: ${run?.mode || 'n/a'}  Status: ${run?.status || 'n/a'}`)
  textLines.push(`Health score: ${run?.health_score ?? 'n/a'}/100   Production ready: ${run?.production_ready === true ? 'yes' : run?.production_ready === false ? 'NO' : 'n/a'}`)
  textLines.push(`Findings: ${findings.length} total — ${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low, ${counts.info} info`)
  if (run?.error) textLines.push(`ERROR: ${maskSecrets(String(run.error))}`)
  textLines.push('')
  textLines.push('ISSUES FOUND')
  textLines.push('============')
  if (findings.length === 0) {
    textLines.push('(none)')
  } else {
    findings.forEach((f, i) => {
      textLines.push(`${i + 1}. [${String(f?.severity || 'info').toUpperCase()}] ${maskSecrets(f?.title || 'Untitled finding')}`)
      if (f?.category) textLines.push(`   category: ${f.category}`)
      if (f?.description) textLines.push(`   ${maskSecrets(f.description)}`)
      const files = (f?.affected_files || []).concat(f?.affected_routes || [])
      if (files.length) textLines.push(`   where: ${files.slice(0, 8).join(', ')}`)
      const fix = correctionFor(f, planByFindingId)
      if (fix) textLines.push(`   recommended fix: ${maskSecrets(fix)}`)
    })
  }
  textLines.push('')
  textLines.push(`CORRECTIONS MADE (${appliedCount} applied)`)
  textLines.push('================')
  if (appliedFixes.length === 0) {
    textLines.push('(none — this run was read-only / report-only)')
  } else {
    appliedFixes.forEach((fix) => textLines.push(`- ${maskSecrets(appliedFixLine(fix))}`))
  }
  const text = textLines.join('\n')

  // ----- HTML ---------------------------------------------------------------
  const findingsHtml = findings.length === 0
    ? '<p style="color:#64748b;">No issues found.</p>'
    : findings.map((f) => {
        const color = SEVERITY_COLOR[f?.severity] || '#475569'
        const files = (f?.affected_files || []).concat(f?.affected_routes || [])
        const fix = correctionFor(f, planByFindingId)
        return `
          <tr>
            <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;vertical-align:top;">
              <span style="display:inline-block;font-size:11px;font-weight:700;color:#fff;background:${color};border-radius:4px;padding:2px 8px;text-transform:uppercase;">${esc(f?.severity || 'info')}</span>
            </td>
            <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;vertical-align:top;">
              <div style="font-weight:600;color:#0f172a;">${esc(maskSecrets(f?.title || 'Untitled finding'))}</div>
              ${f?.category ? `<div style="font-size:12px;color:#64748b;margin-top:2px;">${esc(f.category)}</div>` : ''}
              ${f?.description ? `<div style="font-size:13px;color:#334155;margin-top:6px;">${esc(maskSecrets(f.description))}</div>` : ''}
              ${files.length ? `<div style="font-size:12px;color:#64748b;margin-top:6px;"><strong>Where:</strong> ${esc(files.slice(0, 8).join(', '))}</div>` : ''}
              ${fix ? `<div style="font-size:13px;color:#065f46;margin-top:6px;"><strong>Recommended fix:</strong> ${esc(maskSecrets(fix))}</div>` : ''}
            </td>
          </tr>`
      }).join('')

  const fixesHtml = appliedFixes.length === 0
    ? '<p style="color:#64748b;">No corrections applied — this run was read-only / report-only.</p>'
    : `<ul style="margin:0;padding-left:18px;color:#334155;font-size:13px;line-height:1.6;">${
        appliedFixes.map((fix) => {
          const line = esc(maskSecrets(appliedFixLine(fix)))
          const ok = fix?.applied === true
          return `<li style="color:${ok ? '#065f46' : '#64748b'};">${line}</li>`
        }).join('')
      }</ul>`

  const scoreColor = (run?.health_score ?? 100) >= 85 ? '#16a34a' : (run?.health_score ?? 0) >= 60 ? '#a16207' : '#b91c1c'

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:720px;margin:0 auto;color:#0f172a;">
      <h2 style="margin:0 0 4px;">🛠️ ${esc(headline)}</h2>
      <p style="margin:0 0 16px;color:#64748b;font-size:13px;">
        GrantFlow production-readiness sweep · run <code>${esc(run?.run_id || 'n/a')}</code> ·
        mode <strong>${esc(run?.mode || 'n/a')}</strong> · ${esc(tag)}
      </p>
      <table style="border-collapse:collapse;margin:0 0 18px;font-size:13px;">
        <tr>
          <td style="padding:6px 14px 6px 0;color:#64748b;">Health score</td>
          <td style="padding:6px 0;font-weight:700;color:${scoreColor};">${esc(run?.health_score ?? 'n/a')}/100</td>
          <td style="padding:6px 14px;color:#64748b;">Production ready</td>
          <td style="padding:6px 0;font-weight:700;color:${run?.production_ready === false ? '#b91c1c' : '#16a34a'};">${run?.production_ready === true ? 'Yes' : run?.production_ready === false ? 'NO' : 'n/a'}</td>
        </tr>
        <tr>
          <td style="padding:6px 14px 6px 0;color:#64748b;">Findings</td>
          <td colspan="3" style="padding:6px 0;font-weight:600;">
            ${findings.length} total —
            <span style="color:#b91c1c;">${counts.critical} critical</span>,
            <span style="color:#c2410c;">${counts.high} high</span>,
            <span style="color:#a16207;">${counts.medium} medium</span>,
            ${counts.low} low, ${counts.info} info
          </td>
        </tr>
      </table>
      ${run?.error ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px;margin:0 0 18px;color:#991b1b;font-size:13px;"><strong>Run error:</strong> ${esc(maskSecrets(String(run.error)))}</div>` : ''}

      <h3 style="margin:18px 0 8px;border-bottom:2px solid #0f172a;padding-bottom:4px;">Issues found</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">${findingsHtml}</table>

      <h3 style="margin:24px 0 8px;border-bottom:2px solid #0f172a;padding-bottom:4px;">Corrections made (${appliedCount} applied)</h3>
      ${fixesHtml}

      <p style="margin:24px 0 0;color:#94a3b8;font-size:12px;">
        Sent automatically by Sam after a sweep that surfaced issues. To stop these emails set
        <code>SAM_EMAIL_REPORTS=false</code>. Full history lives in the Sam dashboard and the
        <code>sam_runs</code> / <code>sam_findings</code> tables.
      </p>
    </div>`

  return { subject, html, text }
}

/**
 * Send the per-run report email if warranted. Best-effort; never throws.
 *
 * @param {object} run         the run summary returned by runSam()
 * @param {object} [opts]
 * @param {Function} [opts.send]   injectable sender (defaults to email.sendEmail)
 * @param {object}   [opts.env]    env (defaults to process.env)
 * @returns {Promise<{sent:boolean, reason?:string, id?:string|null, error?:string}>}
 */
export async function sendSamReportEmail(run = {}, { send = defaultSendEmail, env = process.env } = {}) {
  try {
    if (!reportsEnabled(env)) return { sent: false, reason: 'disabled' }
    if (!shouldEmail(run)) return { sent: false, reason: 'clean_run' }

    const to = recipient(env)
    const { subject, html, text } = buildReport(run, env)
    const res = await send({ to, subject, html, text })
    if (res?.ok) return { sent: true, id: res.id ?? null, to }
    if (res?.skipped) return { sent: false, reason: res.error || 'email_not_configured' }
    return { sent: false, reason: 'send_failed', error: res?.error || 'unknown' }
  } catch (err) {
    return { sent: false, reason: 'exception', error: String(err?.message || err) }
  }
}

export const __testing__ = { reportsEnabled, recipient, correctionFor, appliedFixLine, sortFindings }

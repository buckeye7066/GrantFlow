// EVA report section renderer — turns the pure summary (summarizeEvaPortfolioQa)
// into the "PORTFOLIO USER-JOURNEY TESTS" HTML block and its plain-text twin for
// the Anya morning email. Every untrusted value is HTML-escaped AND secret-masked.
// Kept separate from the summarizer so both the summary shape and the rendering
// are independently testable.
import { maskSecrets } from '../sam/samAuditStore.js'
import { redactText } from './evaTypes.js'

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

// Untrusted free text -> masked THEN escaped. redactText strips secrets/paths the
// runner might have missed; maskSecrets is GrantFlow's canonical masker; esc makes
// it HTML-safe. Order matters: sanitize before escaping.
function safe(s) {
  return esc(maskSecrets(redactText(String(s ?? ''))))
}
function safeText(s) {
  return maskSecrets(redactText(String(s ?? '')))
}

const SEVERITY_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' }
const SEVERITY_COLOR = { critical: '#b91c1c', high: '#c2410c', medium: '#a16207', low: '#2563eb', info: '#475569' }
const STATE_LABEL = {
  new: 'NEW',
  recurring: 'Recurring',
  worsened: 'WORSENED',
  intermittent: 'Intermittent',
  resolved: 'Resolved',
  blocked: 'Blocked',
  stale: 'Stale',
}

function confidenceLabel(c) {
  if (typeof c !== 'number') return 'unknown'
  return `${c.toFixed(2)}${c < 0.7 ? ' (low — needs more evidence)' : ''}`
}

/**
 * Render the EVA section. Returns { html, text }. When `summary` is null the
 * section still renders — stating that portfolio testing was stale or not run —
 * so a missing EVA stream can never silently read as all-clear.
 */
export function renderEvaSection(summary) {
  if (!summary) {
    const text =
      '\nPORTFOLIO USER-JOURNEY TESTS\n' +
      '----------------------------\n' +
      'No EVA portfolio testing data is available. Overnight end-user testing was ' +
      'not run or its results have not been received. This is NOT a pass — treat the ' +
      "portfolio's user-facing health as UNVERIFIED until the next successful run.\n"
    const html =
      '<h2 style="margin:24px 0 8px;font-size:16px;color:#0f172a">Portfolio User-Journey Tests</h2>' +
      '<p style="margin:0 0 12px;padding:10px 12px;background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;color:#92400e">' +
      'No EVA portfolio testing data is available. Overnight end-user testing was not run or its results have not been received. ' +
      '<strong>This is not a pass</strong> — the portfolio’s user-facing health is UNVERIFIED until the next successful run.</p>'
    return { html, text }
  }

  const s = summary
  // ---- Plain text ---------------------------------------------------------
  const t = []
  t.push('')
  t.push('PORTFOLIO USER-JOURNEY TESTS')
  t.push('----------------------------')
  t.push(safeText(s.headline))
  if (s.freshness === 'stale') t.push(`(!) Results are STALE — last run ${s.run_age_hours}h ago.`)
  t.push('')
  t.push(
    `Apps: ${s.apps_expected} expected | ${s.apps_tested} tested | ${s.apps_blocked} blocked | ` +
      `${s.apps_startup_failed} startup-failed | ${s.apps_not_run} not run`,
  )
  t.push(
    `Journeys: ${s.journeys_total} executed | ${s.journeys_passed} passed | ${s.journeys_failed} failed` +
      (s.pass_rate !== null ? ` | pass rate ${s.pass_rate}%` : ''),
  )
  t.push(
    `Findings: ${s.lifecycle.new} new | ${s.lifecycle.recurring} recurring | ${s.lifecycle.worsened} worsened | ` +
      `${s.lifecycle.intermittent} intermittent`,
  )
  t.push(
    `Coverage: ${s.coverage_pct !== null ? s.coverage_pct + '%' : 'n/a'} | ` +
      `Runner heartbeat: ${s.heartbeat_state}${s.heartbeat_age_hours !== null ? ` (${s.heartbeat_age_hours}h ago)` : ''}`,
  )

  if (s.actionable.length) {
    t.push('')
    t.push('ACTIONABLE FINDINGS (critical/high first):')
    for (const f of s.actionable) {
      t.push('')
      t.push(`  [${SEVERITY_LABEL[f.severity] || f.severity}] ${safeText(f.program)} — ${safeText(f.journey)} (${STATE_LABEL[f.lifecycle_state] || f.lifecycle_state})`)
      if (f.expected) t.push(`    Expected: ${safeText(f.expected)}`)
      if (f.observed) t.push(`    Observed: ${safeText(f.observed)}`)
      if (f.repro_steps?.length) t.push(`    Repro: ${f.repro_steps.map((x) => safeText(x)).join(' -> ')}`)
      if (f.impact) t.push(`    Impact: ${safeText(f.impact)}`)
      if (f.likely_cause) t.push(`    Likely cause: ${safeText(f.likely_cause)}`)
      if (f.suggested_fix) t.push(`    Suggested repair: ${safeText(f.suggested_fix)}`)
      if (f.candidate_files?.length) t.push(`    Candidate files: ${f.candidate_files.map((x) => safeText(x)).join(', ')}`)
      t.push(`    Confidence: ${confidenceLabel(f.confidence)}`)
      if (f.missing_evidence) t.push(`    Missing evidence: ${safeText(f.missing_evidence)}`)
      t.push(`    First seen ${safeText(f.first_seen)} | last seen ${safeText(f.last_seen)} | seen ${f.recurrence_count}x | last pass ${f.last_passing_run ? safeText(f.last_passing_run) : 'never'}`)
      if (f.evidence?.length) t.push(`    Evidence: ${f.evidence.map((e) => safeText(e.kind + ':' + e.ref)).join(', ')}`)
    }
  }

  t.push('')
  t.push('RESOLVED SINCE YESTERDAY:')
  if (s.resolved.length) {
    for (const r of s.resolved) t.push(`  [${SEVERITY_LABEL[r.severity] || r.severity}] ${safeText(r.program)} — ${safeText(r.journey)} (closed by run ${safeText(r.closing_run)})`)
  } else {
    t.push('  (none)')
  }

  t.push('')
  t.push('NOT TESTED OR BLOCKED:')
  if (s.blocked_apps.length || s.not_tested.length) {
    for (const b of s.blocked_apps) t.push(`  ${safeText(b.program)} — ${b.status}${b.reason ? ': ' + safeText(b.reason) : ''}`)
    for (const id of s.not_tested) t.push(`  ${safeText(id)} — not in the latest run`)
  } else {
    t.push('  (every expected app was tested)')
  }

  // ---- HTML ---------------------------------------------------------------
  const h = []
  h.push('<h2 style="margin:24px 0 8px;font-size:16px;color:#0f172a">Portfolio User-Journey Tests</h2>')
  const headlineBg = s.journeys_failed > 0 || s.freshness !== 'fresh' ? '#fef3c7' : '#dcfce7'
  const headlineBorder = s.journeys_failed > 0 || s.freshness !== 'fresh' ? '#fcd34d' : '#86efac'
  h.push(`<p style="margin:0 0 8px;padding:10px 12px;background:${headlineBg};border:1px solid ${headlineBorder};border-radius:6px;color:#0f172a">${safe(s.headline)}${s.freshness === 'stale' ? ' <strong>(STALE RESULTS)</strong>' : ''}</p>`)
  h.push('<table style="border-collapse:collapse;font-size:13px;margin:0 0 12px"><tbody>')
  h.push(`<tr><td style="padding:2px 10px 2px 0;color:#475569">Apps</td><td style="padding:2px 0">${s.apps_expected} expected · <strong>${s.apps_tested} tested</strong> · ${s.apps_blocked} blocked · ${s.apps_startup_failed} startup-failed · ${s.apps_not_run} not run</td></tr>`)
  h.push(`<tr><td style="padding:2px 10px 2px 0;color:#475569">Journeys</td><td style="padding:2px 0">${s.journeys_total} executed · ${s.journeys_passed} passed · <strong style="color:${s.journeys_failed ? '#b91c1c' : '#166534'}">${s.journeys_failed} failed</strong>${s.pass_rate !== null ? ` · ${s.pass_rate}% pass` : ''}</td></tr>`)
  h.push(`<tr><td style="padding:2px 10px 2px 0;color:#475569">Findings</td><td style="padding:2px 0">${s.lifecycle.new} new · ${s.lifecycle.recurring} recurring · ${s.lifecycle.worsened} worsened · ${s.lifecycle.intermittent} intermittent</td></tr>`)
  h.push(`<tr><td style="padding:2px 10px 2px 0;color:#475569">Coverage</td><td style="padding:2px 0">${s.coverage_pct !== null ? s.coverage_pct + '%' : 'n/a'} · runner heartbeat <strong style="color:${s.heartbeat_state === 'ok' ? '#166534' : '#b91c1c'}">${esc(s.heartbeat_state)}</strong>${s.heartbeat_age_hours !== null ? ` (${s.heartbeat_age_hours}h ago)` : ''}</td></tr>`)
  h.push('</tbody></table>')

  if (s.actionable.length) {
    h.push('<h3 style="margin:16px 0 6px;font-size:14px;color:#0f172a">Actionable findings</h3>')
    for (const f of s.actionable) {
      const color = SEVERITY_COLOR[f.severity] || '#475569'
      h.push('<div style="margin:0 0 12px;padding:10px 12px;border-left:4px solid ' + color + ';background:#f8fafc;border-radius:0 6px 6px 0">')
      h.push(`<div style="font-weight:600;color:#0f172a"><span style="color:${color}">[${esc(SEVERITY_LABEL[f.severity] || f.severity)}]</span> ${safe(f.program)} — ${safe(f.journey)} <span style="font-weight:400;color:#64748b">(${esc(STATE_LABEL[f.lifecycle_state] || f.lifecycle_state)})</span></div>`)
      h.push('<div style="font-size:13px;color:#334155;margin-top:4px">')
      if (f.expected) h.push(`<div><span style="color:#64748b">Expected:</span> ${safe(f.expected)}</div>`)
      if (f.observed) h.push(`<div><span style="color:#64748b">Observed:</span> ${safe(f.observed)}</div>`)
      if (f.repro_steps?.length) h.push(`<div><span style="color:#64748b">Repro:</span> ${f.repro_steps.map((x) => safe(x)).join(' &rarr; ')}</div>`)
      if (f.impact) h.push(`<div><span style="color:#64748b">Impact:</span> ${safe(f.impact)}</div>`)
      if (f.likely_cause) h.push(`<div><span style="color:#64748b">Likely cause:</span> ${safe(f.likely_cause)}</div>`)
      if (f.suggested_fix) h.push(`<div><span style="color:#64748b">Suggested repair:</span> ${safe(f.suggested_fix)}</div>`)
      if (f.candidate_files?.length) h.push(`<div><span style="color:#64748b">Candidate files:</span> ${f.candidate_files.map((x) => `<code>${safe(x)}</code>`).join(', ')}</div>`)
      h.push(`<div><span style="color:#64748b">Confidence:</span> ${esc(confidenceLabel(f.confidence))}</div>`)
      if (f.missing_evidence) h.push(`<div><span style="color:#64748b">Missing evidence:</span> ${safe(f.missing_evidence)}</div>`)
      h.push(`<div style="color:#94a3b8;font-size:12px;margin-top:2px">First seen ${safe(f.first_seen)} · last seen ${safe(f.last_seen)} · seen ${f.recurrence_count}× · last pass ${f.last_passing_run ? safe(f.last_passing_run) : 'never'}</div>`)
      if (f.evidence?.length) h.push(`<div style="color:#94a3b8;font-size:12px">Evidence: ${f.evidence.map((e) => safe(e.kind + ':' + e.ref)).join(', ')}</div>`)
      h.push('</div></div>')
    }
  }

  h.push('<h3 style="margin:16px 0 6px;font-size:14px;color:#166534">Resolved since yesterday</h3>')
  if (s.resolved.length) {
    h.push('<ul style="margin:0 0 12px;padding-left:18px;font-size:13px;color:#334155">')
    for (const r of s.resolved) h.push(`<li><span style="color:${SEVERITY_COLOR[r.severity] || '#475569'}">[${esc(SEVERITY_LABEL[r.severity] || r.severity)}]</span> ${safe(r.program)} — ${safe(r.journey)} <span style="color:#94a3b8">(closed by run ${safe(r.closing_run)})</span></li>`)
    h.push('</ul>')
  } else {
    h.push('<p style="margin:0 0 12px;font-size:13px;color:#94a3b8">(none)</p>')
  }

  h.push('<h3 style="margin:16px 0 6px;font-size:14px;color:#334155">Not tested or blocked</h3>')
  if (s.blocked_apps.length || s.not_tested.length) {
    h.push('<ul style="margin:0 0 12px;padding-left:18px;font-size:13px;color:#334155">')
    for (const b of s.blocked_apps) h.push(`<li>${safe(b.program)} — <strong>${esc(b.status)}</strong>${b.reason ? ': ' + safe(b.reason) : ''}</li>`)
    for (const id of s.not_tested) h.push(`<li>${safe(id)} — not in the latest run</li>`)
    h.push('</ul>')
  } else {
    h.push('<p style="margin:0 0 12px;font-size:13px;color:#94a3b8">(every expected app was tested)</p>')
  }

  return { html: h.join(''), text: t.join('\n') }
}

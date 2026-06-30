/**
 * Error reporter — when a logged-in NON-ADMIN user hits an error, capture it,
 * analyze the likely cause + suggested fix (LLM with heuristic fallback), and
 * email the owner immediately.
 *
 * Hard rules:
 *  - NEVER email when the admin/owner is the logged-in user (isAdminEmail or the
 *    canonical owner address). Admin noise would drown the signal.
 *  - Fire-and-forget: the exported function NEVER throws and callers MUST NOT
 *    await it. It kicks off an internal async IIFE and returns immediately.
 *  - Throttled + globally capped so a crash loop can't spam the inbox.
 */

import { sendEmail } from './email.js'
import { isAdminEmail } from '../config/constants.js'

const OWNER_EMAIL = 'dr.johnwhite@axiombiolabs.org'
const CANONICAL_ADMIN = 'buckeye7066@gmail.com'

// Per-signature throttle: don't re-send the same error within this window.
const THROTTLE_MS = 600000 // 10 minutes
// Global rate cap: at most this many emails per rolling hour.
const HOURLY_CAP = 30
const HOUR_MS = 3600000
// LLM analysis hard timeout.
const ANALYZE_TIMEOUT_MS = 15000

// signature -> { lastSentAt, count }
const sentSignatures = new Map()
// timestamps (ms) of emails actually sent in the last hour
let recentSends = []

function pruneOldEntries(now) {
  // Drop throttle entries whose window has fully elapsed.
  for (const [sig, info] of sentSignatures) {
    if (now - info.lastSentAt > THROTTLE_MS) sentSignatures.delete(sig)
  }
  // Drop send timestamps older than the rolling hour.
  recentSends = recentSends.filter((ts) => now - ts < HOUR_MS)
}

function buildSignature({ source, route, error }) {
  const name = error?.name || 'Error'
  const message = String(error?.message || '').slice(0, 120)
  return `${source}|${route || ''}|${name}|${message}`
}

function truncate(value, max) {
  const str = String(value ?? '')
  return str.length > max ? `${str.slice(0, max)}…` : str
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Heuristic cause/fix/severity classifier — used when the LLM is unavailable
 * or fails. Classifies by error name + message into a sensible triage.
 */
function heuristicAnalyze(error, ctx) {
  const name = String(error?.name || '')
  const message = String(error?.message || '')
  const lower = message.toLowerCase()
  const status = Number(ctx?.statusCode) || 0

  if (name === 'TypeError') {
    return {
      cause: 'A value was used in a way its type does not support (e.g. reading a property of null/undefined or calling a non-function). Often a missing null-check or an unexpected API shape.',
      fix: 'Trace the property/method named in the message; add a guard for the null/undefined case and verify the upstream data shape that produced it.',
      severity: 'high',
    }
  }
  if (name === 'ReferenceError') {
    return {
      cause: 'Code referenced a variable or binding that is not defined in scope — typically a typo, a missing import, or a stale reference after a refactor.',
      fix: 'Locate the identifier in the message; add the missing import/declaration or correct the name.',
      severity: 'high',
    }
  }
  if (
    lower.includes('econnrefused') ||
    lower.includes('timeout') ||
    lower.includes('etimedout') ||
    lower.includes('connection terminated') ||
    lower.includes('too many clients') ||
    /\b5[0-9]{2}\b/.test(message) && lower.includes('database') ||
    lower.includes('statement timeout')
  ) {
    return {
      cause: 'A downstream dependency (database, queue, or external service) was unreachable, overloaded, or timed out.',
      fix: 'Check the dependency health and connection pool/limits; add retry/backoff and surface a retryable 503 instead of a hard failure if this is transient capacity.',
      severity: 'high',
    }
  }
  if (lower.includes('validation') || lower.includes('invalid') || name === 'ValidationError' || status === 422 || status === 400) {
    return {
      cause: 'Input failed validation — a request payload or field did not match the expected schema/constraints.',
      fix: 'Inspect the offending field; align the client payload with the server schema, or relax/clarify the validation rule if it is too strict.',
      severity: 'medium',
    }
  }
  if (status === 401 || status === 403 || lower.includes('unauthorized') || lower.includes('forbidden') || lower.includes('csrf')) {
    return {
      cause: 'An authentication or authorization check failed — missing/expired token, cross-site cookie issue, or insufficient role.',
      fix: 'Verify the session/token refresh path and CSRF/cookie configuration; confirm the user actually has access to the resource.',
      severity: 'medium',
    }
  }
  if (status === 404 || lower.includes('not found')) {
    return {
      cause: 'A requested resource or route did not exist — a stale id, a deleted record, or a mismatched endpoint path.',
      fix: 'Confirm the id/path is correct and the resource still exists; handle the missing case gracefully in the UI.',
      severity: 'low',
    }
  }
  return {
    cause: 'Unclassified application error. See the stack trace for the failing call site.',
    fix: 'Reproduce with the request id/route below, then add handling at the failing call site.',
    severity: status >= 500 ? 'high' : 'medium',
  }
}

let cachedAnthropic = null
let cachedAnthropicKey = null

async function getAnthropic() {
  const key = String(process.env.ANTHROPIC_API_KEY || '').trim()
  if (!key) return null
  if (cachedAnthropic && cachedAnthropicKey === key) return cachedAnthropic
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  cachedAnthropic = new Anthropic({
    apiKey: key,
    timeout: ANALYZE_TIMEOUT_MS,
    maxRetries: 1,
  })
  cachedAnthropicKey = key
  return cachedAnthropic
}

function extractAnthropicText(response) {
  const parts = Array.isArray(response?.content) ? response.content : []
  return parts
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim()
}

function parseAnalysisJson(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const firstBrace = raw.indexOf('{')
  const lastBrace = raw.lastIndexOf('}')
  const candidate = firstBrace !== -1 && lastBrace > firstBrace ? raw.slice(firstBrace, lastBrace + 1) : raw
  try {
    const parsed = JSON.parse(candidate)
    if (!parsed || typeof parsed !== 'object') return null
    const severity = ['low', 'medium', 'high'].includes(parsed.severity) ? parsed.severity : null
    if (!parsed.cause || !parsed.fix) return null
    return {
      cause: String(parsed.cause),
      fix: String(parsed.fix),
      severity: severity || 'medium',
    }
  } catch {
    return null
  }
}

/**
 * Analyze an error → { cause, fix, severity }. Tries the Anthropic client with
 * a short triage prompt (hard 15s timeout); on ANY failure falls back to a
 * heuristic classifier.
 */
async function analyzeError(error, ctx) {
  try {
    const anthropic = await getAnthropic()
    if (!anthropic) return heuristicAnalyze(error, ctx)

    const system =
      'You are a senior software engineer triaging a production error for the GrantFlow app (React + Express + PostgreSQL, ESM JavaScript). Respond with STRICT minified JSON only — no prose, no code fences.'
    const userPrompt = [
      'Triage this error and return JSON: {"cause": string, "fix": string, "severity": "low"|"medium"|"high"}.',
      `app: GrantFlow`,
      `source: ${ctx?.source || 'backend'}`,
      `route: ${ctx?.route || 'unknown'}`,
      `method: ${ctx?.method || 'unknown'}`,
      `httpStatus: ${ctx?.statusCode ?? 'n/a'}`,
      `errorName: ${error?.name || 'Error'}`,
      `errorMessage: ${truncate(error?.message, 500)}`,
      `stack:\n${truncate(error?.stack, 2000)}`,
    ].join('\n')

    const call = anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
      max_tokens: 500,
      temperature: 0.2,
      system,
      messages: [{ role: 'user', content: userPrompt }],
    })

    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('analyze_timeout')), ANALYZE_TIMEOUT_MS)
    })
    let response
    try {
      response = await Promise.race([call, timeout])
    } finally {
      clearTimeout(timer)
    }

    const parsed = parseAnalysisJson(extractAnthropicText(response))
    return parsed || heuristicAnalyze(error, ctx)
  } catch (e) {
    console.error('[errorReporter] analyze failed, using heuristic:', e?.message || e)
    return heuristicAnalyze(error, ctx)
  }
}

function buildEmail({ error, source, userEmail, route, method, requestId, statusCode, analysis }) {
  const shortMessage = truncate(error?.message, 140) || '(no message)'
  const subject = `[GrantFlow] Error for ${userEmail || 'anonymous'}: ${error?.name || 'Error'}: ${shortMessage}`
  const timestamp = new Date().toISOString()

  const text = [
    `GrantFlow error report`,
    ``,
    `Time:        ${timestamp}`,
    `User:        ${userEmail || 'anonymous'}`,
    `Source:      ${source}`,
    `Route:       ${method || ''} ${route || '(unknown)'}`,
    `Request ID:  ${requestId || '(none)'}`,
    `Status:      ${statusCode ?? '(n/a)'}`,
    `Error:       ${error?.name || 'Error'}: ${error?.message || '(no message)'}`,
    ``,
    `Severity:    ${analysis.severity}`,
    `Cause:       ${analysis.cause}`,
    `Suggested fix: ${analysis.fix}`,
    ``,
    `Stack:`,
    String(error?.stack || '(no stack)'),
  ].join('\n')

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;max-width:720px">
      <h2 style="margin:0 0 12px">GrantFlow error report</h2>
      <table style="border-collapse:collapse;font-size:14px;width:100%">
        <tbody>
          <tr><td style="padding:4px 8px;color:#64748b">Time</td><td style="padding:4px 8px">${escapeHtml(timestamp)}</td></tr>
          <tr><td style="padding:4px 8px;color:#64748b">User</td><td style="padding:4px 8px">${escapeHtml(userEmail || 'anonymous')}</td></tr>
          <tr><td style="padding:4px 8px;color:#64748b">Source</td><td style="padding:4px 8px">${escapeHtml(source)}</td></tr>
          <tr><td style="padding:4px 8px;color:#64748b">Route</td><td style="padding:4px 8px">${escapeHtml(`${method || ''} ${route || '(unknown)'}`)}</td></tr>
          <tr><td style="padding:4px 8px;color:#64748b">Request ID</td><td style="padding:4px 8px"><code>${escapeHtml(requestId || '(none)')}</code></td></tr>
          <tr><td style="padding:4px 8px;color:#64748b">Status</td><td style="padding:4px 8px">${escapeHtml(String(statusCode ?? '(n/a)'))}</td></tr>
          <tr><td style="padding:4px 8px;color:#64748b">Error</td><td style="padding:4px 8px">${escapeHtml(`${error?.name || 'Error'}: ${error?.message || '(no message)'}`)}</td></tr>
          <tr><td style="padding:4px 8px;color:#64748b">Severity</td><td style="padding:4px 8px"><strong>${escapeHtml(analysis.severity)}</strong></td></tr>
        </tbody>
      </table>
      <h3 style="margin:16px 0 4px">Likely cause</h3>
      <p style="margin:0;font-size:14px">${escapeHtml(analysis.cause)}</p>
      <h3 style="margin:16px 0 4px">Suggested fix</h3>
      <p style="margin:0;font-size:14px">${escapeHtml(analysis.fix)}</p>
      <h3 style="margin:16px 0 4px">Stack</h3>
      <pre style="background:#0f172a;color:#e2e8f0;padding:12px;border-radius:8px;overflow:auto;font-size:12px;white-space:pre-wrap">${escapeHtml(error?.stack || '(no stack)')}</pre>
    </div>
  `

  return { subject, html, text }
}

/**
 * Report an error to the owner. Fire-and-forget — do NOT await this.
 *
 * @param {object} params
 * @param {Error}  params.error
 * @param {string} params.source - 'backend' | 'frontend'
 * @param {object} [params.user] - resolved request user ({ email })
 * @param {string} [params.route]
 * @param {string} [params.method]
 * @param {string} [params.requestId]
 * @param {number} [params.statusCode]
 * @param {object} [params.extra]
 */
export function reportErrorToOwner({ error, source = 'backend', user, route, method, requestId, statusCode, extra } = {}) {
  // Kick off async work without making callers await; never throw.
  ;(async () => {
    try {
      if (!error) return

      const userEmail = user?.email || null

      // HARD RULE: never email when the admin/owner is the logged-in user.
      if (userEmail && (isAdminEmail(userEmail) || userEmail.toLowerCase() === CANONICAL_ADMIN)) {
        return
      }

      const now = Date.now()
      pruneOldEntries(now)

      // Per-signature throttle.
      const signature = buildSignature({ source, route, error })
      const existing = sentSignatures.get(signature)
      if (existing && now - existing.lastSentAt < THROTTLE_MS) {
        existing.count += 1
        return
      }

      // Global hourly cap.
      if (recentSends.length >= HOURLY_CAP) {
        console.warn('[errorReporter] hourly cap reached; skipping error email')
        return
      }

      const analysis = await analyzeError(error, { source, route, method, statusCode, ...(extra || {}) })
      const { subject, html, text } = buildEmail({
        error,
        source,
        userEmail,
        route,
        method,
        requestId,
        statusCode,
        analysis,
      })

      const result = await sendEmail({
        to: process.env.ERROR_REPORT_EMAIL || OWNER_EMAIL,
        subject,
        html,
        text,
      })

      // Only record as "sent" when the provider actually accepted it, so a
      // skipped/failed send doesn't burn the throttle/cap budget.
      if (result?.ok) {
        sentSignatures.set(signature, { lastSentAt: now, count: (existing?.count || 0) + 1 })
        recentSends.push(now)
      } else if (result && !result.skipped) {
        console.error('[errorReporter] sendEmail failed:', result.error)
      }
    } catch (e) {
      console.error('[errorReporter]', e)
    }
  })()
}

export default reportErrorToOwner

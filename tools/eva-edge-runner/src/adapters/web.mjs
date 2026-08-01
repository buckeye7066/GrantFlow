// Web adapter (Playwright). Drives a browser through a journey's steps against a
// disposable browser profile, capturing trace/screenshot/console/network on
// failure. Playwright is an OPTIONAL dependency: if it isn't installed the
// adapter returns a 'blocked' result naming the missing dep rather than throwing,
// so the rest of the run proceeds.
//
// A journey is a list of steps: { action, selector?, url?, value?, expect? }.
// The adapter asserts SEMANTIC correctness (visible text / value), not merely
// element presence, and records console errors + failed requests as findings.
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

async function loadPlaywright() {
  try {
    const mod = await import('playwright')
    return mod.chromium ? mod : null
  } catch {
    return null
  }
}

export async function runWebJourney({ baseUrl, journey, captureDir = null, dryRun = false }) {
  const started = Date.now()
  if (dryRun) {
    return { journey_id: journey.id, name: journey.name, status: 'skipped', duration_ms: Date.now() - started }
  }
  const pw = await loadPlaywright()
  if (!pw) {
    return blocked(journey, started, 'Playwright is not installed on this runner (npm i playwright && npx playwright install chromium)')
  }

  const userDataDir = mkdtempSync(join(os.tmpdir(), 'eva-web-'))
  const consoleErrors = []
  const failedRequests = []
  let context
  try {
    context = await pw.chromium.launchPersistentContext(userDataDir, { headless: true })
    const page = await context.newPage()
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    page.on('requestfailed', (req) => {
      // ERR_ABORTED is the browser cancelling its own in-flight request
      // (navigation away, <video> teardown, dev-server HMR churn) — not a
      // server failure a user would hit. Counting it made healthy journeys
      // fail intermittently (the GrantFlow onboarding-mp4 class: the file
      // exists and serves fine; the dialog closing aborts the media load).
      const errText = req.failure()?.errorText || ''
      if (errText.includes('ERR_ABORTED')) return
      failedRequests.push(`${req.method()} ${req.url()}${errText ? ` (${errText})` : ''}`)
    })
    page.on('response', (resp) => {
      if (resp.status() >= 500) failedRequests.push(`${resp.status()} ${resp.url()}`)
    })

    for (const step of journey.steps || []) {
      await applyStep(page, step, baseUrl)
    }

    // Semantic assertion(s).
    for (const assertion of journey.assert || []) {
      const okAssert = await checkAssertion(page, assertion)
      if (!okAssert.ok) {
        return await fail(journey, started, page, captureDir, {
          severity: journey.severity || 'high',
          failureClass: 'assertion',
          route: page.url(),
          observed: okAssert.observed,
          expected: okAssert.expected,
          impact: journey.user_impact || 'the user could not complete this workflow',
          errorSignature: `assertion failed: ${assertion.type}`,
          consoleErrors,
          failedRequests,
        })
      }
    }

    // Uncaught console errors / 5xx are findings even if assertions passed —
    // EXCEPT ones the journey declares as expected. An unauthenticated view
    // that fetches a token-gated endpoint logs a 401 by design; reporting that
    // as a defect every night is the "alarm the owner scrolls past" class.
    // Declaring it is deliberate and per-journey; it can never suppress an
    // assertion failure, only this console/network noise lane.
    const expected = expectedConsolePatterns(journey)
    const unexpectedConsole = consoleErrors.filter((m) => !matchesAny(m, expected))
    const unexpectedRequests = failedRequests.filter((m) => !matchesAny(m, expected))
    if (unexpectedConsole.length || unexpectedRequests.length) {
      return await fail(journey, started, page, captureDir, {
        severity: 'medium',
        failureClass: unexpectedConsole.length ? 'console-error' : 'network-5xx',
        route: page.url(),
        observed: [...unexpectedConsole.slice(0, 3), ...unexpectedRequests.slice(0, 3)].join(' | '),
        expected: 'no console errors or 5xx responses during the journey',
        impact: 'the page reached the right state but logged errors a user’s session could hit',
        errorSignature: (unexpectedConsole[0] || unexpectedRequests[0] || '').slice(0, 200),
        consoleErrors: unexpectedConsole,
        failedRequests: unexpectedRequests,
      })
    }

    return { journey_id: journey.id, name: journey.name, status: 'passed', duration_ms: Date.now() - started }
  } catch (err) {
    return await fail(journey, started, null, captureDir, {
      severity: journey.severity || 'high',
      failureClass: 'uncaught-page-error',
      route: baseUrl,
      observed: String(err?.message || err).slice(0, 300),
      expected: 'the journey runs without throwing',
      impact: journey.user_impact || 'the workflow crashed mid-way',
      errorSignature: String(err?.message || err).slice(0, 200),
      consoleErrors,
      failedRequests,
    })
  } finally {
    try {
      await context?.close()
    } catch {
      /* ignore */
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

/**
 * Console/network messages a journey declares as EXPECTED (`expected_console_errors`).
 * Substring match, case-insensitive. Only ever narrows the console/network
 * noise lane — assertion failures are untouched.
 */
export function expectedConsolePatterns(journey) {
  const raw = journey?.expected_console_errors
  if (!Array.isArray(raw)) return []
  return raw.map((p) => String(p || '').trim().toLowerCase()).filter(Boolean)
}

export function matchesAny(message, patterns) {
  if (!patterns.length) return false
  const m = String(message || '').toLowerCase()
  return patterns.some((p) => m.includes(p))
}

async function applyStep(page, step, baseUrl) {
  switch (step.action) {
    case 'goto':
      // 30s default: a cold Vite dev server transforms the entry modules on
      // the first request and routinely blows a 15s budget on a busy machine
      // (the "intermittent goto timeout" class). Manifests can still override.
      return page.goto(new URL(step.url || '/', baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: step.timeout || 30000 })
    case 'fill':
      return page.fill(step.selector, step.value ?? '', { timeout: step.timeout || 10000 })
    case 'click':
      return page.click(step.selector, { timeout: step.timeout || 10000 })
    case 'wait':
      return page.waitForTimeout(Math.min(step.ms || 500, 5000))
    case 'waitForSelector':
      return page.waitForSelector(step.selector, { timeout: step.timeout || 10000 })
    default:
      return null
  }
}

async function checkAssertion(page, assertion) {
  try {
    if (assertion.type === 'text_visible') {
      // POLL until the deadline: a single instant textContent() read raced the
      // SPA mount — on a cold Vite dev server `body` exists immediately but
      // React renders seconds later, so healthy apps failed "visible text did
      // not contain …" (the GrantFlow login class, 2026-07-28).
      const deadline = Date.now() + (assertion.timeout || 8000)
      const loc = page.locator(assertion.selector || 'body')
      let text = ''
      for (;;) {
        text = (await loc.first().textContent({ timeout: 1000 }).catch(() => '')) || ''
        if (text.includes(assertion.value)) return { ok: true }
        if (Date.now() >= deadline) break
        await page.waitForTimeout(250)
      }
      return { ok: false, observed: `visible text did not contain "${assertion.value}"`, expected: `text containing "${assertion.value}"` }
    }
    if (assertion.type === 'url_contains') {
      const ok = page.url().includes(assertion.value)
      return { ok, observed: ok ? '' : `url is ${page.url()}`, expected: `url containing "${assertion.value}"` }
    }
    if (assertion.type === 'input_value') {
      const val = await page.inputValue(assertion.selector, { timeout: assertion.timeout || 8000 })
      const ok = val === assertion.value
      return { ok, observed: ok ? '' : `input value was "${val}"`, expected: `input value "${assertion.value}"` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, observed: String(err?.message || err).slice(0, 200), expected: `assertion ${assertion.type} to hold` }
  }
}

async function fail(journey, started, page, captureDir, ctx) {
  const evidence = []
  if (page && captureDir) {
    try {
      const shot = join(captureDir, `${journey.id}.png`)
      await page.screenshot({ path: shot, fullPage: false })
      // Reference only — a relative name, never the absolute private path.
      evidence.push({ kind: 'screenshot', ref: `${journey.id}.png` })
    } catch {
      /* screenshot best-effort */
    }
  }
  if (ctx.consoleErrors?.length) evidence.push({ kind: 'console', ref: `${journey.id}-console.txt` })
  if (ctx.failedRequests?.length) evidence.push({ kind: 'network', ref: `${journey.id}-network.txt` })
  return {
    journey_id: journey.id,
    name: journey.name,
    status: 'failed',
    severity: ctx.severity,
    retry_classification: 'reproducible',
    failure_class: ctx.failureClass,
    route_or_control: ctx.route,
    error_signature: ctx.errorSignature,
    expected_behavior: ctx.expected,
    observed_behavior: ctx.observed,
    repro_steps: (journey.steps || []).map((s) => `${s.action}${s.selector ? ' ' + s.selector : ''}${s.url ? ' ' + s.url : ''}`).slice(0, 20),
    user_impact: ctx.impact,
    likely_root_cause: journey.likely_root_cause || null,
    recommended_fix: journey.recommended_fix || null,
    candidate_files: journey.candidate_files || null,
    diagnostic_confidence: journey.candidate_files ? 0.7 : 0.55,
    missing_evidence: journey.candidate_files ? null : 'No source mapping yet — inspect the failing route handler and recent changes',
    evidence,
    duration_ms: Date.now() - started,
  }
}

function blocked(journey, started, reason) {
  return {
    journey_id: journey.id,
    name: journey.name,
    status: 'blocked',
    route_or_control: journey.id,
    observed_behavior: reason,
    duration_ms: Date.now() - started,
  }
}

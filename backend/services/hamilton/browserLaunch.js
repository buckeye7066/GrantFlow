import {
  isHamiltonBrowserTargetAllowed,
  isPrivateResolutionVerdict,
  resolvePublicBrowserTarget,
} from './controlledBetaBrowserPolicy.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:browserLaunch')

/**
 * browserLaunch.js — the single source of truth for Chromium launch args used by
 * every Hamilton browser flow.
 *
 * Railway/Docker containers give a tiny `/dev/shm` (64 MB) by default. Chromium
 * writes shared-memory there and, without `--disable-dev-shm-usage`, OOM-crashes
 * the whole container under load — which is exactly what took prod down during a
 * bulk portal-automation run (dozens of serial browsers, silent SIGKILL restarts,
 * no JS stack). `--no-sandbox` is required in the unprivileged container, and
 * `--disable-gpu` trims memory in headless. Every `chromium.launch(...)` in the
 * Hamilton services MUST spread these so no launch site drifts back to the
 * OOM-prone bare default.
 */
export const CHROMIUM_CONTAINER_ARGS = Object.freeze([
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
])

/**
 * One realistic desktop-Chrome UA shared by every portal-facing context. Kept
 * as a single constant so a captured session and its later automated REUSE
 * present the SAME fingerprint (Akamai-class WAFs bind cookies to it) — two
 * services drifting to different UA strings silently invalidates sessions.
 */
export const REALISTIC_PORTAL_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/**
 * launchPortalBrowser — the one launcher for Hamilton portal-facing flows.
 * Accepts the reserved synthetic fixture OR a public HTTPS portal URL.
 * Private / loopback / metadata targets are refused (SSRF), by URL shape AND
 * by resolving the hostname's DNS answers first (a public-looking alias for
 * 127.0.0.1 / 10.x is refused the same way). Callers still gate enablement
 * via HAMILTON_ENABLE_BROWSER_AUTOMATION + host allowlist.
 * PDF/print flows that only render local HTML should keep using plain
 * `chromium.launch` + args.
 *
 * WHY: Playwright's default headless engine is the stripped `headless-shell`
 * build, and Akamai-class bot walls kill it at the CONNECTION level — measured
 * 2026-07-20 against studentaid.gov: headless-shell dies with
 * net::ERR_HTTP2_PROTOCOL_ERROR before any page exists, while FULL Chromium in
 * new-headless mode (`channel: 'chromium'`, the same build headed runs use)
 * renders the real FSA login page. The prod image installs the full build
 * (Dockerfile: `playwright install --with-deps chromium` ships both).
 *
 * Falls back to the default headless shell if the full-Chromium launch fails
 * (e.g. an older image without the full build) so this can never make a
 * previously-working deployment worse. Returns { browser, engine } so callers
 * can log which engine actually served the session.
 */
// Translate a VALIDATED bypass strategy (from hamiltonBotBypassRegistry) into
// Chromium launch args. Input is already allowlist-validated; this only maps
// the known knobs to flags — it can never introduce an arbitrary arg.
function bypassStrategyLaunchArgs(strategy) {
  if (!strategy || typeof strategy !== 'object') return []
  const out = []
  if (typeof strategy.user_agent === 'string' && strategy.user_agent) out.push(`--user-agent=${strategy.user_agent}`)
  if (Array.isArray(strategy.extra_args)) for (const a of strategy.extra_args) if (typeof a === 'string') out.push(a)
  return out
}

export async function launchPortalBrowser(chromium, { headless = true, extraArgs = [], targetUrl = null, bypassStrategy = null, lookup = undefined } = {}) {
  if (targetUrl !== null && !isHamiltonBrowserTargetAllowed(targetUrl)) {
    const err = new Error('unsafe_browser_target')
    err.code = 'unsafe_browser_target'
    err.reason = 'unsafe_target'
    throw err
  }
  // SSRF DNS gate (ported from #1515/#1520): a public-LOOKING name whose A/AAAA
  // answers include private/loopback/metadata space is refused BEFORE a
  // Chromium process exists. A lookup failure is deliberately not a refusal —
  // the browser's own resolver fails the same navigation and the run reports
  // an honest portal_unreachable instead of a misleading "unsafe target".
  if (targetUrl !== null) {
    const verdict = await resolvePublicBrowserTarget(targetUrl, lookup ? { lookup } : {})
    if (isPrivateResolutionVerdict(verdict)) {
      const err = new Error(`unsafe_browser_target:${verdict.reason}`)
      err.code = 'unsafe_browser_target'
      err.reason = verdict.reason
      throw err
    }
  }
  // Condition 3 (owner 2026-08-22): apply a PERSISTED, VALIDATED per-host bypass
  // strategy (hamiltonBotBypassRegistry) — data-only launch knobs (a user agent,
  // a few allowlisted args) the registry has already validated. Never code.
  const strategyArgs = bypassStrategyLaunchArgs(bypassStrategy)
  const args = [...CHROMIUM_CONTAINER_ARGS, '--disable-blink-features=AutomationControlled', ...strategyArgs, ...extraArgs]
  try {
    const browser = await chromium.launch({ headless, channel: 'chromium', args })
    return { browser, engine: 'chromium-new-headless' }
  } catch (err) {
    // NAME THE DOWNGRADE. This file's own header records that `headless-shell`
    // is killed at the CONNECTION level by Akamai-class walls
    // (net::ERR_HTTP2_PROTOCOL_ERROR before a page exists). Discarding the
    // first error meant an image missing the full Chromium build silently ran
    // on the engine that CANNOT reach real portals, and every later failure got
    // attributed to the PORTAL instead of to the deployment. The reason is now
    // logged and returned so a caller can say which it was.
    const downgradeReason = String(err?.message || err)
    log.warn(`[browserLaunch] full-Chromium launch FAILED, downgrading to headless-shell (this engine is blocked by Akamai-class walls): ${downgradeReason}`)
    const browser = await chromium.launch({ headless, args })
    return { browser, engine: 'headless-shell', downgraded_from: 'chromium-new-headless', downgrade_reason: downgradeReason }
  }
}

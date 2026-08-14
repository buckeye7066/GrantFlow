import { isControlledBetaSyntheticBrowserUrl } from './controlledBetaBrowserPolicy.js'
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
 * Controlled beta permits only the reserved synthetic fixture origin. Real
 * portals use packet preparation plus a visible manual browser handoff.
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
export async function launchPortalBrowser(chromium, { headless = true, extraArgs = [], targetUrl = null } = {}) {
  if (!isControlledBetaSyntheticBrowserUrl(targetUrl)) {
    const err = new Error('controlled_beta_manual_handoff')
    err.code = 'controlled_beta_manual_handoff'
    throw err
  }
  const args = [...CHROMIUM_CONTAINER_ARGS, '--disable-blink-features=AutomationControlled', ...extraArgs]
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

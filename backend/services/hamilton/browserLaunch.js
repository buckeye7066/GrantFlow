import {
  installHamiltonBrowserNetworkGuard,
  prepareHamiltonBrowserEgress,
} from './hamiltonBrowserNetworkGuard.js'

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
 * launchPortalBrowser — the one launcher for flows that visit REAL external
 * portals (cloud login, autopilot, signup, portal sync). PDF/print flows that
 * only render local HTML should keep using plain `chromium.launch` + args.
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
export async function launchPortalBrowser(chromium, { headless = true, extraArgs = [] } = {}) {
  const args = [...CHROMIUM_CONTAINER_ARGS, '--disable-blink-features=AutomationControlled', ...extraArgs]
  try {
    const browser = await chromium.launch({ headless, channel: 'chromium', args })
    return { browser, engine: 'chromium-new-headless' }
  } catch {
    const browser = await chromium.launch({ headless, args })
    return { browser, engine: 'headless-shell' }
  }
}

/**
 * Mandatory factory for any Hamilton context that can reach a third-party
 * portal. It resolves and pins the exact reviewed origins before Chromium
 * starts, installs HTTP/WebSocket routing before a page exists, and blocks
 * service workers. Local HTML/PDF rendering is deliberately outside this API.
 */
export async function launchGuardedPortalBrowser(chromium, {
  targetUrl,
  submissionAdapter = null,
  additionalAllowedOrigins = [],
  headless = true,
  contextOptions = {},
  prepareEgress = prepareHamiltonBrowserEgress,
  installGuard = installHamiltonBrowserNetworkGuard,
  launchBrowser = launchPortalBrowser,
} = {}) {
  const egress = await prepareEgress({ targetUrl, submissionAdapter, additionalAllowedOrigins })
  const launched = await launchBrowser(chromium, { headless, extraArgs: egress.extra_args })
  const browser = launched?.browser ?? launched
  let context
  try {
    context = launched?.context || await browser.newContext({
      ...contextOptions,
      ...egress.context_options,
    })
    await installGuard(context, egress)
  } catch (error) {
    await Promise.resolve(browser?.close?.()).catch(() => {})
    throw error
  }
  return { ...launched, browser, context, egress }
}

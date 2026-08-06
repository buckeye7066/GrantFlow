/**
 * Controlled-beta browser boundary.
 *
 * GrantFlow does not yet have a reviewed real-portal Playwright adapter. Until
 * one is reviewed and released, every Hamilton browser flow is limited to the
 * single reserved `.invalid` fixture origin used by the irreversible-boundary
 * tests. Environment allowlists, saved credentials, profile URLs, redirects,
 * and loopback/private addresses cannot widen this boundary.
 */

export const CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN =
  'https://hamilton-submit-fixture.invalid'

export const CONTROLLED_BETA_SYNTHETIC_BROWSER_HOST =
  new URL(CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN).hostname

export function isControlledBetaSyntheticBrowserUrl(value) {
  try {
    const url = new URL(String(value || ''))
    return url.origin === CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN
      && url.protocol === 'https:'
      && !url.username
      && !url.password
  } catch {
    return false
  }
}

/** Non-network document URLs are harmless; every HTTP(S) request stays on the fixture origin. */
export function isControlledBetaBrowserRequestAllowed(value) {
  const raw = String(value || '')
  if (isControlledBetaSyntheticBrowserUrl(raw)) return true
  if (raw === 'about:blank' || raw.startsWith('data:')) return true
  if (raw.startsWith('blob:')) {
    return isControlledBetaSyntheticBrowserUrl(raw.slice('blob:'.length))
  }
  return false
}

export function controlledBetaBrowserRefusal() {
  return {
    code: 'controlled_beta_manual_handoff',
    message: 'Controlled beta does not open real portal sites in a server browser. Hamilton prepared the available packet or draft; open the official portal yourself for login, review, and final submission.',
  }
}

/**
 * Install before the first page/request. Playwright routing covers redirects,
 * popup/new-tab requests, subresources, and fetch/XHR. Blocking service workers
 * on context creation keeps them from bypassing the route handler.
 */
export async function installControlledBetaBrowserEgressGuard(context) {
  if (!context || typeof context.route !== 'function') {
    throw new Error('controlled_beta_browser_guard_unavailable')
  }
  await context.route('**/*', async (route) => {
    let requestUrl = ''
    try { requestUrl = route.request().url() } catch { /* fail closed below */ }
    if (isControlledBetaBrowserRequestAllowed(requestUrl)) {
      await route.continue()
      return
    }
    await route.abort('blockedbyclient')
  })
}

export function controlledBetaBrowserContextOptions(options = {}) {
  return { ...options, serviceWorkers: 'block' }
}

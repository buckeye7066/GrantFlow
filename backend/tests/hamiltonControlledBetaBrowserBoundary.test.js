/**
 * Hamilton browser boundary — the SSRF floor, now DNS-resolved.
 *
 * Ported from PRs #1515/#1520 (2026-09-05) onto main's policy module:
 *   - URL-shape floor unchanged (public HTTPS + the reserved fixture; private /
 *     loopback / metadata refused).
 *   - NEW: every browser target and every http(s) request in a context is DNS
 *     resolved first. A public-LOOKING name whose A/AAAA answers include private
 *     space is refused; a host whose answers change mid-session is refused as
 *     DNS rebinding; WebSockets to unsafe hosts are closed.
 *   - A lookup FAILURE is not a refusal at the launcher (the browser fails the
 *     same navigation and the run reports portal_unreachable honestly).
 *
 * Nothing here re-imposes a host allowlist or a human hand-off on a real
 * public HTTPS portal: a public answer set passes every layer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import dns from 'node:dns'

import {
  CONTROLLED_BETA_SYNTHETIC_BROWSER_HOST,
  CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN,
  EGRESS_GUARD_VERDICT_TTL_MS,
  installControlledBetaBrowserEgressGuard,
  isHamiltonBrowserRequestAllowed,
  isHamiltonBrowserTargetAllowed,
  isPrivateOrLocalHostname,
  isPrivateResolutionVerdict,
  isPublicHttpsPortalUrl,
  resolvePublicBrowserTarget,
} from '../services/hamilton/controlledBetaBrowserPolicy.js'
import { launchPortalBrowser } from '../services/hamilton/browserLaunch.js'
import { browserAutomationPermittedForUrl } from '../services/hamilton/hamiltonAutomationOrchestrator.js'
import { runAutopilot } from '../services/hamilton/hamiltonAutopilotEngine.js'
import { cancelCloudLogin, startCloudLogin } from '../services/hamilton/hamiltonCloudLogin.js'
import { runPortalSync } from '../services/hamilton/portalSync/index.js'

const PUBLIC_A = [{ address: '93.184.216.34', family: 4 }]
const publicLookup = async () => PUBLIC_A

const saved = {}

beforeEach(() => {
  saved.browser = process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION
  saved.allowlist = process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST
  saved.cloud = process.env.HAMILTON_CLOUD_LOGIN_PROVIDER
  process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = 'true'
  delete process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST
  process.env.HAMILTON_CLOUD_LOGIN_PROVIDER = 'self_hosted'
})

afterEach(() => {
  process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = saved.browser
  process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = saved.allowlist
  process.env.HAMILTON_CLOUD_LOGIN_PROVIDER = saved.cloud
  vi.restoreAllMocks()
})

describe('Hamilton browser target policy (URL shape)', () => {
  it('allows the reserved fixture and public HTTPS; refuses private/loopback', () => {
    expect(isHamiltonBrowserTargetAllowed(`${CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN}/apply?case=1`)).toBe(true)
    expect(isPublicHttpsPortalUrl('https://example.org/apply')).toBe(true)
    expect(browserAutomationPermittedForUrl('https://example.org/apply')).toBe(true)

    for (const target of [
      'http://127.0.0.1:3000/',
      'http://localhost:3000/',
      'http://10.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://192.168.1.10/',
    ]) {
      expect(isPrivateOrLocalHostname(new URL(target).hostname), target).toBe(true)
      expect(isPublicHttpsPortalUrl(target), target).toBe(false)
      expect(isHamiltonBrowserTargetAllowed(target), target).toBe(false)
      expect(browserAutomationPermittedForUrl(target), target).toBe(false)
    }
  })

  it('refuses the IP-literal ranges the range table knows that the name rules alone missed', () => {
    for (const target of [
      'https://[::ffff:127.0.0.1]/', // IPv4-mapped loopback (URL renders it ::ffff:7f00:1)
      'https://100.64.0.1/',        // CGNAT
      'https://0.0.0.0/',
      'https://metadata.google.internal/',
      'https://100.100.100.200/',   // Alibaba metadata
    ]) {
      expect(isPublicHttpsPortalUrl(target), target).toBe(false)
      expect(isHamiltonBrowserRequestAllowed(target), target).toBe(false)
    }
  })

  it('honors an optional host allowlist for public portals', () => {
    process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = 'mtsu.edu'
    expect(browserAutomationPermittedForUrl('https://www.mtsu.edu/aid')).toBe(true)
    expect(browserAutomationPermittedForUrl('https://example.org/apply')).toBe(false)
    expect(browserAutomationPermittedForUrl('https://example.org/apply', {
      extraAllowedHosts: ['example.org'],
    })).toBe(true)
  })
})

describe('resolvePublicBrowserTarget (DNS-resolved SSRF gate)', () => {
  it('passes a public host whose answers are all public, without touching the fixture', async () => {
    const lookup = vi.fn(publicLookup)
    await expect(resolvePublicBrowserTarget('https://portal.example/apply', { lookup }))
      .resolves.toMatchObject({ ok: true, addresses: ['93.184.216.34'] })
    await expect(resolvePublicBrowserTarget(`${CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN}/apply`, { lookup }))
      .resolves.toMatchObject({ ok: true })
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('refuses a public-looking name that resolves to private space (any answer)', async () => {
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.7', family: 4 }]
    const verdict = await resolvePublicBrowserTarget('https://alias.example/apply', { lookup })
    expect(verdict).toMatchObject({ ok: false, reason: 'resolves_private:10.0.0.7' })
    expect(isPrivateResolutionVerdict(verdict)).toBe(true)
  })

  it('refuses IPv6 loopback / link-local answers too', async () => {
    for (const address of ['::1', 'fe80::1', 'fd00::5', '::ffff:127.0.0.1']) {
      const verdict = await resolvePublicBrowserTarget('https://alias.example/apply', {
        lookup: async () => [{ address, family: 6 }],
      })
      expect(verdict.ok, address).toBe(false)
      expect(isPrivateResolutionVerdict(verdict), address).toBe(true)
    }
  })

  it('detects DNS rebinding against the first pinned answer set', async () => {
    const pinnedAddresses = new Map()
    await expect(resolvePublicBrowserTarget('https://portal.example/apply', {
      lookup: async () => [{ address: '8.8.8.8', family: 4 }], pinnedAddresses,
    })).resolves.toMatchObject({ ok: true })
    // Same answers again: fine.
    await expect(resolvePublicBrowserTarget('https://portal.example/next', {
      lookup: async () => [{ address: '8.8.8.8', family: 4 }], pinnedAddresses,
    })).resolves.toMatchObject({ ok: true })
    // A NEW public answer is still a rebinding signal.
    const rebound = await resolvePublicBrowserTarget('https://portal.example/next', {
      lookup: async () => [{ address: '1.1.1.1', family: 4 }], pinnedAddresses,
    })
    expect(rebound).toMatchObject({ ok: false, reason: 'dns_rebinding:portal.example' })
    expect(isPrivateResolutionVerdict(rebound)).toBe(true)
  })

  it('reports a lookup failure as dns_error, which is NOT a private-resolution verdict', async () => {
    const verdict = await resolvePublicBrowserTarget('https://dead.example/', {
      lookup: async () => { const e = new Error('nx'); e.code = 'ENOTFOUND'; throw e },
    })
    expect(verdict).toMatchObject({ ok: false, reason: 'dns_error:ENOTFOUND' })
    expect(isPrivateResolutionVerdict(verdict)).toBe(false)
  })

  it('decides IP literals by the range table alone (no lookup) and refuses unsafe shapes first', async () => {
    const lookup = vi.fn(publicLookup)
    await expect(resolvePublicBrowserTarget('https://8.8.8.8/', { lookup })).resolves.toMatchObject({ ok: true })
    // A private literal already fails the URL-shape floor, so it is refused
    // as unsafe_target before the range table is even consulted.
    const literal = await resolvePublicBrowserTarget('https://127.0.0.1/', { lookup })
    expect(literal).toMatchObject({ ok: false, reason: 'unsafe_target' })
    expect(isPrivateResolutionVerdict(literal)).toBe(true)
    await expect(resolvePublicBrowserTarget('ftp://example.org/', { lookup })).resolves.toMatchObject({ ok: false, reason: 'unsafe_target' })
    expect(lookup).not.toHaveBeenCalled()
  })

  it('uses dns.promises.lookup by default (so a real resolver is what production consults)', async () => {
    const spy = vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    await expect(resolvePublicBrowserTarget('https://attacker.example/internal'))
      .resolves.toMatchObject({ ok: false, reason: 'resolves_private:127.0.0.1' })
    expect(spy).toHaveBeenCalledWith('attacker.example', expect.objectContaining({ all: true }))
  })
})

describe('launchPortalBrowser', () => {
  it('rejects a private target before Chromium launch', async () => {
    const chromium = { launch: vi.fn() }
    await expect(launchPortalBrowser(chromium, { targetUrl: 'http://127.0.0.1/admin' }))
      .rejects.toMatchObject({ code: 'unsafe_browser_target' })
    expect(chromium.launch).not.toHaveBeenCalled()
  })

  it('rejects a public-looking name that resolves to private space before Chromium launch', async () => {
    const chromium = { launch: vi.fn() }
    await expect(launchPortalBrowser(chromium, {
      targetUrl: 'https://alias.example/apply',
      lookup: async () => [{ address: '10.0.0.7', family: 4 }],
    })).rejects.toMatchObject({ code: 'unsafe_browser_target', reason: 'resolves_private:10.0.0.7' })
    expect(chromium.launch).not.toHaveBeenCalled()
  })

  it('allows a public HTTPS target whose DNS answers are public', async () => {
    const browser = { close: vi.fn() }
    const chromium = { launch: vi.fn(async () => browser) }
    const result = await launchPortalBrowser(chromium, { targetUrl: 'https://example.org/apply', lookup: publicLookup })
    expect(chromium.launch).toHaveBeenCalledOnce()
    expect(result.browser).toBe(browser)
  })

  it('lets a DNS lookup FAILURE through to the browser (an unreachable portal is not an unsafe one)', async () => {
    const browser = { close: vi.fn() }
    const chromium = { launch: vi.fn(async () => browser) }
    const result = await launchPortalBrowser(chromium, {
      targetUrl: 'https://dead.example/apply',
      lookup: async () => { const e = new Error('nx'); e.code = 'ENOTFOUND'; throw e },
    })
    expect(chromium.launch).toHaveBeenCalledOnce()
    expect(result.browser).toBe(browser)
  })
})

function guardedContext() {
  let handler = null
  let wsHandler = null
  const context = {
    route: vi.fn(async (_pattern, callback) => { handler = callback }),
    routeWebSocket: vi.fn(async (_pattern, callback) => { wsHandler = callback }),
  }
  const dispatch = async (url) => {
    const route = {
      request: () => ({ url: () => url }),
      continue: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    }
    await handler(route)
    return route
  }
  const dispatchWs = async (url) => {
    const ws = { url: () => url, connectToServer: vi.fn(() => ({})), close: vi.fn(async () => {}) }
    await wsHandler(ws)
    return ws
  }
  return { context, dispatch, dispatchWs, getHandler: () => handler, getWsHandler: () => wsHandler }
}

describe('egress guard', () => {
  it('continues public and fixture requests; aborts private targets by shape', async () => {
    const { context, dispatch, getHandler } = guardedContext()
    await installControlledBetaBrowserEgressGuard(context, { lookup: publicLookup })
    expect(getHandler()).toBeTypeOf('function')

    for (const okUrl of [
      `${CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN}/asset.js`,
      'https://example.org/apply',
      'https://cdn.example.org/form.js',
      'http://cdn.example.org/legacy.js', // http subresources stay allowed
      'about:blank',
      'data:text/html,x',
    ]) {
      const route = await dispatch(okUrl)
      expect(route.continue, okUrl).toHaveBeenCalledOnce()
      expect(route.abort, okUrl).not.toHaveBeenCalled()
    }

    for (const bad of [
      'http://127.0.0.1/admin',
      'http://10.0.0.1/private',
      'http://169.254.169.254/latest/meta-data/',
      'https://[::ffff:127.0.0.1]/admin',
    ]) {
      expect(isHamiltonBrowserRequestAllowed(bad)).toBe(false)
      const route = await dispatch(bad)
      expect(route.continue, bad).not.toHaveBeenCalled()
      expect(route.abort, bad).toHaveBeenCalledWith('blockedbyclient')
    }
  })

  it('aborts a public-looking hostname when DNS resolves it to private space (covers redirects)', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    const { context, dispatch } = guardedContext()
    await installControlledBetaBrowserEgressGuard(context)
    const route = await dispatch('https://attacker.example/redirected')
    expect(route.continue).not.toHaveBeenCalled()
    expect(route.abort).toHaveBeenCalledWith('blockedbyclient')
  })

  it('aborts a request whose lookup fails (the browser could not connect either)', async () => {
    const { context, dispatch } = guardedContext()
    await installControlledBetaBrowserEgressGuard(context, {
      lookup: async () => { const e = new Error('nx'); e.code = 'ENOTFOUND'; throw e },
    })
    const route = await dispatch('https://dead.example/asset.js')
    expect(route.abort).toHaveBeenCalledWith('blockedbyclient')
  })

  it('pins the first answer set per host and aborts a rebinding attempt after the verdict TTL', async () => {
    let clock = 1_000_000
    const answers = [[{ address: '8.8.8.8', family: 4 }]]
    const lookup = vi.fn(async () => answers[answers.length - 1])
    const { context, dispatch } = guardedContext()
    await installControlledBetaBrowserEgressGuard(context, { lookup, now: () => clock })

    const first = await dispatch('https://portal.example/apply')
    expect(first.continue).toHaveBeenCalledOnce()
    // Within the TTL the cached verdict is reused: no second lookup per request.
    const second = await dispatch('https://portal.example/asset.js')
    expect(second.continue).toHaveBeenCalledOnce()
    expect(lookup).toHaveBeenCalledTimes(1)

    // After the TTL the host is re-resolved; a changed answer set is rebinding.
    clock += EGRESS_GUARD_VERDICT_TTL_MS + 1
    answers.push([{ address: '10.0.0.7', family: 4 }])
    const rebound = await dispatch('https://portal.example/next')
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(rebound.continue).not.toHaveBeenCalled()
    expect(rebound.abort).toHaveBeenCalledWith('blockedbyclient')
  })

  it('closes WebSockets to unsafe hosts and connects safe ones straight through', async () => {
    const { context, dispatchWs, getWsHandler } = guardedContext()
    await installControlledBetaBrowserEgressGuard(context, { lookup: publicLookup })
    expect(getWsHandler()).toBeTypeOf('function')

    const safe = await dispatchWs('wss://portal.example/live')
    expect(safe.connectToServer).toHaveBeenCalledOnce()
    expect(safe.close).not.toHaveBeenCalled()

    const unsafe = await dispatchWs('ws://127.0.0.1:9229/devtools')
    expect(unsafe.connectToServer).not.toHaveBeenCalled()
    expect(unsafe.close).toHaveBeenCalledOnce()
  })

  it('still installs on a context without routeWebSocket (older/fake contexts)', async () => {
    const context = { route: vi.fn(async () => {}) }
    await expect(installControlledBetaBrowserEgressGuard(context, { lookup: publicLookup })).resolves.toBeUndefined()
    expect(context.route).toHaveBeenCalledOnce()
  })
})

describe('browser entry points', () => {
  it('cloud login refuses private targets before launch', async () => {
    const launchBrowser = vi.fn()
    const result = await startCloudLogin({
      userId: 'u1', profileId: 'p1', portalHost: '127.0.0.1',
      loginUrl: 'http://127.0.0.1:3000/login', launchBrowser,
    })
    expect(result).toMatchObject({
      ok: false,
      reason: 'controlled_beta_manual_handoff',
      requires_human_handoff: true,
    })
    expect(launchBrowser).not.toHaveBeenCalled()
  })

  it('direct autopilot refuses a private target before Playwright launch', async () => {
    const result = await runAutopilot({
      url: 'http://127.0.0.1/apply',
      profile: { id: 'p1', basic_information: { first_name: 'Demo' } },
      authorizations: { complete_forms: true, save_drafts: true, submit_applications: false },
    })
    expect(result).toMatchObject({
      status: 'blocked',
      blocker_kind: 'controlled_beta_manual_handoff',
      requires_human_handoff: true,
      pages_visited: 0,
    })
  })

  it('portal sync refuses a private host before connector work', async () => {
    const result = await runPortalSync({}, {
      profileId: 'p1', portalHost: '127.0.0.1', direction: 'read',
    })
    expect(result.ok).toBe(false)
    expect(result.runId).toBeNull()
  })
})

describe('synthetic fixture remains testable', () => {
  it('cloud login can launch the reserved fixture with a guarded context', async () => {
    const route = vi.fn(async () => {})
    const page = {
      goto: vi.fn(async () => {}),
      url: () => `${CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN}/login`,
      viewportSize: () => ({ width: 1280, height: 900 }),
    }
    const context = {
      route,
      newPage: vi.fn(async () => page),
      storageState: vi.fn(async () => ({ cookies: [], origins: [] })),
    }
    page.context = () => context
    const browser = {
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => {}),
    }
    const launchBrowser = vi.fn(async () => ({ browser, engine: 'synthetic-test' }))

    const result = await startCloudLogin({
      userId: 'u1', profileId: 'p1',
      portalHost: CONTROLLED_BETA_SYNTHETIC_BROWSER_HOST,
      loginUrl: `${CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN}/login`,
      launchBrowser,
    })
    expect(result.ok).toBe(true)
    expect(launchBrowser).toHaveBeenCalledOnce()
    expect(browser.newContext.mock.calls[0][0]).toMatchObject({ serviceWorkers: 'block' })
    expect(route).toHaveBeenCalledOnce()
    expect(page.goto).toHaveBeenCalledWith(
      `${CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN}/login`,
      expect.any(Object),
    )
    await cancelCloudLogin(result.liveSessionId)
  })
})

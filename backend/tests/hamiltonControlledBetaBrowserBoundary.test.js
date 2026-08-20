/**
 * Hamilton hands-off browser gate — SSRF floor only.
 *
 * After the controlled-beta boundary was removed, Hamilton is allowed to open
 * any real public HTTPS portal when browser automation is enabled.  The only
 * hard gate that remains is the SSRF floor (private IPs, loopback, cloud
 * metadata endpoints).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CONTROLLED_BETA_SYNTHETIC_BROWSER_HOST,
  CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN,
  installControlledBetaBrowserEgressGuard,
  isControlledBetaBrowserRequestAllowed,
  isControlledBetaSyntheticBrowserUrl,
} from '../services/hamilton/controlledBetaBrowserPolicy.js'
import { launchPortalBrowser } from '../services/hamilton/browserLaunch.js'
import { browserAutomationPermittedForUrl } from '../services/hamilton/hamiltonAutomationOrchestrator.js'
import { runAutopilot } from '../services/hamilton/hamiltonAutopilotEngine.js'
import { startCloudLogin, cancelCloudLogin } from '../services/hamilton/hamiltonCloudLogin.js'
import { runPortalSync } from '../services/hamilton/portalSync/index.js'

const saved = {}

beforeEach(() => {
  saved.browser = process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION
  saved.allowlist = process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST
  saved.cloud = process.env.HAMILTON_CLOUD_LOGIN_PROVIDER
  process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = 'true'
  process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = 'example.org,127.0.0.1,10.0.0.1'
  process.env.HAMILTON_CLOUD_LOGIN_PROVIDER = 'self_hosted'
})

afterEach(() => {
  process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = saved.browser
  process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = saved.allowlist
  process.env.HAMILTON_CLOUD_LOGIN_PROVIDER = saved.cloud
  vi.restoreAllMocks()
})

describe('controlled-beta target predicate (unchanged)', () => {
  it('still identifies only the exact reserved HTTPS fixture origin as synthetic', () => {
    expect(isControlledBetaSyntheticBrowserUrl(`${CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN}/apply?case=1`)).toBe(true)
    for (const target of [
      'https://example.org/apply',
      'http://127.0.0.1:3000/',
      'http://localhost:3000/',
      `https://sub.${CONTROLLED_BETA_SYNTHETIC_BROWSER_HOST}/`,
      `https://${CONTROLLED_BETA_SYNTHETIC_BROWSER_HOST}:8443/`,
    ]) {
      expect(isControlledBetaSyntheticBrowserUrl(target), target).toBe(false)
    }
  })

  it('browserAutomationPermittedForUrl NOW ALLOWS real public HTTPS portals', () => {
    // Real portals must be permitted when browser automation is enabled.
    expect(browserAutomationPermittedForUrl('https://example.org/apply')).toBe(true)
    expect(browserAutomationPermittedForUrl('https://mtsu.edu/portal')).toBe(true)
    // The synthetic fixture is also still allowed.
    expect(browserAutomationPermittedForUrl(`${CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN}/apply`)).toBe(true)
  })

  it('browserAutomationPermittedForUrl still blocks private/loopback/SSRF targets', () => {
    expect(browserAutomationPermittedForUrl('http://127.0.0.1:3000/')).toBe(false)
    expect(browserAutomationPermittedForUrl('http://10.0.0.1/')).toBe(false)
    expect(browserAutomationPermittedForUrl('http://169.254.169.254/latest/meta-data/')).toBe(false)
    expect(browserAutomationPermittedForUrl('http://192.168.1.10/')).toBe(false)
  })
})

describe('redirect and subresource egress guard', () => {
  it('continues fixture requests and public HTTPS; aborts loopback, private, and metadata targets', async () => {
    let handler = null
    const context = {
      route: vi.fn(async (_pattern, callback) => { handler = callback }),
    }
    await installControlledBetaBrowserEgressGuard(context)
    expect(handler).toBeTypeOf('function')

    const dispatch = async (url) => {
      const route = {
        request: () => ({ url: () => url }),
        continue: vi.fn(async () => {}),
        abort: vi.fn(async () => {}),
      }
      await handler(route)
      return route
    }

    // Fixture origin is still allowed.
    const fixture = await dispatch(`${CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN}/asset.js`)
    expect(fixture.continue).toHaveBeenCalledOnce()
    expect(fixture.abort).not.toHaveBeenCalled()

    // Real public HTTPS is now also allowed.
    expect(isControlledBetaBrowserRequestAllowed('https://example.org/redirected')).toBe(true)
    const realRoute = await dispatch('https://example.org/redirected')
    expect(realRoute.continue).toHaveBeenCalledOnce()
    expect(realRoute.abort).not.toHaveBeenCalled()

    // SSRF targets are still hard-blocked.
    for (const ssrfTarget of [
      'http://127.0.0.1/admin',
      'http://10.0.0.1/private',
      'http://169.254.169.254/latest/meta-data/',
    ]) {
      expect(isControlledBetaBrowserRequestAllowed(ssrfTarget)).toBe(false)
      const route = await dispatch(ssrfTarget)
      expect(route.continue).not.toHaveBeenCalled()
      expect(route.abort).toHaveBeenCalledWith('blockedbyclient')
    }
  })
})

describe('browser entry points — SSRF floor only', () => {
  it('launchPortalBrowser does NOT throw for a real public HTTPS portal', async () => {
    const chromium = { launch: vi.fn(async () => ({ close: vi.fn(), newContext: vi.fn() })) }
    // Should not throw — real portals are now allowed.
    await expect(launchPortalBrowser(chromium, { targetUrl: 'https://example.org/apply' }))
      .resolves.not.toThrow()
  })

  it('launchPortalBrowser still throws ssrf_blocked for private/loopback addresses', async () => {
    const chromium = { launch: vi.fn() }
    await expect(launchPortalBrowser(chromium, { targetUrl: 'http://127.0.0.1:3000/' }))
      .rejects.toMatchObject({ code: 'ssrf_blocked' })
    await expect(launchPortalBrowser(chromium, { targetUrl: 'http://10.0.0.1/' }))
      .rejects.toMatchObject({ code: 'ssrf_blocked' })
    await expect(launchPortalBrowser(chromium, { targetUrl: 'http://169.254.169.254/latest/meta-data/' }))
      .rejects.toMatchObject({ code: 'ssrf_blocked' })
    expect(chromium.launch).not.toHaveBeenCalled()
  })

  it.each([
    ['127.0.0.1', 'http://127.0.0.1:3000/login'],
    ['10.0.0.1', 'http://10.0.0.1/login'],
    ['169.254.169.254', 'http://169.254.169.254/latest/meta-data/'],
  ])('cloud login refuses SSRF target %s before the injected launcher runs', async (portalHost, loginUrl) => {
    const launchBrowser = vi.fn()
    const result = await startCloudLogin({
      userId: 'u1', profileId: 'p1', portalHost, loginUrl, launchBrowser,
    })
    expect(result).toMatchObject({
      ok: false,
      reason: 'ssrf_blocked',
      requires_human_handoff: false,
    })
    expect(launchBrowser).not.toHaveBeenCalled()
  })

  it('direct generic draft fill proceeds past the URL gate for a real public HTTPS portal', async () => {
    // runAutopilot with no real launchBrowser will fail at the browser-launch
    // step, but it must NOT fail at the URL gate.  Previously the result was
    // blocked with blocker_kind:'controlled_beta_manual_handoff'; now it should
    // fail with a different reason (no_browser / launch failure) proving the
    // URL gate no longer blocks real portals.
    const result = await runAutopilot({
      url: 'https://example.org/apply',
      profile: { id: 'p1', basic_information: { first_name: 'Demo' } },
      authorizations: { complete_forms: true, save_drafts: true, submit_applications: false },
    })
    expect(result.blocker_kind).not.toBe('controlled_beta_manual_handoff')
    expect(result.blocker_kind).not.toBe('reviewed_submission_adapter_required')
    // The URL gate was cleared — some other failure (no_browser, etc.) is fine.
    expect(result.pages_visited).toBe(0)
  })

  it('portal sync proceeds past the URL gate for a real public portal host', async () => {
    // With no db/session the sync will fail, but NOT at the controlled-beta URL gate.
    const result = await runPortalSync({}, {
      profileId: 'p1', portalHost: 'example.org', direction: 'read',
    })
    expect(result.ok).toBe(false)
    expect(result.error).not.toBe('controlled_beta_manual_handoff')
    expect(result.error).not.toBe('reviewed_submission_adapter_required')
  })

  it('portal sync still blocks SSRF hosts', async () => {
    const result = await runPortalSync({}, {
      profileId: 'p1', portalHost: '127.0.0.1', direction: 'read',
    })
    expect(result).toMatchObject({
      ok: false,
      error: 'ssrf_blocked',
      requires_human_handoff: false,
    })
  })
})

describe('synthetic fixture remains testable', () => {
  it('cloud login can launch only the reserved fixture with a guarded context', async () => {
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


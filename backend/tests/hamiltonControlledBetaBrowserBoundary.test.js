import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CONTROLLED_BETA_SYNTHETIC_BROWSER_HOST,
  CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN,
  installControlledBetaBrowserEgressGuard,
  isControlledBetaBrowserRequestAllowed,
  isControlledBetaSyntheticBrowserUrl,
  isHamiltonBrowserTargetAllowed,
  isPublicHttpsPortalUrl,
} from '../services/hamilton/controlledBetaBrowserPolicy.js'
import { launchPortalBrowser } from '../services/hamilton/browserLaunch.js'
import { browserAutomationPermittedForUrl } from '../services/hamilton/hamiltonAutomationOrchestrator.js'
import { runAutopilot } from '../services/hamilton/hamiltonAutopilotEngine.js'
import { cancelCloudLogin, startCloudLogin } from '../services/hamilton/hamiltonCloudLogin.js'

const saved = {}

beforeEach(() => {
  saved.browser = process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION
  saved.allowlist = process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST
  saved.cloud = process.env.HAMILTON_CLOUD_LOGIN_PROVIDER
  process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = 'true'
  process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = ''
  process.env.HAMILTON_CLOUD_LOGIN_PROVIDER = 'self_hosted'
})

afterEach(() => {
  process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = saved.browser
  process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = saved.allowlist
  process.env.HAMILTON_CLOUD_LOGIN_PROVIDER = saved.cloud
  vi.restoreAllMocks()
})

describe('public HTTPS + fixture target policy', () => {
  it('allows the reserved fixture and public HTTPS; refuses private/loopback', () => {
    expect(isControlledBetaSyntheticBrowserUrl(`${CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN}/apply?case=1`)).toBe(true)
    expect(isHamiltonBrowserTargetAllowed(`${CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN}/apply`)).toBe(true)
    expect(isPublicHttpsPortalUrl('https://example.org/apply')).toBe(true)
    expect(isHamiltonBrowserTargetAllowed('https://example.org/apply')).toBe(true)
    expect(browserAutomationPermittedForUrl('https://example.org/apply')).toBe(true)
    expect(browserAutomationPermittedForUrl(`${CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN}/apply`)).toBe(true)

    for (const target of [
      'http://127.0.0.1:3000/',
      'http://localhost:3000/',
      'http://10.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://192.168.1.10/',
      'https://127.0.0.1/',
      'https://10.0.0.1/',
    ]) {
      expect(isHamiltonBrowserTargetAllowed(target), target).toBe(false)
      expect(browserAutomationPermittedForUrl(target, {
        extraAllowedHosts: [(() => { try { return new URL(target).hostname } catch { return '' } })()],
      }), target).toBe(false)
    }
  })

  it('launches for public HTTPS and refuses private before Chromium launch', async () => {
    const chromiumOk = { launch: vi.fn(async () => ({ close: vi.fn() })) }
    await expect(launchPortalBrowser(chromiumOk, { targetUrl: 'https://example.org/apply' }))
      .resolves.toMatchObject({ engine: expect.any(String) })
    expect(chromiumOk.launch).toHaveBeenCalled()

    const chromiumBad = { launch: vi.fn() }
    await expect(launchPortalBrowser(chromiumBad, { targetUrl: 'http://127.0.0.1:3000/' }))
      .rejects.toMatchObject({ code: 'unsafe_browser_target' })
    expect(chromiumBad.launch).not.toHaveBeenCalled()
  })

  it('honors allowlist when set (host or extraAllowedHosts)', () => {
    process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = 'tn.gov'
    expect(browserAutomationPermittedForUrl('https://www.tn.gov/apply')).toBe(true)
    expect(browserAutomationPermittedForUrl('https://example.org/apply')).toBe(false)
    expect(browserAutomationPermittedForUrl('https://www.mtsu.edu/', {
      extraAllowedHosts: ['mtsu.edu'],
    })).toBe(true)
  })
})

describe('redirect and subresource egress guard', () => {
  it('continues fixture and public HTTPS; aborts private/loopback/metadata', async () => {
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

    for (const allowed of [
      `${CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN}/asset.js`,
      'https://example.org/redirected',
      'https://cdn.example.org/x.js',
    ]) {
      expect(isControlledBetaBrowserRequestAllowed(allowed), allowed).toBe(true)
      const route = await dispatch(allowed)
      expect(route.continue).toHaveBeenCalledOnce()
      expect(route.abort).not.toHaveBeenCalled()
    }

    for (const blocked of [
      'http://127.0.0.1/admin',
      'http://10.0.0.1/private',
      'http://169.254.169.254/latest/meta-data/',
    ]) {
      expect(isControlledBetaBrowserRequestAllowed(blocked)).toBe(false)
      const route = await dispatch(blocked)
      expect(route.continue).not.toHaveBeenCalled()
      expect(route.abort).toHaveBeenCalledWith('blockedbyclient')
    }
  })
})

describe('browser entry points refuse private only', () => {
  it.each([
    ['127.0.0.1', 'http://127.0.0.1:3000/login'],
    ['10.0.0.1', 'http://10.0.0.1/login'],
    ['169.254.169.254', 'http://169.254.169.254/latest/meta-data/'],
  ])('cloud login refuses private %s before the injected launcher runs', async (portalHost, loginUrl) => {
    const launchBrowser = vi.fn()
    const result = await startCloudLogin({
      userId: 'u1', profileId: 'p1', portalHost, loginUrl, launchBrowser,
    })
    expect(result).toMatchObject({
      ok: false,
      reason: 'controlled_beta_manual_handoff',
      requires_human_handoff: true,
    })
    expect(launchBrowser).not.toHaveBeenCalled()
  })

  it('autopilot refuses a private target before Playwright import/launch', async () => {
    const result = await runAutopilot({
      url: 'http://127.0.0.1:3000/apply',
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

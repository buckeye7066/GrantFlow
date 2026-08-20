import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CONTROLLED_BETA_SYNTHETIC_BROWSER_HOST,
  CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN,
  installControlledBetaBrowserEgressGuard,
  isHamiltonBrowserRequestAllowed,
  isHamiltonBrowserTargetAllowed,
  isPrivateOrLocalHostname,
  isPublicHttpsPortalUrl,
} from '../services/hamilton/controlledBetaBrowserPolicy.js'
import { launchPortalBrowser } from '../services/hamilton/browserLaunch.js'
import { browserAutomationPermittedForUrl } from '../services/hamilton/hamiltonAutomationOrchestrator.js'
import { runAutopilot } from '../services/hamilton/hamiltonAutopilotEngine.js'
import { cancelCloudLogin, startCloudLogin } from '../services/hamilton/hamiltonCloudLogin.js'
import { runPortalSync } from '../services/hamilton/portalSync/index.js'

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

describe('Hamilton browser target policy', () => {
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

  it('honors an optional host allowlist for public portals', () => {
    process.env.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST = 'mtsu.edu'
    expect(browserAutomationPermittedForUrl('https://www.mtsu.edu/aid')).toBe(true)
    expect(browserAutomationPermittedForUrl('https://example.org/apply')).toBe(false)
    expect(browserAutomationPermittedForUrl('https://example.org/apply', {
      extraAllowedHosts: ['example.org'],
    })).toBe(true)
  })

  it('rejects a private target before Chromium launch', async () => {
    const chromium = { launch: vi.fn() }
    await expect(launchPortalBrowser(chromium, { targetUrl: 'http://127.0.0.1/admin' }))
      .rejects.toMatchObject({ code: 'unsafe_browser_target' })
    expect(chromium.launch).not.toHaveBeenCalled()
  })

  it('allows a public HTTPS target through launchPortalBrowser', async () => {
    const browser = { close: vi.fn() }
    const chromium = { launch: vi.fn(async () => browser) }
    const result = await launchPortalBrowser(chromium, { targetUrl: 'https://example.org/apply' })
    expect(chromium.launch).toHaveBeenCalledOnce()
    expect(result.browser).toBe(browser)
  })
})

describe('egress guard', () => {
  it('continues public and fixture requests; aborts private targets', async () => {
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

    for (const okUrl of [
      `${CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN}/asset.js`,
      'https://example.org/apply',
      'https://cdn.example.org/form.js',
    ]) {
      expect(isHamiltonBrowserRequestAllowed(okUrl)).toBe(true)
      const route = await dispatch(okUrl)
      expect(route.continue).toHaveBeenCalledOnce()
      expect(route.abort).not.toHaveBeenCalled()
    }

    for (const bad of [
      'http://127.0.0.1/admin',
      'http://10.0.0.1/private',
      'http://169.254.169.254/latest/meta-data/',
    ]) {
      expect(isHamiltonBrowserRequestAllowed(bad)).toBe(false)
      const route = await dispatch(bad)
      expect(route.continue).not.toHaveBeenCalled()
      expect(route.abort).toHaveBeenCalledWith('blockedbyclient')
    }
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

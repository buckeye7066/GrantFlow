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
import { cancelCloudLogin, startCloudLogin } from '../services/hamilton/hamiltonCloudLogin.js'
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

describe('controlled-beta target predicate', () => {
  it('allows only the exact reserved HTTPS fixture origin', () => {
    expect(isControlledBetaSyntheticBrowserUrl(`${CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN}/apply?case=1`)).toBe(true)
    for (const target of [
      'https://example.org/apply',
      'http://127.0.0.1:3000/',
      'http://localhost:3000/',
      'http://10.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://192.168.1.10/',
      `http://${CONTROLLED_BETA_SYNTHETIC_BROWSER_HOST}/`,
      `https://sub.${CONTROLLED_BETA_SYNTHETIC_BROWSER_HOST}/`,
      `https://${CONTROLLED_BETA_SYNTHETIC_BROWSER_HOST}:8443/`,
    ]) {
      expect(isControlledBetaSyntheticBrowserUrl(target), target).toBe(false)
      expect(browserAutomationPermittedForUrl(target, {
        extraAllowedHosts: [new URL(target).hostname],
      }), target).toBe(false)
    }
  })

  it('rejects a real target before Chromium launch, regardless of env allowlist', async () => {
    const chromium = { launch: vi.fn() }
    await expect(launchPortalBrowser(chromium, { targetUrl: 'https://example.org/apply' }))
      .rejects.toMatchObject({ code: 'controlled_beta_manual_handoff' })
    expect(chromium.launch).not.toHaveBeenCalled()
  })
})

describe('redirect and subresource egress guard', () => {
  it('continues fixture requests and aborts real, loopback, private, and redirect targets', async () => {
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

    const fixture = await dispatch(`${CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN}/asset.js`)
    expect(fixture.continue).toHaveBeenCalledOnce()
    expect(fixture.abort).not.toHaveBeenCalled()

    for (const redirectTarget of [
      'https://example.org/redirected',
      'http://127.0.0.1/admin',
      'http://10.0.0.1/private',
      'http://169.254.169.254/latest/meta-data/',
    ]) {
      expect(isControlledBetaBrowserRequestAllowed(redirectTarget)).toBe(false)
      const route = await dispatch(redirectTarget)
      expect(route.continue).not.toHaveBeenCalled()
      expect(route.abort).toHaveBeenCalledWith('blockedbyclient')
    }
  })
})

describe('browser entry points fail closed before launch', () => {
  it.each([
    ['example.org', 'https://example.org/login'],
    ['127.0.0.1', 'http://127.0.0.1:3000/login'],
    ['10.0.0.1', 'http://10.0.0.1/login'],
    ['169.254.169.254', 'http://169.254.169.254/latest/meta-data/'],
  ])('cloud login refuses %s before the injected launcher runs', async (portalHost, loginUrl) => {
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

  it('direct generic draft fill refuses a real target before Playwright import/launch', async () => {
    const result = await runAutopilot({
      url: 'https://example.org/apply',
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

  it('portal sync refuses a real target before connector or browser work', async () => {
    const result = await runPortalSync({}, {
      profileId: 'p1', portalHost: 'example.org', direction: 'read',
    })
    expect(result).toMatchObject({
      ok: false,
      error: 'controlled_beta_manual_handoff',
      requires_human_handoff: true,
      runId: null,
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import dns from 'node:dns'

import {
  CONTROLLED_BETA_SYNTHETIC_BROWSER_HOST,
  CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN,
  installControlledBetaBrowserEgressGuard,
  installPortalBrowserEgressGuard,
  isControlledBetaBrowserRequestAllowed,
  isControlledBetaSyntheticBrowserUrl,
  isPublicHttpsPortalUrl,
  isPortalBrowserRequestAllowed,
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

describe('controlled-beta target predicate (fixture-only)', () => {
  it('isControlledBetaSyntheticBrowserUrl accepts only the exact reserved HTTPS fixture origin', () => {
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
    }
  })
})

describe('real public-portal URL safety gate (isPublicHttpsPortalUrl)', () => {
  it('accepts public HTTPS portal URLs', () => {
    for (const url of [
      'https://example.org/apply',
      'https://scholarships.com/apply',
      'https://tsac.tn.gov/apply',
      'https://www.mtsu.edu/financial-aid/',
    ]) {
      expect(isPublicHttpsPortalUrl(url), url).toBe(true)
    }
  })

  it('rejects HTTP (not HTTPS), private IPs, loopback, metadata, and .invalid TLD', () => {
    for (const url of [
      'http://example.org/',         // not HTTPS
      'https://127.0.0.1/',          // loopback
      'https://10.0.0.1/',           // private
      'https://192.168.1.1/',        // private
      'https://169.254.169.254/',    // metadata
      'https://localhost/',          // loopback name
      `https://${CONTROLLED_BETA_SYNTHETIC_BROWSER_HOST}/`, // .invalid fixture
      'ftp://example.org/',
      '',
    ]) {
      expect(isPublicHttpsPortalUrl(url), url).toBe(false)
    }
  })
})

describe('browserAutomationPermittedForUrl', () => {
  it('permits the synthetic fixture and real public HTTPS portals when automation is enabled', () => {
    expect(browserAutomationPermittedForUrl(`${CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN}/apply`)).toBe(true)
    expect(browserAutomationPermittedForUrl('https://example.org/apply')).toBe(true)
    expect(browserAutomationPermittedForUrl('https://scholarships.com/')).toBe(true)
  })

  it('refuses private/loopback/metadata IPs and non-HTTPS even when automation is enabled', () => {
    for (const url of [
      'http://127.0.0.1:3000/',
      'http://10.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://example.org/', // HTTP not allowed
    ]) {
      expect(browserAutomationPermittedForUrl(url), url).toBe(false)
    }
  })

  it('refuses everything when automation is globally disabled', () => {
    process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = 'false'
    expect(browserAutomationPermittedForUrl(`${CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN}/apply`)).toBe(false)
    expect(browserAutomationPermittedForUrl('https://example.org/apply')).toBe(false)
  })
})

describe('synthetic fixture egress guard (installControlledBetaBrowserEgressGuard)', () => {
  it('continues fixture requests and aborts ALL non-fixture requests (including public portals)', async () => {
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

    // The controlled-beta fixture guard still aborts real URLs (including public portals).
    // Real portal contexts use installPortalBrowserEgressGuard instead.
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

describe('real-portal egress guard (installPortalBrowserEgressGuard)', () => {
  it('aborts a public-looking hostname when DNS resolves it to private space', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    let handler = null
    await installPortalBrowserEgressGuard({ route: async (_pattern, callback) => { handler = callback } })
    const route = {
      request: () => ({ url: () => 'https://attacker.example/internal' }),
      continue: vi.fn(), abort: vi.fn(),
    }
    await handler(route)
    expect(route.continue).not.toHaveBeenCalled()
    expect(route.abort).toHaveBeenCalledWith('blockedbyclient')
  })

  it('continues public HTTPS/HTTP requests and aborts private/loopback/metadata IPs', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    let handler = null
    const context = {
      route: vi.fn(async (_pattern, callback) => { handler = callback }),
    }
    await installPortalBrowserEgressGuard(context)
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

    for (const allowedUrl of [
      'https://example.org/asset.js',
      'https://scholarships.com/',
      'http://example.org/asset.js', // CDN assets over HTTP
      'about:blank',
      'data:text/html,x',
    ]) {
      const route = await dispatch(allowedUrl)
      expect(route.continue, `should continue ${allowedUrl}`).toHaveBeenCalledOnce()
      expect(route.abort, `should NOT abort ${allowedUrl}`).not.toHaveBeenCalled()
    }

    for (const blockedUrl of [
      'https://127.0.0.1/admin',
      'https://10.0.0.1/private',
      'http://169.254.169.254/latest/meta-data/',
    ]) {
      expect(isPortalBrowserRequestAllowed(blockedUrl), blockedUrl).toBe(false)
      const route = await dispatch(blockedUrl)
      expect(route.continue, `should NOT continue ${blockedUrl}`).not.toHaveBeenCalled()
      expect(route.abort, `should abort ${blockedUrl}`).toHaveBeenCalledWith('blockedbyclient')
    }
  })
})

describe('launchPortalBrowser — real portals allowed, unsafe URLs rejected', () => {
  it('allows a public HTTPS portal URL (proceeds to Chromium launch attempt)', async () => {
    const browser = {}
    const chromium = { launch: vi.fn(async () => browser) }
    // Should NOT throw; public HTTPS portals are permitted.
    const result = await launchPortalBrowser(chromium, { targetUrl: 'https://example.org/apply' })
    expect(chromium.launch).toHaveBeenCalledOnce()
    expect(result.browser).toBe(browser)
  })

  it('rejects private/loopback/metadata targets before Chromium launch', async () => {
    const chromium = { launch: vi.fn() }
    for (const badUrl of [
      'https://127.0.0.1/apply',
      'http://10.0.0.1/apply',
      'https://169.254.169.254/',
      'http://localhost/',
    ]) {
      await expect(launchPortalBrowser(chromium, { targetUrl: badUrl }), badUrl)
        .rejects.toMatchObject({ code: 'unsafe_portal_url' })
    }
    expect(chromium.launch).not.toHaveBeenCalled()
  })
})

describe('browser entry points accept public HTTPS portals, block private IPs', () => {
  it('cloud login accepts a DNS-safe real portal and its real post-navigation URL', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    const page = {
      goto: vi.fn(async () => {}), url: () => 'https://example.org/login',
      viewportSize: () => ({ width: 1280, height: 900 }),
    }
    const context = {
      route: vi.fn(async () => {}), newPage: vi.fn(async () => page),
      storageState: vi.fn(async () => ({ cookies: [], origins: [] })),
    }
    page.context = () => context
    const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => {}) }
    const result = await startCloudLogin({
      userId: 'u1', profileId: 'p1', portalHost: 'example.org',
      loginUrl: 'https://example.org/login',
      launchBrowser: vi.fn(async () => ({ browser, engine: 'test' })),
    })
    expect(result).toMatchObject({ ok: true, portalHost: 'example.org' })
    cancelCloudLogin(result.liveSessionId)
  })

  it.each([
    ['127.0.0.1', 'https://127.0.0.1/login'],
    ['10.0.0.1', 'https://10.0.0.1/login'],
    ['169.254.169.254', 'https://169.254.169.254/latest/meta-data/'],
  ])('cloud login refuses unsafe host %s before the injected launcher runs', async (portalHost, loginUrl) => {
    const launchBrowser = vi.fn()
    const result = await startCloudLogin({
      userId: 'u1', profileId: 'p1', portalHost, loginUrl, launchBrowser,
    })
    expect(result).toMatchObject({
      ok: false,
      reason: 'unsafe_portal_url',
      requires_human_handoff: true,
    })
    expect(launchBrowser).not.toHaveBeenCalled()
  })

  it('direct generic draft fill proceeds past safety check for a public HTTPS portal (blocked only by missing Playwright binary)', async () => {
    const result = await runAutopilot({
      url: 'https://example.org/apply',
      profile: { id: 'p1', basic_information: { first_name: 'Demo' } },
      authorizations: { complete_forms: true, save_drafts: true, submit_applications: false },
    })
    // The run proceeds to Playwright import; it fails with no_browser (no
    // Playwright binary in test env), NOT with controlled_beta_manual_handoff.
    expect(result.status).not.toBe('controlled_beta_manual_handoff')
    expect(result.blocker_kind).not.toBe('controlled_beta_manual_handoff')
    // It fails with no_browser or cancelled, not a safety refusal.
    expect(['failed', 'no_browser', 'cancelled']).toContain(result.status)
  })

  it('direct generic draft fill refuses a private IP target before Playwright import/launch', async () => {
    const result = await runAutopilot({
      url: 'https://127.0.0.1/apply',
      profile: { id: 'p1', basic_information: { first_name: 'Demo' } },
      authorizations: { complete_forms: true, save_drafts: true, submit_applications: false },
    })
    expect(result).toMatchObject({
      status: 'blocked',
      blocker_kind: 'unsafe_portal_url',
      requires_human_handoff: true,
      pages_visited: 0,
    })
  })

  it('portal sync proceeds for a public HTTPS portal (blocked only by no Playwright binary)', async () => {
    const result = await runPortalSync({}, {
      profileId: 'p1', portalHost: 'example.org', direction: 'read',
    })
    // Should NOT be blocked by controlled_beta_manual_handoff.
    expect(result.error).not.toBe('controlled_beta_manual_handoff')
    expect(result.error).not.toBe('reviewed_submission_adapter_required')
  })

  it('portal sync refuses a private/loopback target before connector or browser work', async () => {
    const result = await runPortalSync({}, {
      profileId: 'p1', portalHost: '127.0.0.1', direction: 'read',
    })
    expect(result).toMatchObject({
      ok: false,
      error: 'unsafe_portal_url',
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

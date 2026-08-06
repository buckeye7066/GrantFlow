import { describe, expect, it, vi } from 'vitest'

import {
  hamiltonBrowserActionAllowed,
  hamiltonBrowserNavigationAllowed,
  hamiltonBrowserUrlAllowed,
  installHamiltonBrowserNetworkGuard,
  prepareHamiltonBrowserEgress,
  runHamiltonPageAction,
} from '../services/hamilton/hamiltonBrowserNetworkGuard.js'

const ADAPTER = Object.freeze({
  portal_host: 'portal.public.test',
  allowed_origins: ['https://portal.public.test'],
  allowed_path_prefixes: ['/apply', '/confirmation'],
  auth_path_prefixes: ['/login'],
  status_query: { path_prefix: '/status' },
})

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }]
const safeCheck = async () => ({ ok: true })

describe('Hamilton browser SSRF and origin confinement', () => {
  it.each([
    'https://127.0.0.1/apply',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/apply',
  ])('rejects private/metadata target %s before browser launch', async (targetUrl) => {
    await expect(prepareHamiltonBrowserEgress({ targetUrl }))
      .rejects.toThrow(/browser_ssrf_blocked|browser_dns_private_address/)
  })

  it('rejects a hostname whose resolved address is private and never emits a resolver rule', async () => {
    await expect(prepareHamiltonBrowserEgress({
      targetUrl: 'https://portal.public.test/apply',
      submissionAdapter: ADAPTER,
      ssrfCheck: safeCheck,
      lookup: async () => [{ address: '10.20.30.40', family: 4 }],
    })).rejects.toThrow('browser_dns_private_address')
  })

  it('pins the reviewed exact host and blocks a public-to-private/cross-origin redirect request', async () => {
    const egress = await prepareHamiltonBrowserEgress({
      targetUrl: 'https://portal.public.test/apply?applicationId=opaque',
      submissionAdapter: ADAPTER,
      ssrfCheck: safeCheck,
      lookup: publicLookup,
    })
    expect(egress.extra_args[0]).toContain('MAP portal.public.test 93.184.216.34')
    expect(egress.extra_args[0]).toContain('MAP * ~NOTFOUND')
    expect(hamiltonBrowserUrlAllowed(egress, 'https://portal.public.test/apply')).toBe(true)
    expect(hamiltonBrowserNavigationAllowed(egress, 'https://portal.public.test/apply/round-1')).toBe(true)
    expect(hamiltonBrowserNavigationAllowed(egress, 'https://portal.public.test/apply-evil')).toBe(false)
    expect(hamiltonBrowserNavigationAllowed(egress, 'https://portal.public.test/account')).toBe(false)
    expect(hamiltonBrowserActionAllowed(egress, 'https://portal.public.test/login', 'credential')).toBe(true)
    expect(hamiltonBrowserActionAllowed(egress, 'https://portal.public.test/apply', 'credential')).toBe(false)
    expect(hamiltonBrowserActionAllowed(egress, 'https://portal.public.test/apply', 'application')).toBe(true)
    expect(hamiltonBrowserActionAllowed(egress, 'https://portal.public.test/login', 'application')).toBe(false)
    expect(hamiltonBrowserUrlAllowed(egress, 'https://attacker.example/apply')).toBe(false)
    expect(hamiltonBrowserUrlAllowed(egress, 'https://10.0.0.8/admin')).toBe(false)

    let handler
    let websocketHandler
    const context = {
      route: vi.fn(async (_glob, fn) => { handler = fn }),
      routeWebSocket: vi.fn(async (_glob, fn) => { websocketHandler = fn }),
    }
    await installHamiltonBrowserNetworkGuard(context, egress)
    const continued = vi.fn()
    const aborted = vi.fn()
    await handler({
      request: () => ({
        url: () => 'https://portal.public.test/apply',
        isNavigationRequest: () => true,
      }),
      continue: continued,
      abort: aborted,
    })
    expect(continued).toHaveBeenCalledTimes(1)

    await handler({
      request: () => ({
        url: () => 'https://portal.public.test/unreviewed-login',
        isNavigationRequest: () => true,
      }),
      continue: continued,
      abort: aborted,
    })
    expect(aborted).toHaveBeenCalledTimes(1)
    expect(continued).toHaveBeenCalledTimes(1)

    await handler({
      request: () => ({
        url: () => 'https://169.254.169.254/latest/meta-data',
        isNavigationRequest: () => false,
      }),
      continue: continued,
      abort: aborted,
    })
    expect(aborted).toHaveBeenCalledTimes(2)
    expect(continued).toHaveBeenCalledTimes(1)

    const socketClosed = vi.fn(async () => {})
    const socketConnected = vi.fn()
    await websocketHandler({
      url: () => 'wss://169.254.169.254/private',
      close: socketClosed,
      connectToServer: socketConnected,
    })
    expect(socketClosed).toHaveBeenCalledTimes(1)
    expect(socketConnected).not.toHaveBeenCalled()
    await websocketHandler({
      url: () => 'wss://portal.public.test/live',
      close: socketClosed,
      connectToServer: socketConnected,
    })
    expect(socketConnected).toHaveBeenCalledTimes(1)
  })

  it('rejects a reviewed adapter target on an attacker host even when path and selectors match', async () => {
    await expect(prepareHamiltonBrowserEgress({
      targetUrl: 'https://attacker.example/apply',
      submissionAdapter: ADAPTER,
      ssrfCheck: safeCheck,
      lookup: publicLookup,
    })).rejects.toThrow('reviewed_adapter_origin_mismatch')
  })

  it('treats an unreviewed root target as exact root, never a same-origin wildcard', async () => {
    const egress = await prepareHamiltonBrowserEgress({
      targetUrl: 'https://portal.public.test/',
      ssrfCheck: safeCheck,
      lookup: publicLookup,
    })
    expect(hamiltonBrowserNavigationAllowed(egress, 'https://portal.public.test/')).toBe(true)
    expect(hamiltonBrowserNavigationAllowed(egress, 'https://portal.public.test/login')).toBe(false)
    expect(hamiltonBrowserActionAllowed(egress, 'https://portal.public.test/', 'human_input')).toBe(true)
    expect(hamiltonBrowserActionAllowed(egress, 'https://portal.public.test/other', 'human_input')).toBe(false)
  })

  it('can extend read-only probe navigation without granting any mutation on that path', async () => {
    const egress = await prepareHamiltonBrowserEgress({
      targetUrl: 'https://portal.public.test/account/status',
      additionalNavigationPathPrefixes: ['/login'],
      ssrfCheck: safeCheck,
      lookup: publicLookup,
    })
    expect(hamiltonBrowserNavigationAllowed(egress, 'https://portal.public.test/login')).toBe(true)
    expect(hamiltonBrowserNavigationAllowed(egress, 'https://portal.public.test/login/continue')).toBe(true)
    expect(hamiltonBrowserNavigationAllowed(egress, 'https://portal.public.test/login-evil')).toBe(false)
    expect(hamiltonBrowserActionAllowed(egress, 'https://portal.public.test/login', 'credential')).toBe(false)
    expect(hamiltonBrowserActionAllowed(egress, 'https://portal.public.test/login', 'application')).toBe(false)
    expect(hamiltonBrowserActionAllowed(egress, 'https://portal.public.test/login', 'human_input')).toBe(false)
  })

  it('executes zero sensitive operations on same-origin unreviewed paths', async () => {
    const egress = await prepareHamiltonBrowserEgress({
      targetUrl: 'https://portal.public.test/apply/APP-1',
      submissionAdapter: ADAPTER,
      ssrfCheck: safeCheck,
      lookup: publicLookup,
    })
    const credentialMutation = vi.fn()
    const profileMutation = vi.fn()
    await expect(runHamiltonPageAction(
      { url: () => 'https://portal.public.test/unreviewed-login' },
      egress, 'credential', credentialMutation,
    )).rejects.toThrow('browser_live_credential_path_not_allowed')
    await expect(runHamiltonPageAction(
      { url: () => 'https://portal.public.test/account/profile' },
      egress, 'application', profileMutation,
    )).rejects.toThrow('browser_live_application_path_not_allowed')
    expect(credentialMutation).not.toHaveBeenCalled()
    expect(profileMutation).not.toHaveBeenCalled()

    const reviewedLogin = vi.fn(async () => 'login-ok')
    const reviewedFill = vi.fn(async () => 'fill-ok')
    await expect(runHamiltonPageAction(
      { url: () => 'https://portal.public.test/login' },
      egress, 'credential', reviewedLogin,
    )).resolves.toBe('login-ok')
    await expect(runHamiltonPageAction(
      { url: () => 'https://portal.public.test/apply/APP-1' },
      egress, 'application', reviewedFill,
    )).resolves.toBe('fill-ok')
  })
})

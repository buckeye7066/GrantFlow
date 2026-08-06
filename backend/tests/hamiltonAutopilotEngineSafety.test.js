import { describe, expect, it, vi } from 'vitest'

import {
  runAutopilot,
  sanitizeListingSnapshotForPersistence,
  _internal,
} from '../services/hamilton/hamiltonAutopilotEngine.js'

const SECRET_CANARIES = Object.freeze({
  email: 'sentinel.owner+hamilton@example.test',
  phone: '+1-615-555-0199',
  address: '8742 Sentinel Recovery Lane',
  income: '987654.32',
  essay: 'SENTINEL-ESSAY-DO-NOT-PERSIST',
  password: 'SENTINEL-PASSWORD-DO-NOT-PERSIST',
  otp: '481902',
  pathToken: 'PATH-BEARER-9acff1',
  queryToken: 'QUERY-BEARER-147a8e',
})

function serialized(value) {
  return JSON.stringify(value)
}

describe('Hamilton engine redaction and evidence clock boundary', () => {
  const testEgress = {
    target_origin: 'https://portal.example.test',
    allowed_origins: ['https://portal.example.test'],
    pinned_hosts: { 'portal.example.test': '203.0.113.10' },
    path_contract: { navigation: ['/apply'], application: ['/apply'], authentication: [], status: ['/apply'], interactive: [] },
    extra_args: [],
    context_options: {},
  }

  it('constructs a redaction-safe trace on a direct run before any browser launch', async () => {
    const beforeExternalAction = vi.fn(async () => {
      throw new Error(`guard refused ${SECRET_CANARIES.password}`)
    })
    const result = await runAutopilot({
      url: `https://portal.example.test/resume/${SECRET_CANARIES.pathToken}?token=${SECRET_CANARIES.queryToken}`,
      profile: {
        basic_information: {
          email: SECRET_CANARIES.email,
          phone: SECRET_CANARIES.phone,
          address1: SECRET_CANARIES.address,
        },
        financial_information: { household_income: SECRET_CANARIES.income },
        essays: { primary: SECRET_CANARIES.essay },
      },
      authorizations: { complete_forms: true },
      beforeExternalAction,
    })

    expect(result.status).toBe('blocked')
    expect(Array.isArray(result.trace)).toBe(true)
    const output = serialized(result)
    for (const canary of Object.values(SECRET_CANARIES)) expect(output).not.toContain(canary)
  })

  it('stores only typed fields, hashes, and an origin for trace URLs', () => {
    const trace = _internal.createRedactionSafeTrace()
    trace.push({
      step: 'filled',
      detail: {
        email: SECRET_CANARIES.email,
        phone: SECRET_CANARIES.phone,
        address: SECRET_CANARIES.address,
        income: SECRET_CANARIES.income,
        essay: SECRET_CANARIES.essay,
        password: SECRET_CANARIES.password,
        otp: SECRET_CANARIES.otp,
        url: `https://portal.example.test/resume/${SECRET_CANARIES.pathToken}?token=${SECRET_CANARIES.queryToken}#secret`,
      },
    })
    const output = serialized(trace)
    expect(output).toContain('https://portal.example.test/')
    for (const canary of Object.values(SECRET_CANARIES)) expect(output).not.toContain(canary)
  })

  it('reduces authenticated listing snapshots to hashes and counts before persistence', () => {
    const safe = sanitizeListingSnapshotForPersistence({
      url: `https://portal.example.test/resume/${SECRET_CANARIES.pathToken}?token=${SECRET_CANARIES.queryToken}`,
      title: `Account for ${SECRET_CANARIES.email}`,
      text: `${SECRET_CANARIES.income} ${SECRET_CANARIES.essay}`,
      links: [{
        href: `https://portal.example.test/apply?code=${SECRET_CANARIES.otp}`,
        text: SECRET_CANARIES.address,
      }],
      fieldCount: 3,
    })
    expect(safe).toMatchObject({
      portal_origin: 'https://portal.example.test',
      field_count: 3,
      link_count: 1,
      content_retained: false,
    })
    expect(safe.text_sha256).toMatch(/^[a-f0-9]{64}$/)
    const output = serialized(safe)
    for (const canary of Object.values(SECRET_CANARIES)) expect(output).not.toContain(canary)
  })

  it.each([
    ['missing Playwright import', { playwrightUnavailable: true }],
    ['missing Chromium binary', { chromium: { executablePath: () => '/missing/chromium' }, executableExists: () => false }],
    ['browser context setup failure', {
      chromium: { executablePath: () => '/synthetic/chromium' },
      executableExists: () => true,
      launchGuardedPortalBrowser: async () => { throw new Error('synthetic launch failure') },
    }],
  ])('keeps a pre-dispatch attempt retryable on %s', async (_label, runtime) => {
    const result = await runAutopilot({
      url: 'https://portal.example.test/apply',
      profile: { basic_information: { first_name: 'Ada' } },
      authorizations: { complete_forms: true },
      beforeExternalAction: async () => ({}),
      _testRuntime: {
        prepareBrowserEgress: async () => testEgress,
        ...runtime,
      },
    })
    expect(result).toMatchObject({
      status: 'human_action_required',
      pages_visited: 0,
    })
    expect(['no_browser', 'browser_setup_failed']).toContain(result.blocker_kind)
    expect(result.blocker_detail).toMatch(/retryable|no portal dispatch/i)
  })

  it('never interprets a caller-supplied storage-state filesystem path', async () => {
    const beforeExternalAction = vi.fn(async () => ({}))
    const result = await runAutopilot({
      url: 'https://portal.example.test/apply',
      profile: { basic_information: { first_name: 'Ada' } },
      authorizations: { complete_forms: true, use_saved_session: true },
      // This existing repository path would have passed the former existsSync
      // branch. It is intentionally an unknown option now and must be ignored.
      storageStatePath: 'backend/tests/hamiltonAutopilotEngineSafety.test.js',
      beforeExternalAction,
      _testRuntime: {
        prepareBrowserEgress: async () => testEgress,
        playwrightUnavailable: true,
      },
    })
    expect(result).toMatchObject({ status: 'human_action_required', blocker_kind: 'no_browser' })
    expect(beforeExternalAction).toHaveBeenCalledTimes(1)
    expect(beforeExternalAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'browser_launch' }))
    expect(beforeExternalAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'use_saved_session' }))
  })

  it('never manufactures a post-dispatch timestamp when the observation clock is earlier', async () => {
    const page = {
      url: () => `https://portal.example.test/receipt/${SECRET_CANARIES.pathToken}?code=${SECRET_CANARIES.queryToken}`,
      locator: () => ({
        innerText: async () => `Your application has been received. Confirmation: RCPT-123456 ${SECRET_CANARIES.email}`,
      }),
    }
    const observation = await _internal.captureConfirmation(page, null, {
      afterTimestamp: '2026-08-05T19:00:01.000Z',
      now: new Date('2026-08-05T19:00:00.000Z'),
    })
    expect(observation.captured_at).toBe('2026-08-05T19:00:00.000Z')
    expect(observation.evidence_clock_valid).toBe(false)
    expect(observation.url).toBe('https://portal.example.test/')
    expect(serialized(observation)).not.toContain(SECRET_CANARIES.email)
    expect(serialized(observation)).not.toContain(SECRET_CANARIES.pathToken)
    expect(serialized(observation)).not.toContain(SECRET_CANARIES.queryToken)
  })
})

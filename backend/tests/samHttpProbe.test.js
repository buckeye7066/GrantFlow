import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { __testing__ } from '../routes/sam.js'

const { buildHttpProbe } = __testing__

describe('Sam buildHttpProbe presents admin credentials (no more 401 on internal probes)', () => {
  const realFetch = global.fetch
  const hadToken = Object.prototype.hasOwnProperty.call(process.env, 'ADMIN_TOKEN')
  const realToken = process.env.ADMIN_TOKEN

  beforeEach(() => { process.env.ADMIN_TOKEN = 'svc-token-123' })
  afterEach(() => {
    global.fetch = realFetch
    if (hadToken) process.env.ADMIN_TOKEN = realToken
    else delete process.env.ADMIN_TOKEN
  })

  it('sends X-Admin-Token (service token) and forwards the caller Authorization to protected endpoints', async () => {
    const calls = []
    global.fetch = vi.fn(async (url, opts) => {
      calls.push({ url, opts })
      return { status: 200, json: async () => ({ ok: true }), text: async () => 'ok' }
    })

    const req = {
      headers: { authorization: 'Bearer caller-admin-jwt', 'x-sam-internal-host': 'http://127.0.0.1:9999' },
    }
    const probe = buildHttpProbe(req)
    const result = await probe({ method: 'GET', path: '/api/admin/agent-control/status' })

    expect(result.status).toBe(200)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    const { url, opts } = calls[0]
    expect(url).toBe('http://127.0.0.1:9999/api/admin/agent-control/status')
    expect(opts.headers['x-admin-token']).toBe('svc-token-123')   // trusted service identity
    expect(opts.headers.authorization).toBe('Bearer caller-admin-jwt') // forwarded admin
    expect(opts.headers['x-sam-internal']).toBe('true')
  })

  it('works for every Hamilton/admin probe path the re-audit flagged', async () => {
    global.fetch = vi.fn(async () => ({ status: 200, json: async () => ({ ok: true }), text: async () => 'ok' }))
    const probe = buildHttpProbe({ headers: {} })
    const paths = [
      '/api/admin/agent-control/status',
      '/api/admin/agent-telemetry/hamilton',
      '/api/hamilton/automation/tasks',
      '/api/hamilton/automation/portal-policies',
      '/api/hamilton/automation/payment-authorizations',
      '/api/hamilton/automation/admin/hard-stops',
      '/api/hamilton/automation/admin/tasks',
    ]
    for (const p of paths) {
      const r = await probe({ method: 'GET', path: p })
      expect(r.status).toBe(200)
    }
    // Service token attached on every call even without a forwarded Authorization.
    for (const call of global.fetch.mock.calls) {
      expect(call[1].headers['x-admin-token']).toBe('svc-token-123')
    }
  })

  it('returns a structured { status: 0 } on a network failure instead of throwing', async () => {
    global.fetch = vi.fn(async () => { throw new Error('connect ECONNREFUSED') })
    const probe = buildHttpProbe({ headers: {} })
    const r = await probe({ method: 'GET', path: '/api/admin/agent-control/status' })
    expect(r.status).toBe(0)
  })
})

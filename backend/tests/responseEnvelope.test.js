import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

import { responseEnvelope } from '../utils/responseEnvelope.js'

function appWith(routeSetup) {
  const app = express()
  app.use((req, _res, next) => {
    req.requestId = 'test-req-id'
    next()
  })
  app.use(responseEnvelope)
  routeSetup(app)
  return app
}

describe('responseEnvelope middleware', () => {
  it('wraps JSON error objects (>=400) with ok:false + request_id', async () => {
    const app = appWith((a) =>
      a.get('/err', (_req, res) => res.status(404).json({ error: 'nope' })),
    )
    const res = await request(app).get('/err')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ ok: false, error: 'nope', request_id: 'test-req-id' })
  })

  it('leaves successful (<400) responses untouched', async () => {
    const app = appWith((a) =>
      a.get('/ok', (_req, res) => res.json({ data: 1 })),
    )
    const res = await request(app).get('/ok')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data: 1 })
  })

  it('does not clobber an error body that already declares ok', async () => {
    const app = appWith((a) =>
      a.get('/err2', (_req, res) => res.status(400).json({ ok: true, warning: 'soft' })),
    )
    const res = await request(app).get('/err2')
    expect(res.body).toEqual({ ok: true, warning: 'soft', request_id: 'test-req-id' })
  })

  it('passes non-object bodies through unchanged', async () => {
    const app = appWith((a) =>
      a.get('/arr', (_req, res) => res.status(400).json([1, 2, 3])),
    )
    const res = await request(app).get('/arr')
    expect(res.body).toEqual([1, 2, 3])
  })

  it('double res.json() after the response is sent is a logged no-op, not a throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const app = appWith((a) =>
      a.get('/double', (_req, res) => {
        res.json({ first: true })
        // Simulates the real-world bug: a second send (e.g. from a catch block
        // after a success already flushed). Must NOT throw "Cannot set headers".
        expect(() => res.json({ second: true })).not.toThrow()
      }),
    )
    const res = await request(app).get('/double')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ first: true })
    expect(warn).toHaveBeenCalledWith(
      '[envelope] res.json() called after response already sent',
      expect.objectContaining({ method: 'GET', requestId: 'test-req-id' }),
    )
    warn.mockRestore()
  })
})

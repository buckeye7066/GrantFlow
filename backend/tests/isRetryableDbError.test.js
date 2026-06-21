import { describe, it, expect, vi } from 'vitest'
import { isRetryableDbError, errorHandler } from '../middleware/errorHandler.js'

// Minimal Express res double.
function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
  }
}

describe('isRetryableDbError', () => {
  it('treats Postgres statement_timeout (57014) as retryable', () => {
    expect(isRetryableDbError({ code: '57014', message: 'canceling statement due to statement timeout' })).toBe(true)
  })

  it('treats too_many_connections (53300) as retryable', () => {
    expect(isRetryableDbError({ code: '53300' })).toBe(true)
  })

  it('treats connection-exception class (08xxx) as retryable', () => {
    expect(isRetryableDbError({ code: '08006' })).toBe(true)
    expect(isRetryableDbError({ code: '08003' })).toBe(true)
  })

  it('treats pg pool acquire timeout (no SQLSTATE) as retryable via message', () => {
    expect(isRetryableDbError(new Error('timeout exceeded when trying to connect'))).toBe(true)
    expect(isRetryableDbError(new Error('Connection terminated due to connection timeout'))).toBe(true)
  })

  it('does NOT flag genuine programming errors as retryable', () => {
    expect(isRetryableDbError(new TypeError("Cannot read properties of undefined (reading 'state')"))).toBe(false)
    expect(isRetryableDbError({ code: '42703', message: 'column "foo" does not exist' })).toBe(false)
    expect(isRetryableDbError({ code: '23505', message: 'duplicate key' })).toBe(false)
  })

  it('is null-safe', () => {
    expect(isRetryableDbError(null)).toBe(false)
    expect(isRetryableDbError(undefined)).toBe(false)
  })
})

describe('errorHandler choke point — retryable DB contention -> 503', () => {
  it('maps a statement_timeout to a retryable 503 catalog_busy envelope', () => {
    const res = mockRes()
    const req = { path: '/api/matching/profile/x/opportunities', method: 'GET', requestId: 'req-1' }
    errorHandler({ code: '57014', message: 'canceling statement due to statement timeout' }, req, res, vi.fn())
    expect(res.statusCode).toBe(503)
    expect(res.body.error).toBe('catalog_busy')
    expect(res.body.retryable).toBe(true)
    expect(res.body.ok).toBe(false)
    expect(res.body.request_id).toBe('req-1')
  })

  it('still maps genuine faults to 500 (not 503)', () => {
    const res = mockRes()
    const req = { path: '/api/matching/profile/x/opportunities', method: 'GET' }
    errorHandler(new TypeError("Cannot read properties of undefined (reading 'state')"), req, res, vi.fn())
    expect(res.statusCode).toBe(500)
    expect(res.body.ok).toBe(false)
    expect(res.body.error).not.toBe('catalog_busy')
  })

  it('honors an explicit statusCode for non-DB errors', () => {
    const res = mockRes()
    const req = { path: '/x', method: 'GET' }
    errorHandler({ statusCode: 404, message: 'nope' }, req, res, vi.fn())
    expect(res.statusCode).toBe(404)
  })
})

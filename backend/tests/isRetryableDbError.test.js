import { describe, it, expect } from 'vitest'
import { isRetryableDbError } from '../middleware/errorHandler.js'

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

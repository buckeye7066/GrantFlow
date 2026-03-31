/**
 * Error-envelope consistency tests.
 *
 * Verifies that `errorHandler` from backend/middleware/errorHandler.js always
 * produces a JSON body that contains at minimum an `error` field, uses the
 * correct HTTP status code, and optionally includes `request_id` when a
 * requestId is present on the request.
 *
 * These are pure unit tests — no server process is spawned.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { errorHandler, createError } from '../../backend/middleware/errorHandler.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockReq(overrides = {}) {
  return {
    requestId: null,
    request_id: null,
    path: '/test',
    method: 'GET',
    ...overrides,
  }
}

function mockRes() {
  let _status = 200
  let _body = null
  const res = {
    status(code) {
      _status = code
      return res
    },
    json(body) {
      _body = body
      return res
    },
    getStatus() {
      return _status
    },
    getBody() {
      return _body
    },
  }
  return res
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('errorHandler response always includes an "error" field', () => {
  const err = new Error('something went wrong')
  const res = mockRes()
  errorHandler(err, mockReq(), res, () => {})
  const body = res.getBody()
  assert.ok(body !== null, 'response body should not be null')
  assert.ok('error' in body, 'response body must contain an "error" field')
})

test('errorHandler defaults to HTTP 500 when error has no statusCode', () => {
  const err = new Error('unexpected crash')
  const res = mockRes()
  errorHandler(err, mockReq(), res, () => {})
  assert.strictEqual(res.getStatus(), 500)
})

test('errorHandler uses the statusCode set on the error object', () => {
  const err = createError(404, 'not found')
  const res = mockRes()
  errorHandler(err, mockReq(), res, () => {})
  assert.strictEqual(res.getStatus(), 404)
})

test('errorHandler uses err.status as fallback when statusCode is absent', () => {
  const err = new Error('bad request')
  err.status = 400
  const res = mockRes()
  errorHandler(err, mockReq(), res, () => {})
  assert.strictEqual(res.getStatus(), 400)
})

test('errorHandler includes request_id in body when requestId is present', () => {
  const err = new Error('auth error')
  const req = mockReq({ requestId: 'req-abc-123' })
  const res = mockRes()
  errorHandler(err, req, res, () => {})
  const body = res.getBody()
  assert.strictEqual(body.request_id, 'req-abc-123')
})

test('errorHandler does not include request_id when requestId is null', () => {
  const err = new Error('some error')
  const res = mockRes()
  errorHandler(err, mockReq({ requestId: null }), res, () => {})
  const body = res.getBody()
  // request_id should either be absent or falsy when not set
  assert.ok(!body.request_id, 'request_id should not appear when requestId is null')
})

test('errorHandler marks response ok: false', () => {
  const err = new Error('failure')
  const res = mockRes()
  errorHandler(err, mockReq(), res, () => {})
  const body = res.getBody()
  assert.strictEqual(body.ok, false, 'response body should have ok: false')
})

test('createError returns an error with the correct statusCode and message', () => {
  const err = createError(422, 'validation failed')
  assert.ok(err instanceof Error)
  assert.strictEqual(err.statusCode, 422)
  assert.strictEqual(err.message, 'validation failed')
})

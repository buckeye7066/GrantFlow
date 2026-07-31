/**
 * healthz-schema-bootstrap.test.mjs
 *
 * Regression for: /healthz returning 200 against a half-bootstrapped DB.
 *
 * Background: tests/unit/auth-access-check.test.mjs:217 was failing
 * intermittently in CI with `error: 'no such table: users'` because the
 * test polled `/healthz`, saw 200, then opened its own better-sqlite3
 * connection and tried to INSERT INTO users — but the schema apply
 * inside backend/server.js had silently failed (its catch logged but
 * didn't propagate).
 *
 * Mission rule: "If you cannot test, you must reason through execution
 * line-by-line" — and "Counts displayed in the UI must map 1:1 to
 * backend response fields". The /healthz body MUST reflect actual boot
 * state, not just "the process is listening".
 *
 * What this test asserts:
 *   1. The /healthz handler returns 503 with reason='schema_bootstrap_failed'
 *      when app.locals.schema_bootstrap_failed is true.
 *   2. The /healthz handler returns 200 with schema_bootstrap_failed=false
 *      under normal operation.
 *   3. Public liveness reports an opaque missing-table count without exposing
 *      internal schema names or raw database errors.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'

import healthRouter from '../../backend/routes/health.js'

function startTestServer(localsOverrides = {}) {
  const app = express()
  Object.assign(app.locals, {
    schema_bootstrap_failed: false,
    schema_bootstrap_error: null,
    schema_bootstrap_missing_tables: [],
    db_startup_error: null,
    ...localsOverrides,
  })
  app.use(healthRouter)
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        port,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

test('healthz returns 200 + schema_bootstrap_failed:false under normal boot', async () => {
  const srv = await startTestServer()
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.status, 'ok')
    assert.equal(body.schema_bootstrap_failed, false)
  } finally {
    await srv.close()
  }
})

test('healthz returns 503 when schema_bootstrap_failed is true', async () => {
  const srv = await startTestServer({
    schema_bootstrap_failed: true,
    schema_bootstrap_error: 'syntax error in schema.sql at line 42',
    schema_bootstrap_missing_tables: ['users'],
  })
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`)
    assert.equal(res.status, 503)
    const body = await res.json()
    assert.equal(body.ok, false)
    assert.equal(body.status, 'degraded')
    assert.equal(body.reason, 'schema_bootstrap_failed')
    assert.equal(body.schema_bootstrap_failed, true)
    assert.equal(body.missing_table_count, 1)
    assert.equal(body.missing_tables, undefined)
    assert.equal(body.detail, undefined)
    assert.equal(body.details_redacted, true)
  } finally {
    await srv.close()
  }
})

test('healthz returns 503 with reason=db_startup_error when DB never opened', async () => {
  const srv = await startTestServer({
    db_startup_error: 'connection refused (no postgres at host:port)',
  })
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`)
    assert.equal(res.status, 503)
    const body = await res.json()
    assert.equal(body.ok, false)
    assert.equal(body.reason, 'db_startup_error')
    assert.equal(body.detail, undefined)
    assert.equal(body.details_redacted, true)
  } finally {
    await srv.close()
  }
})

test('healthz reports multiple missing tables in body', async () => {
  const srv = await startTestServer({
    schema_bootstrap_failed: true,
    schema_bootstrap_error: 'missing tables: users, profiles, grants',
    schema_bootstrap_missing_tables: ['users', 'profiles', 'grants'],
  })
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`)
    assert.equal(res.status, 503)
    const body = await res.json()
    assert.equal(body.missing_table_count, 3)
    assert.equal(body.missing_tables, undefined)
    assert.equal(body.details_redacted, true)
  } finally {
    await srv.close()
  }
})

test('healthz tolerates missing app.locals (defensive default)', async () => {
  // If the locals struct is somehow undefined (e.g. an isolated unit test
  // mounting the router directly without setting locals), we must still
  // return 200 — never crash the liveness probe.
  const app = express()
  // intentionally do NOT pre-populate app.locals fields
  app.use(healthRouter)
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  try {
    const { port } = server.address()
    const res = await fetch(`http://127.0.0.1:${port}/healthz`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
  } finally {
    await new Promise((r) => server.close(r))
  }
})

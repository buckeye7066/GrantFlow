import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'

import telemetryRouter from '../../backend/routes/agentTelemetry.js'
import { makeTelemetryDb, nextId, isoMinutesAgo } from './agent-telemetry-test-helpers.mjs'

function startApp({ admin = false, db } = {}) {
  const app = express()
  app.use(express.json())
  // simulate authenticated user + req.db + req.ctx middleware shape
  app.use((req, _res, next) => {
    req.db = db
    if (admin) {
      req.user = { userId: 'u1', email: 'admin@grantflow.test', role: 'admin_global' }
      req.ctx = { isAdmin: true, accessibleProfileIds: null }
    }
    next()
  })
  app.use('/api/admin/agent-telemetry', telemetryRouter)
  const server = app.listen(0)
  return server
}

function get(server, path) {
  const port = server.address().port
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null })
        } catch (err) {
          resolve({ status: res.statusCode, body, parseError: err })
        }
      })
    })
    req.on('error', reject)
  })
}

test('non-admin requests are rejected with 401/403, never returning telemetry', async () => {
  const db = makeTelemetryDb()
  const server = startApp({ admin: false, db })
  try {
    const r = await get(server, '/api/admin/agent-telemetry/summary')
    assert.ok([401, 403].includes(r.status), `got ${r.status}`)
    // body should not contain telemetry payload
    assert.equal(r.body?.agents, undefined)
    assert.equal(r.body?.ok, undefined)
  } finally {
    server.close()
  }
})

test('admin gets summary even when no agent tables exist (zero-data, 200 ok)', async () => {
  const db = makeTelemetryDb()
  const server = startApp({ admin: true, db })
  try {
    const r = await get(server, '/api/admin/agent-telemetry/summary')
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    for (const name of ['anya', 'sam', 'robert', 'yana', 'john']) {
      assert.ok(r.body.agents[name])
      assert.equal(r.body.agents[name].installed, false)
    }
  } finally {
    server.close()
  }
})

test('admin /health returns diagnostics and missing_tables for each agent', async () => {
  const db = makeTelemetryDb({ installAgents: ['john_email_drafts'] })
  const server = startApp({ admin: true, db })
  try {
    const r = await get(server, '/api/admin/agent-telemetry/health')
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.ok(r.body.diagnostics.john.present_tables.includes('john_email_drafts'))
    assert.ok(r.body.diagnostics.john.missing_tables.length > 0)
    assert.ok(r.body.diagnostics.yana.missing_tables.length > 0)
  } finally {
    server.close()
  }
})

test('admin /timeline tolerates synthetic-only data and never crashes', async () => {
  const db = makeTelemetryDb({ installAgents: ['john_email_drafts'] })
  db._raw
    .prepare(
      `INSERT INTO john_email_drafts (id, draft_status, organization_name) VALUES (?, 'created', 'Acme')`,
    )
    .run(nextId('d'))
  const server = startApp({ admin: true, db })
  try {
    const r = await get(server, '/api/admin/agent-telemetry/timeline?range=24h')
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.source, 'synthetic')
    assert.ok(Array.isArray(r.body.events))
  } finally {
    server.close()
  }
})

test('admin /robert/map returns empty payload (200) when robert tables are missing', async () => {
  const db = makeTelemetryDb()
  const server = startApp({ admin: true, db })
  try {
    const r = await get(server, '/api/admin/agent-telemetry/robert/map')
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.installed, false)
    assert.deepEqual(r.body.by_state, [])
  } finally {
    server.close()
  }
})

test('admin /john reports drafts_created and remaining capacity', async () => {
  const db = makeTelemetryDb({ installAgents: ['john_email_drafts'] })
  for (let i = 0; i < 6; i += 1) {
    db._raw
      .prepare(
        `INSERT INTO john_email_drafts (id, created_at, draft_status, organization_name)
         VALUES (?, ?, 'created', 'Acme')`,
      )
      .run(nextId('d'), isoMinutesAgo(30 + i))
  }
  const server = startApp({ admin: true, db })
  try {
    const r = await get(server, '/api/admin/agent-telemetry/john?range=24h')
    assert.equal(r.status, 200)
    assert.equal(r.body.summary.installed, true)
    assert.equal(r.body.summary.primary_metrics.drafts_created, 6)
    assert.equal(r.body.summary.primary_metrics.daily_capacity_remaining, 50 - 6)
  } finally {
    server.close()
  }
})

test('admin /sam never returns the raw secrets in details_json', async () => {
  const db = makeTelemetryDb({ installAgents: ['sam_runs', 'sam_findings'] })
  db._raw
    .prepare(`INSERT INTO sam_findings (id, severity, status, title, details_json)
              VALUES (?, 'critical', 'open', 'leak', ?)`)
    .run(
      nextId('sf'),
      JSON.stringify({ password: 'hunter2', authorization: 'Bearer xyz', file_path: 'src/x.js' }),
    )
  const server = startApp({ admin: true, db })
  try {
    const r = await get(server, '/api/admin/agent-telemetry/sam?range=24h')
    assert.equal(r.status, 200)
    const json = JSON.stringify(r.body)
    assert.equal(json.includes('hunter2'), false, 'password must be redacted')
    assert.equal(json.includes('Bearer xyz'), false, 'bearer token must be redacted')
    assert.ok(r.body.findings.findings.length > 0)
  } finally {
    server.close()
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getSummary,
  getTimeline,
  getYana,
  getRobert,
  getRobertMap,
  getSam,
  getAnya,
  getJohn,
  getHealth,
} from '../../backend/services/agentTelemetry/agentTelemetryService.js'
import { makeTelemetryDb, nextId, isoMinutesAgo } from './agent-telemetry-test-helpers.mjs'

test('getSummary returns a stable shape for every canonical agent even with no data', async () => {
  const db = makeTelemetryDb()
  const result = await getSummary(db, { range: '24h' })
  assert.ok(result.range)
  assert.ok(result.agents)
  for (const name of ['anya', 'sam', 'robert', 'yana', 'john']) {
    assert.ok(result.agents[name], `${name} entry present`)
    assert.equal(result.agents[name].agent_name, name)
  }
})

test('getHealth reports overall not_installed when no agents are present', async () => {
  const db = makeTelemetryDb()
  const h = await getHealth(db)
  assert.equal(h.overall, 'not_installed')
  assert.equal(h.unified_table_present, true)
  assert.equal(h.rollup_table_present, true)
  assert.deepEqual(
    Object.keys(h.diagnostics).sort(),
    ['anya', 'hamilton', 'john', 'robert', 'sam', 'yana'],
  )
  for (const d of Object.values(h.diagnostics)) {
    assert.deepEqual(d.present_tables, [])
    assert.ok(Array.isArray(d.missing_tables))
  }
})

test('getYana returns aggregated funnel + summary for installed agent', async () => {
  const db = makeTelemetryDb({ installAgents: ['yana_runs', 'yana_lead_candidates', 'yana_john_queue'] })
  db._raw
    .prepare('INSERT INTO yana_runs (id, status, urls_fetched, leads_found) VALUES (?, ?, ?, ?)')
    .run(nextId('yr'), 'succeeded', 100, 25)
  for (let i = 0; i < 10; i += 1) {
    db._raw
      .prepare('INSERT INTO yana_lead_candidates (id, qualification_status) VALUES (?, ?)')
      .run(nextId('ylc'), 'qualified')
  }
  for (let i = 0; i < 4; i += 1) {
    db._raw.prepare('INSERT INTO yana_john_queue (id, lead_id) VALUES (?, ?)').run(nextId('yjq'), 'lid')
  }
  const out = await getYana(db, { range: '24h' })
  assert.equal(out.summary.installed, true)
  assert.equal(out.summary.primary_metrics.websites_checked, 100)
  assert.equal(out.summary.primary_metrics.leads_qualified, 10)
  assert.equal(out.summary.primary_metrics.leads_sent_to_john, 4)
  assert.ok(Array.isArray(out.funnel.funnel))
})

test('getRobertMap returns empty when robert tables are missing', async () => {
  const db = makeTelemetryDb()
  const out = await getRobertMap(db, { range: '24h' })
  assert.equal(out.installed, false)
  assert.deepEqual(out.by_state, [])
  assert.deepEqual(out.by_city, [])
  assert.equal(out.unknown_count, 0)
})

test('getJohn returns daily capacity remaining = 50 when no john tables present', async () => {
  const db = makeTelemetryDb()
  const out = await getJohn(db, { range: '24h' })
  assert.equal(out.summary.installed, false)
  assert.equal(out.summary.primary_metrics.daily_capacity_remaining, 50)
})

test('getJohn surfaces drafts created and remaining capacity once john tables exist', async () => {
  const db = makeTelemetryDb({ installAgents: ['john_email_drafts'] })
  for (let i = 0; i < 12; i += 1) {
    db._raw
      .prepare(
        `INSERT INTO john_email_drafts (id, created_at, draft_status, organization_name)
         VALUES (?, ?, 'created', 'Acme')`,
      )
      .run(nextId('d'), isoMinutesAgo(30 + i))
  }
  const out = await getJohn(db, { range: '24h' })
  assert.equal(out.summary.installed, true)
  assert.equal(out.summary.primary_metrics.drafts_created, 12)
  assert.equal(out.summary.primary_metrics.daily_capacity_remaining, 50 - 12)
})

test('getSam returns findings panel with severity counts', async () => {
  const db = makeTelemetryDb({ installAgents: ['sam_runs', 'sam_findings'] })
  for (const sev of ['critical', 'high', 'medium']) {
    db._raw
      .prepare(`INSERT INTO sam_findings (id, severity, status, title) VALUES (?, ?, 'open', ?)`)
      .run(nextId('sf'), sev, 'x')
  }
  const out = await getSam(db, { range: '24h' })
  assert.equal(out.findings.installed, true)
  assert.equal(out.findings.counts.critical, 1)
  assert.equal(out.findings.counts.high, 1)
  assert.equal(out.findings.counts.medium, 1)
})

test('getAnya returns metadata-only panel even when messages contain content', async () => {
  const db = makeTelemetryDb({ installAgents: ['anya_sessions', 'anya_messages'] })
  db._raw.prepare('INSERT INTO anya_sessions (id, user_id) VALUES (?, ?)').run(nextId('as'), 'u1')
  db._raw
    .prepare('INSERT INTO anya_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)')
    .run(nextId('am'), 'sess', 'user', 'SECRET MESSAGE TEXT')
  const out = await getAnya(db, { range: '24h' })
  const json = JSON.stringify(out)
  assert.equal(json.includes('SECRET MESSAGE TEXT'), false)
  assert.equal(out.panel.sessions_count, 1)
  assert.equal(out.panel.interactions, 1)
})

test('getTimeline tolerates missing tables and synthesises from agent-specific data', async () => {
  const db = makeTelemetryDb({ installAgents: ['john_email_drafts', 'anya_runs'] })
  db._raw
    .prepare(
      `INSERT INTO john_email_drafts (id, draft_status, organization_name) VALUES (?, 'created', 'Acme')`,
    )
    .run(nextId('d'))
  db._raw
    .prepare('INSERT INTO anya_runs (id, status, mode) VALUES (?, ?, ?)')
    .run(nextId('arn'), 'completed', 'copilot')
  const out = await getTimeline(db, { range: '24h' })
  assert.equal(out.source, 'synthetic')
  assert.ok(out.events.length >= 2)
})

test('getSummary aggregates Yana websites checked AND leads sent to John in a single call', async () => {
  const db = makeTelemetryDb({
    installAgents: ['yana_runs', 'yana_john_queue', 'john_email_drafts'],
  })
  db._raw
    .prepare('INSERT INTO yana_runs (id, status, urls_fetched, leads_found) VALUES (?, ?, ?, ?)')
    .run(nextId('yr'), 'succeeded', 200, 40)
  for (let i = 0; i < 18; i += 1) {
    db._raw.prepare('INSERT INTO yana_john_queue (id, lead_id) VALUES (?, ?)').run(nextId('yjq'), 'lid')
  }
  for (let i = 0; i < 14; i += 1) {
    db._raw
      .prepare(
        `INSERT INTO john_email_drafts (id, draft_status, organization_name) VALUES (?, 'created', 'Acme')`,
      )
      .run(nextId('d'))
  }

  const out = await getSummary(db, { range: '24h' })
  assert.equal(out.agents.yana.primary_metrics.websites_checked, 200)
  assert.equal(out.agents.yana.primary_metrics.leads_sent_to_john, 18)
  assert.equal(out.agents.john.primary_metrics.drafts_created, 14)
})

test('getRobertMap returns empty city array when geometry columns are absent', async () => {
  // Custom test: simulate older schema without latitude/longitude
  const db = makeTelemetryDb()
  db._raw.exec(`
    CREATE TABLE robert_opportunity_candidates (
      id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      verification_status TEXT,
      ingested_opportunity_id TEXT,
      title TEXT,
      category TEXT
    );
  `)
  db._raw
    .prepare(
      `INSERT INTO robert_opportunity_candidates (id, verification_status, ingested_opportunity_id, title, category)
       VALUES (?, 'verified', 'opp1', 't', 'general')`,
    )
    .run(nextId('roc'))
  const out = await getRobertMap(db, { range: '24h' })
  assert.equal(out.installed, true)
  assert.equal(out.unknown_count, 1, 'no city/state/lat/lng → unknown')
})

test('getSummary handles partial agent install (only some tables exist)', async () => {
  const db = makeTelemetryDb({ installAgents: ['anya_sessions'] })
  db._raw.prepare('INSERT INTO anya_sessions (id, user_id) VALUES (?, ?)').run(nextId('as'), 'u1')
  const out = await getSummary(db, { range: '24h' })
  // anya partially installed
  assert.equal(out.agents.anya.installed, true)
  // others not installed but still in payload
  assert.equal(out.agents.sam.installed, false)
  assert.equal(out.agents.robert.installed, false)
  assert.equal(out.agents.yana.installed, false)
  assert.equal(out.agents.john.installed, false)
})

test('getRobert returns funnel + summary structure', async () => {
  const db = makeTelemetryDb({ installAgents: ['robert_runs', 'robert_opportunity_candidates'] })
  db._raw
    .prepare('INSERT INTO robert_runs (id, status, sources_checked, candidates_found) VALUES (?, ?, ?, ?)')
    .run(nextId('rr'), 'succeeded', 10, 5)
  for (let i = 0; i < 5; i += 1) {
    db._raw
      .prepare(
        `INSERT INTO robert_opportunity_candidates (id, verification_status, ingested_opportunity_id)
         VALUES (?, ?, ?)`,
      )
      .run(nextId('roc'), 'verified', i < 3 ? nextId('opp') : null)
  }
  const out = await getRobert(db, { range: '24h' })
  const m = (s) => out.funnel.funnel.find((x) => x.stage === s)?.value
  assert.equal(m('sources_checked'), 10)
  assert.equal(m('verified'), 5)
  assert.equal(m('ingested'), 3)
})

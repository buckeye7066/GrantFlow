import test from 'node:test'
import assert from 'node:assert/strict'

import {
  aggregateAnya,
  aggregateAnyaInteractions,
  aggregateSam,
  aggregateSamFindings,
  aggregateRobert,
  aggregateRobertFunnel,
  aggregateRobertMap,
  aggregateYana,
  aggregateYanaFunnel,
  aggregateJohn,
  aggregateTimeline,
  redactSecrets,
} from '../../backend/services/agentTelemetry/agentTelemetryAggregator.js'
import { resolveRange } from '../../backend/services/agentTelemetry/agentTelemetryTypes.js'
import { makeTelemetryDb, nextId, isoMinutesAgo } from './agent-telemetry-test-helpers.mjs'

const range24h = () => resolveRange({ range: '24h' })

function seedDraft(db, { status = 'created', minutesAgo = 30, blockReason = null, organization = 'Acme' } = {}) {
  db._raw
    .prepare(
      `INSERT INTO john_email_drafts (id, created_at, draft_status, block_reason, organization_name, recipient_email)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(nextId('draft'), isoMinutesAgo(minutesAgo), status, blockReason, organization, 'a@b.com')
}

test('all aggregators return installed:false when no agent tables exist', async () => {
  const db = makeTelemetryDb()
  const r = range24h()
  const [anya, sam, robert, yana, john] = await Promise.all([
    aggregateAnya(db, r),
    aggregateSam(db, r),
    aggregateRobert(db, r),
    aggregateYana(db, r),
    aggregateJohn(db, r),
  ])
  for (const a of [anya, sam, robert, yana]) {
    assert.equal(a.installed, false, `${a.agent_name} installed should be false`)
    assert.equal(a.health, 'not_installed', `${a.agent_name} health should be not_installed`)
    assert.equal(a.actions_in_window, 0)
  }
  // John is special-cased: he reports the daily cap remaining even with no install
  assert.equal(john.installed, false)
  assert.equal(john.primary_metrics.daily_capacity_remaining, 50)
})

test('Yana funnel: websites checked vs leads sent to John', async () => {
  const db = makeTelemetryDb({ installAgents: ['yana_runs', 'yana_lead_candidates', 'yana_john_queue'] })
  db._raw
    .prepare('INSERT INTO yana_runs (id, status, urls_fetched, leads_found) VALUES (?, ?, ?, ?)')
    .run(nextId('yr'), 'succeeded', 120, 30)
  // 18 qualified candidates; 9 of them have been pushed to John. The
  // aggregator now sources leads_sent_to_john from the PRIMARY
  // pushed_to_john flag on the candidate (the legacy yana_john_queue is no
  // longer written in production — it double-counted re-pushes and grew
  // unbounded). We still insert into yana_john_queue below to prove the
  // primary flag path wins over the legacy fallback.
  for (let i = 0; i < 18; i += 1) {
    db._raw
      .prepare('INSERT INTO yana_lead_candidates (id, qualification_status, pushed_to_john) VALUES (?, ?, ?)')
      .run(nextId('ylc'), 'qualified', i < 9 ? 1 : 0)
  }
  for (let i = 0; i < 12; i += 1) {
    db._raw
      .prepare('INSERT INTO yana_lead_candidates (id, qualification_status, rejection_reason) VALUES (?, ?, ?)')
      .run(nextId('ylc'), 'rejected', i % 2 ? 'no_public_evidence' : 'compliance')
  }
  // Legacy queue rows (should be IGNORED now that pushed_to_john exists).
  for (let i = 0; i < 99; i += 1) {
    db._raw.prepare('INSERT INTO yana_john_queue (id, lead_id) VALUES (?, ?)').run(nextId('yjq'), nextId('lid'))
  }

  const summary = await aggregateYana(db, range24h())
  assert.equal(summary.installed, true)
  assert.equal(summary.primary_metrics.websites_checked, 120)
  assert.equal(summary.primary_metrics.leads_qualified, 18)
  assert.equal(summary.primary_metrics.leads_sent_to_john, 9)
  assert.ok(summary.primary_metrics.lead_conversion_rate > 0 && summary.primary_metrics.lead_conversion_rate < 1)
  assert.equal(summary.primary_metrics.leads_rejected, 12)

  const funnel = await aggregateYanaFunnel(db, range24h())
  const websites = funnel.funnel.find((s) => s.stage === 'websites_checked').value
  const sent = funnel.funnel.find((s) => s.stage === 'leads_sent_to_john').value
  assert.equal(websites, 120)
  assert.equal(sent, 9)
})

test('John daily capacity: drafts created in last 24h count toward 50/day cap', async () => {
  const db = makeTelemetryDb({ installAgents: ['john_email_drafts', 'john_alias_checks'] })
  for (let i = 0; i < 12; i += 1) seedDraft(db, { status: 'created', minutesAgo: 30 + i })
  for (let i = 0; i < 4; i += 1) seedDraft(db, { status: 'blocked', blockReason: 'suppressed', minutesAgo: 50 + i })
  for (let i = 0; i < 2; i += 1) seedDraft(db, { status: 'needs_sender_alias_review', minutesAgo: 70 + i })
  // a draft created 26 hours ago must NOT count
  seedDraft(db, { status: 'created', minutesAgo: 60 * 26 })

  db._raw
    .prepare('INSERT INTO john_alias_checks (id, alias_status) VALUES (?, ?)')
    .run(nextId('alias'), 'verified')

  const summary = await aggregateJohn(db, range24h())
  const m = summary.primary_metrics
  // created + needs_sender_alias_review = drafts that count as created
  assert.equal(m.drafts_created, 14)
  assert.equal(m.drafts_blocked, 4)
  assert.equal(m.drafts_needing_alias_review, 2)
  assert.equal(m.drafts_created_24h, 14, 'drafts older than 24h must not count')
  assert.equal(m.daily_capacity_remaining, 50 - 14)
  assert.equal(m.daily_capacity_total, 50)
  assert.equal(m.alias_status, 'verified')
})

test('John block reasons surface as a counted map', async () => {
  const db = makeTelemetryDb({ installAgents: ['john_email_drafts'] })
  seedDraft(db, { status: 'blocked', blockReason: 'suppressed' })
  seedDraft(db, { status: 'blocked', blockReason: 'suppressed' })
  seedDraft(db, { status: 'blocked', blockReason: 'unsafe_content' })
  const summary = await aggregateJohn(db, range24h())
  assert.deepEqual(summary.primary_metrics.block_reasons, {
    suppressed: 2,
    unsafe_content: 1,
  })
})

test('Robert map groups ingested opportunities by state and city, with unknowns', async () => {
  const db = makeTelemetryDb({ installAgents: ['robert_opportunity_candidates'] })
  function ins(state, city, ingested = true, title = 'Opp', category = 'general') {
    db._raw
      .prepare(
        `INSERT INTO robert_opportunity_candidates
         (id, verification_status, ingested_opportunity_id, state, city, title, category)
         VALUES (?, 'verified', ?, ?, ?, ?, ?)`,
      )
      .run(nextId('roc'), ingested ? nextId('opp') : null, state, city, title, category)
  }
  ins('OH', 'Columbus', true, 'Local fire grant', 'fire')
  ins('OH', 'Cleveland', true, 'Energy', 'energy')
  ins('TX', 'Austin', true)
  ins('TX', 'Houston', true)
  ins('TX', 'Houston', true, 'Another Houston grant', 'housing')
  ins('CA', null, true)
  ins(null, null, true) // unknown location

  const map = await aggregateRobertMap(db, range24h())
  assert.equal(map.installed, true)
  const oh = map.by_state.find((s) => s.state === 'OH')
  const tx = map.by_state.find((s) => s.state === 'TX')
  const ca = map.by_state.find((s) => s.state === 'CA')
  assert.equal(oh.count, 2)
  assert.equal(tx.count, 3)
  assert.equal(ca.count, 1)
  assert.equal(map.unknown_count, 1)
  // city aggregation
  const houston = map.by_city.find((c) => c.city === 'Houston')
  assert.equal(houston.count, 2)
})

test('Robert funnel reflects sources, candidates, verified, ingested', async () => {
  const db = makeTelemetryDb({
    installAgents: ['robert_runs', 'robert_opportunity_candidates', 'robert_profile_recommendations'],
  })
  db._raw
    .prepare('INSERT INTO robert_runs (id, status, sources_considered, candidates_found) VALUES (?, ?, ?, ?)')
    .run(nextId('rr'), 'succeeded', 25, 18)
  for (let i = 0; i < 18; i += 1) {
    db._raw
      .prepare(
        `INSERT INTO robert_opportunity_candidates (id, verification_status, ingested_opportunity_id)
         VALUES (?, ?, ?)`,
      )
      .run(nextId('roc'), i < 12 ? 'verified' : 'rejected', i < 8 ? nextId('opp') : null)
  }
  for (let i = 0; i < 5; i += 1) {
    db._raw
      .prepare('INSERT INTO robert_profile_recommendations (id, recommendation_status) VALUES (?, ?)')
      .run(nextId('rpr'), i < 3 ? 'accepted' : 'pending')
  }
  const f = await aggregateRobertFunnel(db, range24h())
  const m = (stage) => f.funnel.find((s) => s.stage === stage)?.value
  assert.equal(m('sources_checked'), 25)
  assert.equal(m('candidates_found'), 18)
  assert.equal(m('verified'), 12)
  assert.equal(m('ingested'), 8)
  assert.equal(m('matched_profiles'), 5)
  assert.equal(m('accepted'), 3)
})

test('Sam findings panel returns severity counts and redacts secrets', async () => {
  const db = makeTelemetryDb({ installAgents: ['sam_runs', 'sam_findings'] })
  for (const sev of ['critical', 'high', 'high', 'medium', 'low', 'info']) {
    db._raw
      .prepare(
        `INSERT INTO sam_findings (id, severity, status, title, file_path, details_json)
         VALUES (?, ?, 'open', ?, 'src/x.js', ?)`,
      )
      .run(
        nextId('sf'),
        sev,
        `${sev} finding`,
        JSON.stringify({ password: 'hunter2', metadata: { token: 'abc', path: 'src/x.js' } }),
      )
  }
  const panel = await aggregateSamFindings(db, range24h())
  assert.equal(panel.installed, true)
  assert.equal(panel.counts.critical, 1)
  assert.equal(panel.counts.high, 2)
  assert.equal(panel.counts.medium, 1)
  // redaction
  for (const f of panel.findings) {
    assert.equal(f.details?.password, '[REDACTED]')
    assert.equal(f.details?.metadata?.token, '[REDACTED]')
    assert.equal(f.details?.metadata?.path, 'src/x.js')
  }
})

test('Anya panel returns metadata only, never message content', async () => {
  const db = makeTelemetryDb({ installAgents: ['anya_sessions', 'anya_messages', 'anya_tool_usage', 'anya_runs'] })
  for (let i = 0; i < 4; i += 1) {
    db._raw
      .prepare('INSERT INTO anya_sessions (id, user_id, profile_id) VALUES (?, ?, ?)')
      .run(nextId('as'), `u${i % 2}`, `p${i % 2}`)
  }
  for (let i = 0; i < 12; i += 1) {
    db._raw
      .prepare('INSERT INTO anya_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)')
      .run(nextId('am'), 'sess', 'user', 'PRIVATE TEXT MUST NOT LEAK')
  }
  for (const t of ['summarize', 'summarize', 'lookup_grant']) {
    db._raw
      .prepare('INSERT INTO anya_tool_usage (id, tool_name) VALUES (?, ?)')
      .run(nextId('atu'), t)
  }
  for (const m of ['copilot', 'admin_ops', 'copilot']) {
    db._raw
      .prepare('INSERT INTO anya_runs (id, status, mode, user_id) VALUES (?, ?, ?, ?)')
      .run(nextId('arn'), 'completed', m, 'u1')
  }

  const panel = await aggregateAnyaInteractions(db, range24h())
  assert.equal(panel.installed, true)
  assert.equal(panel.sessions_count, 4)
  assert.equal(panel.interactions, 12)
  assert.equal(panel.tool_invocations, 3)
  assert.equal(panel.most_used_tools[0].tool, 'summarize')
  assert.equal(panel.most_used_tools[0].uses, 2)
  assert.equal(panel.modes.copilot, 2)
  assert.equal(panel.modes.admin_ops, 1)
  // privacy: no field on the panel should contain the message body
  const json = JSON.stringify(panel)
  assert.equal(json.includes('PRIVATE TEXT MUST NOT LEAK'), false)
})

test('aggregateAnya degrades gracefully when only some tables are present', async () => {
  const db = makeTelemetryDb({ installAgents: ['anya_sessions'] })
  db._raw.prepare('INSERT INTO anya_sessions (id) VALUES (?)').run(nextId('as'))
  const summary = await aggregateAnya(db, range24h())
  assert.equal(summary.installed, true)
  assert.equal(summary.primary_metrics.active_sessions, 1)
})

test('aggregateSam reflects severity breakdown and resolved count', async () => {
  const db = makeTelemetryDb({ installAgents: ['sam_runs', 'sam_findings'] })
  for (const sev of ['critical', 'high', 'high', 'medium']) {
    db._raw
      .prepare(`INSERT INTO sam_findings (id, severity, status, title) VALUES (?, ?, 'open', ?)`)
      .run(nextId('sf'), sev, 'x')
  }
  db._raw
    .prepare(`INSERT INTO sam_findings (id, severity, status, title, event_type) VALUES (?, 'high', 'open', 'gate', 'gate_failed')`)
    .run(nextId('sf'))
  db._raw
    .prepare(`INSERT INTO sam_findings (id, severity, status, title) VALUES (?, 'low', 'resolved', 'x')`)
    .run(nextId('sf'))

  const summary = await aggregateSam(db, range24h())
  assert.equal(summary.installed, true)
  // 4 base findings + 1 gate-failed (high) + 1 low-resolved = 6 total severity counts
  assert.equal(summary.primary_metrics.errors_found, 6)
  assert.equal(summary.primary_metrics.critical_errors, 1)
  assert.equal(summary.primary_metrics.errors_resolved, 1)
  assert.equal(summary.primary_metrics.failed_gates, 1)
})

test('aggregateTimeline falls back to synthetic events from john_email_drafts when no unified events', async () => {
  const db = makeTelemetryDb({ installAgents: ['john_email_drafts'] })
  seedDraft(db, { status: 'created' })
  seedDraft(db, { status: 'blocked', blockReason: 'suppressed' })
  const tl = await aggregateTimeline(db, range24h(), {})
  assert.equal(tl.source, 'synthetic')
  assert.equal(tl.events.length, 2)
  assert.ok(tl.events.find((e) => e.event_type === 'draft_created'))
  assert.ok(tl.events.find((e) => e.event_type === 'draft_blocked'))
})

test('redactSecrets recurses through nested arrays and objects', () => {
  const input = {
    safe: 'ok',
    api_key: 'leak1',
    nested: {
      bearer_token: 'leak2',
      list: [{ password: 'leak3' }, { username: 'visible' }],
    },
  }
  const out = redactSecrets(input)
  assert.equal(out.safe, 'ok')
  assert.equal(out.api_key, '[REDACTED]')
  assert.equal(out.nested.bearer_token, '[REDACTED]')
  assert.equal(out.nested.list[0].password, '[REDACTED]')
  assert.equal(out.nested.list[1].username, 'visible')
})

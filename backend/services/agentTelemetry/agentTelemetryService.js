/**
 * Agent Mission Control — public service surface used by the routes.
 *
 * Each function takes a `db` handle and an opts object (range + filters)
 * and returns plain JSON.  No I/O outside the supplied db.
 */

import {
  AGENT_NAMES,
  AGENT_HEALTH,
  resolveRange,
  makeEmptyAgentSummary,
} from './agentTelemetryTypes.js'
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
  aggregateHamilton,
  aggregateJohn,
  aggregateTimeline,
} from './agentTelemetryAggregator.js'
import { tableExists } from './agentTelemetryStore.js'

function normalizeRange(opts = {}) {
  return resolveRange({
    range: opts.range,
    start: opts.start,
    end: opts.end,
  })
}

/**
 * Multi-agent summary used by overview cards. Always returns an entry for
 * every canonical agent so the dashboard layout is stable.
 */
export async function getSummary(db, opts = {}) {
  const range = normalizeRange(opts)
  const [anya, sam, robert, yana, hamilton, john] = await Promise.all([
    aggregateAnya(db, range),
    aggregateSam(db, range),
    aggregateRobert(db, range),
    aggregateYana(db, range),
    aggregateHamilton(db, range),
    aggregateJohn(db, range),
  ])
  const agents = { anya, sam, robert, yana, hamilton, john }
  for (const name of AGENT_NAMES) {
    if (!agents[name]) agents[name] = makeEmptyAgentSummary(name)
  }
  return {
    range,
    agents,
    generated_at: new Date().toISOString(),
  }
}

export async function getTimeline(db, opts = {}) {
  const range = normalizeRange(opts)
  const tl = await aggregateTimeline(db, range, {
    agent: opts.agent,
    status: opts.status,
    profile_id: opts.profile_id,
    state: opts.state,
    limit: Number(opts.limit) || 200,
  })
  return { range, ...tl }
}

export async function getYana(db, opts = {}) {
  const range = normalizeRange(opts)
  const [summary, funnel] = await Promise.all([
    aggregateYana(db, range),
    aggregateYanaFunnel(db, range),
  ])
  return { range, summary, funnel }
}

export async function getRobert(db, opts = {}) {
  const range = normalizeRange(opts)
  const [summary, funnel] = await Promise.all([
    aggregateRobert(db, range),
    aggregateRobertFunnel(db, range),
  ])
  return { range, summary, funnel }
}

export async function getRobertMap(db, opts = {}) {
  const range = normalizeRange(opts)
  const map = await aggregateRobertMap(db, range)
  return { range, ...map }
}

export async function getSam(db, opts = {}) {
  const range = normalizeRange(opts)
  const [summary, findings] = await Promise.all([
    aggregateSam(db, range),
    aggregateSamFindings(db, range, {
      severity: opts.severity,
      status: opts.status,
      limit: Number(opts.limit) || 100,
    }),
  ])
  return { range, summary, findings }
}

export async function getAnya(db, opts = {}) {
  const range = normalizeRange(opts)
  const [summary, panel] = await Promise.all([
    aggregateAnya(db, range),
    aggregateAnyaInteractions(db, range),
  ])
  return { range, summary, panel }
}

export async function getJohn(db, opts = {}) {
  const range = normalizeRange(opts)
  const summary = await aggregateJohn(db, range)
  return { range, summary }
}

export async function getHamilton(db, opts = {}) {
  const range = normalizeRange(opts)
  const summary = await aggregateHamilton(db, range)
  return { range, summary }
}

/**
 * Health probe for every agent — mirrors the overview cards but adds a
 * diagnostics section listing tables that are missing per agent.
 */
export async function getHealth(db) {
  const range = resolveRange({ range: '24h' })
  // allSettled (not all): one agent's aggregator throwing must never blank the
  // entire Mission Control dashboard. A rejected aggregator degrades to a
  // labelled "error" summary for that agent only — the others still render.
  const names = ['anya', 'sam', 'robert', 'yana', 'hamilton', 'john']
  const fns = [aggregateAnya, aggregateSam, aggregateRobert, aggregateYana, aggregateHamilton, aggregateJohn]
  const settled = await Promise.allSettled(fns.map((fn) => fn(db, range)))
  const agents = {}
  settled.forEach((res, i) => {
    const name = names[i]
    if (res.status === 'fulfilled') {
      agents[name] = res.value
    } else {
      const fallback = makeEmptyAgentSummary(name)
      fallback.health = AGENT_HEALTH.ERROR
      fallback.notes = [`aggregator failed: ${res.reason?.message || res.reason}`]
      agents[name] = fallback
    }
  })

  // Hamilton-specific Sam checks live alongside the agent's table list
  // so Sam can monitor application autopilot health independently of
  // the lead-discovery Yana agent. The keys correspond directly to the
  // agent.hamilton.* checks in the user's spec:
  //   agent.hamilton.health, agent.hamilton.routes,
  //   agent.hamilton.portalAutomation, agent.hamilton.documents,
  //   agent.hamilton.notifications, agent.hamilton.blockers,
  //   agent.hamilton.security
  const expected = {
    anya: ['anya_runs', 'anya_sessions', 'anya_messages', 'anya_tool_usage'],
    sam: ['sam_runs', 'sam_findings'],
    robert: ['robert_runs', 'robert_opportunity_candidates', 'robert_profile_recommendations'],
    yana: ['yana_lead_candidates', 'yana_john_queue', 'yana_larry_queue'],
    hamilton: [
      'hamilton_runs', 'hamilton_autopilot_runs', 'hamilton_authorizations',
      'hamilton_blockers', 'hamilton_blocker_resolutions', 'hamilton_saved_sessions',
      'hamilton_payment_authorizations', 'hamilton_attestation_authorizations',
      'hamilton_portal_policies', 'hamilton_resolved_fields', 'hamilton_portal_providers',
      'application_tasks', 'application_missing_info', 'application_portal_links',
      'student_portals',
    ],
    john: ['john_runs', 'john_email_drafts', 'john_email_audit', 'john_suppression_list', 'john_alias_checks'],
  }
  const diagnostics = {}
  for (const [name, tables] of Object.entries(expected)) {
    const presence = {}
    for (const t of tables) presence[t] = await tableExists(db, t)
    diagnostics[name] = {
      missing_tables: tables.filter((t) => !presence[t]),
      present_tables: tables.filter((t) => presence[t]),
    }
  }

  const overall = (() => {
    const states = Object.values(agents).map((a) => a.health)
    if (states.includes(AGENT_HEALTH.ERROR)) return AGENT_HEALTH.ERROR
    if (states.includes(AGENT_HEALTH.WARNING)) return AGENT_HEALTH.WARNING
    if (states.every((s) => s === AGENT_HEALTH.NOT_INSTALLED)) return AGENT_HEALTH.NOT_INSTALLED
    if (states.includes(AGENT_HEALTH.HEALTHY)) return AGENT_HEALTH.HEALTHY
    // No agent did real work, but at least one ran cleanly with zero output:
    // report that honestly rather than collapsing to plain "idle" (never ran).
    if (states.includes(AGENT_HEALTH.RAN_NO_OUTPUT)) return AGENT_HEALTH.RAN_NO_OUTPUT
    return AGENT_HEALTH.IDLE
  })()

  return {
    overall,
    agents,
    diagnostics,
    unified_table_present: await tableExists(db, 'agent_activity_events'),
    rollup_table_present: await tableExists(db, 'agent_daily_rollups'),
    generated_at: new Date().toISOString(),
  }
}

export const __testables = { normalizeRange }

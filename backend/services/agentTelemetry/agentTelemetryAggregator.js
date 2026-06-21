/**
 * Agent Mission Control — per-agent metric extractors.
 *
 * Each `aggregateXxx(db, range)` function returns a stable shape regardless
 * of whether the agent's tables exist. When tables are missing, the function
 * returns `{ installed: false, ... zeros }` so every dashboard panel renders.
 *
 * Reads tables in this priority:
 *   1. Unified `agent_activity_events` (always queried first when present)
 *   2. Agent-specific tables (anya_*, sam_*, robert_*, yana_*, john_*) if they
 *      exist via tableExists() — never assumed to exist.
 *
 * Privacy:
 *   - Never returns email body content for John drafts.
 *   - Never returns Anya message content (only counts + last_at metadata).
 *   - Sam findings exclude `details_json.secrets`-style keys via a redactor.
 */

import { withProfileScope } from '../../middleware/profileContext.js'
import {
  AGENT_HEALTH,
  AGENT_LABELS,
  AGENT_TAGLINES,
  makeEmptyAgentSummary,
} from './agentTelemetryTypes.js'
import {
  tableExists,
  countEventsByAgent,
  readActivityEvents,
  columnsFor,
} from './agentTelemetryStore.js'

const SECRET_KEY_RE = /(secret|token|password|api[-_ ]?key|authorization|bearer)/i

/**
 * Truthy env flag reader (mirrors readEnvBool used by the agent services).
 * Treats '1'/'true'/'yes'/'on' (any case) as true.
 */
function envEnabled(name, defaultValue = false) {
  const raw = process.env[name]
  if (raw === undefined || raw === null || String(raw).trim() === '') return defaultValue
  return /^(1|true|yes|on)$/i.test(String(raw).trim())
}

/**
 * Whether an opt-in background agent is switched ON by the owner. The Mission
 * Control overview badge ("enabled" / "disabled") must reflect the REAL master
 * switch — not merely "tables exist" — otherwise a configured-off agent reads
 * as "enabled" and a configured-on agent (like Yana after YANA_ENABLED=true)
 * can read as "disabled" on stale telemetry. Sam/Anya/Hamilton are always-on
 * operationally, so they stay enabled-when-installed.
 */
const AGENT_MASTER_SWITCH = {
  robert: () => envEnabled('ROBERT_ENABLED', false),
  yana: () => envEnabled('YANA_ENABLED', false),
  john: () => envEnabled('JOHN_ENABLED', false),
}
function agentEnabled(agentName) {
  const fn = AGENT_MASTER_SWITCH[agentName]
  return fn ? fn() : true
}

/** Strip obviously-sensitive keys from a details JSON blob. */
export function redactSecrets(value) {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (typeof value !== 'object') return value
  const out = {}
  for (const k of Object.keys(value)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = '[REDACTED]'
      continue
    }
    out[k] = redactSecrets(value[k])
  }
  return out
}

function pct(n, d) {
  if (!d || d === 0) return null
  return Math.max(0, Math.min(1, n / d))
}

/**
 * Resolve the timestamp column a table actually has, from the live schema.
 *
 * The per-agent run tables (sam_runs, robert_runs, hamilton_runs, john_runs)
 * timestamp with `started_at`; event/candidate tables use `created_at`; some
 * lead tables only have `discovered_at`. The aggregators were originally
 * written assuming `created_at` everywhere, so on Postgres every run-table
 * query threw `column "created_at" does not exist`. Because getHealth fans the
 * aggregators out with Promise.all, a single throw rejected the whole call and
 * the dashboard rendered EVERY agent as "Not installed". Resolving the column
 * from columnsFor() (and zero-filling when none is present) makes each query
 * schema-accurate across dialects and historical schema drift.
 */
function pickTimeCol(cols, preferred = ['started_at', 'created_at', 'discovered_at', 'completed_at']) {
  for (const c of preferred) if (cols && cols.has(c)) return c
  return null
}

function deriveHealth({ installed, last_failure_at, last_success_at, error_count }) {
  if (!installed) return AGENT_HEALTH.NOT_INSTALLED
  if (error_count > 0 && last_failure_at && (!last_success_at || last_failure_at > last_success_at)) {
    return AGENT_HEALTH.ERROR
  }
  if (error_count > 0) return AGENT_HEALTH.WARNING
  if (!last_success_at) return AGENT_HEALTH.IDLE
  return AGENT_HEALTH.HEALTHY
}

async function unifiedAgentBase(db, agent, range) {
  const events = await countEventsByAgent(db, range)
  const row = events.find((r) => r.agent_name === agent) || null
  const total = Number(row?.total || 0)
  const succ = Number(row?.succeeded || 0)
  const failed = Number(row?.failed || 0)
  return {
    actions_in_window: total,
    success_rate: pct(succ, total),
    error_count: failed,
    last_run_at: row?.last_at || null,
    last_success_at: row?.last_success_at || null,
    last_failure_at: row?.last_failure_at || null,
  }
}

/** ─── ANYA ──────────────────────────────────────────────────────────────── */

export async function aggregateAnya(db, range) {
  const sessions = await tableExists(db, 'anya_sessions')
  const messages = await tableExists(db, 'anya_messages')
  const tools = await tableExists(db, 'anya_tool_usage')
  const runs = await tableExists(db, 'anya_runs')

  const installed = sessions || messages || tools || runs
  const out = makeEmptyAgentSummary('anya')
  if (!installed) return out
  out.installed = true
  out.notes = []

  const since = range.startIso
  const base = await unifiedAgentBase(db, 'anya', range)
  Object.assign(out, base)

  return withProfileScope({ bypass: true }, async () => {
    if (sessions) {
      const r = await db
        .prepare('SELECT COUNT(*) AS n FROM anya_sessions WHERE created_at >= ?')
        .get(since)
      out.primary_metrics.active_sessions = Number(r?.n || 0)
    }
    if (messages) {
      const r = await db
        .prepare('SELECT COUNT(*) AS n FROM anya_messages WHERE created_at >= ?')
        .get(since)
      out.primary_metrics.interactions = Number(r?.n || 0)
    }
    if (tools) {
      const r = await db
        .prepare('SELECT COUNT(*) AS n FROM anya_tool_usage WHERE created_at >= ?')
        .get(since)
      out.primary_metrics.tool_invocations = Number(r?.n || 0)
    }
    if (runs) {
      const r = await db
        .prepare('SELECT COUNT(DISTINCT user_id) AS n FROM anya_runs WHERE created_at >= ? AND user_id IS NOT NULL')
        .get(since)
      out.primary_metrics.unique_users = Number(r?.n || 0)
      const lastRun = await db
        .prepare("SELECT created_at, status FROM anya_runs ORDER BY created_at DESC LIMIT 1")
        .get()
      if (lastRun?.created_at && !out.last_run_at) out.last_run_at = lastRun.created_at
      if (lastRun?.status === 'completed' && !out.last_success_at) out.last_success_at = lastRun.created_at
      if (lastRun?.status === 'failed' && !out.last_failure_at) out.last_failure_at = lastRun.created_at
      const errs = await db
        .prepare("SELECT COUNT(*) AS n FROM anya_runs WHERE status = 'failed' AND created_at >= ?")
        .get(since)
      if (Number(errs?.n || 0) > out.error_count) out.error_count = Number(errs.n)
    }
    out.enabled = true
    out.tagline = AGENT_TAGLINES.anya
    out.label = AGENT_LABELS.anya
    out.health = deriveHealth(out)
    return out
  })
}

/** Anya panel — list of recent users (metadata only, no message content). */
export async function aggregateAnyaInteractions(db, range) {
  const out = {
    installed: false,
    sessions_count: 0,
    interactions: 0,
    tool_invocations: 0,
    unique_users: 0,
    recent_users: [],
    most_used_tools: [],
    modes: {},
    notes: [],
  }
  const sessions = await tableExists(db, 'anya_sessions')
  const messages = await tableExists(db, 'anya_messages')
  const tools = await tableExists(db, 'anya_tool_usage')
  const runs = await tableExists(db, 'anya_runs')
  if (!sessions && !messages && !tools && !runs) {
    out.notes.push('No anya_* tables found.')
    return out
  }
  out.installed = true
  const since = range.startIso

  return withProfileScope({ bypass: true }, async () => {
    if (sessions) {
      const s = await db.prepare('SELECT COUNT(*) AS n FROM anya_sessions WHERE created_at >= ?').get(since)
      out.sessions_count = Number(s?.n || 0)
      const recent = await db.prepare(`
        SELECT user_id, profile_id, MAX(created_at) AS last_at, COUNT(*) AS sessions
          FROM anya_sessions
         WHERE created_at >= ? AND user_id IS NOT NULL
         GROUP BY user_id, profile_id
         ORDER BY last_at DESC
         LIMIT 25
      `).all(since)
      out.recent_users = recent.map((r) => ({
        user_id: r.user_id,
        profile_id: r.profile_id || null,
        sessions: Number(r.sessions || 0),
        last_at: r.last_at,
      }))
      out.unique_users = recent.length
    }
    if (messages) {
      const m = await db.prepare('SELECT COUNT(*) AS n FROM anya_messages WHERE created_at >= ?').get(since)
      out.interactions = Number(m?.n || 0)
    }
    if (tools) {
      const t = await db.prepare('SELECT COUNT(*) AS n FROM anya_tool_usage WHERE created_at >= ?').get(since)
      out.tool_invocations = Number(t?.n || 0)
      const top = await db.prepare(`
        SELECT tool_name, COUNT(*) AS uses
          FROM anya_tool_usage
         WHERE created_at >= ? AND tool_name IS NOT NULL
         GROUP BY tool_name
         ORDER BY uses DESC
         LIMIT 10
      `).all(since)
      out.most_used_tools = top.map((r) => ({ tool: r.tool_name, uses: Number(r.uses || 0) }))
    }
    if (runs) {
      const m = await db.prepare(`
        SELECT mode, COUNT(*) AS n
          FROM anya_runs
         WHERE created_at >= ? AND mode IS NOT NULL
         GROUP BY mode
      `).all(since)
      const modes = {}
      for (const row of m) modes[row.mode] = Number(row.n || 0)
      out.modes = modes
    }
    return out
  })
}

/** ─── SAM ───────────────────────────────────────────────────────────────── */

export async function aggregateSam(db, range) {
  const out = makeEmptyAgentSummary('sam')
  out.label = AGENT_LABELS.sam
  out.tagline = AGENT_TAGLINES.sam
  const runs = await tableExists(db, 'sam_runs')
  const findings = await tableExists(db, 'sam_findings')
  const installed = runs || findings
  if (!installed) return out
  out.installed = true
  out.enabled = true
  out.notes = []
  Object.assign(out, await unifiedAgentBase(db, 'sam', range))

  const since = range.startIso

  return withProfileScope({ bypass: true }, async () => {
    try {
      if (runs) {
        const tcol = pickTimeCol(new Set(await columnsFor(db, 'sam_runs')))
        if (tcol) {
          const r = await db.prepare(`SELECT COUNT(*) AS n, MAX(${tcol}) AS last_at FROM sam_runs WHERE ${tcol} >= ?`).get(since)
          out.primary_metrics.checks_run = Number(r?.n || 0)
          if (r?.last_at && !out.last_run_at) out.last_run_at = r.last_at
          const ls = await db.prepare(`SELECT MAX(${tcol}) AS last_success_at FROM sam_runs WHERE status = 'succeeded' OR status = 'completed'`).get()
          if (ls?.last_success_at && !out.last_success_at) out.last_success_at = ls.last_success_at
        }
      }
      if (findings) {
        const fcols = new Set(await columnsFor(db, 'sam_findings'))
        const ftcol = pickTimeCol(fcols)
        // Scope severity metrics to the LATEST Sam run so the card reflects the
        // current audit state. Sam re-audits from scratch every cycle, so
        // counting every finding in the time window made the totals grow
        // unboundedly run-over-run (the "16 -> 32 Tool invocation failed" creep).
        let scopeClause = `${ftcol} >= ?`
        let scopeArg = since
        if (runs && fcols.has('sam_run_id')) {
          const rtcol = pickTimeCol(new Set(await columnsFor(db, 'sam_runs')))
          if (rtcol) {
            const lr = await db.prepare(`SELECT id FROM sam_runs ORDER BY ${rtcol} DESC LIMIT 1`).get()
            if (lr?.id) { scopeClause = 'sam_run_id = ?'; scopeArg = lr.id }
          }
        }
        if ((ftcol || scopeClause.startsWith('sam_run_id')) && fcols.has('severity')) {
          const sev = await db.prepare(`SELECT severity, COUNT(*) AS n FROM sam_findings WHERE ${scopeClause} GROUP BY severity`).all(scopeArg)
          const map = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
          for (const row of sev) if (map[row.severity] !== undefined) map[row.severity] = Number(row.n || 0)
          out.primary_metrics.errors_found = map.critical + map.high + map.medium + map.low
          out.primary_metrics.critical_errors = map.critical
          out.primary_metrics.severity_breakdown = map

          if (fcols.has('status')) {
            const resolved = await db.prepare(`SELECT COUNT(*) AS n FROM sam_findings WHERE status = 'resolved' AND ${scopeClause}`).get(scopeArg)
            out.primary_metrics.errors_resolved = Number(resolved?.n || 0)
          }
          if (fcols.has('event_type')) {
            const failedGates = await db.prepare(`SELECT COUNT(*) AS n FROM sam_findings WHERE event_type = 'gate_failed' AND ${scopeClause}`).get(scopeArg)
            out.primary_metrics.failed_gates = Number(failedGates?.n || 0)
          }
        }
      }
    } catch (err) {
      out.notes = [...(out.notes || []), `metrics unavailable: ${err?.message || err}`]
    }
    out.error_count = Number(out.primary_metrics.errors_found || 0)
    out.health = deriveHealth(out)
    return out
  })
}

/** Sam panel — flat list of findings with secrets redacted. */
export async function aggregateSamFindings(db, range, { severity, status, limit = 100 } = {}) {
  const out = { installed: false, findings: [], counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, notes: [] }
  const findings = await tableExists(db, 'sam_findings')
  if (!findings) {
    out.notes.push('sam_findings table not present.')
    return out
  }
  out.installed = true

  const filters = ['created_at >= ?']
  const args = [range.startIso]
  if (severity) { filters.push('severity = ?'); args.push(String(severity)) }
  if (status) { filters.push('status = ?'); args.push(String(status)) }

  return withProfileScope({ bypass: true }, async () => {
    const rows = await db.prepare(`
      SELECT id, severity, status, title, file_path, created_at, details_json
        FROM sam_findings
       WHERE ${filters.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ?
    `).all(...args, Math.min(Math.max(Number(limit) || 100, 1), 500))

    out.findings = rows.map((r) => {
      let details = null
      try {
        details = r.details_json ? (typeof r.details_json === 'string' ? JSON.parse(r.details_json) : r.details_json) : null
      } catch { details = null }
      return {
        id: r.id,
        severity: r.severity,
        status: r.status,
        title: r.title,
        file_path: r.file_path,
        created_at: r.created_at,
        details: redactSecrets(details),
      }
    })
    const sev = await db.prepare(`
      SELECT severity, COUNT(*) AS n FROM sam_findings WHERE created_at >= ? GROUP BY severity
    `).all(range.startIso)
    for (const s of sev) if (out.counts[s.severity] !== undefined) out.counts[s.severity] = Number(s.n || 0)
    return out
  })
}

/** ─── ROBERT ────────────────────────────────────────────────────────────── */

export async function aggregateRobert(db, range) {
  const out = makeEmptyAgentSummary('robert')
  out.label = AGENT_LABELS.robert
  out.tagline = AGENT_TAGLINES.robert

  const runs = await tableExists(db, 'robert_runs')
  const candidates = await tableExists(db, 'robert_opportunity_candidates')
  const recs = await tableExists(db, 'robert_profile_recommendations')
  const installed = runs || candidates || recs
  if (!installed) return out
  out.installed = true
  out.enabled = agentEnabled('robert')
  out.notes = []
  Object.assign(out, await unifiedAgentBase(db, 'robert', range))

  const since = range.startIso

  return withProfileScope({ bypass: true }, async () => {
    try {
      if (runs) {
        const rcols = new Set(await columnsFor(db, 'robert_runs'))
        const rtcol = pickTimeCol(rcols)
        if (rtcol) {
          // The canonical schema names the column `sources_considered`; fall
          // back to a legacy `sources_checked` if an old DB still has it.
          const srcCol = rcols.has('sources_considered') ? 'sources_considered'
            : (rcols.has('sources_checked') ? 'sources_checked' : null)
          if (srcCol) {
            const r = await db.prepare(`SELECT COALESCE(SUM(${srcCol}),0) AS n FROM robert_runs WHERE ${rtcol} >= ?`).get(since)
            out.primary_metrics.sources_checked = Number(r?.n || 0)
          }
          if (rcols.has('candidates_found')) {
            const cf = await db.prepare(`SELECT COALESCE(SUM(candidates_found),0) AS n FROM robert_runs WHERE ${rtcol} >= ?`).get(since)
            out.primary_metrics.opportunities_found = Number(cf?.n || 0)
          }
        }
      }
      if (candidates) {
        const ccols = new Set(await columnsFor(db, 'robert_opportunity_candidates'))
        const ctcol = pickTimeCol(ccols)
        if (ctcol) {
          if (!out.primary_metrics.opportunities_found) {
            const r = await db.prepare(`SELECT COUNT(*) AS n FROM robert_opportunity_candidates WHERE ${ctcol} >= ?`).get(since)
            out.primary_metrics.opportunities_found = Number(r?.n || 0)
          }
          const v = await db.prepare(`SELECT COUNT(*) AS n FROM robert_opportunity_candidates WHERE verification_status = 'verified' AND ${ctcol} >= ?`).get(since)
          out.primary_metrics.opportunities_verified = Number(v?.n || 0)
          const ing = await db.prepare(`SELECT COUNT(*) AS n FROM robert_opportunity_candidates WHERE ingested_opportunity_id IS NOT NULL AND ${ctcol} >= ?`).get(since)
          out.primary_metrics.opportunities_ingested = Number(ing?.n || 0)

          // The candidate table's rejection reason lives in
          // `policy_rejection_reason`; tolerate a legacy `rejection_reason`.
          const rejCol = ccols.has('policy_rejection_reason') ? 'policy_rejection_reason'
            : (ccols.has('rejection_reason') ? 'rejection_reason' : null)
          if (rejCol) {
            const rejBreakdown = await db.prepare(`
              SELECT ${rejCol} AS reason, COUNT(*) AS n
                FROM robert_opportunity_candidates
               WHERE ${ctcol} >= ? AND ${rejCol} IS NOT NULL
               GROUP BY ${rejCol}
            `).all(since)
            const rej = {}
            for (const row of rejBreakdown) rej[row.reason] = Number(row.n || 0)
            out.primary_metrics.rejection_reasons = rej
          }
        }
      }
      if (recs) {
        const pcols = new Set(await columnsFor(db, 'robert_profile_recommendations'))
        const ptcol = pickTimeCol(pcols)
        if (ptcol) {
          const total = await db.prepare(`SELECT COUNT(*) AS n FROM robert_profile_recommendations WHERE ${ptcol} >= ?`).get(since)
          out.primary_metrics.profile_recommendations = Number(total?.n || 0)
          const acc = await db.prepare(`SELECT COUNT(*) AS n FROM robert_profile_recommendations WHERE recommendation_status = 'accepted' AND ${ptcol} >= ?`).get(since)
          out.primary_metrics.pipeline_acceptances = Number(acc?.n || 0)
          out.primary_metrics.general_pool_only = Math.max(
            0,
            Number(out.primary_metrics.opportunities_verified || 0) - Number(out.primary_metrics.profile_recommendations || 0),
          )
        }
      }
    } catch (err) {
      out.notes = [...(out.notes || []), `metrics unavailable: ${err?.message || err}`]
    }
    out.health = deriveHealth(out)
    return out
  })
}

/** Robert funnel data (ordered counts for the dashboard chart). */
export async function aggregateRobertFunnel(db, range) {
  const summary = await aggregateRobert(db, range)
  const m = summary.primary_metrics
  return {
    installed: summary.installed,
    funnel: [
      { stage: 'sources_checked', label: 'Sources checked', value: Number(m.sources_checked || 0) },
      { stage: 'candidates_found', label: 'Candidates found', value: Number(m.opportunities_found || 0) },
      { stage: 'verified', label: 'Verified', value: Number(m.opportunities_verified || 0) },
      { stage: 'ingested', label: 'Ingested', value: Number(m.opportunities_ingested || 0) },
      { stage: 'matched_profiles', label: 'Profile recs', value: Number(m.profile_recommendations || 0) },
      { stage: 'accepted', label: 'Accepted', value: Number(m.pipeline_acceptances || 0) },
    ],
    rejection_reasons: m.rejection_reasons || {},
  }
}

/** Robert opportunity map — group ingested opportunities by location. */
export async function aggregateRobertMap(db, range) {
  const out = { installed: false, by_state: [], by_city: [], unknown_count: 0, notes: [] }
  const candidates = await tableExists(db, 'robert_opportunity_candidates')
  if (!candidates) {
    out.notes.push('robert_opportunity_candidates table not present.')
    return out
  }
  out.installed = true
  const since = range.startIso

  return withProfileScope({ bypass: true }, async () => {
    const cols = (await columnsFor(db, 'robert_opportunity_candidates')).reduce((s, c) => (s.add(c), s), new Set())
    const hasCity = cols.has('city')
    const hasState = cols.has('state')
    const hasLat = cols.has('latitude')
    const hasLng = cols.has('longitude')
    const hasCategory = cols.has('category')
    const tcol = pickTimeCol(cols)
    if (!tcol) return out

    const rows = await db.prepare(`
      SELECT
        ${hasCity ? 'city' : 'NULL AS city'},
        ${hasState ? 'state' : 'NULL AS state'},
        ${hasLat ? 'latitude' : 'NULL AS latitude'},
        ${hasLng ? 'longitude' : 'NULL AS longitude'},
        ${hasCategory ? 'category' : 'NULL AS category'},
        title,
        ingested_opportunity_id,
        ${tcol} AS created_at
      FROM robert_opportunity_candidates
      WHERE ingested_opportunity_id IS NOT NULL AND ${tcol} >= ?
      ORDER BY ${tcol} DESC
      LIMIT 5000
    `).all(since)

    const byState = new Map()
    const byCity = new Map()
    let unknown = 0
    for (const r of rows) {
      const state = (r.state || '').trim().toUpperCase() || null
      const city = (r.city || '').trim() || null
      if (!state && !city && !r.latitude && !r.longitude) {
        unknown += 1
        continue
      }
      if (state) {
        if (!byState.has(state)) byState.set(state, { state, count: 0, categories: {}, examples: [] })
        const e = byState.get(state)
        e.count += 1
        if (r.category) e.categories[r.category] = (e.categories[r.category] || 0) + 1
        if (e.examples.length < 5 && r.title) {
          e.examples.push({ title: r.title, opportunity_id: r.ingested_opportunity_id, created_at: r.created_at })
        }
      }
      if (state && city) {
        const key = `${state}|${city}`
        if (!byCity.has(key)) byCity.set(key, { state, city, count: 0, latitude: r.latitude || null, longitude: r.longitude || null })
        byCity.get(key).count += 1
      }
    }
    out.by_state = Array.from(byState.values()).sort((a, b) => b.count - a.count)
    out.by_city = Array.from(byCity.values()).sort((a, b) => b.count - a.count).slice(0, 200)
    out.unknown_count = unknown
    return out
  })
}

/** ─── YANA ──────────────────────────────────────────────────────────────── */

export async function aggregateYana(db, range) {
  const out = makeEmptyAgentSummary('yana')
  out.label = AGENT_LABELS.yana
  out.tagline = AGENT_TAGLINES.yana

  // yana_runs was historically a compatibility table; it has been
  // renamed to hamilton_runs as part of the autopilot agent split.
  // We still attempt yana_runs first so older databases that have not
  // applied the rename migration keep producing telemetry, then fall
  // through to hamilton_runs.
  const yanaRunsTable = (await tableExists(db, 'yana_runs')) ? 'yana_runs'
    : ((await tableExists(db, 'hamilton_runs')) ? 'hamilton_runs' : null)
  const leads = await tableExists(db, 'yana_lead_candidates')
  const johnQ = await tableExists(db, 'yana_john_queue')
  const larryQ = await tableExists(db, 'yana_larry_queue')
  const installed = !!yanaRunsTable || leads || johnQ || larryQ
  if (!installed) return out
  out.installed = true
  out.enabled = agentEnabled('yana')
  out.notes = []
  Object.assign(out, await unifiedAgentBase(db, 'yana', range))

  const since = range.startIso

  return withProfileScope({ bypass: true }, async () => {
    try {
      if (yanaRunsTable) {
        const rcols = new Set(await columnsFor(db, yanaRunsTable))
        const rtcol = pickTimeCol(rcols)
        if (rtcol) {
          if (rcols.has('urls_fetched')) {
            const u = await db.prepare(`SELECT COALESCE(SUM(urls_fetched),0) AS n FROM ${yanaRunsTable} WHERE ${rtcol} >= ?`).get(since)
            out.primary_metrics.websites_checked = Number(u?.n || 0)
          }
          if (rcols.has('leads_found')) {
            const lf = await db.prepare(`SELECT COALESCE(SUM(leads_found),0) AS n FROM ${yanaRunsTable} WHERE ${rtcol} >= ?`).get(since)
            out.primary_metrics.leads_found = Number(lf?.n || 0)
          }
        }
      }
      if (leads) {
        const lcols = new Set(await columnsFor(db, 'yana_lead_candidates'))
        const ltcol = pickTimeCol(lcols)
        if (ltcol) {
          if (!out.primary_metrics.leads_found) {
            const r = await db.prepare(`SELECT COUNT(*) AS n FROM yana_lead_candidates WHERE ${ltcol} >= ?`).get(since)
            out.primary_metrics.leads_found = Number(r?.n || 0)
          }
          if (lcols.has('qualification_status')) {
            const q = await db.prepare(`SELECT COUNT(*) AS n FROM yana_lead_candidates WHERE qualification_status = 'qualified' AND ${ltcol} >= ?`).get(since)
            out.primary_metrics.leads_qualified = Number(q?.n || 0)
            // Lead candidates have no single rejection_reason column; the count
            // of non-qualified leads is the closest stable signal.
            const rejected = await db.prepare(`SELECT COUNT(*) AS n FROM yana_lead_candidates WHERE qualification_status = 'rejected' AND ${ltcol} >= ?`).get(since)
            out.primary_metrics.leads_rejected = Number(rejected?.n || 0)
          }
        }
      }
      if (johnQ) {
        const jcols = new Set(await columnsFor(db, 'yana_john_queue'))
        const jtcol = pickTimeCol(jcols)
        if (jtcol) {
          const r = await db.prepare(`SELECT COUNT(*) AS n FROM yana_john_queue WHERE ${jtcol} >= ?`).get(since)
          out.primary_metrics.leads_sent_to_john = Number(r?.n || 0)
        }
      } else if (leads) {
        // Fallback: count leads flagged as pushed to John directly on the
        // lead-candidates table when the dedicated queue table is absent.
        const lcols = new Set(await columnsFor(db, 'yana_lead_candidates'))
        const ltcol = pickTimeCol(lcols)
        if (ltcol && lcols.has('pushed_to_john')) {
          // pushed_to_john is stored as an integer flag (0/1). Comparing it to a
          // boolean literal (`= TRUE`) throws `operator does not exist:
          // integer = boolean` on Postgres — compare to 1 so it's valid on both
          // SQLite and Postgres.
          const r = await db.prepare(`SELECT COUNT(*) AS n FROM yana_lead_candidates WHERE pushed_to_john = 1 AND ${ltcol} >= ?`).get(since)
          out.primary_metrics.leads_sent_to_john = Number(r?.n || 0)
        } else {
          out.primary_metrics.leads_sent_to_john = 0
        }
      } else {
        out.primary_metrics.leads_sent_to_john = 0
      }
      out.primary_metrics.lead_conversion_rate = pct(
        Number(out.primary_metrics.leads_sent_to_john || 0),
        Number(out.primary_metrics.websites_checked || 0),
      )
    } catch (err) {
      out.notes = [...(out.notes || []), `metrics unavailable: ${err?.message || err}`]
    }
    out.health = deriveHealth(out)
    return out
  })
}

/** ─── HAMILTON ──────────────────────────────────────────────────────────── */

/**
 * Hamilton — Application Autopilot / Funding Completion. Reads from
 * hamilton_runs, hamilton_autopilot_runs, hamilton_blockers, and
 * application_tasks (the unified task table Hamilton drives).
 */
export async function aggregateHamilton(db, range) {
  const out = makeEmptyAgentSummary('hamilton')
  out.label = AGENT_LABELS.hamilton
  out.tagline = AGENT_TAGLINES.hamilton

  const runsTable = (await tableExists(db, 'hamilton_runs')) ? 'hamilton_runs'
    : ((await tableExists(db, 'yana_runs')) ? 'yana_runs' : null)
  const autopilotRunsTable = (await tableExists(db, 'hamilton_autopilot_runs')) ? 'hamilton_autopilot_runs'
    : ((await tableExists(db, 'yana_autopilot_runs')) ? 'yana_autopilot_runs' : null)
  const blockersTable = (await tableExists(db, 'hamilton_blockers')) ? 'hamilton_blockers'
    : ((await tableExists(db, 'yana_blockers')) ? 'yana_blockers' : null)
  const tasksTable = (await tableExists(db, 'application_tasks')) ? 'application_tasks' : null

  const installed = !!(runsTable || autopilotRunsTable || blockersTable || tasksTable)
  if (!installed) return out
  out.installed = true
  out.enabled = true
  out.notes = []
  Object.assign(out, await unifiedAgentBase(db, 'hamilton', range))

  const since = range.startIso

  return withProfileScope({ bypass: true }, async () => {
    try {
      if (runsTable) {
        // The legacy yana_runs schema only has lead-discovery columns; Hamilton
        // metrics live in the autopilot-specific columns we added in migration
        // 085. Probe the column list so that older databases / tests without
        // those columns still produce a useful (zero-filled) summary.
        const cols = new Set(await columnsFor(db, runsTable))
        const rtcol = pickTimeCol(cols)
        const sumIfPresent = async (col, key) => {
          if (!cols.has(col) || !rtcol) { out.primary_metrics[key] = 0; return }
          const r = await db.prepare(`SELECT COALESCE(SUM(${col}),0) AS n FROM ${runsTable} WHERE ${rtcol} >= ?`).get(since)
          out.primary_metrics[key] = Number(r?.n || 0)
        }
        await sumIfPresent('fields_filled', 'fields_filled')
        await sumIfPresent('drafts_completed', 'drafts_completed')
        await sumIfPresent('submissions_completed', 'submissions_completed')
        await sumIfPresent('blocked_safety', 'blocked_safety')
      }
      if (autopilotRunsTable) {
        const acols = new Set(await columnsFor(db, autopilotRunsTable))
        const atcol = pickTimeCol(acols)
        if (atcol && acols.has('status')) {
          const finished = await db.prepare(`SELECT status, COUNT(*) AS n FROM ${autopilotRunsTable} WHERE ${atcol} >= ? GROUP BY status`).all(since)
          const map = {}
          for (const row of finished) map[row.status] = Number(row.n || 0)
          out.primary_metrics.autopilot_runs_by_status = map
          out.primary_metrics.autopilot_total = Object.values(map).reduce((a, b) => a + b, 0)
        }
      }
      if (blockersTable) {
        const bcols = new Set(await columnsFor(db, blockersTable))
        if (bcols.has('resolved_at')) {
          const open = await db.prepare(`SELECT COUNT(*) AS n FROM ${blockersTable} WHERE resolved_at IS NULL`).get()
          out.primary_metrics.open_blockers = Number(open?.n || 0)
          if (bcols.has('admin_required')) {
            const adminOpen = await db.prepare(`SELECT COUNT(*) AS n FROM ${blockersTable} WHERE resolved_at IS NULL AND admin_required = TRUE`).get()
            out.primary_metrics.open_blockers_admin = Number(adminOpen?.n || 0)
          }
          if (bcols.has('blocker_type')) {
            const byType = await db.prepare(`SELECT blocker_type, COUNT(*) AS n FROM ${blockersTable} WHERE resolved_at IS NULL GROUP BY blocker_type`).all()
            const tmap = {}
            for (const row of byType) tmap[row.blocker_type] = Number(row.n || 0)
            out.primary_metrics.open_blockers_by_type = tmap
          }
        }
      }
      if (tasksTable) {
        const byStatus = await db.prepare(`SELECT status, COUNT(*) AS n FROM ${tasksTable} GROUP BY status`).all()
        const tmap = {}
        for (const row of byStatus) tmap[row.status] = Number(row.n || 0)
        out.primary_metrics.application_tasks_by_status = tmap
      }
    } catch (err) {
      out.notes = [...(out.notes || []), `metrics unavailable: ${err?.message || err}`]
    }
    out.health = deriveHealth(out)
    return out
  })
}

/** Yana funnel data — websites → leads → qualified → John drafts. */
export async function aggregateYanaFunnel(db, range) {
  const yana = await aggregateYana(db, range)
  const john = await aggregateJohn(db, range)
  const m = yana.primary_metrics
  return {
    installed: yana.installed || john.installed,
    funnel: [
      { stage: 'websites_checked', label: 'Websites checked', value: Number(m.websites_checked || 0) },
      { stage: 'leads_found', label: 'Lead candidates', value: Number(m.leads_found || 0) },
      { stage: 'leads_qualified', label: 'Qualified', value: Number(m.leads_qualified || 0) },
      { stage: 'leads_sent_to_john', label: 'Sent to John', value: Number(m.leads_sent_to_john || 0) },
      { stage: 'john_drafts', label: 'John drafts', value: Number(john.primary_metrics.drafts_created || 0) },
    ],
    rejection_reasons: m.rejection_reasons || {},
  }
}

/** ─── JOHN ──────────────────────────────────────────────────────────────── */

const JOHN_DAILY_CAP = Number(process.env.JOHN_MAX_DRAFTS_PER_24H || 50)

export async function aggregateJohn(db, range) {
  const out = makeEmptyAgentSummary('john')
  out.label = AGENT_LABELS.john
  out.tagline = AGENT_TAGLINES.john

  const drafts = await tableExists(db, 'john_email_drafts')
  const audit = await tableExists(db, 'john_email_audit')
  const runs = await tableExists(db, 'john_runs')
  const supp = await tableExists(db, 'john_suppression_list')
  const aliasChecks = await tableExists(db, 'john_alias_checks')
  const installed = drafts || audit || runs
  if (!installed) {
    out.primary_metrics.daily_capacity_remaining = JOHN_DAILY_CAP
    return out
  }
  out.installed = true
  out.enabled = agentEnabled('john')
  out.notes = []
  Object.assign(out, await unifiedAgentBase(db, 'john', range))

  const since = range.startIso
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  return withProfileScope({ bypass: true }, async () => {
    try {
      if (drafts) {
        const dcols = new Set(await columnsFor(db, 'john_email_drafts'))
        const dtcol = pickTimeCol(dcols)
        const hasBlockReason = dcols.has('block_reason')
        if (dtcol) {
          const created = await db.prepare(`
            SELECT COUNT(*) AS n FROM john_email_drafts
             WHERE draft_status IN ('created','needs_review','needs_sender_alias_review') AND ${dtcol} >= ?
          `).get(since)
          out.primary_metrics.drafts_created = Number(created?.n || 0)

          const blocked = await db.prepare(`SELECT COUNT(*) AS n FROM john_email_drafts WHERE draft_status = 'blocked' AND ${dtcol} >= ?`).get(since)
          out.primary_metrics.drafts_blocked = Number(blocked?.n || 0)

          const aliasReview = await db.prepare(`SELECT COUNT(*) AS n FROM john_email_drafts WHERE draft_status = 'needs_sender_alias_review' AND ${dtcol} >= ?`).get(since)
          out.primary_metrics.drafts_needing_alias_review = Number(aliasReview?.n || 0)

          const created24 = await db.prepare(`
            SELECT COUNT(*) AS n FROM john_email_drafts
             WHERE draft_status IN ('created','needs_review','needs_sender_alias_review') AND ${dtcol} >= ?
          `).get(dayAgo)
          const used = Number(created24?.n || 0)
          out.primary_metrics.drafts_created_24h = used
          out.primary_metrics.daily_capacity_remaining = Math.max(0, JOHN_DAILY_CAP - used)
          out.primary_metrics.daily_capacity_total = JOHN_DAILY_CAP

          // `block_reason` is an optional/legacy column; the canonical schema
          // keeps block detail inside safety_report_json instead.
          if (hasBlockReason) {
            const blocks = await db.prepare(`
              SELECT block_reason, COUNT(*) AS n FROM john_email_drafts
               WHERE draft_status = 'blocked' AND block_reason IS NOT NULL AND ${dtcol} >= ?
               GROUP BY block_reason
            `).all(since)
            const blockMap = {}
            for (const r of blocks) blockMap[r.block_reason] = Number(r.n || 0)
            out.primary_metrics.block_reasons = blockMap

            if (supp) {
              const hits = await db.prepare(`
                SELECT COUNT(*) AS n FROM john_email_drafts
                 WHERE block_reason = 'suppressed' AND ${dtcol} >= ?
              `).get(since)
              out.primary_metrics.suppression_hits = Number(hits?.n || 0)
            }
          }
        }
      }
      if (aliasChecks) {
        const acols = new Set(await columnsFor(db, 'john_alias_checks'))
        // The john_alias_checks table has no `alias_status` column — selecting
        // it threw `column "alias_status" does not exist`. Derive a status from
        // the columns that DO exist (alias_verified / alias_send_supported),
        // selecting only present columns.
        if (acols.has('checked_at')) {
          const selCols = ['checked_at']
          if (acols.has('alias_status')) selCols.push('alias_status')
          if (acols.has('alias_verified')) selCols.push('alias_verified')
          if (acols.has('alias_send_supported')) selCols.push('alias_send_supported')
          const last = await db.prepare(`SELECT ${selCols.join(', ')} FROM john_alias_checks ORDER BY checked_at DESC LIMIT 1`).get()
          out.primary_metrics.alias_status = last?.alias_status
            || (last?.alias_verified
              ? (last?.alias_send_supported ? 'verified' : 'verified_no_send')
              : (last ? 'unverified' : 'unknown'))
          out.primary_metrics.alias_checked_at = last?.checked_at || null
        }
      }
    } catch (err) {
      out.notes = [...(out.notes || []), `metrics unavailable: ${err?.message || err}`]
    }
    out.health = deriveHealth(out)
    return out
  })
}

/** ─── TIMELINE ─────────────────────────────────────────────────────────── */

/**
 * Timeline = unified `agent_activity_events` rows when present, falling back
 * to synthetic events derived from per-agent tables for older deployments.
 */
export async function aggregateTimeline(db, range, { agent, status, profile_id, state, limit = 200 } = {}) {
  const events = await readActivityEvents(db, {
    agent,
    status,
    profile_id,
    state,
    startIso: range.startIso,
    endIso: range.endIso,
    limit,
  })
  if (events.length) return { events, source: 'unified' }

  const synth = []
  if (await tableExists(db, 'john_email_drafts')) {
    const rows = await withProfileScope({ bypass: true }, async () => db
      .prepare(`SELECT id, created_at, draft_status, organization_name, recipient_email FROM john_email_drafts WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?`)
      .all(range.startIso, Math.min(limit, 100)))
    for (const r of rows) {
      synth.push({
        id: r.id,
        agent_name: 'john',
        event_type: r.draft_status === 'blocked' ? 'draft_blocked' : 'draft_created',
        status: r.draft_status === 'blocked' ? 'blocked' : 'succeeded',
        severity: r.draft_status === 'blocked' ? 'medium' : 'info',
        title: r.draft_status === 'blocked' ? 'Outreach draft blocked' : 'Outreach draft created',
        description: r.organization_name || null,
        created_at: r.created_at,
      })
    }
  }
  if (await tableExists(db, 'anya_runs')) {
    const rows = await withProfileScope({ bypass: true }, async () => db
      .prepare(`SELECT id, created_at, status, mode, tool_name FROM anya_runs WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?`)
      .all(range.startIso, Math.min(limit, 100)))
    for (const r of rows) {
      synth.push({
        id: r.id,
        agent_name: 'anya',
        event_type: r.tool_name ? 'tool_invoked' : 'session_message',
        status: r.status === 'completed' ? 'succeeded' : r.status,
        severity: r.status === 'failed' ? 'high' : 'info',
        title: r.tool_name ? `Anya invoked ${r.tool_name}` : `Anya ${r.mode || 'copilot'}`,
        description: null,
        created_at: r.created_at,
      })
    }
  }
  synth.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  return { events: synth.slice(0, limit), source: 'synthetic' }
}

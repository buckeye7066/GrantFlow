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
    if (runs) {
      const r = await db.prepare("SELECT COUNT(*) AS n, MAX(created_at) AS last_at FROM sam_runs WHERE created_at >= ?").get(since)
      out.primary_metrics.checks_run = Number(r?.n || 0)
      if (r?.last_at && !out.last_run_at) out.last_run_at = r.last_at
      const ls = await db.prepare("SELECT MAX(created_at) AS last_success_at FROM sam_runs WHERE status = 'succeeded' OR status = 'completed'").get()
      if (ls?.last_success_at && !out.last_success_at) out.last_success_at = ls.last_success_at
    }
    if (findings) {
      const sev = await db.prepare(`
        SELECT severity, COUNT(*) AS n FROM sam_findings WHERE created_at >= ? GROUP BY severity
      `).all(since)
      const map = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
      for (const row of sev) if (map[row.severity] !== undefined) map[row.severity] = Number(row.n || 0)
      out.primary_metrics.errors_found = map.critical + map.high + map.medium + map.low
      out.primary_metrics.critical_errors = map.critical
      out.primary_metrics.severity_breakdown = map

      const resolved = await db.prepare("SELECT COUNT(*) AS n FROM sam_findings WHERE status = 'resolved' AND created_at >= ?").get(since)
      out.primary_metrics.errors_resolved = Number(resolved?.n || 0)

      const failedGates = await db.prepare("SELECT COUNT(*) AS n FROM sam_findings WHERE event_type = 'gate_failed' AND created_at >= ?").get(since)
      out.primary_metrics.failed_gates = Number(failedGates?.n || 0)
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
  out.enabled = true
  out.notes = []
  Object.assign(out, await unifiedAgentBase(db, 'robert', range))

  const since = range.startIso

  return withProfileScope({ bypass: true }, async () => {
    if (runs) {
      const r = await db.prepare("SELECT COALESCE(SUM(sources_checked),0) AS n FROM robert_runs WHERE created_at >= ?").get(since)
      out.primary_metrics.sources_checked = Number(r?.n || 0)
      const cf = await db.prepare("SELECT COALESCE(SUM(candidates_found),0) AS n FROM robert_runs WHERE created_at >= ?").get(since)
      out.primary_metrics.opportunities_found = Number(cf?.n || 0)
    }
    if (candidates) {
      if (!out.primary_metrics.opportunities_found) {
        const r = await db.prepare("SELECT COUNT(*) AS n FROM robert_opportunity_candidates WHERE created_at >= ?").get(since)
        out.primary_metrics.opportunities_found = Number(r?.n || 0)
      }
      const v = await db.prepare("SELECT COUNT(*) AS n FROM robert_opportunity_candidates WHERE verification_status = 'verified' AND created_at >= ?").get(since)
      out.primary_metrics.opportunities_verified = Number(v?.n || 0)
      const ing = await db.prepare("SELECT COUNT(*) AS n FROM robert_opportunity_candidates WHERE ingested_opportunity_id IS NOT NULL AND created_at >= ?").get(since)
      out.primary_metrics.opportunities_ingested = Number(ing?.n || 0)

      const rejBreakdown = await db.prepare(`
        SELECT rejection_reason, COUNT(*) AS n
          FROM robert_opportunity_candidates
         WHERE created_at >= ? AND rejection_reason IS NOT NULL
         GROUP BY rejection_reason
      `).all(since)
      const rej = {}
      for (const row of rejBreakdown) rej[row.rejection_reason] = Number(row.n || 0)
      out.primary_metrics.rejection_reasons = rej
    }
    if (recs) {
      const total = await db.prepare("SELECT COUNT(*) AS n FROM robert_profile_recommendations WHERE created_at >= ?").get(since)
      out.primary_metrics.profile_recommendations = Number(total?.n || 0)
      const acc = await db.prepare("SELECT COUNT(*) AS n FROM robert_profile_recommendations WHERE recommendation_status = 'accepted' AND created_at >= ?").get(since)
      out.primary_metrics.pipeline_acceptances = Number(acc?.n || 0)
      out.primary_metrics.general_pool_only = Math.max(
        0,
        Number(out.primary_metrics.opportunities_verified || 0) - Number(out.primary_metrics.profile_recommendations || 0),
      )
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

    const rows = await db.prepare(`
      SELECT
        ${hasCity ? 'city' : 'NULL AS city'},
        ${hasState ? 'state' : 'NULL AS state'},
        ${hasLat ? 'latitude' : 'NULL AS latitude'},
        ${hasLng ? 'longitude' : 'NULL AS longitude'},
        category,
        title,
        ingested_opportunity_id,
        created_at
      FROM robert_opportunity_candidates
      WHERE ingested_opportunity_id IS NOT NULL AND created_at >= ?
      ORDER BY created_at DESC
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

  const runs = await tableExists(db, 'yana_runs')
  const leads = await tableExists(db, 'yana_lead_candidates')
  const johnQ = await tableExists(db, 'yana_john_queue')
  const larryQ = await tableExists(db, 'yana_larry_queue')
  const installed = runs || leads || johnQ || larryQ
  if (!installed) return out
  out.installed = true
  out.enabled = true
  out.notes = []
  Object.assign(out, await unifiedAgentBase(db, 'yana', range))

  const since = range.startIso

  return withProfileScope({ bypass: true }, async () => {
    if (runs) {
      const u = await db.prepare("SELECT COALESCE(SUM(urls_fetched),0) AS n FROM yana_runs WHERE created_at >= ?").get(since)
      out.primary_metrics.websites_checked = Number(u?.n || 0)
      const lf = await db.prepare("SELECT COALESCE(SUM(leads_found),0) AS n FROM yana_runs WHERE created_at >= ?").get(since)
      out.primary_metrics.leads_found = Number(lf?.n || 0)
    }
    if (leads) {
      if (!out.primary_metrics.leads_found) {
        const r = await db.prepare("SELECT COUNT(*) AS n FROM yana_lead_candidates WHERE created_at >= ?").get(since)
        out.primary_metrics.leads_found = Number(r?.n || 0)
      }
      const q = await db.prepare("SELECT COUNT(*) AS n FROM yana_lead_candidates WHERE qualification_status = 'qualified' AND created_at >= ?").get(since)
      out.primary_metrics.leads_qualified = Number(q?.n || 0)
      const rej = await db.prepare(`
        SELECT rejection_reason, COUNT(*) AS n FROM yana_lead_candidates
         WHERE rejection_reason IS NOT NULL AND created_at >= ?
         GROUP BY rejection_reason
      `).all(since)
      const map = {}
      let rejCount = 0
      for (const row of rej) { map[row.rejection_reason] = Number(row.n || 0); rejCount += Number(row.n || 0) }
      out.primary_metrics.leads_rejected = rejCount
      out.primary_metrics.rejection_reasons = map
    }
    if (johnQ) {
      const r = await db.prepare("SELECT COUNT(*) AS n FROM yana_john_queue WHERE created_at >= ?").get(since)
      out.primary_metrics.leads_sent_to_john = Number(r?.n || 0)
    } else {
      out.primary_metrics.leads_sent_to_john = 0
    }
    out.primary_metrics.lead_conversion_rate = pct(
      Number(out.primary_metrics.leads_sent_to_john || 0),
      Number(out.primary_metrics.websites_checked || 0),
    )
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
  out.enabled = true
  out.notes = []
  Object.assign(out, await unifiedAgentBase(db, 'john', range))

  const since = range.startIso
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  return withProfileScope({ bypass: true }, async () => {
    if (drafts) {
      const created = await db.prepare(`
        SELECT COUNT(*) AS n FROM john_email_drafts
         WHERE draft_status IN ('created','needs_review','needs_sender_alias_review') AND created_at >= ?
      `).get(since)
      out.primary_metrics.drafts_created = Number(created?.n || 0)

      const blocked = await db.prepare("SELECT COUNT(*) AS n FROM john_email_drafts WHERE draft_status = 'blocked' AND created_at >= ?").get(since)
      out.primary_metrics.drafts_blocked = Number(blocked?.n || 0)

      const aliasReview = await db.prepare("SELECT COUNT(*) AS n FROM john_email_drafts WHERE draft_status = 'needs_sender_alias_review' AND created_at >= ?").get(since)
      out.primary_metrics.drafts_needing_alias_review = Number(aliasReview?.n || 0)

      const created24 = await db.prepare(`
        SELECT COUNT(*) AS n FROM john_email_drafts
         WHERE draft_status IN ('created','needs_review','needs_sender_alias_review') AND created_at >= ?
      `).get(dayAgo)
      const used = Number(created24?.n || 0)
      out.primary_metrics.drafts_created_24h = used
      out.primary_metrics.daily_capacity_remaining = Math.max(0, JOHN_DAILY_CAP - used)
      out.primary_metrics.daily_capacity_total = JOHN_DAILY_CAP

      const blocks = await db.prepare(`
        SELECT block_reason, COUNT(*) AS n FROM john_email_drafts
         WHERE draft_status = 'blocked' AND block_reason IS NOT NULL AND created_at >= ?
         GROUP BY block_reason
      `).all(since)
      const blockMap = {}
      for (const r of blocks) blockMap[r.block_reason] = Number(r.n || 0)
      out.primary_metrics.block_reasons = blockMap
    }
    if (supp) {
      const hits = await db.prepare(`
        SELECT COUNT(*) AS n FROM john_email_drafts
         WHERE block_reason = 'suppressed' AND created_at >= ?
      `).get(since)
      out.primary_metrics.suppression_hits = Number(hits?.n || 0)
    }
    if (aliasChecks) {
      const last = await db.prepare("SELECT alias_status, checked_at FROM john_alias_checks ORDER BY checked_at DESC LIMIT 1").get()
      out.primary_metrics.alias_status = last?.alias_status || 'unknown'
      out.primary_metrics.alias_checked_at = last?.checked_at || null
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

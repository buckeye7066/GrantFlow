/**
 * robertJohnBridge.js
 *
 * Robert → John lead handoff. This MIRRORS yanaLeadDiscovery.makeYanaLeadSource:
 * it implements John's lead-source contract (listQualifiedLeads /
 * markQueuedForReview / requestEnrichment / getEnrichmentRequest) and is
 * registered alongside Yana at boot via johnYanaBridge.registerLeadSource.
 *
 * CRITICAL SCOPING (owner-authoritative):
 *   - Robert's FUNDING discovery is unchanged. Funding sources and grant
 *     opportunities continue to flow to PROFILES (the discovery catalog /
 *     pipeline / recommendations) exactly as before. This bridge touches NONE
 *     of that path — it only READS rows Robert already persisted.
 *   - Robert hands John ONLY *leads*: contactable organizations that are
 *     prospects to pitch GrantFlow TO — the same shape Yana surfaces. A funder
 *     (a foundation/agency Robert finds to APPLY to) is the OPPOSITE of a lead
 *     and is NEVER surfaced here.
 *
 * Where the leads come from
 * -------------------------
 * Robert has no native "GrantFlow-client prospect" table — his entire surface
 * (robert_source_candidates = funders, robert_opportunity_candidates = grants,
 * funding_opportunities, robert_profile_recommendations) is the funding→profile
 * path. The one place Robert can carry a *client prospect* without inventing a
 * new table is an explicit tag on a row he already stores:
 *
 *   robert_source_candidates.evidence_json.lead = {
 *     is_client_prospect: true,            // REQUIRED — opt-in marker
 *     email: 'contact@org.org',            // REQUIRED — usable contact email
 *     contact_person: { name, title },     // optional
 *     organization_type: 'nonprofit',      // optional
 *     funding_need_summary: '…',           // optional
 *     grantflow_fit_summary: '…',          // optional
 *     lead_score: 78,                      // optional (defaults below)
 *     do_not_contact: false,               // optional
 *   }
 *
 * A row WITHOUT `evidence.lead.is_client_prospect === true` is a plain funding
 * source and is IGNORED here. So today, with nothing tagging that block, this
 * source is an honest NOOP — it returns zero leads — while being fully wired to
 * surface client prospects the moment a Robert mining step (or an operator)
 * tags one. This is the conservative, non-fragile handoff: it can never leak a
 * funder to John, and it never fabricates a contact.
 *
 * Cap ownership: like Yana, THIS source owns its daily cap (John does not
 * re-enforce). We enforce ≤ ROBERT_JOHN_MAX_LEADS_PER_24H (default 50) rolling
 * 24h, counted by John drafts already attributed to Robert leads, so the two
 * agents share the spirit of the charter §4 cap without double-drafting.
 */

import { createLogger } from '../../utils/logger.js'

const log = createLogger('robert-john-bridge')

const LEAD_ID_PREFIX = 'robert-src:'

function maxLeadsPer24h() {
  const n = Number(process.env.ROBERT_JOHN_MAX_LEADS_PER_24H)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 50
}

function defaultLeadScore() {
  const n = Number(process.env.ROBERT_JOHN_DEFAULT_LEAD_SCORE)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 75
}

function parseEvidence(value) {
  if (value === null || value === undefined) return {}
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(String(value))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** A row qualifies as a CLIENT lead only when explicitly tagged + has an email. */
function extractClientLead(row) {
  const evidence = parseEvidence(row?.evidence_json)
  const lead = evidence && typeof evidence.lead === 'object' ? evidence.lead : null
  if (!lead || lead.is_client_prospect !== true) return null
  const email = typeof lead.email === 'string' ? lead.email.trim() : ''
  if (!email) return null
  return { lead, email }
}

/**
 * Map a tagged robert_source_candidate row into John's lead packet shape (the
 * same shape Yana produces in candidateToLeadPacket). lead_id is namespaced so
 * it can never collide with a Yana candidate id and so markQueuedForReview can
 * recover the underlying source id.
 */
export function robertSourceToLeadPacket(row) {
  const extracted = extractClientLead(row)
  if (!extracted) return null
  const { lead, email } = extracted

  const contactPoints = [{ type: 'email', value: email }]
  const sourceUrls = []
  if (row.source_url) sourceUrls.push(row.source_url)

  const publicEvidence = []
  if (lead.funding_need_summary) {
    publicEvidence.push({ type: 'funding_need', text: String(lead.funding_need_summary) })
  }
  if (lead.grantflow_fit_summary) {
    publicEvidence.push({ type: 'grantflow_fit', text: String(lead.grantflow_fit_summary) })
  }
  if (lead.contact_person?.name) {
    publicEvidence.push({
      type: 'contact',
      name: lead.contact_person.name,
      title: lead.contact_person.title || null,
      email,
    })
  }
  // Always carry at least one public-evidence item (John requires it): the
  // source URL Robert discovered the org on is itself public evidence.
  if (publicEvidence.length === 0 && row.source_url) {
    publicEvidence.push({ type: 'source', text: `Discovered by Robert at ${row.source_url}` })
  }

  const location = [row.geography_city, row.geography_state].filter(Boolean).join(', ') || null

  return {
    lead_id: `${LEAD_ID_PREFIX}${row.id}`,
    organization_name: row.source_name || lead.organization_name || null,
    organization_type: lead.organization_type || row.source_type || null,
    website_url: lead.website_url || row.source_url || null,
    location,
    contact_points: contactPoints,
    contact_person: lead.contact_person?.name
      ? { name: lead.contact_person.name, title: lead.contact_person.title || null }
      : null,
    public_evidence: publicEvidence,
    funding_need_summary: lead.funding_need_summary || null,
    grantflow_fit_summary: lead.grantflow_fit_summary || null,
    lead_score: typeof lead.lead_score === 'number' ? lead.lead_score : defaultLeadScore(),
    contact_confidence: typeof lead.contact_confidence === 'number' ? lead.contact_confidence : 0.6,
    urgency_score: typeof lead.urgency_score === 'number' ? lead.urgency_score : 0,
    recommended_channel: 'email',
    do_not_contact_flags: lead.do_not_contact === true ? ['robert_do_not_contact'] : [],
    source_urls: sourceUrls,
    discovered_at: row.discovered_at || null,
    qualified: true, // tagged client prospects are pre-qualified by Robert
    status: 'qualified',
  }
}

/** Recover the robert_source_candidates.id from a namespaced lead_id. */
function sourceIdFromLeadId(leadId) {
  const s = String(leadId || '')
  return s.startsWith(LEAD_ID_PREFIX) ? s.slice(LEAD_ID_PREFIX.length) : null
}

/**
 * Count how many John drafts in the last 24h were created from Robert leads, so
 * THIS source can enforce its own rolling-24h cap (John does not re-enforce).
 * Counts john_email_drafts whose yana_lead_id carries our namespace prefix.
 * Returns 0 (cap not yet hit) on any error — recall over suppression.
 */
async function countRobertDraftsLast24h(db) {
  if (!db?.prepare) return 0
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  try {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS c FROM john_email_drafts
           WHERE yana_lead_id LIKE ? AND created_at >= ?`,
      )
      .get(`${LEAD_ID_PREFIX}%`, since)
    return Number(row?.c || 0)
  } catch (err) {
    log.warn('countRobertDraftsLast24h failed (treating as 0)', { error: String(err?.message || err) })
    return 0
  }
}

/**
 * List Robert's qualified CLIENT-prospect leads as John lead packets.
 * Applies Robert's own daily cap (John trusts it). Returns [] on any query
 * error so a bad query never blocks Yana's leads in the aggregate.
 */
export async function listQualifiedRobertLeads(db, { limit = 200, leadIds = null } = {}) {
  if (!db?.prepare) return []

  // Robert's own daily cap: how many MORE Robert leads John may draft now.
  const alreadyDrafted = await countRobertDraftsLast24h(db)
  const capRemaining = Math.max(0, maxLeadsPer24h() - alreadyDrafted)
  if (capRemaining === 0) {
    log.info('robert→john daily cap reached', { cap: maxLeadsPer24h(), alreadyDrafted })
    return []
  }

  let rows = []
  try {
    if (Array.isArray(leadIds) && leadIds.length > 0) {
      const ids = leadIds.map((id) => sourceIdFromLeadId(id)).filter(Boolean)
      if (ids.length === 0) return []
      const ph = ids.map(() => '?').join(',')
      rows = (await db.prepare(`SELECT * FROM robert_source_candidates WHERE id IN (${ph})`).all(...ids)) || []
    } else {
      // Approved/pending contactable rows, newest first. evidence tag is the
      // real gate (applied below); we just bound the scan.
      rows = (await db
        .prepare(
          `SELECT * FROM robert_source_candidates
             WHERE status IN ('approved','pending')
             ORDER BY discovered_at DESC
             LIMIT ?`,
        )
        .all(Math.max(1, Math.min(Number(limit) || 200, 1000)))) || []
    }
  } catch (err) {
    log.warn('listQualifiedRobertLeads query failed (returning none)', { error: String(err?.message || err) })
    return []
  }

  const leads = []
  for (const row of rows) {
    const packet = robertSourceToLeadPacket(row)
    if (packet) leads.push(packet)
    if (leads.length >= capRemaining) break
  }
  return leads
}

/**
 * The Robert-backed lead source John consumes (registered at boot via
 * johnYanaBridge.registerLeadSource). Mirrors makeYanaLeadSource.
 */
export function makeRobertLeadSource(db) {
  return {
    name: 'robert',
    async listQualifiedLeads({ limit, leadIds } = {}) {
      // includeUnqualified is meaningless for Robert (his leads are pre-tagged
      // qualified or absent), so it is intentionally ignored.
      return listQualifiedRobertLeads(db, { limit, leadIds })
    },
    async markQueuedForReview({ leadId } = {}) {
      const sourceId = sourceIdFromLeadId(leadId)
      if (!sourceId || !db?.prepare) return { ok: true }
      // Stamp the row's evidence so the same prospect isn't re-surfaced after a
      // draft exists; never touches Robert's funding/status fields.
      const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
      try {
        const existing = await db
          .prepare('SELECT evidence_json FROM robert_source_candidates WHERE id = ? LIMIT 1')
          .get(sourceId)
        if (!existing) return { ok: true }
        const evidence = parseEvidence(existing.evidence_json)
        evidence.lead = { ...(evidence.lead || {}), queued_for_john_at: new Date().toISOString() }
        await db
          .prepare(`UPDATE robert_source_candidates SET evidence_json = ?, last_checked_at = ${nowFn} WHERE id = ?`)
          .run(JSON.stringify(evidence), sourceId)
      } catch (err) {
        return { ok: false, error: err?.message || String(err) }
      }
      return { ok: true }
    },
    /**
     * Robert does not run live enrichment for John today. Implementing the hook
     * as a supported no-op keeps the contract complete and lets John's deferral
     * logic behave consistently across sources.
     */
    async requestEnrichment() {
      return { ok: true, attempts: 1 }
    },
  }
}

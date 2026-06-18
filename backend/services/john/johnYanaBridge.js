/**
 * John — Yana bridge.
 *
 * Yana is the lead-discovery agent. She produces qualified lead packets and
 * places them on a queue (or in a database table) for John to consume.
 *
 * In this repository, Yana's storage is not yet finalized — when it lands,
 * the bridge will be pointed at her queue. To keep John usable today, the
 * bridge accepts a pluggable `leadSource` so:
 *
 *   - admin endpoints can pass an explicit array of lead packets (for
 *     drafting from a manual lead the operator just approved),
 *   - tests can pass an in-memory adapter,
 *   - production will register a Yana-backed source at boot.
 *
 * The bridge enforces filtering rules John relies on:
 *   - lead.qualified === true (unless requireYanaQualified=false)
 *   - lead.lead_score >= JOHN_MIN_LEAD_SCORE
 *   - at least one usable email contact_point
 *   - has source_urls (contact source) and public_evidence
 *   - lead has not already been drafted by John
 *   - lead is not in the suppression list
 *   - sort by lead_score desc, urgency_score desc, contact_confidence desc,
 *     discovered_at desc
 */

import { hasDraftForLead } from './johnRunStore.js'
import { makeYanaLeadPacket } from './johnTypes.js'
import { getJohnConfig } from './johnOutreachSafety.js'
import { makeSuppressionChecker } from './johnSuppressionService.js'
import { isValidEmail } from './johnOutreachSafety.js'

/**
 * The default lead source — empty. Real deployments should register a
 * Yana-backed source by passing { leadSource } to fetchLeadsForJohn().
 */
export const NULL_LEAD_SOURCE = Object.freeze({
  name: 'null',
  async listQualifiedLeads() {
    return []
  },
  async markQueuedForReview() {
    return { ok: true }
  },
})

let registeredSource = NULL_LEAD_SOURCE

/**
 * Allow the server bootstrap (or tests) to install a real lead source.
 *
 * The source owns daily-cap enforcement: John does NOT re-enforce caps, he
 * trusts whatever the registered source returns. Yana applies the
 * ≤50-per-rolling-24h cap in pushQualifiedToJohn (charter §4) before a lead is
 * ever visible here. Any future source MUST do the same. The contract is both
 * methods the bridge calls — listQualifiedLeads() and markQueuedForReview().
 */
export function registerLeadSource(src) {
  if (!src || typeof src.listQualifiedLeads !== 'function') {
    throw new Error('registerLeadSource: src must implement listQualifiedLeads()')
  }
  if (typeof src.markQueuedForReview !== 'function') {
    throw new Error('registerLeadSource: src must implement markQueuedForReview()')
  }
  registeredSource = src
}

export function getRegisteredLeadSource() {
  return registeredSource
}

function hasUsableEmail(lead) {
  const pts = Array.isArray(lead?.contact_points) ? lead.contact_points : []
  return pts.some(
    (p) => p && (p.type === 'email' || p.type === 'mailto') && isValidEmail(p.value || p.email)
  )
}

/**
 * Fetch + filter + sort lead packets ready for John to draft.
 *
 * Returns:
 *   { leads, considered, filtered_out: { reason: count } }
 */
export async function fetchLeadsForJohn({
  db,
  leadSource = registeredSource,
  config = getJohnConfig(),
  limit = config.maxDraftsPerRun,
  leadIds = null,            // explicit list overrides queue order
  includeUnqualified = false, // admin override
  suppression = null,
} = {}) {
  if (!leadSource || typeof leadSource.listQualifiedLeads !== 'function') {
    leadSource = NULL_LEAD_SOURCE
  }

  const rawLeads = await leadSource.listQualifiedLeads({
    limit: typeof limit === 'number' ? limit * 4 : 200,
    leadIds: Array.isArray(leadIds) && leadIds.length > 0 ? leadIds : null,
    includeUnqualified,
  })

  const filtered_out = {}
  const supp = suppression || (db ? await makeSuppressionChecker(db) : { isSuppressed: () => false })

  const requireQualified = config.requireYanaQualified === true && !includeUnqualified
  const minScore = typeof config.minLeadScore === 'number' ? config.minLeadScore : 0

  const accepted = []
  for (const raw of rawLeads || []) {
    const lead = makeYanaLeadPacket(raw)
    let drop = null

    if (requireQualified && lead.qualified !== true) drop = 'not_qualified_by_yana'
    else if (typeof lead.lead_score === 'number' && lead.lead_score < minScore) drop = 'low_lead_score'
    else if (config.requirePublicEvidence && lead.public_evidence.length === 0) drop = 'missing_public_evidence'
    else if (config.requireContactSource && lead.source_urls.length === 0) drop = 'missing_contact_source'
    else if (Array.isArray(lead.do_not_contact_flags) && lead.do_not_contact_flags.length > 0) drop = 'do_not_contact'
    else if (!hasUsableEmail(lead)) drop = 'no_usable_email_contact'
    else if (lead.organization_name && supp.isSuppressed({ type: 'organization', value: lead.organization_name })) {
      drop = 'organization_suppressed'
    } else if (lead.lead_id && db && (await hasDraftForLead(db, lead.lead_id))) {
      drop = 'already_drafted'
    }

    if (drop) {
      filtered_out[drop] = (filtered_out[drop] || 0) + 1
      continue
    }
    accepted.push(lead)
  }

  accepted.sort((a, b) => {
    const ls = (b.lead_score ?? 0) - (a.lead_score ?? 0)
    if (ls !== 0) return ls
    const us = (b.urgency_score ?? 0) - (a.urgency_score ?? 0)
    if (us !== 0) return us
    const cs = (b.contact_confidence ?? 0) - (a.contact_confidence ?? 0)
    if (cs !== 0) return cs
    const ad = a.discovered_at ? Date.parse(a.discovered_at) : 0
    const bd = b.discovered_at ? Date.parse(b.discovered_at) : 0
    return bd - ad
  })

  const cap = typeof limit === 'number' ? Math.max(0, limit) : accepted.length
  const leads = accepted.slice(0, cap)

  return {
    leads,
    considered: rawLeads?.length ?? 0,
    filtered_out,
    source_name: leadSource.name || 'unknown',
  }
}

/**
 * Notify the lead source that John has produced a draft and the lead is now
 * "queued for human review". Optional — no-ops if the source doesn't
 * implement the hook.
 */
export async function markLeadQueuedForReview(leadSource, leadId, draftId) {
  try {
    if (leadSource && typeof leadSource.markQueuedForReview === 'function') {
      await leadSource.markQueuedForReview({ leadId, draftId })
    }
  } catch (err) {
    // Lead-source hooks are advisory; never fail the draft because of one.
    return { ok: false, error: err?.message || String(err) }
  }
  return { ok: true }
}

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
import { isExcludedEmail, isExcludedUrl } from '../yana/prospectExclusions.js'

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

/**
 * John consumes leads from MULTIPLE discovery agents. Today both Yana (the
 * client-discovery agent) and Robert (the funding-discovery agent, for the
 * subset of contactable client prospects he encounters — never his funding
 * sources) register here at boot. The registry is therefore a LIST.
 *
 * Each source owns daily-cap enforcement: John does NOT re-enforce caps, he
 * trusts whatever each registered source returns. Yana applies the
 * ≤50-per-rolling-24h cap in pushQualifiedToJohn (charter §4) before a lead is
 * ever visible here; Robert's source applies its own cap. Any future source
 * MUST do the same. The contract is both methods the bridge calls —
 * listQualifiedLeads() and markQueuedForReview().
 */
const registeredSources = []

function validateLeadSource(src) {
  if (!src || typeof src.listQualifiedLeads !== 'function') {
    throw new Error('registerLeadSource: src must implement listQualifiedLeads()')
  }
  if (typeof src.markQueuedForReview !== 'function') {
    throw new Error('registerLeadSource: src must implement markQueuedForReview()')
  }
}

/**
 * Register a lead source. Appending semantics: the source is added to the list
 * John aggregates over, so Yana AND Robert can both register at boot.
 *
 * Back-compat: callers that expect "set the single source" still work — when a
 * source with the same `name` is registered again it REPLACES the prior one
 * (so re-registering Yana, or resetting to NULL_LEAD_SOURCE in tests, behaves
 * exactly as the old singular setter did), and getRegisteredLeadSource() keeps
 * returning the most-recently-registered source.
 */
export function registerLeadSource(src) {
  validateLeadSource(src)
  const name = src.name || 'unknown'
  // Special-case: registering the NULL source is the documented "reset" — it
  // clears the registry so getRegisteredLeadSource() returns NULL_LEAD_SOURCE
  // and tests start from a clean slate (matches the old single-slot behaviour).
  if (src === NULL_LEAD_SOURCE) {
    registeredSources.length = 0
    return
  }
  const existingIdx = registeredSources.findIndex((s) => (s.name || 'unknown') === name)
  if (existingIdx >= 0) registeredSources[existingIdx] = src
  else registeredSources.push(src)
}

/**
 * Back-compat singular accessor: returns the most-recently-registered source,
 * or NULL_LEAD_SOURCE when none are registered. New code should prefer
 * getRegisteredLeadSources().
 */
export function getRegisteredLeadSource() {
  return registeredSources.length > 0 ? registeredSources[registeredSources.length - 1] : NULL_LEAD_SOURCE
}

/** All registered lead sources (Yana, Robert, …). Empty list → John has no work. */
export function getRegisteredLeadSources() {
  return registeredSources.slice()
}

function hasUsableEmail(lead) {
  const pts = Array.isArray(lead?.contact_points) ? lead.contact_points : []
  return pts.some(
    (p) => p && (p.type === 'email' || p.type === 'mailto') && isValidEmail(p.value || p.email)
  )
}

/**
 * Drop a lead whose website or any email contact resolves to an excluded domain
 * (grant-tech competitor, aggregator/directory, social, or junk infra). Keeps
 * John from drafting outreach to e.g. a competitor's address that enrichment
 * mistakenly scraped off an aggregator page.
 */
function isExcludedLead(lead) {
  if (isExcludedUrl(lead?.website_url)) return true
  const pts = Array.isArray(lead?.contact_points) ? lead.contact_points : []
  return pts.some((p) => {
    if (!p || (p.type !== 'email' && p.type !== 'mailto')) return false
    const value = p.value || p.email
    return value && isExcludedEmail(value)
  })
}

/**
 * A stable dedupe key for a lead across sources. Two sources can surface the
 * same organization (e.g. Yana and Robert both find the same nonprofit); we
 * keep the first/highest-ranked and drop the rest so John never drafts twice to
 * one org. Prefer the email (most precise), else the org name.
 */
function dedupeKeyForLead(lead) {
  const pts = Array.isArray(lead?.contact_points) ? lead.contact_points : []
  const email = pts
    .map((p) => (p && (p.type === 'email' || p.type === 'mailto') ? (p.value || p.email) : null))
    .filter(Boolean)
    .map((e) => String(e).trim().toLowerCase())
    .sort()[0]
  if (email) return `email:${email}`
  const org = String(lead?.organization_name || '').trim().toLowerCase()
  return org ? `org:${org}` : null
}

/**
 * Resolve which lead sources to pull from. When the caller passes an explicit
 * `leadSource` (admin drafting a single approved lead, or a test adapter), we
 * use ONLY that one — preserving the exact legacy single-source behaviour.
 * Otherwise we aggregate over every registered source (Yana, Robert, …).
 */
function resolveSources(leadSource) {
  if (leadSource) {
    return typeof leadSource.listQualifiedLeads === 'function' ? [leadSource] : [NULL_LEAD_SOURCE]
  }
  const all = getRegisteredLeadSources()
  return all.length > 0 ? all : [NULL_LEAD_SOURCE]
}

/**
 * Fetch + filter + sort lead packets ready for John to draft.
 *
 * Aggregates across ALL registered lead sources (Yana, Robert, …) unless an
 * explicit `leadSource` is supplied (then only that one is used). Leads are
 * deduped by email/org across sources, and each returned packet carries its
 * owning source on `_leadSource` so John can route markQueuedForReview /
 * enrichment hooks back to the right agent.
 *
 * Returns:
 *   { leads, considered, filtered_out: { reason: count }, source_name, source_names }
 */
export async function fetchLeadsForJohn({
  db,
  leadSource = null,
  config = getJohnConfig(),
  limit = config.maxDraftsPerRun,
  leadIds = null,            // explicit list overrides queue order
  includeUnqualified = false, // admin override
  suppression = null,
} = {}) {
  const sources = resolveSources(leadSource)

  // Pull from each source, tagging every raw lead with its owning source so we
  // can route hooks + report per-source provenance after filtering.
  const tagged = []
  for (const src of sources) {
    let rows = []
    try {
      rows = await src.listQualifiedLeads({
        limit: typeof limit === 'number' ? limit * 4 : 200,
        leadIds: Array.isArray(leadIds) && leadIds.length > 0 ? leadIds : null,
        includeUnqualified,
      })
    } catch {
      // A failing source must not blind John to the others. Recall-over-
      // suppression: skip this source's leads, keep going.
      rows = []
    }
    for (const raw of rows || []) tagged.push({ raw, src })
  }

  const filtered_out = {}
  const supp = suppression || (db ? await makeSuppressionChecker(db) : { isSuppressed: () => false })

  const requireQualified = config.requireYanaQualified === true && !includeUnqualified
  const minScore = typeof config.minLeadScore === 'number' ? config.minLeadScore : 0

  const accepted = []
  for (const { raw, src } of tagged) {
    const lead = makeYanaLeadPacket(raw)
    let drop = null

    if (requireQualified && lead.qualified !== true) drop = 'not_qualified_by_yana'
    else if (typeof lead.lead_score === 'number' && lead.lead_score < minScore) drop = 'low_lead_score'
    else if (config.requirePublicEvidence && lead.public_evidence.length === 0) drop = 'missing_public_evidence'
    else if (config.requireContactSource && lead.source_urls.length === 0) drop = 'missing_contact_source'
    else if (Array.isArray(lead.do_not_contact_flags) && lead.do_not_contact_flags.length > 0) drop = 'do_not_contact'
    else if (!hasUsableEmail(lead)) drop = 'no_usable_email_contact'
    else if (isExcludedLead(lead)) drop = 'excluded_domain'
    else if (lead.organization_name && supp.isSuppressed({ type: 'organization', value: lead.organization_name })) {
      drop = 'organization_suppressed'
    } else if (lead.lead_id && db && (await hasDraftForLead(db, lead.lead_id))) {
      drop = 'already_drafted'
    }

    if (drop) {
      filtered_out[drop] = (filtered_out[drop] || 0) + 1
      continue
    }

    // Carry the owning source (non-enumerable so it never leaks into JSON the
    // composer/persistence serializes; johnAgent reads it to route hooks).
    Object.defineProperty(lead, '_leadSource', { value: src, enumerable: false })
    Object.defineProperty(lead, '_sourceName', { value: src.name || 'unknown', enumerable: false })
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

  // Cross-source dedupe (post-sort, so the highest-ranked wins): when two
  // DIFFERENT sources surface the same organization/email, keep one. Two leads
  // from the SAME source that share an org (distinct lead_ids) are intentional
  // and preserved — a source already deduped its own pool.
  const deduped = []
  const seenByKey = new Map() // key -> source name of the kept lead
  for (const lead of accepted) {
    const key = dedupeKeyForLead(lead)
    const srcName = lead._sourceName
    if (key && seenByKey.has(key) && seenByKey.get(key) !== srcName) {
      filtered_out.duplicate_across_sources = (filtered_out.duplicate_across_sources || 0) + 1
      continue
    }
    if (key && !seenByKey.has(key)) seenByKey.set(key, srcName)
    deduped.push(lead)
  }

  const cap = typeof limit === 'number' ? Math.max(0, limit) : deduped.length
  const leads = deduped.slice(0, cap)

  const sourceNames = sources.map((s) => s.name || 'unknown')
  return {
    leads,
    considered: tagged.length,
    filtered_out,
    // Back-compat: singular name = first source when aggregating, else the one.
    source_name: sourceNames[0] || 'unknown',
    source_names: sourceNames,
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

/**
 * John → Yana: ask the lead source to enrich a lead that is too thin to
 * personalize. Optional hook — a source that does not implement
 * requestEnrichment() simply gets a no-op, so this never breaks older sources
 * or tests. Returns the source's result (incl. `attempts`) when available so
 * the orchestrator can apply its deferral cap.
 */
export async function requestLeadEnrichment(leadSource, { leadId, organizationName, missing, note } = {}) {
  try {
    if (leadSource && typeof leadSource.requestEnrichment === 'function') {
      const res = await leadSource.requestEnrichment({ leadId, organizationName, missing, note })
      return { ok: true, supported: true, ...(res || {}) }
    }
  } catch (err) {
    return { ok: false, supported: true, error: err?.message || String(err) }
  }
  return { ok: true, supported: false }
}

/**
 * Read John's currently-open enrichment request for a lead (how many times he
 * has already asked), so he can stop deferring after a few tries and draft the
 * best available version. No-op-safe for sources without the hook.
 */
export async function getEnrichmentRequest(leadSource, leadId) {
  try {
    if (leadSource && typeof leadSource.getEnrichmentRequest === 'function') {
      return await leadSource.getEnrichmentRequest({ leadId })
    }
  } catch {
    /* advisory */
  }
  return null
}

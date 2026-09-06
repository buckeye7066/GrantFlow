/**
 * funderLead.js — a GRANTMAKER is a funder lead, not an application.
 *
 * Owner 2026-09-05: "These sources error when I try to add them" — the
 * Foundation & Data Source Search "Add" on a ProPublica 990 grantmaker
 * (community foundations, private foundations, charitable trusts) for a
 * student profile. The row carries no application URL, no need vocabulary and
 * a DIRECTORY kind, so the canonical admission gate refused it (422
 * NEED_COVERAGE) and the page showed a bare error. The refusal was right —
 * a 990 filer is not something a person applies to — but the click deserved
 * work, not a wall: the funder's own scholarship / grant PROGRAMS are what the
 * profile can apply to, and the item-need search already finds them through
 * the canonical engine. This module only decides WHAT a funder lead is.
 */

const GRANTMAKER_SOURCE_RX = /^propublica\.990$|^irs\.990|^990/i
const GRANTMAKER_TITLE_RX = /\b(foundation|grantmaker|charitable trust|community trust|philanthrop)/i

/**
 * @returns {null | { name: string, ein: string|null, source: string|null, reason: string }}
 */
export function classifyFunderLead(opportunity = {}) {
  if (!opportunity || typeof opportunity !== 'object') return null
  const source = String(opportunity.source ?? '').trim()
  const fundingSourceType = String(opportunity.funding_source_type ?? '').trim().toLowerCase()
  const kind = String(opportunity.type ?? opportunity.opportunity_kind ?? '').trim().toUpperCase()
  const title = String(opportunity.title ?? '')
  const sponsor = String(opportunity.sponsor ?? opportunity.funder ?? '').trim()
  const hasApplicationUrl = Boolean(String(opportunity.application_url ?? opportunity.apply_url ?? '').trim())
  let reason = null
  if (GRANTMAKER_SOURCE_RX.test(source)) reason = `source:${source}`
  else if (fundingSourceType === 'foundation' && !hasApplicationUrl) reason = 'funding_source_type:foundation'
  else if (kind === 'DIRECTORY' && !hasApplicationUrl && GRANTMAKER_TITLE_RX.test(title)) reason = 'directory_grantmaker_title'
  if (!reason) return null
  const name = sponsor || title.replace(/\s+[—-]\s+Foundation\/Grantmaker\s*$/i, '').trim()
  if (!name) return null
  return { name, ein: opportunity.source_id ? String(opportunity.source_id) : null, source: source || null, reason }
}

export default { classifyFunderLead }

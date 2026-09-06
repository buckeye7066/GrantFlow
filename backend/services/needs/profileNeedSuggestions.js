/**
 * profileNeedSuggestions.js — the "Search by Profile Needs" list can never be
 * empty for a parsed profile.
 *
 * Owner 2026-09-05: "A profile is only in GrantFlow if it has a need. To say
 * there are no inferred needs means the profile has not been properly parsed
 * and that information stored and crawled appropriately." The SmartMatcher
 * checklist read ONLY the derived ITEM needs (profileItemNeeds — purchasable
 * things a declared field names), which are honestly empty for most person
 * profiles (measured 2026-08-02: 27 of 37 real profiles derive zero items).
 * The page then said "No inferred needs for this profile" — false: the same
 * profile declares canonical needs (education, housing, medical…), and an
 * organization carries a needs plan. Those ARE the profile's needs.
 *
 * Ladder (each tier is a DECLARED or TYPE-DERIVED fact, never prose):
 *   1. derived item needs (profileItemNeeds)            basis: declared_items
 *   2. needs-plan open items (orgNeedsTaxonomy)         basis: needs_plan
 *   3. declared canonical needs (pipelinePrecision)     basis: declared_needs
 *   4. nothing — a PARSE FAILURE, reported as such, never as "no needs".
 */
import { deriveProfileItemNeeds } from '../../config/profileItemNeeds.js'
import { deriveOrgNeeds } from './orgNeedsTaxonomy.js'
import { declaredNeedsFrom } from '../pipelinePrecision.js'

export const SUGGESTION_BASIS = Object.freeze({
  DECLARED_ITEMS: 'declared_items',
  NEEDS_PLAN: 'needs_plan',
  DECLARED_NEEDS: 'declared_needs',
  PARSE_FAILURE: 'parse_failure',
})

function needLabel(canonical) {
  return String(canonical ?? '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * @returns {{ suggestions: Array<object>, basis: string, parse_failure: boolean, unmapped: Array, silent_fields: Array, message: string|null }}
 */
export function buildProfileNeedSuggestions({ profile = {}, sections = {}, limit = 8 } = {}) {
  const safeLimit = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 8
  const derived = deriveProfileItemNeeds(profile ?? {}, sections ?? {})
  const base = { unmapped: derived?.unmapped ?? [], silent_fields: derived?.silentFields ?? [] }
  if (Array.isArray(derived?.needs) && derived.needs.length > 0) {
    return {
      ...base,
      basis: SUGGESTION_BASIS.DECLARED_ITEMS,
      parse_failure: false,
      message: null,
      suggestions: derived.needs.slice(0, safeLimit).map((n) => ({
        name: n.item,
        category: n.category,
        score: null,
        reasons: [`Declared in ${n.evidence}`],
        source: n.source,
        evidence: n.evidence,
        need_text: n.need_text,
      })),
    }
  }

  let plan = null
  try { plan = deriveOrgNeeds({ profile: profile ?? {}, sections: sections ?? {} }) } catch { plan = null }
  const open = Array.isArray(plan?.open) ? plan.open : []
  if (open.length > 0) {
    return {
      ...base,
      basis: SUGGESTION_BASIS.NEEDS_PLAN,
      parse_failure: false,
      message: null,
      suggestions: open.slice(0, safeLimit).map((n) => ({
        name: n.label,
        category: Array.isArray(n.funding_categories) && n.funding_categories.length > 0 ? n.funding_categories[0] : null,
        score: null,
        reasons: [`Needs plan for a ${String(plan.blueprint ?? profile?.primary_type ?? 'profile').replace(/_/g, ' ')}`],
        source: n.source ?? 'profile_type_blueprint',
        evidence: n.blueprint ?? null,
        need_text: n.search_subject ?? n.label,
        need_code: n.code,
      })),
    }
  }

  let declared = []
  try { declared = declaredNeedsFrom(profile ?? {}, sections ?? {}) } catch { declared = [] }
  if (declared.length > 0) {
    return {
      ...base,
      basis: SUGGESTION_BASIS.DECLARED_NEEDS,
      parse_failure: false,
      message: null,
      suggestions: declared.slice(0, safeLimit).map((need) => ({
        name: needLabel(need),
        category: need,
        score: null,
        reasons: ['Declared need on the profile'],
        source: 'declared_need',
        evidence: 'needs',
        need_text: needLabel(need),
        need_code: need,
      })),
    }
  }

  return {
    ...base,
    basis: SUGGESTION_BASIS.PARSE_FAILURE,
    parse_failure: true,
    message: 'GrantFlow could not read a single need from this profile. A profile is only here because it has a need, so this profile was not parsed correctly — open it and confirm its needs, type, and sections.',
    suggestions: [],
  }
}

export default { buildProfileNeedSuggestions, SUGGESTION_BASIS }

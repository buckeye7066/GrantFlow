/**
 * profileConfiguration.js — the ONE place that turns a loaded profile context
 * into the canonical "is this profile CONFIGURED?" verdict.
 *
 * The rule and its threshold live in `config/placeholderProfileSignals.js`;
 * this module only supplies that pure detector with the two derivations the
 * crawlers themselves read (`buildProfileSignals`, `deriveProfileFacts`) so
 * every consumer — the crawl entry point, the match engine, the boot sweep and
 * the coverage/result-floor audit — reaches the SAME verdict from the SAME
 * evidence. Do not re-implement the check at a call site.
 *
 * Never writes. Never mutates a profile.
 */

import { detectUnconfiguredProfile } from '../../config/placeholderProfileSignals.js'
import { deriveProfileFacts } from '../../config/profileDerivedFacts.js'
import { classifyProductionProfile } from '../../config/productionProfileScope.js'
import { buildProfileSignals } from '../profileHelpers.js'

/**
 * @param {object}  ctx                 a loadProfileContext()-shaped object
 * @param {object}  ctx.profile
 * @param {object}  ctx.sections
 * @param {object} [ctx.signals]        reused when present (it is expensive)
 * @returns {object}
 */
export function assessProfileConfiguration(ctx = {}) {
  const profile = ctx?.profile ?? {}
  const sections = ctx?.sections ?? {}

  // Administration/test fixtures are intentionally valid records, but they are
  // not funding applicants. Block them at the same choke point the live crawl
  // consults before building a thesis or performing network work. This prevents
  // Admin Vault / Play Review from reappearing through a new route that forgot
  // a local name check.
  const scope = classifyProductionProfile(ctx)
  if (!scope.production) {
    return {
      unconfigured: true,
      excluded_from_matching: true,
      exclusion_reason: scope.reason,
      families: [],
      signals: [],
      substance: [],
      missing_prerequisites: [],
      reason: 'profile_non_production',
    }
  }

  let signals = ctx?.signals ?? null
  if (!signals) {
    try { signals = buildProfileSignals({ profile, sections }) } catch { signals = {} }
  }
  let facts = null
  try { facts = deriveProfileFacts(profile, sections) } catch { facts = {} }

  return detectUnconfiguredProfile({ profile, sections, signals, facts })
}

/**
 * The honest, owner-facing sentence for an unconfigured profile: what is
 * missing, named. Mirrors the EVA runner's "blocked, with the prerequisite
 * named" posture — "we could not read it" is never reported as "there is
 * nothing out there".
 */
export function describeUnconfiguredProfile(verdict, { max = 6 } = {}) {
  if (!verdict?.unconfigured) return null
  if (verdict.excluded_from_matching) {
    return 'This is an internal or test profile and is excluded from production funding matching.'
  }
  const prereqs = (verdict.missing_prerequisites || []).slice(0, max)
  return `This profile has not been filled in, so no crawl can mean anything for it yet. Supply: ${prereqs.join('; ')}.`
}

export default { assessProfileConfiguration, describeUnconfiguredProfile }

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
import { buildProfileSignals } from '../profileHelpers.js'

/**
 * @param {object}  ctx                 a loadProfileContext()-shaped object
 * @param {object}  ctx.profile
 * @param {object}  ctx.sections
 * @param {object} [ctx.signals]        reused when present (it is expensive)
 * @returns {import('../../config/placeholderProfileSignals.js').default extends never ? object : {
 *   unconfigured: boolean, families: string[], signals: object[],
 *   substance: string[], missing_prerequisites: string[], reason: string|null }}
 */
export function assessProfileConfiguration(ctx = {}) {
  const profile = ctx?.profile ?? {}
  const sections = ctx?.sections ?? {}

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
  const prereqs = (verdict.missing_prerequisites || []).slice(0, max)
  return `This profile has not been filled in, so no crawl can mean anything for it yet. Supply: ${prereqs.join('; ')}.`
}

export default { assessProfileConfiguration, describeUnconfiguredProfile }
